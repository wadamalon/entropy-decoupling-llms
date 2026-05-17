// ============================================================
// ui.js — All HUD elements and modals
// ============================================================
import { PLAYER_NAMES, PIECE_NAMES, PLAYER_ACCENT } from './config.js';
import { getUpgradesWithStatus, formatCost, getActiveEffectLabels, UPGRADE_GROUPS } from './upgrades.js';

// Injected by main.js to avoid circular imports
let _handleTerritoryAction = null;

const TERRAIN_ICONS = {
  capital:'🏛', plains:'🌾', mine:'⛏', city:'🏙', temple:'⛩',
  port:'⚓', fortress:'🏰', mountain:'⛰', forest:'🌲', coast:'⛵', swamp:'🌿',
};
const RESOURCE_ICONS = { gold:'◈', iron:'⬡', grain:'⬢', glory:'✦' };
const PIECE_UNICODE = { p:'♟', n:'♞', b:'♝', r:'♜', q:'♛', k:'♚' };

let _socket = null;

export function initUI(socket, territoryActionHandler) {
  _socket = socket;
  _handleTerritoryAction = territoryActionHandler;
}

// ── HUD update ────────────────────────────────────────────
export function updateHUD(state, myRole) {
  // Store on window for chess.js access
  window.__conquestGameState = state;

  const p1 = state.players.player1;
  const p2 = state.players.player2;

  // Resources
  _setRes('p1', p1.resources);
  _setRes('p2', p2.resources);

  // Turn info
  document.getElementById('turn-number').textContent = state.turnNumber;
  const activeName = state.currentPlayer === 'player1'
    ? PLAYER_NAMES.player1.split(' ')[0]
    : PLAYER_NAMES.player2.split(' ')[0];
  document.getElementById('active-player-label').textContent = activeName;

  // Highlight active player panel
  const p1Panel = document.getElementById('p1-panel');
  const p2Panel = document.getElementById('p2-panel');
  p1Panel.classList.toggle('active', state.currentPlayer === 'player1');
  p2Panel.classList.toggle('active', state.currentPlayer === 'player2');

  // Enable/disable controls
  const myTurn = state.currentPlayer === myRole;
  document.getElementById('btn-end-turn').disabled = !myTurn || state.phase === 'battle';

  updatePhaseIndicator(myTurn, state.turnActionsUsed);
}

function _setRes(prefix, res) {
  document.getElementById(`${prefix}-gold`).textContent  = res.gold  || 0;
  document.getElementById(`${prefix}-iron`).textContent  = res.iron  || 0;
  document.getElementById(`${prefix}-grain`).textContent = res.grain || 0;
  document.getElementById(`${prefix}-glory`).textContent = res.glory || 0;
}

export function updatePhaseIndicator(myTurn, actionsUsed) {
  const ids = ['collect', 'spend', 'move', 'attack'];
  ids.forEach(s => {
    const el = document.getElementById(`phase-${s}`);
    if (!el) return;
    el.classList.remove('done', 'active');
    el.disabled = true;
  });

  // Turn banner
  const banner = document.getElementById('turn-banner');
  if (banner) {
    banner.textContent = myTurn ? '⚡ YOUR TURN' : '⏳ OPPONENT\'S TURN';
    banner.className = myTurn ? 'your-turn' : 'their-turn';
  }

  if (!myTurn) return;

  // Collect: always done (auto at turn start)
  document.getElementById('phase-collect').classList.add('done');

  // Spend: always available on your turn
  const spendEl = document.getElementById('phase-spend');
  spendEl.classList.add(actionsUsed ? 'done' : 'active');
  spendEl.disabled = false;

  // Move
  const moveEl = document.getElementById('phase-move');
  if (actionsUsed?.moved) {
    moveEl.classList.add('done');
  } else {
    moveEl.classList.add('active');
    moveEl.disabled = false;
  }

  // Attack
  const attackEl = document.getElementById('phase-attack');
  if (actionsUsed?.attacked) {
    attackEl.classList.add('done');
  } else if (actionsUsed?.moved) {
    attackEl.classList.add('active');
    attackEl.disabled = false;
  } else {
    // Can attack without moving if army is already adjacent
    attackEl.disabled = false;
  }
}

// ── Territory panel ───────────────────────────────────────
export function showTerritoryPanel(territory, state, myRole) {
  const panel = document.getElementById('territory-panel');
  panel.classList.add('visible');

  document.getElementById('tp-name').textContent = territory.name;
  document.getElementById('tp-terrain').textContent =
    `${TERRAIN_ICONS[territory.terrain] || ''} ${territory.terrain.toUpperCase()}`;

  const ownerEl = document.getElementById('tp-owner');
  ownerEl.textContent = territory.owner === 'neutral'
    ? 'Neutral'
    : (territory.owner === 'player1' ? PLAYER_NAMES.player1 : PLAYER_NAMES.player2);
  ownerEl.className = `territory-owner ${territory.owner}`;

  // Modifier
  const modEl = document.getElementById('tp-modifier');
  if (territory.chessModifier) {
    modEl.textContent = territory.chessModifier.description;
    modEl.classList.remove('hidden');
  } else {
    modEl.classList.add('hidden');
  }

  // Income
  const income = Object.entries(territory.resourceOutput)
    .map(([r, a]) => `${RESOURCE_ICONS[r]}${a}`).join(' ');
  document.getElementById('tp-income').textContent = income || '—';

  // Status flags
  let statusParts = [];
  if (territory.lockedTurns > 0) statusParts.push(`🔒 Locked ${territory.lockedTurns}t`);
  if (territory.damagedTurns > 0) statusParts.push(`⚠ Damaged ${territory.damagedTurns}t`);
  if (territory.bufferTurns > 0)  statusParts.push(`⏳ Buffer ${territory.bufferTurns}t`);

  // Adjacent
  const adjNames = territory.adjacentIds.map(id => {
    const t = state.territories.find(x => x.id === id);
    return t ? t.name : id;
  }).join(', ');
  document.getElementById('tp-adjacent').textContent = adjNames || '—';

  // Actions
  _buildTerritoryActions(territory, state, myRole);
}

function _buildTerritoryActions(territory, state, myRole) {
  const container = document.getElementById('tp-actions');
  container.innerHTML = '';

  if (state.currentPlayer !== myRole || state.phase === 'battle') return;

  const player = state.players[myRole];
  const myArmyAt = player.armyTokens;
  const actionsUsed = state.turnActionsUsed;

  // Move army button: show if player has an army adjacent to this territory
  if (!actionsUsed.moved) {
    const adjacentArmy = myArmyAt.find(tid => territory.adjacentIds.includes(tid));
    const onTerritory = myArmyAt.includes(territory.id);
    if (adjacentArmy && !onTerritory && territory.owner === myRole) {
      const btn = _btn('↗ Move Army Here', 'btn-primary btn-sm', () => {
        _handleTerritoryAction('move_army', territory.id, { fromId: adjacentArmy });
      });
      container.appendChild(btn);
    }
  }

  // Attack button: show if adjacent army and territory is enemy/neutral
  if (!actionsUsed.attacked && territory.owner !== myRole && territory.lockedTurns === 0) {
    const adjacentArmy = myArmyAt.find(tid => territory.adjacentIds.includes(tid));
    if (adjacentArmy) {
      const btn = _btn('⚔ Attack', 'btn-danger btn-sm', () => {
        _handleTerritoryAction('declare_attack', territory.id, { fromId: adjacentArmy });
      });
      container.appendChild(btn);
    }
  }

  // Bribe button: show if neutral and adjacent
  if (territory.owner === 'neutral' && territory.lockedTurns === 0) {
    const myTerritories = state.territories.filter(t => t.owner === myRole);
    const adjacent = myTerritories.some(t => t.adjacentIds.includes(territory.id));
    if (adjacent && player.resources.gold >= 4) {
      const btn = _btn('💰 Bribe (4◈)', 'btn-warning btn-sm', () => {
        _handleTerritoryAction('bribe', territory.id, {});
      });
      container.appendChild(btn);
    }
  }
}

function _btn(text, classes, handler) {
  const b = document.createElement('button');
  b.className = `btn ${classes}`;
  b.innerHTML = text;
  b.addEventListener('click', handler);
  return b;
}

// ── Battle HUD ────────────────────────────────────────────
export function updateLosses(state, myRole) {
  _renderLosses('p1-losses', state.players.player1.lostPieces);
  _renderLosses('p2-losses', state.players.player2.lostPieces);
}

function _renderLosses(containerId, lost) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (const p of lost) {
    const el = document.createElement('div');
    el.className = 'piece-ghost';
    el.textContent = PIECE_UNICODE[p] || p;
    el.title = PIECE_NAMES[p] || p;
    container.appendChild(el);
  }
  if (lost.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">None</span>';
  }
}

export function updateUpgradeBadges(state, myRole) {
  const container = document.getElementById('active-upgrades-list');
  if (!container) return;
  container.innerHTML = '';

  for (const pid of ['player1', 'player2']) {
    const player = state.players[pid];
    const labels = getActiveEffectLabels(player);
    if (labels.length === 0) continue;

    const header = document.createElement('div');
    header.style.cssText = 'font-size:10px;letter-spacing:1px;color:var(--text-muted);text-transform:uppercase;margin-top:4px;';
    header.textContent = pid === 'player1' ? PLAYER_NAMES.player1 : PLAYER_NAMES.player2;
    container.appendChild(header);

    for (const { name } of labels) {
      const el = document.createElement('div');
      el.className = 'upgrade-badge';
      el.textContent = name;
      container.appendChild(el);
    }
  }
  if (container.children.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">No active systems</span>';
  }
}

// ── Move log ──────────────────────────────────────────────
export function addMoveLogEntry(text, role, moveNum) {
  const log = document.getElementById('move-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'move-log-entry';
  const numSpan = `<span class="move-num">${Math.ceil(moveNum/2)}.</span>`;
  const moveClass = role === 'player1' ? 'move-p1' : 'move-p2';
  el.innerHTML = `${numSpan}<span class="${moveClass}">${text}</span>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  // Keep last 20 entries
  while (log.children.length > 20) log.removeChild(log.firstChild);
}

export function populateMoveLog(history) {
  const log = document.getElementById('move-log');
  if (!log) return;
  log.innerHTML = '';
  history.forEach((m, i) => addMoveLogEntry(m.text, m.role, i + 1));
}

// ── Modals ────────────────────────────────────────────────
function _openModal(id) {
  document.getElementById('modal-overlay').classList.add('active');
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function _closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}

export function showModal(id) { _openModal(id); }
export function hideModal()   { _closeModal(); }

// ── Pre-battle briefing ────────────────────────────────────
export function showBattleBriefing(data, myRole, onConfirm) {
  const t = data.territory;
  document.getElementById('pb-territory-desc').textContent =
    `Deploying forces to ${t.name} — ${(TERRAIN_ICONS[t.terrain]||'')} ${t.terrain}`;

  const modBox = document.getElementById('pb-modifier-box');
  if (t.chessModifier) {
    modBox.textContent = '⚠ ' + t.chessModifier.description;
    modBox.classList.remove('hidden');
  } else {
    modBox.classList.add('hidden');
  }

  // Missing pieces
  const state = data.state;
  _fillMissingPieces('pb-p1-missing', state.players.player1.lostPieces);
  _fillMissingPieces('pb-p2-missing', state.players.player2.lostPieces);

  // Intel reveal (War Council)
  if (data.revealedPieces?.length > 0) {
    const intelDiv = document.getElementById('pb-intel');
    intelDiv.classList.remove('hidden');
    document.getElementById('pb-intel-content').textContent =
      'Enemy missing: ' + data.revealedPieces.map(p => PIECE_NAMES[p]).join(', ');
  }

  document.getElementById('pb-confirm').onclick = () => {
    _closeModal();
    onConfirm();
  };
  _openModal('prebattle-modal');
}

function _fillMissingPieces(containerId, lostPieces) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (lostPieces.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">Full strength</span>';
    return;
  }
  for (const p of lostPieces) {
    const el = document.createElement('div');
    el.className = 'piece-ghost';
    el.textContent = PIECE_UNICODE[p] || p;
    el.title = PIECE_NAMES[p] || p;
    container.appendChild(el);
  }
}

// ── Promotion modal ────────────────────────────────────────
export function showPromotionModal(onPick) {
  _openModal('promo-modal');
  document.querySelectorAll('.promo-pick').forEach(el => {
    el.onclick = () => {
      _closeModal();
      onPick(el.dataset.promo);
    };
  });
}

// ── Battle result modal ────────────────────────────────────
export function showResultModal(data, myRole) {
  const isAttacker = data.attacker === myRole;
  const won = ['checkmate','blitz','pyrrhic','pawnPromoWin','kpEndgame'].includes(data.outcome) && isAttacker;
  const lost = ['checkmate','blitz','pyrrhic','pawnPromoWin','kpEndgame'].includes(data.outcome) && !isAttacker;
  const draw = ['stalemate','repetition'].includes(data.outcome);

  const banner = document.getElementById('result-banner');
  const LABELS = {
    checkmate:   'CHECKMATE',
    blitz:       'BLITZ VICTORY',
    pyrrhic:     'PYRRHIC VICTORY',
    pawnPromoWin:'FIELD PROMOTION WIN',
    stalemate:   'STALEMATE',
    repetition:  'DRAW',
    resignation: won ? 'ENEMY SURRENDERED' : 'SURRENDER',
    kpEndgame:   'CONTESTED GROUND',
  };
  banner.textContent = LABELS[data.outcome] || data.outcome.toUpperCase();
  banner.className = `outcome-banner ${won ? 'victory' : lost ? 'defeat' : 'stalemate'}`;

  // Consequences
  const list = document.getElementById('result-consequences');
  list.innerHTML = '';
  const consequences = _buildConsequences(data, myRole);
  for (const c of consequences) {
    const el = document.createElement('div');
    el.className = 'consequence-item';
    el.innerHTML = `<span class="icon">${c.icon}</span><span>${c.text}</span>`;
    list.appendChild(el);
  }

  document.getElementById('result-continue').onclick = _closeModal;
  _openModal('result-modal');
}

function _buildConsequences(data, myRole) {
  const cons = [];
  const isAttacker = data.attacker === myRole;
  const t = data.state?.territories?.find(t => t.id === data.territoryId);

  switch (data.outcome) {
    case 'checkmate':
    case 'blitz':
      if (isAttacker) {
        cons.push({ icon:'🏴', text:`${t?.name || 'Territory'} captured` });
        cons.push({ icon:'◈', text:`+2 Gold, +1 Glory earned` });
      } else {
        cons.push({ icon:'⚑', text:'Territory lost — regroup' });
        cons.push({ icon:'⏭', text:'Skip next strategic turn' });
      }
      if (data.outcome === 'blitz' && isAttacker) {
        cons.push({ icon:'✦', text:'+2 extra Glory — blitz victory!' });
      }
      break;
    case 'pyrrhic':
      if (isAttacker) {
        cons.push({ icon:'🏴', text:'Territory captured — at great cost' });
        cons.push({ icon:'✦', text:'+2 Glory' });
        cons.push({ icon:'🪖', text:'Extra Infantry unit lost' });
      }
      break;
    case 'stalemate':
      cons.push({ icon:'⏳', text:'Territory becomes neutral buffer (2 turns)' });
      cons.push({ icon:'⬢', text:'-1 Grain each' });
      break;
    case 'repetition':
      cons.push({ icon:'🔒', text:'Territory locked 3 turns' });
      cons.push({ icon:'🪖', text:'Both sides lose an army token' });
      break;
    case 'resignation':
      if (isAttacker) cons.push({ icon:'🏴', text:'Enemy surrendered — territory captured' });
      else cons.push({ icon:'⚑', text:'You surrendered the engagement' });
      break;
  }

  if (data.winner) {
    cons.push({ icon:'🏆', text:`${data.winner === myRole ? 'YOU WIN' : 'YOU LOSE'} THE CAMPAIGN` });
  }
  return cons;
}

// ── Upgrade shop ──────────────────────────────────────────
export function showUpgradeShop(state, myRole, onBuy) {
  const player = state.players[myRole];
  const allUpgrades = getUpgradesWithStatus(player);
  const grid = document.getElementById('upgrade-grid');
  grid.innerHTML = '';

  for (const group of UPGRADE_GROUPS) {
    const groupUpgrades = allUpgrades.filter(u => u.piece === group.piece);
    if (groupUpgrades.length === 0) continue;

    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;letter-spacing:2px;color:var(--text-muted);text-transform:uppercase;margin-top:8px;padding-bottom:4px;border-bottom:1px solid var(--border);';
    header.textContent = group.label;
    grid.appendChild(header);

    for (const upg of groupUpgrades) {
      const el = document.createElement('div');
      el.className = `upgrade-item${upg.owned ? ' owned' : ''}${(!upg.owned && !upg.affordable) ? ' unaffordable' : ''}`;

      el.innerHTML = `
        <div class="upgrade-item-info">
          <div class="upgrade-item-name">${upg.owned ? '✓ ' : ''}${upg.name}</div>
          <div class="upgrade-item-desc">${upg.desc}</div>
        </div>
        <div class="upgrade-item-cost">${formatCost(upg.cost)}</div>
      `;

      if (!upg.owned && upg.affordable) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          onBuy(upg.id);
          _closeModal();
        });
      }
      grid.appendChild(el);
    }
  }

  // Army upgrades section
  const armyUpgrades = allUpgrades.filter(u => u.category === 'army');
  if (armyUpgrades.length > 0) {
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;letter-spacing:2px;color:var(--text-muted);text-transform:uppercase;margin-top:8px;padding-bottom:4px;border-bottom:1px solid var(--border);';
    header.textContent = `🎖 Command Systems (${player.armyUpgrades.length}/3 active)`;
    grid.appendChild(header);

    for (const upg of armyUpgrades) {
      const el = document.createElement('div');
      el.className = `upgrade-item${upg.owned ? ' owned' : ''}${(!upg.owned && !upg.affordable) ? ' unaffordable' : ''}`;
      el.innerHTML = `
        <div class="upgrade-item-info">
          <div class="upgrade-item-name">${upg.owned ? '✓ ' : ''}${upg.name}</div>
          <div class="upgrade-item-desc">${upg.desc}</div>
        </div>
        <div class="upgrade-item-cost">${formatCost(upg.cost)}</div>
      `;
      if (!upg.owned && upg.affordable) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => { onBuy(upg.id); _closeModal(); });
      }
      grid.appendChild(el);
    }
  }

  document.getElementById('upgrade-close').onclick = _closeModal;
  _openModal('upgrade-modal');
}

// ── Game over ─────────────────────────────────────────────
export function showGameOver(winner, myRole) {
  const won = winner === myRole;
  const winnerName = winner === 'player1' ? PLAYER_NAMES.player1 : PLAYER_NAMES.player2;
  document.getElementById('gameover-winner').textContent = won ? '🏆 VICTORY' : '☠ DEFEAT';
  document.getElementById('gameover-winner').style.color = won ? 'var(--gold)' : 'var(--p2)';
  document.getElementById('gameover-subtitle').textContent =
    `${winnerName} wins the campaign!`;
  _openModal('gameover-modal');
}
