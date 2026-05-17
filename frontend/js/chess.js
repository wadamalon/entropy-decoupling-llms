// ============================================================
// chess.js — Chess.js integration: moves, validation, outcomes
// ============================================================
import { Chess } from 'chess.js';
import { PIECE_NAMES } from './config.js';

let game = null;
let myRoleLocal = null;
let socketLocal = null;
let battleDataLocal = null;
let callbacks = {};
let battleState = null;
let knightBonusUsed = {};
let _moveListener = null; // tracked so we can remove it between battles
let _pendingMoves = [];   // buffer for battle_move_made events arriving before initChess

// Call this from main.js as soon as the socket is ready, before models load
export function attachMoveBuffer(socket) {
  const buf = (data) => { if (!_moveListener) _pendingMoves.push(data); };
  socket.on('battle_move_made', buf);
  // Store so we can clean it up
  socket._chessBuf = buf;
}

export function detachMoveBuffer(socket) {
  if (socket._chessBuf) { socket.off('battle_move_made', socket._chessBuf); socket._chessBuf = null; }
  _pendingMoves = [];
}

// ── Init ──────────────────────────────────────────────────
export function initChess(battleData, myRole, socket, cbs, pendingMoves = []) {
  myRoleLocal    = myRole;
  socketLocal    = socket;
  battleDataLocal = battleData;
  callbacks      = cbs;

  battleState = {
    moveCount: 0,
    queenLostBefore15: false,
    kpEndgame: false,
    pawnPromoted: false,
    lostPieces: {
      [battleData.attacker]: [],
      [battleData.defender]: [],
    },
    knightBonusUsed:   { player1: false, player2: false },
    droneOverloadUsed: { player1: false, player2: false },
    royalEscapeUsed:   { player1: false, player2: false },
    darkNetworkUsed:   { player1: false, player2: false },
    ironCitadelUsed:   { player1: false, player2: false },
  };
  knightBonusUsed = { player1: false, player2: false };

  game = new Chess(battleData.fen);

  // Remove any stale listener from a previous battle before adding a new one
  if (_moveListener) {
    socket.off('battle_move_made', _moveListener);
    _moveListener = null;
  }

  _moveListener = ({ move, role, state: serverState }) => {
    if (role === myRole) return; // own move already applied locally
    if (!game) return;

    let result = game.move({
      from: move.from, to: move.to,
      promotion: move.promotion || 'q',
    });

    if (!result) {
      // Race condition: models loaded late, game state is behind the server.
      // Re-sync from the authoritative FEN carried in battle_move_made.
      const syncFen = serverState?.currentBattle?.fen;
      if (syncFen) {
        try { game.load(syncFen); } catch(e) { console.error('[chess] FEN sync failed:', e); return; }
        // After loading the post-move FEN the move is already applied;
        // fire callbacks with minimal info so the turn indicator & 3D board update.
        callbacks.onMove({
          from: move.from, to: move.to,
          captured: null, isPromotion: false, promotedTo: null,
          fen: game.fen(),
        });
      }
      return;
    }

    battleState.moveCount++;
    const capturedOwner = role === battleData.attacker ? battleData.defender : battleData.attacker;
    _trackCapture(result, capturedOwner);
    _trackKPEndgame();
    callbacks.onMove({
      from: move.from, to: move.to,
      captured: result.captured || null,
      isPromotion: result.flags.includes('p'),
      promotedTo: result.promotion || null,
      fen: game.fen(),
    });
    // Do NOT emit battle_fen_update here — only the player who made the move emits it
    _checkOutcome();
    _updateMoveLog(result, role);
  };
  socket.on('battle_move_made', _moveListener);

  // Drain any moves that arrived during model loading.
  // _pendingMoves = chess.js-internal buffer (legacy attachMoveBuffer path).
  // pendingMoves  = main.js synchronous buffer (the reliable path).
  // Combine both so we never miss a move regardless of which path caught it.
  const toReplay = [..._pendingMoves.splice(0), ...pendingMoves.splice(0)];
  // Deduplicate by move identity (same from+to can appear in both buffers)
  const seen = new Set();
  toReplay
    .filter(d => { const k = `${d.move?.from}${d.move?.to}${d.role}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .forEach(data => _moveListener(data));
}

export function destroyChess() {
  if (_moveListener && socketLocal) {
    socketLocal.off('battle_move_made', _moveListener);
    _moveListener = null;
  }
  game = null;
}

// ── Square selection → returns legal target squares ────────
export function selectSquare(sq) {
  if (!game) return null;
  const iAmWhite = myRoleLocal === battleDataLocal.attacker;
  const myColor  = iAmWhite ? 'w' : 'b';
  if (game.turn() !== myColor) return null;         // not my turn

  const piece = game.get(sq);
  if (!piece || piece.color !== myColor) return null; // not my piece

  const moves   = game.moves({ square: sq, verbose: true }).map(m => m.to);
  const specials = _getSpecialMoveTargets(sq, piece);
  return { moves: [...new Set([...moves, ...specials])] };
}

// ── Promotion check ────────────────────────────────────────
export function needsPromotion(from, to) {
  if (!game) return false;
  const piece = game.get(from);
  if (!piece || piece.type !== 'p') return false;
  const rank = parseInt(to[1]);
  return (piece.color === 'w' && rank === 8) || (piece.color === 'b' && rank === 1);
}

// ── Execute a move ────────────────────────────────────────
export function executeMove(from, to, promotion) {
  if (!game) return;

  if (typeof to === 'string' && to.startsWith('SPECIAL:')) {
    _executeSpecialMove(from, to); return;
  }

  const moveObj = { from, to };
  if (promotion) moveObj.promotion = promotion;

  const result = game.move(moveObj);
  if (!result) { console.warn('Illegal move rejected by Chess.js:', from, '→', to); return; }

  battleState.moveCount++;
  const myOpponent = myRoleLocal === battleDataLocal.attacker
    ? battleDataLocal.defender : battleDataLocal.attacker;
  _trackCapture(result, myOpponent);
  if (result.flags.includes('p')) battleState.pawnPromoted = true;
  _trackKPEndgame();

  callbacks.onMove({
    from, to,
    captured: result.captured || null,
    isPromotion: result.flags.includes('p'),
    promotedTo: result.promotion || null,
    fen: game.fen(),
  });

  // battle_move MUST be sent before battle_fen_update — both go over the same socket,
  // so the server processes them in this order. If fen_update arrives first, the server
  // flips active colour to the opponent, then rejects our battle_move as "not your turn".
  socketLocal.emit('battle_move', { from, to, promotion: promotion || null });
  _sendFenUpdate(result);
  _checkOutcome();
  _updateMoveLog(result, myRoleLocal);
}

// ── Special moves (upgrade abilities) ─────────────────────
function _getSpecialMoveTargets(sq, piece) {
  const extras = [];
  const gs = window.__conquestGameState;
  if (!gs) return extras;
  const upgrades = gs.players[myRoleLocal]?.pieceUpgrades || {};

  // Drone T1 — diagonal strike
  if (piece.type === 'n' && upgrades['knight_t1'] && !knightBonusUsed[myRoleLocal]) {
    _getBishopReach(sq).forEach(t => extras.push(`SPECIAL:knightBonus:${sq}:${t}`));
  }
  // General T1 — 2-square escape
  if (piece.type === 'k' && upgrades['king_t1'] && !battleState.royalEscapeUsed[myRoleLocal]) {
    _getKingEscapeSquares(sq).forEach(t => extras.push(`SPECIAL:royalEscape:${sq}:${t}`));
  }
  return extras;
}

function _getBishopReach(sq) {
  const targets = [];
  const f0 = sq.charCodeAt(0) - 97, r0 = parseInt(sq[1]) - 1;
  for (const [df, dr] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let f = f0+df, r = r0+dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const t = String.fromCharCode(97+f) + (r+1);
      const occ = game.get(t);
      if (occ) { if (occ.color !== game.turn()) targets.push(t); break; }
      targets.push(t);
      f += df; r += dr;
    }
  }
  return targets;
}

function _getKingEscapeSquares(sq) {
  const targets = [];
  const f0 = sq.charCodeAt(0) - 97, r0 = parseInt(sq[1]) - 1;
  for (let df = -2; df <= 2; df++) for (let dr = -2; dr <= 2; dr++) {
    if (df === 0 && dr === 0) continue;
    const f = f0+df, r = r0+dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8)
      targets.push(String.fromCharCode(97+f) + (r+1));
  }
  return targets;
}

function _executeSpecialMove(from, encoded) {
  const [, type, , target] = encoded.split(':');
  const piece    = game.get(from);
  const captured = game.get(target);
  const oppRole  = myRoleLocal === battleDataLocal.attacker
    ? battleDataLocal.defender : battleDataLocal.attacker;

  if (type === 'knightBonus')  knightBonusUsed[myRoleLocal] = true;
  if (type === 'royalEscape')  battleState.royalEscapeUsed[myRoleLocal] = true;

  // Manually move piece and flip turn via FEN
  game.remove(from);
  if (captured) {
    game.remove(target);
    battleState.lostPieces[oppRole].push(captured.type);
  }
  game.put(piece, target);

  // Flip active color in FEN
  const parts = game.fen().split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-'; // clear en passant
  parts[4] = '0'; parts[5] = String(parseInt(parts[5] || '1') + (parts[1] === 'w' ? 1 : 0));
  game.load(parts.join(' '));

  socketLocal.emit('battle_move', { from, to: target, promotion: null, specialMove: type });
  socketLocal.emit('battle_fen_update', {
    fen: game.fen(),
    capturedPiece: captured?.type || null,
    capturedBy: captured ? oppRole : null,
    isPromotion: false,
  });
  callbacks.onFenUpdate(game.fen());
  _checkOutcome();
}

// ── Outcome detection ─────────────────────────────────────
function _checkOutcome() {
  if (!game) return;
  let outcome = null;
  if      (game.isCheckmate())           outcome = 'checkmate';
  else if (game.isStalemate())           outcome = 'stalemate';
  else if (game.isThreefoldRepetition()) outcome = 'repetition';
  else if (game.isDraw())                outcome = 'draw';
  if (!outcome) return;

  if (callbacks.onOutcome) callbacks.onOutcome(outcome, battleState);
  socketLocal.emit('battle_over', { outcome, battleState });
}

function _trackCapture(result, capturedOwner) {
  if (!result.captured) return;
  battleState.lostPieces[capturedOwner] = battleState.lostPieces[capturedOwner] || [];
  battleState.lostPieces[capturedOwner].push(result.captured);
  if (result.captured === 'q' && battleState.moveCount < 15)
    battleState.queenLostBefore15 = true;
}

function _trackKPEndgame() {
  const pieces = game.board().flat().filter(Boolean);
  if (pieces.length > 2 && pieces.every(p => p.type === 'k' || p.type === 'p'))
    battleState.kpEndgame = true;
}

function _sendFenUpdate(result) {
  socketLocal.emit('battle_fen_update', {
    fen: game.fen(),
    capturedPiece: result.captured || null,
    capturedBy: result.captured
      ? (result.color === 'w' ? battleDataLocal.defender : battleDataLocal.attacker)
      : null,
    isPromotion: result.flags.includes('p'),
    promotedTo:  result.promotion || null,
  });
}

function _updateMoveLog(result, role) {
  import('./ui.js').then(({ addMoveLogEntry }) => {
    const piece   = PIECE_NAMES[result.piece]    || result.piece.toUpperCase();
    const target  = PIECE_NAMES[result.captured] || null;
    const text    = target
      ? `${piece} destroys ${target} at ${result.to}`
      : `${piece} moves to ${result.to}`;
    addMoveLogEntry(text, role, battleState.moveCount);
  });
}

export function getCurrentFen()  { return game?.fen() ?? null; }
export function getBattleState() { return battleState; }
