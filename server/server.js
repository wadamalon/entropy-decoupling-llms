// ============================================================
// server.js — Node.js + Socket.io game server
// ============================================================
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { GameState } = require('./gameState');

const path = require('path');
const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// Active rooms: roomId → { state: GameState, players: { player1: socketId, player2: socketId } }
const rooms = new Map();

// Per-room battle readiness: roomId → Set of ready player roles
const battleReadyMap = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomBySocket(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.players.player1 === socketId || room.players.player2 === socketId) {
      return { roomId, room };
    }
  }
  return null;
}

function getPlayerRole(room, socketId) {
  if (room.players.player1 === socketId) return 'player1';
  if (room.players.player2 === socketId) return 'player2';
  return null;
}

function broadcast(room, event, data) {
  io.to(room.players.player1).emit(event, data);
  if (room.players.player2) io.to(room.players.player2).emit(event, data);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // ── Create room ──────────────────────────────────────────
  socket.on('create_room', ({ timerSeconds } = {}) => {
    const roomId = generateRoomId();
    const state = new GameState(roomId);
    rooms.set(roomId, {
      state,
      players: { player1: socket.id, player2: null },
      timerSeconds: timerSeconds || 0,
    });
    socket.join(roomId);
    socket.emit('room_created', { roomId, role: 'player1', timerSeconds: timerSeconds || 0 });
    console.log(`Room created: ${roomId} by ${socket.id} timer=${timerSeconds||0}s`);
  });

  // ── Join room ────────────────────────────────────────────
  socket.on('join_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (room.players.player2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    room.players.player2 = socket.id;
    socket.join(roomId);

    // Start game — collect initial resources for player1
    room.state.phase = 'strategic';
    room.state.collectResources('player1');

    socket.emit('room_joined', { role: 'player2' });
    broadcast(room, 'game_start', room.state.toJSON());
    console.log(`Game started in room ${roomId}`);
  });

  // ── Strategic action ────────────────────────────────────
  socket.on('strategic_action', ({ action, payload }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    const role = getPlayerRole(room, socket.id);
    if (!role) return;

    const state = room.state;
    if (state.phase !== 'strategic') {
      socket.emit('error', { message: 'Not in strategic phase' });
      return;
    }
    if (state.currentPlayer !== role) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    let result;
    switch (action) {
      case 'recruit':
        result = state.recruitPiece(role, payload.pieceType);
        break;
      case 'buy_upgrade':
        result = state.buyUpgrade(role, payload.upgradeId);
        break;
      case 'bribe':
        result = state.bribeTerritory(role, payload.territoryId);
        break;
      case 'move_army':
        result = state.moveArmy(role, payload.fromId, payload.toId);
        break;
      case 'declare_attack': {
        result = state.declareAttack(role, payload.fromId, payload.targetId);
        if (result.ok) {
          const opponent = role === 'player1' ? 'player2' : 'player1';
          const territory = state.getTerritoryById(payload.targetId);
          const fen = state.generateBattleFEN(role, opponent, territory);

          state.currentBattle = {
            territoryId: payload.targetId,
            attacker: role,
            defender: opponent,
            fen,
            moveHistory: [],
            battleState: {
              moveCount: 0,
              queenLostBefore15: false,
              kpEndgame: false,
              pawnPromoted: false,
              lostPieces: { [role]: [], [opponent]: [] },
              knightBonusUsed: { [role]: false, [opponent]: false },
              droneOverloadUsed: { [role]: false, [opponent]: false },
              royalEscapeUsed: { [role]: false, [opponent]: false },
              darkNetworkUsed: { [role]: false, [opponent]: false },
              ironCitadelUsed: { [role]: false, [opponent]: false },
            },
          };
          state.phase = 'battle';
          state.currentBattle.territory = territory;
          state.currentBattle.revealedPieces = result.revealedPieces || [];
          state.currentBattle.modifier = territory.chessModifier || null;

          // War Council: reveal opponent's lost pieces
          if (state.players[role].armyUpgrades.includes('war_council')) {
            const revealCount = Math.min(2, state.players[opponent].lostPieces.length);
            result.revealedPieces = state.players[opponent].lostPieces.slice(0, revealCount);
          }

          broadcast(room, 'battle_start', {
            territoryId: payload.targetId,
            territory: territory,
            modifier: territory.chessModifier,
            fen,
            attacker: role,
            defender: opponent,
            revealedPieces: result.revealedPieces || [],
            timerSeconds: room.timerSeconds || 0,
            state: state.toJSON(),
          });
          return;
        }
        break;
      }
      case 'end_turn': {
        result = state.endTurn();
        if (result.ok) {
          broadcast(room, 'strategic_turn', {
            currentPlayer: state.currentPlayer,
            turnNumber: state.turnNumber,
            state: state.toJSON(),
          });
          return;
        }
        break;
      }
      default:
        socket.emit('error', { message: 'Unknown action' });
        return;
    }

    if (result.ok) {
      broadcast(room, 'state_update', state.toJSON());
    } else {
      socket.emit('action_error', { message: result.error });
    }
  });

  // ── Battle move ──────────────────────────────────────────
  socket.on('battle_move', ({ from, to, promotion, specialMove }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    const role = getPlayerRole(room, socket.id);
    const state = room.state;

    if (state.phase !== 'battle' || !state.currentBattle) {
      socket.emit('error', { message: 'Not in battle phase' });
      return;
    }

    // Determine whose turn it is in chess (white = attacker)
    // We track via FEN active color
    const fen = state.currentBattle.fen;
    const activeColor = fen.split(' ')[1]; // 'w' or 'b'
    const expectedRole = activeColor === 'w' ? state.currentBattle.attacker : state.currentBattle.defender;

    if (role !== expectedRole) {
      socket.emit('error', { message: 'Not your move' });
      return;
    }

    // The actual Chess.js validation happens on the client
    // Server trusts the move structure but records it
    const moveData = { from, to, promotion: promotion || null, specialMove: specialMove || null };
    state.currentBattle.moveHistory.push({ role, ...moveData });
    state.currentBattle.battleState.moveCount++;

    // Update FEN sent from client (client validates with chess.js and sends updated FEN)
    // The client sends { from, to, promotion, newFen, outcome, capturedPiece, isPromotion }
    broadcast(room, 'battle_move_made', {
      move: moveData,
      role,
      state: state.toJSON(),
    });
  });

  // ── Battle FEN update (authoritative FEN from chess.js client) ──
  socket.on('battle_fen_update', ({ fen, capturedPiece, capturedBy, isPromotion, promotedTo }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    const state = room.state;
    if (!state.currentBattle) return;

    state.currentBattle.fen = fen;

    const bs = state.currentBattle.battleState;
    if (capturedPiece) {
      const capturedPieceType = capturedPiece.toLowerCase();
      bs.lostPieces[capturedBy] = bs.lostPieces[capturedBy] || [];
      bs.lostPieces[capturedBy].push(capturedPieceType);
      if (capturedPieceType === 'q' && bs.moveCount < 15) {
        bs.queenLostBefore15 = true;
      }
    }
    if (isPromotion) bs.pawnPromoted = true;

    broadcast(room, 'state_update', state.toJSON());
  });

  // ── Battle outcome ───────────────────────────────────────
  socket.on('battle_over', ({ outcome, battleState: clientBattleState }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    const role = getPlayerRole(room, socket.id);
    const state = room.state;
    if (!state.currentBattle) return;

    const { attacker, defender, territoryId } = state.currentBattle;
    battleReadyMap.delete(found.roomId);

    // Merge client battle state
    if (clientBattleState) {
      Object.assign(state.currentBattle.battleState, clientBattleState);
    }

    // Determine actual outcome label
    let finalOutcome = outcome;
    const bs = state.currentBattle.battleState;
    if (outcome === 'checkmate' && bs.moveCount < 20) finalOutcome = 'blitz';
    if (outcome === 'checkmate' && bs.queenLostBefore15) finalOutcome = 'pyrrhic';
    if (outcome === 'checkmate' && bs.pawnPromoted) finalOutcome = 'pawnPromoWin';
    if (outcome === 'checkmate' && bs.kpEndgame) finalOutcome = 'kpEndgame';

    const result = state.applyBattleOutcome(
      finalOutcome, attacker, defender, territoryId, bs
    );
    state.phase = 'strategic';

    broadcast(room, 'battle_over', {
      outcome: finalOutcome,
      attacker,
      defender,
      territoryId,
      winner: result.winner,
      state: state.toJSON(),
    });

    if (result.winner) {
      broadcast(room, 'game_over', { winner: result.winner, state: state.toJSON() });
    }
  });

  // ── Resignation ──────────────────────────────────────────
  socket.on('battle_resign', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    const role = getPlayerRole(room, socket.id);
    const state = room.state;
    if (!state.currentBattle) return;

    const { attacker, defender, territoryId } = state.currentBattle;
    const bs = state.currentBattle.battleState;
    const result = state.applyBattleOutcome('resignation', attacker, defender, territoryId, bs);
    state.phase = 'strategic';

    broadcast(room, 'battle_over', {
      outcome: 'resignation',
      attacker,
      defender,
      territoryId,
      winner: result.winner,
      state: state.toJSON(),
    });

    if (result.winner) {
      broadcast(room, 'game_over', { winner: result.winner, state: state.toJSON() });
    }
  });

  // ── Battle ready (player confirmed briefing) ──────────────
  socket.on('battle_player_ready', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { roomId, room } = found;
    const role = getPlayerRole(room, socket.id);
    if (!role) return;

    if (!battleReadyMap.has(roomId)) battleReadyMap.set(roomId, new Set());
    battleReadyMap.get(roomId).add(role);

    if (battleReadyMap.get(roomId).size >= 2) {
      battleReadyMap.delete(roomId);
      const state = room.state;
      if (!state.currentBattle) return;
      broadcast(room, 'battle_begin', {
        territoryId: state.currentBattle.territoryId,
        territory:   state.currentBattle.territory || {},
        fen:         state.currentBattle.fen,
        attacker:    state.currentBattle.attacker,
        defender:    state.currentBattle.defender,
        modifier:    state.currentBattle.modifier || null,
        revealedPieces: state.currentBattle.revealedPieces || [],
        timerSeconds: found.room.timerSeconds || 0,
        state:       state.toJSON(),
      });
    }
  });

  // ── Upgrade purchase from battle ──────────────────────────
  socket.on('upgrade_purchase', ({ upgradeId }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    const role = getPlayerRole(room, socket.id);
    const state = room.state;
    const result = state.buyUpgrade(role, upgradeId);
    if (result.ok) {
      broadcast(room, 'state_update', state.toJSON());
    } else {
      socket.emit('action_error', { message: result.error });
    }
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const found = getRoomBySocket(socket.id);
    if (found) {
      const { roomId, room } = found;
      const role = getPlayerRole(room, socket.id);
      broadcast(room, 'opponent_disconnected', { role });
      // Clean up room after grace period
      setTimeout(() => {
        if (rooms.has(roomId)) rooms.delete(roomId);
      }, 30000);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Conquest server running on port ${PORT}`);
});
