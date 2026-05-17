// ============================================================
// upgrades.js — Upgrade system: piece + army upgrades
// ============================================================
import { PIECE_UPGRADES_DATA, ARMY_UPGRADES_DATA, PIECE_NAMES } from './config.js';

// ── Check affordability ───────────────────────────────────
export function canAfford(resources, cost) {
  for (const [res, amt] of Object.entries(cost)) {
    if ((resources[res] || 0) < amt) return false;
  }
  return true;
}

// ── Get all upgrades for a player with affordability flags ─
export function getUpgradesWithStatus(player) {
  const result = [];

  for (const upg of PIECE_UPGRADES_DATA) {
    const owned = !!player.pieceUpgrades[upg.id];
    const affordable = canAfford(player.resources, upg.cost);
    result.push({
      ...upg,
      owned,
      affordable,
      category: 'piece',
      pieceName: PIECE_NAMES[upg.piece] || upg.piece.toUpperCase(),
    });
  }

  for (const upg of ARMY_UPGRADES_DATA) {
    const owned = player.armyUpgrades.includes(upg.id);
    const affordable = canAfford(player.resources, upg.cost);
    const atMax = player.armyUpgrades.length >= 3 && !owned;
    result.push({
      ...upg,
      owned,
      affordable: affordable && !atMax,
      category: 'army',
      pieceName: null,
    });
  }

  return result;
}

// ── Format cost as HTML pills ─────────────────────────────
export function formatCost(cost) {
  const icons = { gold: '◈', iron: '⬡', grain: '⬢', glory: '✦' };
  return Object.entries(cost)
    .map(([res, amt]) => `<span class="cost-pill ${res}">${icons[res]} ${amt}</span>`)
    .join(' ');
}

// ── Describe active upgrade effects for HUD ──────────────
export function getActiveEffectLabels(player) {
  const labels = [];

  // Piece upgrades
  for (const upg of PIECE_UPGRADES_DATA) {
    if (player.pieceUpgrades[upg.id]) {
      labels.push({ name: upg.name, type: 'piece', desc: upg.desc });
    }
  }

  // Army upgrades
  for (const upg of ARMY_UPGRADES_DATA) {
    if (player.armyUpgrades.includes(upg.id)) {
      labels.push({ name: upg.name, type: 'army', desc: upg.desc });
    }
  }

  // Special states
  if (player.queenReturning) {
    labels.push({ name: 'Droid Returning', type: 'special', desc: `Combat Droid returns in ${player.queenReturnTurns} turn(s)` });
  }
  if (player.legendaryKing) {
    labels.push({ name: 'Living Legend', type: 'special', desc: 'All units have bonus move active' });
  }

  return labels;
}

// ── Apply terrain modifier flags to battle state ──────────
export function applyTerrainToBattleState(modifier, battleState) {
  if (!modifier) return;

  switch (modifier.type) {
    case 'noCastling':
      battleState.noCastling = true;
      break;
    case 'slowPawns':
      battleState.slowPawns = true;
      battleState.slowPawnMoves = { player1: 0, player2: 0 };
      break;
    case 'knightBonus':
      battleState.knightBonusAvailable = true;
      break;
    case 'extraPawn':
      battleState.defenderExtraPawn = true;
      break;
  }
}

// ── Piece type groupings for the upgrade shop ─────────────
export const UPGRADE_GROUPS = [
  { label: '🪖 Infantry (Pawn)',     piece: 'p' },
  { label: '🚁 Drone (Knight)',      piece: 'n' },
  { label: '🎯 Sniper (Bishop)',     piece: 'b' },
  { label: '🪖 Tank (Rook)',         piece: 'r' },
  { label: '🤖 Combat Droid (Queen)',piece: 'q' },
  { label: '⭐ General (King)',       piece: 'k' },
];
