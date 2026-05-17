// ============================================================
// main.js — Entry point: socket connection, screen routing
// ============================================================
import { initGlobe, updateGlobe, selectTerritory, onGlobeVisible,
         highlightTerritories, clearHighlightRings } from './globe.js';
import { initBattle, destroyBattle } from './battle.js';
import { initUI, updateHUD, showModal, hideModal, showBattleBriefing,
         showResultModal, showUpgradeShop, populateMoveLog, updateLosses,
         updateUpgradeBadges, updatePhaseIndicator, showGameOver } from './ui.js';
import { loadingShow, loadingProgress, loadingHide } from './loader.js';
import { PLAYER_NAMES } from './config.js';

// ── Server URL ───────────────────────────────────────────
// When served via ngrok/production the frontend is on the same origin as the server
const SERVER_URL = window.CONQUEST_SERVER || window.location.origin;

// ── State ────────────────────────────────────────────────
export let myRole = null;       // 'player1' | 'player2'
export let gameState = null;    // latest full server state
export let socket = null;

// Synchronous move buffer — captures battle_move_made events that arrive while
// models are still loading, so initChess can drain them after registration.
let _battleMoveBuf = [];
let _capturingMoves = false;

// Phase interaction mode
// null | 'move-select' | 'move-dest' | 'attack-dest'
let phaseMode = null;
let selectedArmyTerritory = null;

// ── Screen management ────────────────────────────────────
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Socket setup ─────────────────────────────────────────
function connectSocket() {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('Connected to server');
    loadingHide(); // server reachable → show lobby
  });
  socket.on('connect_error', (e) => {
    console.error('Connection failed:', e.message);
    loadingShow('Cannot reach server', 0, 'Make sure the server is running on :3000');
    document.getElementById('join-status').textContent = '⚠ Cannot reach server — is it running?';
    document.getElementById('join-status').classList.remove('hidden');
  });

  socket.on('room_created', ({ roomId, role, timerSeconds }) => {
    myRole = role;
    document.getElementById('room-code-text').textContent = roomId;
    document.getElementById('room-display').classList.remove('hidden');
    const timerLabel = timerSeconds > 0 ? ` · ${timerSeconds / 60}min clock` : ' · No timer';
    document.getElementById('waiting-msg').textContent = 'Waiting for opponent' + timerLabel;
  });

  socket.on('room_joined', ({ role }) => {
    myRole = role;
    const status = document.getElementById('join-status');
    status.textContent = 'Joined! Starting game...';
    status.classList.remove('hidden');
    loadingShow('Loading world map...', 20, 'Fetching Earth texture');
  });

  socket.on('game_start', (state) => {
    gameState = state;
    loadingShow('Deploying forces...', 60, 'Building globe');
    showScreen('world-screen');
    requestAnimationFrame(() => {
      onGlobeVisible(document.getElementById('globe-canvas'));
      updateHUD(state, myRole);
      updateGlobe(state, myRole);
      loadingHide();
    });
  });

  socket.on('state_update', (state) => {
    gameState = state;
    cancelPhaseMode();
    updateHUD(state, myRole);
    updateGlobe(state, myRole);
    if (state.phase === 'battle' && state.currentBattle) {
      updateLosses(state, myRole);
      updateUpgradeBadges(state, myRole);
    }
  });

  let _pendingBattleData = null;

  socket.on('battle_start', (data) => {
    gameState = data.state;
    _pendingBattleData = data;
    showBattleBriefing(data, myRole, () => {
      socket.emit('battle_player_ready');
      const timerLabel = data.timerSeconds > 0 ? `${data.timerSeconds / 60} min per player` : 'No time limit';
      loadingShow('Entering battle...', 40, timerLabel);
    });
  });

  socket.on('battle_begin', (data) => {
    if (_pendingBattleData) data = Object.assign({}, _pendingBattleData, data);
    _pendingBattleData = null;
    gameState = data.state;
    showScreen('battle-screen');
    loadingShow('Loading battlefield...', 50, 'Initialising 3D engine');
    // Start capturing move events synchronously NOW — before any async work begins.
    // This guarantees no battle_move_made event is lost during model loading.
    _capturingMoves = true;
    _battleMoveBuf = [];
    requestAnimationFrame(async () => {
      await initBattle(data, myRole, socket, _battleMoveBuf);
      // initChess has registered its listener and drained _battleMoveBuf — stop capturing
      _capturingMoves = false;
      _battleMoveBuf = [];
      updateLosses(gameState, myRole);
      loadingHide();
    });
  });

  socket.on('battle_move_made', ({ move, role, state }) => {
    gameState = state;
    // Synchronously buffer moves that arrive before initChess registers its listener
    if (_capturingMoves) _battleMoveBuf.push({ move, role, state });
  });

  socket.on('battle_over', (data) => {
    gameState = data.state;
    _capturingMoves = false;
    _battleMoveBuf = [];
    destroyBattle();
    showScreen('world-screen');
    updateHUD(data.state, myRole);
    updateGlobe(data.state, myRole);
    showResultModal(data, myRole);
  });

  socket.on('strategic_turn', ({ state }) => {
    gameState = state;
    updateHUD(state, myRole);
    updateGlobe(state, myRole);
    const isMyTurn = state.currentPlayer === myRole;
    updatePhaseIndicator(isMyTurn, state.turnActionsUsed);
  });

  socket.on('game_over', ({ winner, state }) => {
    gameState = state;
    showGameOver(winner, myRole);
  });

  socket.on('opponent_disconnected', () => {
    alert('Your opponent disconnected. The game has ended.');
    location.reload();
  });

  socket.on('action_error', ({ message }) => {
    showToast(message, 'danger');
  });

  socket.on('error', ({ message }) => {
    showToast(message, 'danger');
  });
}

// ── Toast notifications ──────────────────────────────────
export function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    background:var(--surface); border:1px solid var(--border2);
    border-radius:6px; padding:10px 20px; font-size:13px; font-weight:600;
    z-index:9999; color:var(--text); pointer-events:none;
    animation: fadeInUp .2s ease;
  `;
  if (type === 'danger')  el.style.borderColor = 'var(--p2)';
  if (type === 'success') el.style.borderColor = 'var(--success)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Lobby UI ─────────────────────────────────────────────
function initLobby() {
  document.getElementById('btn-create').addEventListener('click', () => {
    const timerSeconds = parseInt(document.getElementById('timer-select')?.value || '0', 10);
    socket.emit('create_room', { timerSeconds });
    document.getElementById('btn-create').disabled = true;
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('room-input').value.trim().toUpperCase();
    if (code.length < 4) { showToast('Enter a valid room code', 'danger'); return; }
    socket.emit('join_room', { roomId: code });
    document.getElementById('btn-join').disabled = true;
  });

  document.getElementById('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });
}

// ── Phase mode helpers ────────────────────────────────────
function enterMoveSelectMode() {
  if (!gameState || gameState.currentPlayer !== myRole) {
    showToast('Not your turn', 'danger'); return;
  }
  if (gameState.turnActionsUsed?.moved) {
    showToast('Already moved this turn', 'danger'); return;
  }
  const myArmies = gameState.players[myRole].armyTokens;
  if (myArmies.length === 0) { showToast('No armies to move', 'danger'); return; }

  phaseMode = 'move-select';
  selectedArmyTerritory = null;
  highlightTerritories(myArmies, 0x00ccff);
  showToast('Click your army to select it', 'info');
}

function enterAttackMode() {
  if (!gameState || gameState.currentPlayer !== myRole) {
    showToast('Not your turn', 'danger'); return;
  }
  if (gameState.turnActionsUsed?.attacked) {
    showToast('Already attacked this turn', 'danger'); return;
  }
  const myArmies = gameState.players[myRole].armyTokens;
  // Find all enemy/neutral territories adjacent to my armies
  const attackable = [];
  for (const armyTid of myArmies) {
    const t = gameState.territories.find(x => x.id === armyTid);
    if (!t) continue;
    for (const adjId of t.adjacentIds) {
      const adj = gameState.territories.find(x => x.id === adjId);
      if (adj && adj.owner !== myRole && adj.lockedTurns === 0) attackable.push(adjId);
    }
  }
  if (attackable.length === 0) {
    showToast('No territories in attack range — move your army first', 'danger'); return;
  }
  phaseMode = 'attack-dest';
  highlightTerritories(attackable, 0xff3300);
  showToast('Click a highlighted territory to attack', 'info');
}

function cancelPhaseMode() {
  phaseMode = null;
  selectedArmyTerritory = null;
  clearHighlightRings();
}

// ── Strategic turn actions ────────────────────────────────
function initStrategicActions() {
  // End turn button
  document.getElementById('btn-end-turn').addEventListener('click', () => {
    cancelPhaseMode();
    if (!gameState || gameState.currentPlayer !== myRole) {
      showToast('Not your turn', 'danger'); return;
    }
    socket.emit('strategic_action', { action: 'end_turn', payload: {} });
  });

  // Phase: Spend → upgrade shop
  document.getElementById('phase-spend').addEventListener('click', () => {
    if (!gameState || gameState.currentPlayer !== myRole) {
      showToast('Not your turn', 'danger'); return;
    }
    cancelPhaseMode();
    showUpgradeShop(gameState, myRole, (upgradeId) => {
      socket.emit('strategic_action', { action: 'buy_upgrade', payload: { upgradeId } });
    });
  });

  // Phase: Move Army
  document.getElementById('phase-move').addEventListener('click', () => {
    if (phaseMode === 'move-select' || phaseMode === 'move-dest') {
      cancelPhaseMode(); return;
    }
    enterMoveSelectMode();
  });

  // Phase: Attack
  document.getElementById('phase-attack').addEventListener('click', () => {
    if (phaseMode === 'attack-dest') {
      cancelPhaseMode(); return;
    }
    enterAttackMode();
  });

  // New game
  document.getElementById('btn-new-game').addEventListener('click', () => {
    location.reload();
  });

  // Resign from battle — show in-game modal instead of browser confirm()
  document.getElementById('btn-resign').addEventListener('click', () => {
    import('./ui.js').then(({ showModal }) => showModal('resign-condition-modal'));
  });

  // Resign condition buttons (exile / scorched / tribute all map to surrender)
  document.querySelectorAll('#resign-condition-modal [data-condition]').forEach(btn => {
    btn.addEventListener('click', () => {
      import('./ui.js').then(({ hideModal }) => hideModal());
      socket.emit('battle_resign');
    });
  });
  document.getElementById('resign-cancel').addEventListener('click', () => {
    import('./ui.js').then(({ hideModal }) => hideModal());
  });
}

// ── Territory panel action handler ─────────────────────────
export function handleTerritoryAction(action, territoryId, extra) {
  switch (action) {
    case 'move_army':
      socket.emit('strategic_action', {
        action: 'move_army',
        payload: { fromId: extra.fromId, toId: territoryId },
      });
      break;
    case 'declare_attack':
      socket.emit('strategic_action', {
        action: 'declare_attack',
        payload: { fromId: extra.fromId, targetId: territoryId },
      });
      break;
    case 'bribe':
      socket.emit('strategic_action', {
        action: 'bribe',
        payload: { territoryId },
      });
      break;
  }
}

// ── Init ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  connectSocket();
  initLobby();
  initStrategicActions();
  initUI(socket, handleTerritoryAction);
  initGlobe(document.getElementById('globe-canvas'), (territoryId) => {
    if (!gameState) return;

    // ── Mode-aware click handling ─────────────────────────
    if (phaseMode === 'move-select') {
      // Player clicked an army position
      const myArmies = gameState.players[myRole].armyTokens;
      if (myArmies.includes(territoryId)) {
        selectedArmyTerritory = territoryId;
        phaseMode = 'move-dest';
        // Highlight valid move destinations
        const t = gameState.territories.find(x => x.id === territoryId);
        const dests = t.adjacentIds.filter(adjId => {
          const adj = gameState.territories.find(x => x.id === adjId);
          return adj && adj.owner === myRole; // can only move into own territory
        });
        highlightTerritories(dests, 0x00ff88);
        showToast(`Army selected — click a destination`, 'info');
      } else {
        showToast('Select a territory with your army (blue rings)', 'danger');
      }
      return;
    }

    if (phaseMode === 'move-dest') {
      // Player clicked a destination
      socket.emit('strategic_action', {
        action: 'move_army',
        payload: { fromId: selectedArmyTerritory, toId: territoryId },
      });
      cancelPhaseMode();
      return;
    }

    if (phaseMode === 'attack-dest') {
      // Player clicked an attack target
      const t = gameState.territories.find(x => x.id === territoryId);
      if (!t || t.owner === myRole) {
        showToast('Select an enemy territory (red rings)', 'danger'); return;
      }
      // Find which army is adjacent
      const myArmies = gameState.players[myRole].armyTokens;
      const fromId = myArmies.find(tid => {
        const at = gameState.territories.find(x => x.id === tid);
        return at && at.adjacentIds.includes(territoryId);
      });
      if (!fromId) { showToast('No army in range', 'danger'); return; }
      socket.emit('strategic_action', {
        action: 'declare_attack',
        payload: { fromId, targetId: territoryId },
      });
      cancelPhaseMode();
      return;
    }

    // ── Default: show territory panel ────────────────────
    const t = gameState.territories.find(t => t.id === territoryId);
    if (t) {
      import('./ui.js').then(({ showTerritoryPanel }) => {
        showTerritoryPanel(t, gameState, myRole);
      });
    }
  });
});
