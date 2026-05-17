// ============================================================
// strategy.js — World map turn logic (client-side helpers)
// All actual state changes go through the server via socket.
// This module handles local UI state for the strategic layer.
// ============================================================

// ── Selected army tracking ─────────────────────────────────
let _selectedArmyFrom = null;

export function getSelectedArmy() { return _selectedArmyFrom; }
export function setSelectedArmy(id) { _selectedArmyFrom = id; }
export function clearSelectedArmy() { _selectedArmyFrom = null; }

// ── Income preview ─────────────────────────────────────────
export function previewIncome(state, playerId) {
  const player = state.players[playerId];
  const territories = state.territories.filter(t => t.owner === playerId);
  const preview = { gold: 0, iron: 0, grain: 0, glory: 0 };

  for (const t of territories) {
    const mult = t.damagedTurns > 0 ? 0.5 : 1;
    for (const [res, amt] of Object.entries(t.resourceOutput)) {
      preview[res] = (preview[res] || 0) + Math.floor(amt * mult);
    }
  }

  // Black market bonus
  if (player.armyUpgrades.includes('merchant_guilds')) {
    const cities = territories.filter(t => t.terrain === 'city' || t.terrain === 'capital');
    preview.gold += cities.length;
  }

  return preview;
}

// ── Territory control stats ────────────────────────────────
export function getControlStats(state) {
  const total = state.territories.length;
  const p1 = state.territories.filter(t => t.owner === 'player1').length;
  const p2 = state.territories.filter(t => t.owner === 'player2').length;
  const neutral = total - p1 - p2;
  return { total, p1, p2, neutral, p1pct: p1/total, p2pct: p2/total };
}

// ── Can attack capital? ────────────────────────────────────
export function canAttackCapital(state, attackerId, capitalId) {
  const opponent = attackerId === 'player1' ? 'player2' : 'player1';
  const opponentHomeIds = attackerId === 'player1'
    ? ['cairo', 'riyadh', 'tunis']
    : ['london', 'birmingham', 'edinburgh'];

  const captured = opponentHomeIds.filter(id => {
    const t = state.territories.find(t => t.id === id);
    return t && t.owner !== opponent;
  });

  return captured.length >= 2;
}
