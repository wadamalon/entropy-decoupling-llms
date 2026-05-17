// ============================================================
// battle.js — Three.js 3D chess board + military piece rendering
// Pawns render as a FORMATION of infantry models filling the square.
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MODEL_PATHS, PIECE_COLORS, PIECE_NAMES, EXPLOSION_MODEL } from './config.js';
import { loadingProgress } from './loader.js';

function showToast(msg, type) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border2);border-radius:6px;padding:10px 20px;font-size:13px;font-weight:600;z-index:9999;color:var(--text);pointer-events:none;`;
  if (type === 'danger') el.style.borderColor = 'var(--p2)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Module state ──────────────────────────────────────────
let renderer, scene, camera, controls, raycaster, mouse;
let boardGroup, pieceGroup, highlightGroup, explosionGroup, hoverGroup, hitGroup;
let clock;
let animMixers = [];
let pieceObjects = new Map();
let selectedSquare = null;
let legalMoves = [];
let hoveredSquare = null;
let myRoleLocal, socketLocal;
let battleDataLocal;
let chessModule = null;
let promotionPending = null;
let _running = false;
let _cutsceneActive = false;
let _hoverQueued = false;
let _lastHoverE  = null;

// ── Chess clock ────────────────────────────────────────────
let _timerWhite  = 0;   // remaining seconds (attacker = white)
let _timerBlack  = 0;
let _timerActive = null; // 'white' | 'black' | null
let _timerLast   = 0;   // timestamp of last tick
let _timerIv     = null; // setInterval handle

// GLB cache: pieceType → THREE.Group (cloned per piece)
const modelCache = new Map();
let explosionTemplate = null;

const SQUARE_SIZE = 1.0;
const BOARD_OFFSET = -3.5; // centers 8x8 board

// Target heights relative to king=1.0 reference, then mapped to world units
// King = 0.62 world units; everything else is proportional
const _KING_H = 0.62;
const PIECE_TARGET_H = {
  k: _KING_H * 1.00,   // 0.620
  q: _KING_H * 0.88,   // 0.546
  r: _KING_H * 0.72,   // 0.446
  b: _KING_H * 0.76,   // 0.471
  n: _KING_H * 0.74,   // 0.459
  p: _KING_H * 0.52,   // 0.322
};

// Computed auto-scales after model load (pieceType → number)
const autoScales = {};

// Infantry formation offsets (3×2 = 6 soldiers per pawn square)
// Positions are in local square space [-0.35..0.35]
const INFANTRY_FORMATION = [
  [-0.28, -0.18], [0, -0.18], [0.28, -0.18],
  [-0.28,  0.14], [0,  0.14], [0.28,  0.14],
];

// ── Init ──────────────────────────────────────────────────
export async function initBattle(battleData, myRole, socket, pendingMoves = []) {
  myRoleLocal   = myRole;
  socketLocal   = socket;
  battleDataLocal = battleData;

  const canvas = document.getElementById('battle-canvas');
  const w = canvas.offsetWidth  || canvas.parentElement?.offsetWidth  || window.innerWidth;
  const h = canvas.offsetHeight || canvas.parentElement?.offsetHeight || window.innerHeight;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setSize(w, h);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a1008, 0.025); // subtler fog — skybox handles background

  clock = new THREE.Clock();

  // Camera: behind own pieces, looking across the board
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 200);
  // White (attacker) pieces sit at negative-Z, black at positive-Z
  const isAttacker = myRole === battleData.attacker;
  camera.position.set(0, 6, isAttacker ? -12 : 12);
  camera.lookAt(0, 0, 0);

  // Orbit controls — drag to rotate, scroll to zoom
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.minDistance = 6;
  controls.maxDistance = 22;
  controls.maxPolarAngle = Math.PI / 2.1; // can't go below board
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Raycaster
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // Skybox + lighting
  _buildSkybox();
  _setupLights();

  // Groups
  boardGroup    = new THREE.Group();
  pieceGroup    = new THREE.Group();
  highlightGroup = new THREE.Group();
  explosionGroup = new THREE.Group();
  hoverGroup    = new THREE.Group();
  hitGroup      = new THREE.Group();
  scene.add(boardGroup, pieceGroup, highlightGroup, explosionGroup, hoverGroup, hitGroup);

  _buildBoard();

  // Pre-load all GLB models
  await _loadModels();

  // Import chess module and set up game
  const chessMod = await import('./chess.js');
  chessModule = chessMod; // destroyBattle calls chessModule.destroyChess()

  // Render initial board BEFORE initChess so pieceObjects is populated
  // when pendingMoves are drained — otherwise _onChessMove fires with empty pieceObjects
  // and every buffered move silently fails (pieceObjects.get(from) === undefined → early return)
  _renderPiecesFromFEN(battleData.fen);

  chessMod.initChess(battleData, myRole, socket, {
    onMove: _onChessMove,
    onHighlight: _setHighlights,
    onPromotion: _onPromotionNeeded,
    onOutcome: _onBattleOutcome,
    onFenUpdate: _onFenUpdate,
  }, pendingMoves);

  // If buffered moves advanced the game, re-render from the actual current position.
  // (Animations for buffered moves are skipped — just snap to correct board state.)
  const latestFen = chessMod.getCurrentFen() || battleData.fen;
  if (latestFen !== battleData.fen) _renderPiecesFromFEN(latestFen);

  // Turn indicator: use current game FEN so it reflects any moves that arrived during loading
  _updateTurnIndicator(latestFen);

  // Build grid + hit-plane layer AFTER board (needs boardGroup built)
  _buildInteractionGrid();

  // Events — use pointerdown/pointerup so OrbitControls drag doesn't swallow clicks
  let _ptrDownPos = null;
  canvas.addEventListener('pointerdown', (e) => { _ptrDownPos = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup',   (e) => {
    if (!_ptrDownPos) return;
    const dx = e.clientX - _ptrDownPos.x, dy = e.clientY - _ptrDownPos.y;
    _ptrDownPos = null;
    if (Math.sqrt(dx*dx + dy*dy) < 6) _onCanvasClick(e);
  });
  canvas.addEventListener('mousemove', (e) => {
    _lastHoverE = e;
    if (!_hoverQueued) {
      _hoverQueued = true;
      requestAnimationFrame(() => { if (_lastHoverE) _onCanvasHover(_lastHoverE); _hoverQueued = false; });
    }
  });
  window.addEventListener('resize', () => _onResize(canvas));

  // Start chess clock if configured
  if (battleData.timerSeconds > 0) _initTimer(battleData.timerSeconds);

  _running = true;
  _animate();
}

export function destroyBattle() {
  _running = false;
  _stopTimer();
  const canvas = document.getElementById('battle-canvas');
  canvas.removeEventListener('mousemove', _onCanvasHover);
  hoveredSquare = null;
  if (chessModule?.destroyChess) chessModule.destroyChess();
  if (renderer) { renderer.dispose(); renderer = null; }
  if (controls) { controls.dispose(); controls = null; }
  hitGroup = null; hoverGroup = null;
  animMixers = [];
  pieceObjects.clear();
  modelCache.clear();
  selectedSquare = null;
  legalMoves = [];
  chessModule = null;
}

// ── Skybox ─────────────────────────────────────────────────
function _buildSkybox() {
  // Gradient sky: dark navy zenith → smoky military-green horizon
  const skyGeo = new THREE.SphereGeometry(80, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor:     { value: new THREE.Color(0x04080f) },  // near-black navy
      horizonColor: { value: new THREE.Color(0x0d1a12) },  // dark smoky green
    },
    vertexShader: `
      varying float vY;
      void main() {
        vY = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      varying float vY;
      void main() {
        float t = clamp(vY * 1.4 + 0.1, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizonColor, topColor, t * t), 1.0);
      }`,
    depthWrite: false,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  // Distant stars
  const starCount = 1800;
  const starPos   = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(1 - Math.random() * 1.6); // mostly upper hemisphere
    starPos[i*3]   = 70 * Math.sin(phi) * Math.cos(theta);
    starPos[i*3+1] = 70 * Math.abs(Math.cos(phi));
    starPos[i*3+2] = 70 * Math.sin(phi) * Math.sin(theta);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo,
    new THREE.PointsMaterial({ color: 0xddeeff, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.8 })));
}

// ── Lights ────────────────────────────────────────────────
function _setupLights() {
  // Hemisphere: cold sky above, dark earth below
  scene.add(new THREE.HemisphereLight(0x1a2a35, 0x0a110a, 1.0));

  // Main moonlight — cool, off-axis for dramatic shadows
  const moon = new THREE.DirectionalLight(0xb0c8d8, 1.8);
  moon.position.set(-6, 14, 10);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 0.5;
  moon.shadow.camera.far  = 50;
  moon.shadow.camera.left = moon.shadow.camera.bottom = -12;
  moon.shadow.camera.right = moon.shadow.camera.top   =  12;
  scene.add(moon);

  // Warm secondary fill (distant fire glow from horizon)
  const fire = new THREE.DirectionalLight(0xff6622, 0.35);
  fire.position.set(8, 2, -10);
  scene.add(fire);

  // Player accent point lights — same positions as before but warmer
  const blueLight = new THREE.PointLight(0x3399cc, 0.7, 18);
  blueLight.position.set(-3, 3, 5);
  scene.add(blueLight);
  const redLight = new THREE.PointLight(0xcc3322, 0.7, 18);
  redLight.position.set(3, 3, -5);
  scene.add(redLight);
}

// ── Board ─────────────────────────────────────────────────
function _buildBoard() {
  // Board surface
  const boardGeo = new THREE.BoxGeometry(8.6, 0.15, 8.6);
  const boardMat = new THREE.MeshPhongMaterial({ color: 0x0d1610, shininess: 20 });
  const boardBase = new THREE.Mesh(boardGeo, boardMat);
  boardBase.position.y = -0.09;
  boardBase.receiveShadow = true;
  boardGroup.add(boardBase);

  // Board edge trim
  const edgeGeo = new THREE.BoxGeometry(8.8, 0.08, 8.8);
  const edgeMat = new THREE.MeshPhongMaterial({ color: 0x1a2e1c });
  boardGroup.add(new THREE.Mesh(edgeGeo, edgeMat));

  // Squares
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const isLight = (rank + file) % 2 === 0;
      const geo = new THREE.PlaneGeometry(SQUARE_SIZE * 0.98, SQUARE_SIZE * 0.98);
      const mat = new THREE.MeshPhongMaterial({
        color: isLight ? 0x2a3e2c : 0x111810,
        shininess: 5,
      });
      const sq = new THREE.Mesh(geo, mat);
      sq.rotation.x = -Math.PI / 2;
      sq.position.set(
        BOARD_OFFSET + file * SQUARE_SIZE + SQUARE_SIZE / 2,
        0.001,
        BOARD_OFFSET + rank * SQUARE_SIZE + SQUARE_SIZE / 2,
      );
      sq.receiveShadow = true;
      sq.userData = { type: 'square', square: _coordToSquare(file, rank) };
      boardGroup.add(sq);
    }
  }

  // Coordinate labels
  const canvas2d = document.createElement('canvas');
  canvas2d.width = 512; canvas2d.height = 512;
  // (label rendering skipped for performance — optional)
}

// ── Interaction grid (visible lines + invisible hit planes) ──
function _buildInteractionGrid() {
  // One invisible hit-plane per square — sits high enough to intercept raycasts above pieces
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = _coordToSquare(file, rank);
      const geo = new THREE.PlaneGeometry(SQUARE_SIZE, SQUARE_SIZE);
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      });
      const plane = new THREE.Mesh(geo, mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(
        BOARD_OFFSET + file * SQUARE_SIZE + SQUARE_SIZE / 2,
        1.2, // above pieces so raycast always hits before anything else
        BOARD_OFFSET + rank * SQUARE_SIZE + SQUARE_SIZE / 2,
      );
      plane.userData = { type: 'square', square: sq };
      hitGroup.add(plane);
    }
  }

  // Visible grid lines — at y=0.05 (well above squares at y=0.001), renderOrder ensures
  // they paint after the board so depth-fighting never hides them
  const lineMat = new THREE.LineBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.30, depthTest: false });
  const points = [];
  for (let i = 0; i <= 8; i++) {
    const p = BOARD_OFFSET + i * SQUARE_SIZE;
    points.push(new THREE.Vector3(p, 0.05, BOARD_OFFSET));
    points.push(new THREE.Vector3(p, 0.05, BOARD_OFFSET + 8 * SQUARE_SIZE));
    points.push(new THREE.Vector3(BOARD_OFFSET, 0.05, p));
    points.push(new THREE.Vector3(BOARD_OFFSET + 8 * SQUARE_SIZE, 0.05, p));
  }
  const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
  const lineSegs = new THREE.LineSegments(lineGeo, lineMat);
  lineSegs.renderOrder = 2;
  boardGroup.add(lineSegs);
}

// ── Strip effects geometry from loaded GLB ────────────────
// Removes ground planes, explosion/fire meshes, and orange emissives BEFORE
// bounding-box measurement so autoScales are based on the actual model only.
function _stripModelEffects(model) {
  const toRemove = [];

  // Pass 1 — name-based VFX strip
  model.traverse(child => {
    if (!child.isMesh) return;
    if (/\b(smoke|fire|explosion|dust|trail|spark|impact|debris|decal|vfx|effect|emitter|particle|ground|floor|plane_base|shadow_plane)\b/i.test(child.name)) {
      toRemove.push(child);
    }
  });

  toRemove.forEach(c => { if (c.parent) c.parent.remove(c); });
}

// ── Model loading ─────────────────────────────────────────
async function _loadModels() {
  const loader = new GLTFLoader();
  const types  = ['p', 'n', 'b', 'r', 'q', 'k'];
  const keyMap = { p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king' };
  const NAMES  = { p:'Infantry', n:'Drone', b:'Sniper', r:'Artillery', q:'Combat Droid', k:'General' };
  const total  = types.length + 2; // +praying +explosion
  let loaded   = 0;
  const tick = (label) => { loaded++; loadingProgress(10 + Math.round((loaded / total) * 80), `Loading ${label}...`); };

  await Promise.all(types.map(t => new Promise((resolve) => {
    const path = MODEL_PATHS[keyMap[t]];
    if (!path) { tick(NAMES[t]); resolve(); return; }
    loader.load(path, (gltf) => {
      const model = gltf.scene;
      model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });

      // ── Strip VFX effects before measuring ─────────────────
      _stripModelEffects(model);

      // ── Skeleton update — must happen before any Box3 measurement ──
      // Without this, SkinnedMesh bone matrices are identity/zero → setFromObject(precise=true)
      // returns an empty or near-zero box → autoScale falls back to 1.0 → model at native scale.
      model.updateMatrixWorld(true);
      model.traverse(c => { if (c.isSkinnedMesh && c.skeleton) c.skeleton.update(); });

      // Pre-compute geometry bounding boxes (needed as fallback for non-SkinnedMesh)
      model.traverse(c => { if (c.isMesh && c.geometry) c.geometry.computeBoundingBox(); });

      if (t === 'p') {
        const rb = new THREE.Box3().setFromObject(model, true);
        const rs = rb.getSize(new THREE.Vector3());
        if      (rs.y < rs.z * 0.5) model.rotation.x = -Math.PI / 2;
        else if (rs.y < rs.x * 0.5) model.rotation.z =  Math.PI / 2;
        model.updateMatrixWorld(true);
        model.traverse(c => { if (c.isSkinnedMesh && c.skeleton) c.skeleton.update(); });
        const rb2 = new THREE.Box3().setFromObject(model, true);
        if ((rb2.min.y + rb2.max.y) / 2 < 0) model.rotation.x += Math.PI;
      }

      // ── Scale normalisation ─────────────────────────────────
      model.updateMatrixWorld(true);
      model.traverse(c => { if (c.isSkinnedMesh && c.skeleton) c.skeleton.update(); });
      const box2  = new THREE.Box3().setFromObject(model, true);
      const size2 = box2.getSize(new THREE.Vector3());
      const h2    = size2.y > 0.001 ? size2.y : Math.max(size2.x, size2.z);
      autoScales[t] = PIECE_TARGET_H[t] / h2;
      // Safety clamp — if h2 is near-zero or absurd, fall back to scale=1.0 so
      // _buildSinglePiece post-scale correction can measure & re-derive from scratch
      if (!isFinite(autoScales[t]) || autoScales[t] > 3.0 || autoScales[t] <= 0) {
        autoScales[t] = 1.0;
        console.warn(`[battle] autoScale clamped for ${t}, h2=${h2} — post-scale correction will fix`);
      }

      modelCache.set(t, { scene: model, animations: gltf.animations, nativeBBox: box2.clone() });
      tick(NAMES[t]);
      resolve();
    }, undefined, () => { tick(NAMES[t]); resolve(); });
  })));

  // Praying animation model
  await new Promise((resolve) => {
    if (!MODEL_PATHS.praying) { tick('praying'); resolve(); return; }
    loader.load(MODEL_PATHS.praying, (gltf) => {
      modelCache.set('praying', { scene: gltf.scene, animations: gltf.animations });
      tick('praying');
      resolve();
    }, undefined, () => { tick('praying'); resolve(); });
  });

  // Explosion effect
  await new Promise((resolve) => {
    if (!EXPLOSION_MODEL) { tick('effects'); resolve(); return; }
    loader.load(EXPLOSION_MODEL, (gltf) => {
      explosionTemplate = gltf;
      tick('effects');
      resolve();
    }, undefined, () => { tick('effects'); resolve(); });
  });
}

// ── Piece rendering ───────────────────────────────────────
function _squareToCoord(sq) {
  // sq = 'e2' → { file: 4, rank: 1 }
  const file = sq.charCodeAt(0) - 97; // a=0
  const rank = parseInt(sq[1]) - 1;   // 1=0
  return { file, rank };
}

function _coordToSquare(file, rank) {
  return String.fromCharCode(97 + file) + (rank + 1);
}

function _squareToWorld(sq) {
  const { file, rank } = _squareToCoord(sq);
  return new THREE.Vector3(
    BOARD_OFFSET + file * SQUARE_SIZE + SQUARE_SIZE / 2,
    0,
    BOARD_OFFSET + rank * SQUARE_SIZE + SQUARE_SIZE / 2,
  );
}

function _renderPiecesFromFEN(fen) {
  // Clear existing pieces
  while (pieceGroup.children.length) pieceGroup.remove(pieceGroup.children[0]);
  pieceObjects.clear();
  animMixers = [];

  const boardPart = fen.split(' ')[0];
  const rows = boardPart.split('/');

  // FEN rows go rank 8 → rank 1 (top → bottom)
  rows.forEach((row, rowIdx) => {
    const rank = 7 - rowIdx; // rank index 0-7
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += parseInt(ch);
      } else {
        const sq = _coordToSquare(file, rank);
        const isWhite = ch === ch.toUpperCase();
        const pieceType = ch.toLowerCase();
        const player = isWhite ? 'player1' : 'player2';
        _placePiece(sq, pieceType, player);
        file++;
      }
    }
  });
}

function _placePiece(square, pieceType, player) {
  const worldPos = _squareToWorld(square);
  const color = player === 'player1' ? PIECE_COLORS.player1 : PIECE_COLORS.player2;

  const group = new THREE.Group();
  group.position.copy(worldPos);
  group.userData.pieceType = pieceType; // needed by walk helpers

  if (pieceType === 'p') {
    // ── Infantry formation: multiple soldiers filling the square ──
    _buildInfantryFormation(group, player, color);
  } else {
    _buildSinglePiece(group, pieceType, player, color);
  }

  // Flip black pieces 180° so they face the opponent
  if (player === 'player2') {
    group.rotation.y = Math.PI;
  }

  pieceGroup.add(group);
  pieceObjects.set(square, { group, pieceType, player, mixers: [] });
}

function _buildInfantryFormation(parentGroup, player, color) {
  const cached = modelCache.get('p');
  const scale = autoScales['p'] ?? 0.14;

  INFANTRY_FORMATION.forEach(([ox, oz], idx) => {
    const soldierGroup = new THREE.Group();
    soldierGroup.position.set(ox, 0, oz);

    // Slight random rotation variation for realism
    soldierGroup.rotation.y = (Math.random() - 0.5) * 0.3;

    if (cached) {
      const clone = _cloneModel(cached, color);
      clone.scale.setScalar(scale);
      // Use pre-measured template bbox — avoids shared-skeleton issue where
      // setFromObject on clones reads template bone matrices (scale=1) not clone matrices.
      const nb = cached.nativeBBox;
      const tempBox = (nb && !nb.isEmpty())
        ? new THREE.Box3(nb.min.clone().multiplyScalar(scale), nb.max.clone().multiplyScalar(scale))
        : (() => { clone.updateMatrixWorld(true); return new THREE.Box3().setFromObject(clone); })();
      const centre  = tempBox.getCenter(new THREE.Vector3());
      clone.position.x += -centre.x;
      clone.position.z += -centre.z;
      clone.position.y -= tempBox.min.y;
      soldierGroup.add(clone);

      // Set up animation mixer — store walk clip, DO NOT auto-play
      // Infantry only animates while physically moving across the board
      if (cached.animations.length > 0) {
        const mixer = new THREE.AnimationMixer(clone);
        const walkClip =
          THREE.AnimationClip.findByName(cached.animations, 'walk') ||
          THREE.AnimationClip.findByName(cached.animations, 'run')  ||
          THREE.AnimationClip.findByName(cached.animations, 'move') ||
          cached.animations.find(a => !/idle/i.test(a.name))        ||
          cached.animations[0];
        animMixers.push(mixer);
        soldierGroup.userData.mixer    = mixer;
        soldierGroup.userData.walkClip = walkClip;
        // No action.play() — triggered by _startPieceWalk during move animation
      }
    } else {
      // Infantry fallback: body + helmet
      const isLight = color >= 0x888888;
      const col = isLight ? 0xccccbb : 0x222222;
      const emCol = isLight ? 0xffffff : 0x000000;
      const bodyGeo = new THREE.CylinderGeometry(0.045, 0.06, 0.18, 6);
      const bodyMat = new THREE.MeshPhongMaterial({ color: col, emissive: emCol, emissiveIntensity: isLight ? 0.2 : 0 });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.09;
      body.castShadow = true;
      const headGeo = new THREE.SphereGeometry(0.055, 6, 5);
      const head = new THREE.Mesh(headGeo, bodyMat);
      head.position.y = 0.22;
      head.castShadow = true;
      soldierGroup.add(body, head);
    }

    parentGroup.add(soldierGroup);
  });
}

function _buildSinglePiece(parentGroup, pieceType, player, color) {
  const cached = modelCache.get(pieceType);
  const scale = autoScales[pieceType] ?? 0.22;

  if (cached) {
    const clone = _cloneModel(cached, color);
    clone.scale.setScalar(scale);
    clone.updateMatrixWorld(true);
    // Pre-compute geometry bounding boxes and update skeleton matrices.
    // skeleton.update() is required so that setFromObject(precise=true) can apply bone
    // transforms when iterating SkinnedMesh vertices — without it bone matrices are zero
    // and the returned box is empty, making autoScales fall back to 1.0 (native/huge scale).
    // Scale + position using pre-measured TEMPLATE bbox.
    // Clones share the template's skeleton reference — setFromObject(clone, true) reads
    // the template's bone matrixWorld (scale=1.0), not the clone's scaled matrices.
    // This causes the post-scale correction to see ~100-unit bounds on a 0.006-scale clone
    // and overcorrect to near-zero. Using the native bbox and scaling it is exact.
    const nb = cached.nativeBBox;
    const _scaledBox = (s) => {
      if (nb && !nb.isEmpty()) {
        return new THREE.Box3(nb.min.clone().multiplyScalar(s), nb.max.clone().multiplyScalar(s));
      }
      // Fallback: measure clone without bone transforms (precise=false, static mesh path)
      clone.scale.setScalar(s);
      clone.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(clone);
    };

    let usedScale = scale;
    let usedBox   = _scaledBox(usedScale);
    let usedSize  = usedBox.getSize(new THREE.Vector3());
    let measH     = usedSize.y > 0.001 ? usedSize.y : Math.max(usedSize.x, usedSize.z);

    // Post-scale correction: if height is >50% off target, re-derive scale
    if (measH > 0.001 && Math.abs(measH - PIECE_TARGET_H[pieceType]) / PIECE_TARGET_H[pieceType] > 0.5) {
      usedScale = usedScale * PIECE_TARGET_H[pieceType] / measH;
      usedBox   = _scaledBox(usedScale);
      usedSize  = usedBox.getSize(new THREE.Vector3());
      measH     = usedSize.y > 0.001 ? usedSize.y : Math.max(usedSize.x, usedSize.z);
    }
    // Hard cap: if still taller than 2× target
    if (measH > PIECE_TARGET_H[pieceType] * 2 && measH > 0.001) {
      usedScale = usedScale * PIECE_TARGET_H[pieceType] / measH;
      usedBox   = _scaledBox(usedScale);
    }

    clone.scale.setScalar(usedScale);
    const centre = usedBox.getCenter(new THREE.Vector3());
    clone.position.x = -centre.x;
    clone.position.z = -centre.z;
    clone.position.y = usedBox.isEmpty() ? 0 : -usedBox.min.y;
    parentGroup.add(clone);

    if (cached.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(clone);
      // Prefer a move/walk clip; fall back to first clip available
      const moveClip =
        THREE.AnimationClip.findByName(cached.animations, 'walk') ||
        THREE.AnimationClip.findByName(cached.animations, 'move') ||
        THREE.AnimationClip.findByName(cached.animations, 'run')  ||
        cached.animations.find(a => !/idle/i.test(a.name))        ||
        cached.animations[0];
      animMixers.push(mixer);
      parentGroup.userData.mixer    = mixer;
      parentGroup.userData.moveClip = moveClip;
      // No auto-play — triggered only during move animation
    }
  } else {
    // Placeholder box sized by piece importance
    const h = { k:0.52, q:0.46, r:0.38, b:0.38, n:0.36, p:0.28 }[pieceType] || 0.3;
    const w = { k:0.22, q:0.20, r:0.20, b:0.16, n:0.20, p:0.16 }[pieceType] || 0.18;
    const geo = new THREE.BoxGeometry(w, h, w);
    const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2;
    mesh.castShadow = true;
    parentGroup.add(mesh);
  }
}

function _cloneModel(cached, color) {
  const clone = cached.scene.clone(true);
  const isLight = color >= 0x888888;

  const _tintMat = (m) => {
    const mat = m.clone();
    const c = (mat.color || new THREE.Color(1,1,1)).clone();
    // Skin detection: warm tone, r dominant
    const isSkin = c.r > 0.35 && c.g > 0.20 && c.b < 0.55 && c.r > c.b * 1.25;
    if (isLight) {
      if (!isSkin) { mat.color.r = Math.min(1, c.r*1.15+0.08); mat.color.g = Math.min(1, c.g*1.15+0.08); mat.color.b = Math.min(1, c.b*1.15+0.08); }
      if (mat.emissive) { mat.emissive.set(isSkin ? 0x000000 : 0x666655); mat.emissiveIntensity = isSkin ? 0 : 0.10; }
    } else {
      mat.color.multiplyScalar(isSkin ? 0.72 : 0.32);
      if (mat.emissive) { mat.emissive.set(0x000000); mat.emissiveIntensity = 0; }
    }
    return mat;
  };

  clone.traverse(child => {
    if (!child.isMesh) return;
    if (Array.isArray(child.material)) {
      child.material = child.material.map(_tintMat);
    } else if (child.material) {
      child.material = _tintMat(child.material);
    }
  });
  return clone;
}

// ── Highlights ────────────────────────────────────────────
function _setHighlights(squares) {
  while (highlightGroup.children.length) highlightGroup.remove(highlightGroup.children[0]);
  legalMoves = squares;

  for (const sq of squares) {
    const pos = _squareToWorld(sq);
    const hasPiece = pieceObjects.has(sq);

    // Tinted square overlay
    const sqGeo = new THREE.PlaneGeometry(SQUARE_SIZE * 0.96, SQUARE_SIZE * 0.96);
    const sqMat = new THREE.MeshBasicMaterial({
      color: hasPiece ? 0xff4422 : 0x44ddaa,
      transparent: true, opacity: hasPiece ? 0.28 : 0.18,
      depthWrite: false,
    });
    const sqMesh = new THREE.Mesh(sqGeo, sqMat);
    sqMesh.rotation.x = -Math.PI / 2;
    sqMesh.position.set(pos.x, 0.003, pos.z);
    sqMesh.userData = { type: 'highlight', square: sq };
    highlightGroup.add(sqMesh);

    if (hasPiece) {
      // Capture target: bright red ring
      const rGeo = new THREE.RingGeometry(0.40, 0.48, 32);
      const rMat = new THREE.MeshBasicMaterial({ color: 0xff3300, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(rGeo, rMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.006, pos.z);
      ring.userData = { type: 'highlight', square: sq };
      highlightGroup.add(ring);
    } else {
      // Empty square: green dot in the centre
      const dGeo = new THREE.CircleGeometry(0.18, 20);
      const dMat = new THREE.MeshBasicMaterial({ color: 0x00ff99, transparent: true, opacity: 0.75, depthWrite: false });
      const dot = new THREE.Mesh(dGeo, dMat);
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(pos.x, 0.006, pos.z);
      dot.userData = { type: 'highlight', square: sq };
      highlightGroup.add(dot);
    }
  }

  // Selected piece: bright cyan ring + filled glow under piece
  if (selectedSquare) {
    const pos = _squareToWorld(selectedSquare);

    // Filled glow
    const glowGeo = new THREE.CircleGeometry(0.50, 32);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x00eeff, transparent: true, opacity: 0.20, depthWrite: false });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(pos.x, 0.004, pos.z);
    glow.userData = { isSelectionGlow: true };
    highlightGroup.add(glow);

    // Sharp cyan ring
    const rGeo = new THREE.RingGeometry(0.42, 0.50, 32);
    const rMat = new THREE.MeshBasicMaterial({ color: 0x00eeff, transparent: true, opacity: 1.0, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(rGeo, rMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.007, pos.z);
    ring.userData = { isSelectionRing: true };
    highlightGroup.add(ring);
  }
}

// ── Hover glimmer ─────────────────────────────────────────
function _onCanvasHover(e) {
  if (!renderer) return;
  const canvas = document.getElementById('battle-canvas');
  const rect = canvas.getBoundingClientRect();
  const hx = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  const hy = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

  const hoverRay = new THREE.Raycaster();
  hoverRay.setFromCamera(new THREE.Vector2(hx, hy), camera);

  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const wp = new THREE.Vector3();
  let sq = null;
  if (hoverRay.ray.intersectPlane(boardPlane, wp)) {
    sq = _squareFromWorldPoint(wp.x, wp.z);
  }

  // Only update when square changes
  if (sq === hoveredSquare) return;
  hoveredSquare = sq;

  // Clear previous glimmer
  while (hoverGroup.children.length) hoverGroup.remove(hoverGroup.children[0]);

  // Only show glimmer if there's a piece on this square
  if (!sq || !pieceObjects.has(sq)) return;

  const pos = _squareToWorld(sq);

  // Outer soft glow disc
  const glowGeo = new THREE.CircleGeometry(0.52, 32);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(pos.x, 0.004, pos.z);
  glow.userData.isGlimmer = true;

  // Inner sharp ring
  const ringGeo = new THREE.RingGeometry(0.44, 0.50, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffe066, transparent: true, opacity: 0.0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(pos.x, 0.005, pos.z);
  ring.userData.isGlimmer = true;

  hoverGroup.add(glow, ring);
}

// ── Board square from world coords ────────────────────────
function _squareFromWorldPoint(wx, wz) {
  const file = Math.floor((wx - BOARD_OFFSET) / SQUARE_SIZE);
  const rank = Math.floor((wz - BOARD_OFFSET) / SQUARE_SIZE);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return _coordToSquare(file, rank);
}

// ── Click handling ────────────────────────────────────────
function _onCanvasClick(e) {
  if (!chessModule) return;
  // Always ensure hitGroup is visible — guards against any stuck state
  if (hitGroup) hitGroup.visible = true;

  const canvas = document.getElementById('battle-canvas');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  mouse.x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Intersect the y=0 board plane directly — precise, no missed hits, works at any angle
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const worldPoint = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(boardPlane, worldPoint)) return;

  const sq = _squareFromWorldPoint(worldPoint.x, worldPoint.z);
  if (!sq) { selectedSquare = null; _setHighlights([]); return; }

  // If a piece is selected and this square is a legal move target → execute move
  if (selectedSquare && legalMoves.includes(sq)) {
    _tryMove(selectedSquare, sq);
    return;
  }

  // Otherwise try to select a piece on this square
  _selectSquare(sq);
}

function _findSquareOfGroup(group) {
  for (const [sq, data] of pieceObjects.entries()) {
    if (data.group === group) return sq;
  }
  return null;
}

function _selectSquare(sq) {
  if (!chessModule) return;
  const result = chessModule.selectSquare(sq);
  if (result) {
    selectedSquare = sq;
    // Clear hover ring so it doesn't overlap the selection ring
    while (hoverGroup.children.length) hoverGroup.remove(hoverGroup.children[0]);
    hoveredSquare = null;
    _setHighlights(result.moves);
  } else {
    selectedSquare = null;
    _setHighlights([]);
  }
}

function _tryMove(from, to) {
  if (!chessModule) return;
  // Check if promotion needed
  if (chessModule.needsPromotion(from, to)) {
    promotionPending = { from, to };
    import('./ui.js').then(ui => ui.showPromotionModal(_onPromoPick));
    return;
  }
  chessModule.executeMove(from, to, null);
  selectedSquare = null;
  _setHighlights([]);
}

function _onPromoPick(piece) {
  if (!promotionPending) return;
  const { from, to } = promotionPending;
  promotionPending = null;
  chessModule.executeMove(from, to, piece);
  selectedSquare = null;
  _setHighlights([]);
}

// ── Chess callbacks ───────────────────────────────────────
function _updateTurnIndicator(fen) {
  const el = document.getElementById('battle-turn-indicator');
  if (!el) return;
  const activeColor = fen.split(' ')[1]; // 'w' or 'b'
  const isMyTurn = (activeColor === 'w') === (myRoleLocal === battleDataLocal?.attacker);
  el.textContent = isMyTurn ? 'YOUR TURN' : "OPPONENT'S TURN";
  el.className = 'battle-turn-indicator ' + (isMyTurn ? 'my-turn' : 'opp-turn');
}

function _onChessMove({ from, to, captured, isPromotion, promotedTo, fen }) {
  _switchTimer(fen); // advance clock to next player
  _updateTurnIndicator(fen);
  const pieceData = pieceObjects.get(from);
  if (!pieceData) return;
  const targetPos = _squareToWorld(to);

  // Hide grid + clear selection during animation
  selectedSquare = null; _setHighlights([]);
  if (hitGroup) hitGroup.visible = false;
  while (hoverGroup && hoverGroup.children.length) hoverGroup.remove(hoverGroup.children[0]);

  // Start cinematic zoom immediately — runs concurrently with the piece animation
  // so the camera is already pushing in as the piece lifts off the board
  _playCutscene(from, to, () => {});

  const _finishMove = () => {
    if (hitGroup) hitGroup.visible = true;
  };

  // ── Castling: king moves 2 squares → also slide the rook ────────────────
  if (pieceData.pieceType === 'k' && Math.abs(from.charCodeAt(0) - to.charCodeAt(0)) === 2) {
    const rank      = from[1];
    const kingSide  = to.charCodeAt(0) > from.charCodeAt(0);
    const rookFrom  = kingSide ? `h${rank}` : `a${rank}`;
    const rookTo    = kingSide ? `f${rank}` : `d${rank}`;
    const rookData  = pieceObjects.get(rookFrom);
    if (rookData) {
      _animateMovePiece(rookData.group, _squareToWorld(rookTo), () => {
        pieceObjects.delete(rookFrom);
        pieceObjects.set(rookTo, rookData);
      });
    }
  }

  if (captured) {
    // ── En passant: pawn captures diagonally to an empty square ─────────────
    // The actually-captured pawn sits on the same rank as the attacker's origin,
    // not at the destination square, so pieceObjects.get(to) would be null.
    const capturedData = pieceObjects.get(to);
    if (!capturedData && pieceData.pieceType === 'p') {
      const epSq   = to[0] + from[1]; // same file as dest, same rank as origin
      const epData = pieceObjects.get(epSq);
      if (epData) {
        _playDeathAnimation(epData, true, () => pieceGroup.remove(epData.group));
        pieceObjects.delete(epSq);
      }
    }

    _animateAttack(pieceData.group, targetPos, () => {
      if (capturedData) {
        const isPawn = capturedData.pieceType === 'p';
        _playDeathAnimation(capturedData, isPawn, () => pieceGroup.remove(capturedData.group));
      }
      pieceData.group.position.copy(targetPos);
      pieceData.group.position.y = 0;
      pieceObjects.delete(from);
      pieceObjects.set(to, pieceData);
      if (isPromotion && promotedTo) {
        pieceGroup.remove(pieceData.group); pieceObjects.delete(to);
        _placePiece(to, promotedTo, pieceData.player);
      }
      _finishMove();
    });
  } else {
    _animateMovePiece(pieceData.group, targetPos, () => {
      pieceObjects.delete(from);
      pieceObjects.set(to, pieceData);
      if (isPromotion && promotedTo) {
        pieceGroup.remove(pieceData.group); pieceObjects.delete(to);
        _placePiece(to, promotedTo, pieceData.player);
      }
      _finishMove();
    });
  }
}

// ── Cutscene: zoom toward action then zoom back ───────────
function _playCutscene(from, to, onDone) {
  if (!controls || !camera) { onDone(); return; }
  _cutsceneActive = true;
  controls.enabled = false;

  const targetPos = _squareToWorld(to);
  const homePos   = camera.position.clone();
  const homeTgt   = controls.target.clone();
  const zoomPos   = new THREE.Vector3(targetPos.x * 0.4, 2.5, targetPos.z + (homePos.z > 0 ? 2.5 : -2.5));

  const start = performance.now();
  const TOTAL = 1800; // ms — slow, dramatic zoom

  (function tick(now) {
    const t    = Math.min((now - start) / TOTAL, 1);
    const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;

    if (t < 0.45) {
      const p = ease / 0.45;
      camera.position.lerpVectors(homePos, zoomPos, p);
      controls.target.lerpVectors(homeTgt, targetPos, p);
    } else {
      const p = (ease - 0.45) / 0.55;
      camera.position.lerpVectors(zoomPos, homePos, p);
      controls.target.lerpVectors(targetPos, homeTgt, p);
    }
    controls.update();

    if (t < 1) requestAnimationFrame(tick);
    else {
      camera.position.copy(homePos);
      controls.target.copy(homeTgt);
      controls.update();
      controls.enabled = true;
      _cutsceneActive  = false;
      onDone();
    }
  })(start);
}

function _onFenUpdate(fen) {
  // Re-render full board from new FEN
  _renderPiecesFromFEN(fen);
  selectedSquare = null;
  _setHighlights([]);
}

function _onPromotionNeeded(from, to, callback) {
  promotionPending = { from, to };
  import('./ui.js').then(ui => ui.showPromotionModal((piece) => {
    promotionPending = null;
    callback(piece);
  }));
}

function _onBattleOutcome(outcome, battleState) {
  // Handled by chess.js which emits to server
  import('./ui.js').then(ui => {
    // Victory animation on winner's king/general
    _playVictoryAnimations(outcome);
  });
}

// ── Animations ────────────────────────────────────────────

// Quick lunge toward target, pause at impact, then call onComplete
function _animateAttack(group, targetPos, onComplete) {
  const startPos = group.position.clone();
  // Lunge 75% of the way to the target
  const lungePos = startPos.clone().lerp(targetPos, 0.75);
  lungePos.y = startPos.y + 0.15;

  const startTime = performance.now();
  const lungeDuration = 0.30; // slower, weightier lunge
  const pauseDuration = 0.25; // longer pause at impact

  function lunge(now) {
    const t = Math.min((now - startTime) / 1000 / lungeDuration, 1);
    const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
    group.position.lerpVectors(startPos, lungePos, ease);
    if (t < 1) {
      requestAnimationFrame(lunge);
    } else {
      // At impact: flash white, spawn impact ring
      _spawnImpactFlash(targetPos);
      setTimeout(() => onComplete(), pauseDuration * 1000);
    }
  }
  requestAnimationFrame(lunge);
}

function _spawnImpactFlash(pos) {
  const geo = new THREE.RingGeometry(0.05, 0.45, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(pos.x, 0.05, pos.z);
  scene.add(ring);

  const startTime = performance.now();
  function expand(now) {
    const t = Math.min((now - startTime) / 300, 1);
    ring.scale.setScalar(1 + t * 2);
    mat.opacity = 0.9 * (1 - t);
    if (t < 1) requestAnimationFrame(expand);
    else scene.remove(ring);
  }
  requestAnimationFrame(expand);
}

// ── Walk animation helpers ─────────────────────────────────
// Infantry: iterate child soldierGroups; single pieces: use parentGroup directly.
function _startPieceWalk(group) {
  if (group.userData.pieceType === 'p') {
    group.children.forEach(soldierGroup => {
      const mixer = soldierGroup.userData?.mixer;
      const clip  = soldierGroup.userData?.walkClip;
      if (mixer && clip) { const a = mixer.clipAction(clip); a.reset(); a.play(); }
    });
  } else {
    const mixer = group.userData?.mixer;
    const clip  = group.userData?.moveClip;
    if (mixer && clip) { const a = mixer.clipAction(clip); a.reset(); a.play(); }
  }
}

function _stopPieceWalk(group) {
  if (group.userData.pieceType === 'p') {
    group.children.forEach(soldierGroup => {
      if (soldierGroup.userData?.mixer) soldierGroup.userData.mixer.stopAllAction();
    });
  } else {
    if (group.userData?.mixer) group.userData.mixer.stopAllAction();
  }
}

function _animateMovePiece(group, targetPos, onComplete) {
  _startPieceWalk(group);
  const startPos = group.position.clone();
  const duration = 0.90; // slow cinematic arc
  const startTime = performance.now();
  function animStep(now) {
    const elapsed = (now - startTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    const ease = progress < 0.5 ? 2*progress*progress : -1 + (4-2*progress)*progress;

    group.position.x = THREE.MathUtils.lerp(startPos.x, targetPos.x, ease);
    group.position.z = THREE.MathUtils.lerp(startPos.z, targetPos.z, ease);
    group.position.y = startPos.y + Math.sin(ease * Math.PI) * 1.0; // higher arc

    if (progress < 1) {
      requestAnimationFrame(animStep);
    } else {
      group.position.copy(targetPos);
      group.position.y = 0;
      _stopPieceWalk(group);
      if (onComplete) onComplete();
    }
  }
  requestAnimationFrame(animStep);
}

function _playDeathAnimation(pieceData, isPawn, onComplete) {
  if (!pieceData) { if (onComplete) onComplete(); return; }
  const group = pieceData.group;

  // ── Pawn captured → praying animation ────────────────────
  if (isPawn) {
    const prayingCached = modelCache.get('praying');
    if (prayingCached && prayingCached.animations.length > 0) {
      const prayScene = prayingCached.scene.clone(true);
      const scale = autoScales['p'] ?? 0.20;
      prayScene.scale.setScalar(scale);
      const pb = new THREE.Box3().setFromObject(prayScene);
      const pc = pb.getCenter(new THREE.Vector3());
      prayScene.position.set(group.position.x - pc.x, pb.min.y < 0 ? -pb.min.y : 0, group.position.z - pc.z);
      // Match facing direction of original piece
      prayScene.rotation.y = group.rotation.y;
      scene.add(prayScene);
      // Apply same team tint
      const color = pieceData.player === 'player1' ? PIECE_COLORS.player1 : PIECE_COLORS.player2;
      const tinted = _cloneModel(prayingCached, color);
      tinted.scale.setScalar(scale);
      tinted.position.copy(prayScene.position);
      tinted.rotation.y = prayScene.rotation.y;
      scene.remove(prayScene);
      scene.add(tinted);

      const mixer = new THREE.AnimationMixer(tinted);
      const clip  = prayingCached.animations[0];
      const action = mixer.clipAction(clip);
      action.clampWhenFinished = true;
      action.loop = THREE.LoopOnce;
      action.play();
      animMixers.push(mixer);

      // Fade out original group immediately
      group.visible = false;
      // Remove praying model after clip duration + small buffer
      const clipDuration = (clip.duration + 0.3) * 1000;
      setTimeout(() => {
        scene.remove(tinted);
        animMixers.splice(animMixers.indexOf(mixer), 1);
        if (onComplete) onComplete();
      }, Math.min(clipDuration, 2500));
      return;
    }
  }

  // ── Non-pawn / fallback: explosion + tip-and-fade ─────────
  if (explosionTemplate) {
    const expScene = explosionTemplate.scene.clone(true);
    expScene.position.copy(group.position);
    expScene.scale.setScalar(0.5);
    explosionGroup.add(expScene);
    if (explosionTemplate.animations.length > 0) {
      const mixer = new THREE.AnimationMixer(expScene);
      const action = mixer.clipAction(explosionTemplate.animations[0]);
      action.clampWhenFinished = true; action.loop = THREE.LoopOnce; action.play();
      animMixers.push(mixer);
    }
    setTimeout(() => explosionGroup.remove(expScene), 1000);
  }

  const startTime = performance.now();
  (function fall(now) {
    const t = Math.min((now - startTime) / 500, 1);
    group.rotation.x = t * Math.PI / 2;
    group.position.y  = -t * 0.3;
    const mats = [];
    group.traverse(c => { if (c.isMesh && c.material) mats.push(c.material); });
    mats.forEach(m => { m.transparent = true; m.opacity = 1 - t; });
    if (t < 1) requestAnimationFrame(fall);
    else if (onComplete) onComplete();
  })(startTime);
}

function _playVictoryAnimations(outcome) {
  if (outcome !== 'checkmate' && outcome !== 'blitz' && outcome !== 'pyrrhic') return;
  for (const [sq, data] of pieceObjects.entries()) {
    if (data.pieceType === 'k') {
      const mixer = data.group.userData?.mixer;
      if (mixer && data.group.userData?.clips) {
        const vic = THREE.AnimationClip.findByName(data.group.userData.clips, 'victory');
        if (vic) mixer.clipAction(vic).play();
      }
    }
  }
}

// ── Chess clock ───────────────────────────────────────────
function _initTimer(seconds) {
  if (!seconds) return;
  _timerWhite  = seconds;
  _timerBlack  = seconds;
  _timerActive = 'white'; // white (attacker) moves first
  _timerLast   = Date.now();
  const sec = document.getElementById('timer-section');
  if (sec) sec.style.display = '';
  _renderTimers();
  _timerIv = setInterval(_tickTimer, 100);
}

function _tickTimer() {
  if (!_timerActive || !_running) return;
  const now     = Date.now();
  const elapsed = (now - _timerLast) / 1000;
  _timerLast = now;
  if (_timerActive === 'white') { _timerWhite -= elapsed; if (_timerWhite <= 0) { _timerWhite = 0; _flagTimer('white'); } }
  else                          { _timerBlack -= elapsed; if (_timerBlack <= 0) { _timerBlack = 0; _flagTimer('black'); } }
  _renderTimers();
}

function _switchTimer(fenAfterMove) {
  // fenAfterMove: the FEN string AFTER the move — active colour is who moves NEXT
  if (!_timerActive || !_timerIv) return;
  const next = fenAfterMove.split(' ')[1]; // 'w' or 'b'
  _timerActive = next === 'w' ? 'white' : 'black';
  _timerLast   = Date.now();
  _renderTimers();
}

function _flagTimer(color) {
  clearInterval(_timerIv); _timerIv = null; _timerActive = null;
  // Only the flagged player emits — avoids double-fire from both clients
  const iAmWhite = myRoleLocal === battleDataLocal?.attacker;
  const iAmFlagged = (color === 'white' && iAmWhite) || (color === 'black' && !iAmWhite);
  if (iAmFlagged && socketLocal) socketLocal.emit('battle_resign');
}

function _renderTimers() {
  const wEl = document.getElementById('timer-white');
  const bEl = document.getElementById('timer-black');
  if (!wEl || !bEl) return;
  wEl.textContent = _fmtTime(_timerWhite);
  bEl.textContent = _fmtTime(_timerBlack);
  wEl.className = 'timer-clock' + (_timerActive === 'white' ? ' active' : '') + (_timerWhite <= 30 ? ' danger' : '');
  bEl.className = 'timer-clock' + (_timerActive === 'black' ? ' active' : '') + (_timerBlack <= 30 ? ' danger' : '');
}

function _fmtTime(s) {
  const t = Math.max(0, s);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function _stopTimer() {
  if (_timerIv) { clearInterval(_timerIv); _timerIv = null; }
  _timerActive = null;
}

// ── Resize ────────────────────────────────────────────────
function _onResize(canvas) {
  if (!renderer) return;
  const w = canvas.offsetWidth  || window.innerWidth;
  const h = canvas.offsetHeight || window.innerHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Render loop ───────────────────────────────────────────
function _animate() {
  if (!_running || !renderer) return;
  requestAnimationFrame(_animate);
  const delta = clock.getDelta();
  for (const mixer of animMixers) mixer.update(delta);
  // Animate highlights
  const t = performance.now() / 1000;
  highlightGroup.children.forEach(h => {
    if (h.userData.isSelectionRing) {
      // Cyan selection ring: fast pulse
      h.material.opacity = 0.7 + 0.3 * Math.sin(t * 8);
      const s = 1 + 0.04 * Math.sin(t * 8);
      h.scale.setScalar(s);
    } else if (h.userData.isSelectionGlow) {
      h.material.opacity = 0.12 + 0.10 * Math.sin(t * 8);
    } else if (h.userData.type === 'highlight') {
      // Move dots and overlays: gentle breathing
      h.material.opacity = (h.geometry.type === 'CircleGeometry')
        ? 0.55 + 0.20 * Math.sin(t * 4)   // dot
        : 0.12 + 0.08 * Math.sin(t * 4);  // square overlay
    }
  });
  // Animate hover glimmer — shimmer wave
  if (hoverGroup.children.length > 0) {
    const wave = 0.5 + 0.5 * Math.sin(t * 6);
    hoverGroup.children.forEach((m, i) => {
      if (i === 0) m.material.opacity = 0.08 + 0.10 * wave; // glow disc
      if (i === 1) m.material.opacity = 0.55 + 0.35 * wave; // sharp ring
    });
  }
  if (controls) controls.update();
  renderer.render(scene, camera);
}
