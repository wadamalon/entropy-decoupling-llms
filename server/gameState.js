// ============================================================
// gameState.js — Server-side game state manager
// ============================================================

const TERRITORIES_TEMPLATE = [
  { id:'london',    name:'London HQ',         owner:'player1', terrain:'capital',  lat:51.5,  lng:-0.1, adjacentIds:['brussels','edinburgh','birmingham','paris'],          resourceOutput:{gold:3,glory:1},  chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'birmingham',name:'Birmingham Arsenal', owner:'player1', terrain:'mine',     lat:52.5,  lng:-1.9, adjacentIds:['london','edinburgh'],                                 resourceOutput:{iron:2},          chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'edinburgh', name:'Edinburgh Base',     owner:'player1', terrain:'plains',   lat:55.9,  lng:-3.2, adjacentIds:['birmingham','london'],                                resourceOutput:{grain:2},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'cairo',     name:'Cairo Command',      owner:'player2', terrain:'capital',  lat:30.0,  lng:31.2, adjacentIds:['tunis','athens','istanbul','riyadh'],                 resourceOutput:{gold:3,glory:1},  chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'riyadh',    name:'Riyadh Depot',       owner:'player2', terrain:'mine',     lat:24.7,  lng:46.7, adjacentIds:['cairo','istanbul'],                                   resourceOutput:{iron:2},          chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'tunis',     name:'Tunis Station',      owner:'player2', terrain:'plains',   lat:36.8,  lng:10.2, adjacentIds:['cairo','malta','madrid','lisbon'],                    resourceOutput:{grain:2},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'paris',     name:'Paris Sector',       owner:'neutral', terrain:'city',     lat:48.9,  lng:2.3,  adjacentIds:['london','brussels','amsterdam','alps'],               resourceOutput:{gold:3},          chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'madrid',    name:'Madrid Front',       owner:'neutral', terrain:'plains',   lat:40.4,  lng:-3.7, adjacentIds:['lisbon','tunis'],                                     resourceOutput:{grain:2},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'lisbon',    name:'Lisbon Port',        owner:'neutral', terrain:'port',     lat:38.7,  lng:-9.1, adjacentIds:['madrid','tunis'],                                     resourceOutput:{gold:2,grain:1},  chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'rome',      name:'Rome Outpost',       owner:'neutral', terrain:'temple',   lat:41.9,  lng:12.5, adjacentIds:['alps','athens','malta'],                              resourceOutput:{glory:1},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'vienna',    name:'Vienna Depot',       owner:'neutral', terrain:'mine',     lat:48.2,  lng:16.4, adjacentIds:['alps','prague','budapest'],                           resourceOutput:{iron:2},          chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'amsterdam', name:'Amsterdam Delta',    owner:'neutral', terrain:'swamp',    lat:52.4,  lng:4.9,  adjacentIds:['brussels','paris','prague'],                          resourceOutput:{grain:1},         chessModifier:{type:'noCastling',description:'No castling in the swamps'}, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'alps',      name:'Alpine Pass',        owner:'neutral', terrain:'mountain', lat:47.0,  lng:8.5,  adjacentIds:['paris','rome','vienna'],                              resourceOutput:{iron:1},          chessModifier:{type:'noCastling',description:'Impassable terrain — no castling'}, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'athens',    name:'Athens Stronghold',  owner:'neutral', terrain:'city',     lat:37.9,  lng:23.7, adjacentIds:['rome','cairo','istanbul','budapest'],                 resourceOutput:{gold:3,glory:1},  chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'malta',     name:'Malta Strait',       owner:'neutral', terrain:'coast',    lat:35.9,  lng:14.5, adjacentIds:['tunis','rome'],                                       resourceOutput:{gold:1,grain:1},  chessModifier:{type:'slowPawns',description:'Infantry advance 1 sq only for first 3 turns'}, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'prague',    name:'Prague Forest',      owner:'neutral', terrain:'forest',   lat:50.1,  lng:14.4, adjacentIds:['amsterdam','vienna','warsaw','budapest'],             resourceOutput:{grain:2},         chessModifier:{type:'knightBonus',description:'Drones get one extra L-move per game'}, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'warsaw',    name:'Warsaw Front',       owner:'neutral', terrain:'plains',   lat:52.2,  lng:21.0, adjacentIds:['prague','budapest'],                                  resourceOutput:{grain:2},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'budapest',  name:'Budapest Fortress',  owner:'neutral', terrain:'fortress', lat:47.5,  lng:19.0, adjacentIds:['vienna','prague','athens','istanbul'],                resourceOutput:{iron:1},          chessModifier:{type:'extraPawn',description:'Defender starts with an extra Infantry'}, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'istanbul',  name:'Istanbul Crossing',  owner:'neutral', terrain:'plains',   lat:41.0,  lng:29.0, adjacentIds:['cairo','riyadh','athens','budapest'],                 resourceOutput:{grain:2},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
  { id:'brussels',  name:'Brussels Junction',  owner:'neutral', terrain:'plains',   lat:50.8,  lng:4.4,  adjacentIds:['london','paris','amsterdam'],                         resourceOutput:{grain:2},         chessModifier:null, bufferTurns:0,damagedTurns:0,lockedTurns:0 },
];

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makePlayer() {
  return {
    resources: { gold: 5, iron: 5, grain: 5, glory: 0 },
    lostPieces: [],
    armyTokens: [],
    pieceUpgrades: {},
    armyUpgrades: [],
    skipNextTurn: false,
    queenReturning: false,
    queenReturnTurns: 0,
    battlesWon: 0,
    legendaryKing: false,
    imperialDecreeUsed: false,
  };
}

class GameState {
  constructor(roomId) {
    this.roomId = roomId;
    this.phase = 'lobby';
    this.currentPlayer = 'player1';
    this.turnNumber = 1;
    this.players = {
      player1: makePlayer(),
      player2: makePlayer(),
    };
    this.players.player1.armyTokens = ['london'];
    this.players.player2.armyTokens = ['cairo'];
    this.territories = deepClone(TERRITORIES_TEMPLATE);
    this.currentBattle = null;
    this.turnActionsUsed = { moved: false, attacked: false };
    this.winner = null;
  }

  getTerritoryById(id) {
    return this.territories.find(t => t.id === id);
  }

  getPlayerTerritories(playerId) {
    return this.territories.filter(t => t.owner === playerId);
  }

  // ── Resource collection ──────────────────────────────────
  collectResources(playerId) {
    const player = this.players[playerId];
    const ownedTerritories = this.getPlayerTerritories(playerId);
    for (const t of ownedTerritories) {
      const multiplier = t.damagedTurns > 0 ? 0.5 : 1;
      const output = t.resourceOutput;
      for (const [res, amt] of Object.entries(output)) {
        player.resources[res] = (player.resources[res] || 0) + Math.floor(amt * multiplier);
      }
    }
    // Black market bonus
    if (player.armyUpgrades.includes('merchant_guilds')) {
      const cities = ownedTerritories.filter(t => t.terrain === 'city' || t.terrain === 'capital');
      player.resources.gold += cities.length;
    }
    // Decrement status timers
    for (const t of this.territories) {
      if (t.bufferTurns > 0) t.bufferTurns--;
      if (t.damagedTurns > 0) t.damagedTurns--;
      if (t.lockedTurns > 0) t.lockedTurns--;
      // Buffer expired → stays neutral (already neutral owner set during battle outcome)
    }
    // Queen return countdown
    if (player.queenReturning) {
      player.queenReturnTurns--;
      if (player.queenReturnTurns <= 0) {
        player.queenReturning = false;
        // Remove queen from lostPieces
        const idx = player.lostPieces.indexOf('q');
        if (idx !== -1) player.lostPieces.splice(idx, 1);
      }
    }
  }

  // ── Recruit piece ────────────────────────────────────────
  recruitPiece(playerId, pieceType) {
    const COSTS = { p:{iron:1}, n:{gold:2}, b:{gold:2}, r:{gold:3}, q:{gold:5} };
    const player = this.players[playerId];
    const cost = COSTS[pieceType];
    if (!cost) return { ok: false, error: 'Unknown piece type' };
    if (!player.lostPieces.includes(pieceType)) return { ok: false, error: 'Piece not lost' };

    // Supply Lines: grain costs halved
    const adjustedCost = {};
    for (const [res, amt] of Object.entries(cost)) {
      if (res === 'grain' && player.armyUpgrades.includes('supply_lines')) {
        adjustedCost[res] = Math.ceil(amt / 2);
      } else {
        adjustedCost[res] = amt;
      }
    }
    for (const [res, amt] of Object.entries(adjustedCost)) {
      if ((player.resources[res] || 0) < amt) return { ok: false, error: 'Insufficient resources' };
    }
    for (const [res, amt] of Object.entries(adjustedCost)) {
      player.resources[res] -= amt;
    }
    const idx = player.lostPieces.indexOf(pieceType);
    player.lostPieces.splice(idx, 1);
    return { ok: true };
  }

  // ── Buy upgrade ─────────────────────────────────────────
  buyUpgrade(playerId, upgradeId) {
    const PIECE_UPGRADES = [
      { id:'pawn_t1',   cost:{iron:2}             }, { id:'pawn_t2',    cost:{gold:3,iron:3}     },
      { id:'knight_t1', cost:{gold:2,grain:1}     }, { id:'knight_t2',  cost:{gold:4,iron:2}     },
      { id:'bishop_t1', cost:{gold:2}             }, { id:'bishop_t2',  cost:{glory:2,gold:3}    },
      { id:'rook_t1',   cost:{iron:3}             }, { id:'rook_t2',    cost:{gold:5,iron:4}     },
      { id:'queen_t1',  cost:{gold:4,glory:1}     }, { id:'queen_pres', cost:{glory:4,gold:8}    },
      { id:'king_t1',   cost:{gold:3,glory:1}     }, { id:'king_pres',  cost:{glory:5,gold:10}   },
    ];
    const ARMY_UPGRADES = [
      { id:'supply_lines',    cost:{grain:3,gold:2} },
      { id:'war_council',     cost:{gold:4,glory:1} },
      { id:'fortification',   cost:{iron:4,gold:3}  },
      { id:'merchant_guilds', cost:{gold:5}          },
      { id:'battle_hymns',    cost:{glory:2,gold:3} },
      { id:'imperial_decree', cost:{glory:4,gold:8} },
    ];

    const player = this.players[playerId];
    const allUpgrades = [...PIECE_UPGRADES, ...ARMY_UPGRADES];
    const upg = allUpgrades.find(u => u.id === upgradeId);
    if (!upg) return { ok: false, error: 'Unknown upgrade' };

    const isArmy = ARMY_UPGRADES.some(u => u.id === upgradeId);
    if (isArmy && player.armyUpgrades.includes(upgradeId)) return { ok: false, error: 'Already owned' };
    if (!isArmy && player.pieceUpgrades[upgradeId]) return { ok: false, error: 'Already owned' };

    for (const [res, amt] of Object.entries(upg.cost)) {
      if ((player.resources[res] || 0) < amt) return { ok: false, error: 'Insufficient resources' };
    }
    for (const [res, amt] of Object.entries(upg.cost)) {
      player.resources[res] -= amt;
    }
    if (isArmy) {
      if (player.armyUpgrades.length >= 3) return { ok: false, error: 'Max 3 army upgrades' };
      player.armyUpgrades.push(upgradeId);
    } else {
      player.pieceUpgrades[upgradeId] = true;
    }
    return { ok: true };
  }

  // ── Bribe neutral territory ──────────────────────────────
  bribeTerritory(playerId, territoryId) {
    const player = this.players[playerId];
    const t = this.getTerritoryById(territoryId);
    if (!t) return { ok: false, error: 'Territory not found' };
    if (t.owner !== 'neutral') return { ok: false, error: 'Not neutral' };
    if (t.lockedTurns > 0) return { ok: false, error: 'Territory locked' };
    if (player.resources.gold < 4) return { ok: false, error: 'Need 4 gold' };
    // Must be adjacent to a territory the player owns
    const playerTerritories = this.getPlayerTerritories(playerId).map(t => t.id);
    const isAdjacent = t.adjacentIds.some(adjId => playerTerritories.includes(adjId));
    if (!isAdjacent) return { ok: false, error: 'Territory not adjacent to your lands' };

    player.resources.gold -= 4;
    t.owner = playerId;
    return { ok: true };
  }

  // ── Move army ────────────────────────────────────────────
  moveArmy(playerId, fromId, toId) {
    if (this.turnActionsUsed.moved) return { ok: false, error: 'Already moved this turn' };
    const player = this.players[playerId];
    if (!player.armyTokens.includes(fromId)) return { ok: false, error: 'No army at source' };
    const from = this.getTerritoryById(fromId);
    const to = this.getTerritoryById(toId);
    if (!from || !to) return { ok: false, error: 'Invalid territory' };
    if (!from.adjacentIds.includes(toId)) return { ok: false, error: 'Not adjacent' };
    if (to.owner !== playerId && to.owner !== 'neutral') {
      // Can only move into own or neutral (neutral conquered passively)
      // To attack, use declareAttack
    }

    const idx = player.armyTokens.indexOf(fromId);
    player.armyTokens[idx] = toId;
    this.turnActionsUsed.moved = true;
    return { ok: true };
  }

  // ── Declare attack ───────────────────────────────────────
  declareAttack(playerId, fromId, targetId) {
    if (this.turnActionsUsed.attacked) return { ok: false, error: 'Already attacked this turn' };
    const player = this.players[playerId];
    const opponent = playerId === 'player1' ? 'player2' : 'player1';

    if (!player.armyTokens.includes(fromId)) return { ok: false, error: 'No army at source' };
    const from = this.getTerritoryById(fromId);
    const target = this.getTerritoryById(targetId);
    if (!from || !target) return { ok: false, error: 'Invalid territory' };
    if (!from.adjacentIds.includes(targetId)) return { ok: false, error: 'Target not adjacent' };
    if (target.owner === playerId) return { ok: false, error: 'Cannot attack own territory' };
    if (target.lockedTurns > 0) return { ok: false, error: 'Territory is locked' };

    // Capital restriction
    if (target.terrain === 'capital' && target.owner === opponent) {
      const opponentHomeTerrs = ['london','birmingham','edinburgh','cairo','riyadh','tunis'];
      const homeIds = opponentHomeTerrs.filter(id => {
        const t = this.getTerritoryById(id);
        return t && t.owner === opponent;
      });
      const captured = opponentHomeTerrs.filter(id => {
        const t = this.getTerritoryById(id);
        return t && t.owner !== opponent && id !== target.id;
      });
      if (captured.length < 2) return { ok: false, error: 'Must capture 2 enemy home territories before attacking capital' };
    }

    this.turnActionsUsed.attacked = true;
    return { ok: true, battle: true };
  }

  // ── Generate battle FEN ──────────────────────────────────
  generateBattleFEN(attackerId, defenderId, territory) {
    // Standard starting position, modified for lost pieces and terrain
    const attacker = this.players[attackerId];
    const defender = this.players[defenderId];

    // Build piece sets (true = piece available)
    const attackerPieces = this._buildPieceSet(attacker);
    const defenderPieces = this._buildPieceSet(defender);

    // Apply no-grain penalty
    if (attacker.resources.grain === 0 && attackerPieces.n > 0) attackerPieces.n--;
    if (defender.resources.grain === 0 && defenderPieces.n > 0) defenderPieces.n--;

    // Fortress: defender gets extra pawn
    if (territory.chessModifier?.type === 'extraPawn') {
      defenderPieces.p = Math.min(defenderPieces.p + 1, 9); // chess allows up to 9 pawns via promo
    }
    // Fortification upgrade for defender
    if (defender.armyUpgrades.includes('fortification')) {
      defenderPieces.p = Math.min(defenderPieces.p + 1, 9);
    }

    const fen = this._piecesToFEN(attackerPieces, defenderPieces, territory.chessModifier);
    return fen;
  }

  _buildPieceSet(player) {
    const standard = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    const pieces = { ...standard };
    for (const lost of player.lostPieces) {
      if (lost !== 'k' && pieces[lost] > 0) pieces[lost]--;
    }
    return pieces;
  }

  _piecesToFEN(wPieces, bPieces, modifier) {
    // Build a custom FEN from piece counts
    // White (attacker) on ranks 1-2, Black (defender) on ranks 7-8
    const ranks = [];

    // Rank 8 (black back rank)
    ranks.push(this._buildBackRank(bPieces, 'black'));
    // Rank 7 (black pawns)
    ranks.push(this._buildPawnRank(bPieces.p, 'black'));
    // Ranks 6-3 (empty)
    ranks.push('8', '8', '8', '8');
    // Rank 2 (white pawns)
    ranks.push(this._buildPawnRank(wPieces.p, 'white'));
    // Rank 1 (white back rank)
    ranks.push(this._buildBackRank(wPieces, 'white'));

    const board = ranks.join('/');

    let castling = 'KQkq';
    if (modifier?.type === 'noCastling') castling = '-';

    return `${board} w ${castling} - 0 1`;
  }

  _buildBackRank(pieces, color) {
    // Standard arrangement: R N B Q K B N R, removing pieces that are lost
    const isWhite = color === 'white';
    let rank = [];

    // Build symmetric arrangement prioritizing center
    const rooks  = pieces.r;
    const knights = pieces.n;
    const bishops = pieces.b;
    const queens  = pieces.q;
    const king    = pieces.k;

    // Place pieces in standard positions, omitting missing ones
    const standardOrder = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    const available = { r: rooks, n: knights, b: bishops, q: queens, k: king };
    const placed = [];

    for (const p of standardOrder) {
      if (available[p] > 0) {
        placed.push(isWhite ? p.toUpperCase() : p);
        available[p]--;
      } else {
        placed.push(null); // empty square
      }
    }

    // Convert to FEN segment
    let seg = '';
    let empty = 0;
    for (const sq of placed) {
      if (sq === null) {
        empty++;
      } else {
        if (empty > 0) { seg += empty; empty = 0; }
        seg += sq;
      }
    }
    if (empty > 0) seg += empty;
    return seg;
  }

  _buildPawnRank(count, color) {
    const p = color === 'white' ? 'P' : 'p';
    const empty = 8 - count;
    if (empty === 0) return p.repeat(8);
    if (empty === 8) return '8';
    // Center the pawns
    const leftEmpty = Math.floor(empty / 2);
    const rightEmpty = empty - leftEmpty;
    let seg = '';
    if (leftEmpty > 0) seg += leftEmpty;
    seg += p.repeat(count);
    if (rightEmpty > 0) seg += rightEmpty;
    return seg;
  }

  // ── Apply battle outcome ─────────────────────────────────
  applyBattleOutcome(outcome, attackerId, defenderId, territoryId, battleState) {
    const attacker = this.players[attackerId];
    const defender = this.players[defenderId];
    const territory = this.getTerritoryById(territoryId);

    // Update lost pieces
    for (const p of (battleState.lostPieces[attackerId] || [])) {
      if (p !== 'k') attacker.lostPieces.push(p);
    }
    for (const p of (battleState.lostPieces[defenderId] || [])) {
      if (p !== 'k') defender.lostPieces.push(p);
    }

    switch (outcome) {
      case 'checkmate': {
        territory.owner = attackerId;
        attacker.resources.gold  += 2;
        attacker.resources.glory += 1;
        defender.skipNextTurn = true;
        attacker.battlesWon = (attacker.battlesWon || 0) + 1;
        // Move attacker's army to captured territory
        if (attacker.armyTokens.length > 0) attacker.armyTokens[0] = territoryId;
        break;
      }
      case 'blitz': {
        // Checkmate < 20 moves
        territory.owner = attackerId;
        attacker.resources.gold  += 2;
        attacker.resources.glory += 3;
        defender.skipNextTurn = true;
        attacker.battlesWon = (attacker.battlesWon || 0) + 1;
        if (attacker.armyTokens.length > 0) attacker.armyTokens[0] = territoryId;
        // Adjacent neutral auto-captured
        const adjacent = territory.adjacentIds
          .map(id => this.getTerritoryById(id))
          .find(t => t && t.owner === 'neutral' && t.lockedTurns === 0);
        if (adjacent) adjacent.owner = attackerId;
        break;
      }
      case 'pyrrhic': {
        territory.owner = attackerId;
        attacker.resources.glory += 2;
        attacker.battlesWon = (attacker.battlesWon || 0) + 1;
        // Attacker loses one extra piece (remove a pawn if available)
        attacker.lostPieces.push('p');
        if (attacker.armyTokens.length > 0) attacker.armyTokens[0] = territoryId;
        break;
      }
      case 'pawnPromoWin': {
        territory.owner = attackerId;
        attacker.resources.glory += 2;
        territory.damagedTurns = -2; // negative = bonus (handled separately — 2x resources)
        // Use damagedTurns < 0 as "bonusTurns" flag
        territory.bonusTurns = 2;
        attacker.battlesWon = (attacker.battlesWon || 0) + 1;
        if (attacker.armyTokens.length > 0) attacker.armyTokens[0] = territoryId;
        break;
      }
      case 'stalemate': {
        // Stays neutral (buffer)
        territory.owner = 'neutral';
        territory.bufferTurns = 2;
        territory.lockedTurns = 2;
        attacker.resources.grain = Math.max(0, attacker.resources.grain - 1);
        defender.resources.grain = Math.max(0, defender.resources.grain - 1);
        break;
      }
      case 'repetition': {
        // Stays contested — keep current owner
        territory.lockedTurns = 3;
        // Both lose an army token (just flag it for now — remove a lost piece)
        attacker.lostPieces.push('p');
        defender.lostPieces.push('p');
        break;
      }
      case 'resignation': {
        territory.owner = attackerId;
        attacker.battlesWon = (attacker.battlesWon || 0) + 1;
        if (attacker.armyTokens.length > 0) attacker.armyTokens[0] = territoryId;
        break;
      }
      case 'kpEndgame': {
        // Winner captures
        territory.owner = attackerId;
        territory.damagedTurns = 2;
        attacker.resources.iron = Math.max(0, attacker.resources.iron - 1);
        defender.resources.iron = Math.max(0, defender.resources.iron - 1);
        attacker.battlesWon = (attacker.battlesWon || 0) + 1;
        if (attacker.armyTokens.length > 0) attacker.armyTokens[0] = territoryId;
        break;
      }
    }

    // Legendary King trigger
    if ((attacker.battlesWon || 0) >= 5 && attacker.pieceUpgrades['king_pres']) {
      attacker.legendaryKing = true;
    }

    // Check win condition
    const capitals = { player1: 'london', player2: 'cairo' };
    for (const [pid, capId] of Object.entries(capitals)) {
      const opp = pid === 'player1' ? 'player2' : 'player1';
      const capTerr = this.getTerritoryById(capId);
      if (capTerr && capTerr.owner === opp) {
        this.winner = opp;
        this.phase = 'gameover';
      }
    }

    // Check 60% surrender
    if (!this.winner) {
      const total = this.territories.length;
      for (const pid of ['player1', 'player2']) {
        const count = this.getPlayerTerritories(pid).length;
        if (count / total >= 0.6) {
          // Auto-flip one neutral territory
          const neutral = this.territories.find(t => t.owner === 'neutral' && t.lockedTurns === 0);
          if (neutral) neutral.owner = pid;
        }
      }
    }

    this.currentBattle = null;
    return { ok: true, winner: this.winner };
  }

  // ── End turn ─────────────────────────────────────────────
  endTurn() {
    const nextPlayer = this.currentPlayer === 'player1' ? 'player2' : 'player1';

    // Handle skip
    if (this.players[nextPlayer].skipNextTurn) {
      this.players[nextPlayer].skipNextTurn = false;
      this.currentPlayer = nextPlayer === 'player1' ? 'player2' : 'player1';
      this.turnNumber++;
    } else {
      this.currentPlayer = nextPlayer;
    }

    this.turnActionsUsed = { moved: false, attacked: false };

    // Collect resources for the new current player
    this.collectResources(this.currentPlayer);

    return { ok: true };
  }

  toJSON() {
    return {
      roomId: this.roomId,
      phase: this.phase,
      currentPlayer: this.currentPlayer,
      turnNumber: this.turnNumber,
      players: this.players,
      territories: this.territories,
      currentBattle: this.currentBattle,
      turnActionsUsed: this.turnActionsUsed,
      winner: this.winner,
    };
  }
}

module.exports = { GameState };
