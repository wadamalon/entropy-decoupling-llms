// ============================================================
// globe.js — Three.js 3D globe with territory markers
// ============================================================
import * as THREE from 'three';
import { TERRITORIES_DATA, PIECE_COLORS } from './config.js';

// Callbacks injected by main.js at init time (no circular import)
let _onTerritoryClick = null;

// ── Module state ──────────────────────────────────────────
let renderer, scene, camera, globe, raycaster, mouse;
let globeGroup, markerGroup, armyGroup;
let isDragging = false, prevMouse = { x: 0, y: 0 };
let selectedTerritoryId = null;
let selectedArmyFrom = null;   // territory from which army is being moved
const GLOBE_R = 5;
const MARKER_H = 0.18;

// Map: territoryId → { marker, label }
const markers = new Map();
const armyTokens = new Map(); // playerId_territoryId → mesh

// ── Highlight overlays ────────────────────────────────────
const glowRings = new Map(); // territoryId → ring mesh

export function highlightTerritories(ids, colorHex = 0xffcc00) {
  clearHighlightRings();
  for (const id of ids) {
    const entry = markers.get(id);
    if (!entry) continue;
    // Ring disc around marker
    const geo = new THREE.CylinderGeometry(0.22, 0.22, 0.01, 24, 1, false);
    const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.copy(entry.pos.clone().add(entry.normal.clone().multiplyScalar(MARKER_H + 0.05)));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), entry.normal);
    ring.userData.isRing = true;
    ring.userData.type   = 'territory';
    ring.userData.id     = id;
    markerGroup.add(ring);
    glowRings.set(id, ring);
  }
}

export function clearHighlightRings() {
  for (const ring of glowRings.values()) markerGroup.remove(ring);
  glowRings.clear();
}

// ── Init ──────────────────────────────────────────────────
export function initGlobe(canvas, onTerritoryClickCb) {
  _onTerritoryClick = onTerritoryClickCb;

  // Canvas may be hidden (0×0) at init — use fallback dimensions
  const w = canvas.offsetWidth  || window.innerWidth;
  const h = canvas.offsetHeight || window.innerHeight;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080c0a);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(0, 0, 14);

  // Ambient + directional light (sunlight effect)
  scene.add(new THREE.AmbientLight(0x334433, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(10, 10, 10);
  scene.add(sun);

  // Subtle hemisphere light (sky/ground)
  scene.add(new THREE.HemisphereLight(0x223322, 0x111a11, 0.5));

  // Stars
  _buildStars();

  // Globe group — single parent so globe + markers rotate together
  globeGroup = new THREE.Group();
  globeGroup.rotation.y = -Math.PI / 2; // rotate so Europe/MENA faces forward
  scene.add(globeGroup);

  // Globe
  _buildGlobe();

  // Groups
  markerGroup = new THREE.Group();
  armyGroup = new THREE.Group();
  globeGroup.add(markerGroup, armyGroup);

  // Raycaster
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // Build static markers from TERRITORIES_DATA
  for (const t of TERRITORIES_DATA) {
    _addTerritoryMarker(t);
  }

  // Events
  _bindEvents(canvas);

  // Resize: observe the parent container, not the canvas itself
  window.addEventListener('resize', () => _onResize(canvas));

  // Render loop
  _animate();
}

// ── Globe geometry ─────────────────────────────────────────
function _buildGlobe() {
  const geo = new THREE.SphereGeometry(GLOBE_R, 64, 64);

  // Try to load Earth texture
  const loader = new THREE.TextureLoader();
  const tex = loader.load(
    'https://raw.githubusercontent.com/mrdoob/three.js/r158/examples/textures/planets/earth_atmos_2048.jpg',
    undefined,
    undefined,
    () => {
      // Fallback: procedural globe
      mat.color.setHex(0x1a2e1a);
    }
  );
  const bumpTex = loader.load(
    'https://raw.githubusercontent.com/mrdoob/three.js/r158/examples/textures/planets/earth_normal_2048.jpg'
  );
  const specTex = loader.load(
    'https://raw.githubusercontent.com/mrdoob/three.js/r158/examples/textures/planets/earth_specular_2048.jpg'
  );

  const mat = new THREE.MeshPhongMaterial({
    map: tex,
    bumpMap: bumpTex,
    bumpScale: 0.05,
    specularMap: specTex,
    specular: new THREE.Color(0x222233),
    shininess: 15,
  });

  globe = new THREE.Mesh(geo, mat);
  globeGroup.add(globe);

  // Atmosphere glow
  const atmGeo = new THREE.SphereGeometry(GLOBE_R * 1.02, 32, 32);
  const atmMat = new THREE.MeshPhongMaterial({
    color: 0x002200,
    transparent: true,
    opacity: 0.08,
    side: THREE.BackSide,
  });
  globeGroup.add(new THREE.Mesh(atmGeo, atmMat));
}

function _buildStars() {
  const count = 2000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 80 + Math.random() * 120;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x334455, size: 0.3 })));
}

// ── Territory markers ──────────────────────────────────────
function latLngToVec3(lat, lng, r) {
  const phi  = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  );
}

function _ownerColor(owner) {
  if (owner === 'player1') return 0x2E86AB;
  if (owner === 'player2') return 0xB03A2E;
  return 0x4a664a;
}

function _addTerritoryMarker(t) {
  const pos = latLngToVec3(t.lat, t.lng, GLOBE_R);
  const normal = pos.clone().normalize();

  // Cylinder pin
  const geo = new THREE.CylinderGeometry(0.08, 0.12, MARKER_H, 8);
  const mat = new THREE.MeshPhongMaterial({ color: _ownerColor(t.owner), emissive: _ownerColor(t.owner), emissiveIntensity: 0.3 });
  const mesh = new THREE.Mesh(geo, mat);

  // Position on globe surface
  mesh.position.copy(pos.clone().add(normal.clone().multiplyScalar(MARKER_H / 2)));

  // Orient cylinder to point outward
  const up = new THREE.Vector3(0, 1, 0);
  mesh.quaternion.setFromUnitVectors(up, normal);

  mesh.userData = { type: 'territory', id: t.id };
  mesh.name = `marker_${t.id}`;

  markerGroup.add(mesh);
  markers.set(t.id, { mesh, mat, pos, normal });
}

// ── Army tokens ────────────────────────────────────────────
function _addArmyToken(playerId, territoryId, pos, normal) {
  const key = `${playerId}_${territoryId}`;
  // Remove old token at same position
  const old = armyTokens.get(key);
  if (old) armyGroup.remove(old);

  const color = playerId === 'player1' ? 0x5aacdb : 0xd86050;
  const geo = new THREE.ConeGeometry(0.11, 0.22, 6);
  const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.5 });
  const mesh = new THREE.Mesh(geo, mat);

  // Offset slightly from marker
  const offset = normal.clone().multiplyScalar(MARKER_H + 0.2);
  mesh.position.copy(pos.clone().add(offset));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  mesh.userData = { type: 'army', playerId, territoryId };

  armyGroup.add(mesh);
  armyTokens.set(key, mesh);
  return mesh;
}

function _clearArmyTokens() {
  while (armyGroup.children.length) armyGroup.remove(armyGroup.children[0]);
  armyTokens.clear();
}

// ── Update from server state ──────────────────────────────
export function updateGlobe(state, myRoleLocal) {
  // Update marker colors
  for (const t of state.territories) {
    const entry = markers.get(t.id);
    if (!entry) continue;
    const color = _ownerColor(t.owner);
    entry.mat.color.setHex(color);
    entry.mat.emissive.setHex(color);
    // Pulse locked territories
    entry.mat.emissiveIntensity = t.lockedTurns > 0 ? 0 : 0.3;
  }

  // Rebuild army tokens
  _clearArmyTokens();
  for (const pid of ['player1', 'player2']) {
    for (const tid of state.players[pid].armyTokens) {
      const entry = markers.get(tid);
      if (entry) _addArmyToken(pid, tid, entry.pos, entry.normal);
    }
  }

  // Highlight if it's my turn
  const myTurn = state.currentPlayer === myRoleLocal;
  document.getElementById('btn-end-turn').style.opacity = myTurn ? '1' : '0.4';
  if (myTurn) {
    const pp = myRoleLocal === 'player1' ? document.getElementById('p1-panel') : document.getElementById('p2-panel');
    pp.classList.add('your-turn-glow');
    const other = myRoleLocal === 'player1' ? document.getElementById('p2-panel') : document.getElementById('p1-panel');
    other.classList.remove('your-turn-glow');
  }
}

export function selectTerritory(id) {
  selectedTerritoryId = id;
  _highlightSelected(id);
}

function _highlightSelected(id) {
  for (const [tid, { mat }] of markers.entries()) {
    mat.emissiveIntensity = tid === id ? 1.2 : 0.3;
  }
}

// ── Events ────────────────────────────────────────────────
function _bindEvents(canvas) {
  canvas.addEventListener('mousedown', (e) => {
    isDragging = false;
    prevMouse = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('mousemove', (e) => {
    if (e.buttons === 1) {
      const dx = e.clientX - prevMouse.x;
      const dy = e.clientY - prevMouse.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        isDragging = true;
        globeGroup.rotation.y += dx * 0.005;
        globeGroup.rotation.x = Math.max(-0.7, Math.min(0.7, globeGroup.rotation.x + dy * 0.005));
        prevMouse = { x: e.clientX, y: e.clientY };
      }
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!isDragging) _onClick(e, canvas);
  });

  canvas.addEventListener('wheel', (e) => {
    camera.position.z = Math.max(7, Math.min(22, camera.position.z + e.deltaY * 0.01));
  });
}

function _onClick(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  // Check all markerGroup children (markers + rings) — first hit with a territory id wins
  const hits = raycaster.intersectObjects(markerGroup.children, true);
  for (const hit of hits) {
    // Walk up to find an object with userData.type === 'territory'
    let obj = hit.object;
    while (obj) {
      if (obj.userData?.type === 'territory' && obj.userData?.id) {
        _handleTerritoryClick(obj.userData.id);
        return;
      }
      obj = obj.parent;
    }
  }
}

function _handleTerritoryClick(id) {
  selectTerritory(id);
  if (_onTerritoryClick) _onTerritoryClick(id);
}

// ── Resize ────────────────────────────────────────────────
function _onResize(canvas) {
  const w = canvas.offsetWidth  || window.innerWidth;
  const h = canvas.offsetHeight || window.innerHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Called by main.js when world-screen becomes visible
export function onGlobeVisible(canvas) {
  _onResize(canvas);
}

// ── Render loop ───────────────────────────────────────────
function _animate() {
  requestAnimationFrame(_animate);
  // Slow auto-rotation when idle
  if (!isDragging) {
    globeGroup.rotation.y += 0.0003;
  }
  // Pulse highlight rings
  if (glowRings.size > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
    for (const ring of glowRings.values()) {
      ring.material.opacity = 0.4 + 0.4 * pulse;
      const s = 0.95 + 0.1 * pulse;
      ring.scale.setScalar(s);
    }
  }
  renderer.render(scene, camera);
}
