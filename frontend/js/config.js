// ============================================================
// config.js — All game constants and tunable values
// ============================================================

export const MODEL_PATHS = {
  pawn:   './assets/models/pawn.glb',
  knight: './assets/models/knight.glb',
  bishop: './assets/models/bishop.glb',
  rook:   './assets/models/rook.glb',
  queen:  './assets/models/queen.glb',
  king:   './assets/models/king.glb',
  praying: './assets/models/praying.glb',
};

export const EXPLOSION_MODEL = './assets/models/timeframe_explosion.glb';

// Lore names (military theme)
export const PIECE_NAMES = {
  p: 'Infantry',
  n: 'Drone',
  b: 'Sniper',
  r: 'Artillery',
  q: 'Combat Droid',
  k: 'General',
};

export const PIECE_COLORS = {
  player1: 0xffffff, // White pieces
  player2: 0x111111, // Black pieces
};

export const PLAYER_NAMES = {
  player1: 'NATO Command',
  player2: 'Eastern Force',
};

export const PLAYER_ACCENT = {
  player1: '#2E6CA6',
  player2: '#B03A2E',
};

export const RESOURCES = {
  GOLD:  'gold',
  IRON:  'iron',
  GRAIN: 'grain',
  GLORY: 'glory',
};

export const TERRAIN_TYPES = {
  PLAINS:   'plains',
  MINE:     'mine',
  CITY:     'city',
  TEMPLE:   'temple',
  PORT:     'port',
  FORTRESS: 'fortress',
  CAPITAL:  'capital',
  MOUNTAIN: 'mountain',
  FOREST:   'forest',
  COAST:    'coast',
  SWAMP:    'swamp',
};

export const RECRUIT_COSTS = {
  p: { iron: 1 },
  n: { gold: 2 },
  b: { gold: 2 },
  r: { gold: 3 },
  q: { gold: 5 },
};

export const TERRITORY_INCOME = {
  plains:   { grain: 2 },
  mine:     { iron: 2 },
  city:     { gold: 3 },
  temple:   { glory: 1 },
  port:     { gold: 2, grain: 1 },
  fortress: { iron: 1 },
  capital:  { gold: 3, glory: 1 },
  mountain: { iron: 1 },
  forest:   { grain: 2 },
  coast:    { gold: 1, grain: 1 },
  swamp:    { grain: 1 },
};

// 20 Territories: Europe / Middle East / North Africa
export const TERRITORIES_DATA = [
  // ── Player 1 (NATO Command) ──
  {
    id: 'london',
    name: 'London HQ',
    owner: 'player1',
    terrain: 'capital',
    lat: 51.5, lng: -0.1,
    adjacentIds: ['brussels', 'edinburgh', 'birmingham', 'paris'],
    resourceOutput: { gold: 3, glory: 1 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'birmingham',
    name: 'Birmingham Arsenal',
    owner: 'player1',
    terrain: 'mine',
    lat: 52.5, lng: -1.9,
    adjacentIds: ['london', 'edinburgh'],
    resourceOutput: { iron: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'edinburgh',
    name: 'Edinburgh Base',
    owner: 'player1',
    terrain: 'plains',
    lat: 55.9, lng: -3.2,
    adjacentIds: ['birmingham', 'london'],
    resourceOutput: { grain: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  // ── Player 2 (Eastern Force) ──
  {
    id: 'cairo',
    name: 'Cairo Command',
    owner: 'player2',
    terrain: 'capital',
    lat: 30.0, lng: 31.2,
    adjacentIds: ['tunis', 'athens', 'istanbul', 'riyadh'],
    resourceOutput: { gold: 3, glory: 1 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'riyadh',
    name: 'Riyadh Depot',
    owner: 'player2',
    terrain: 'mine',
    lat: 24.7, lng: 46.7,
    adjacentIds: ['cairo', 'istanbul'],
    resourceOutput: { iron: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'tunis',
    name: 'Tunis Station',
    owner: 'player2',
    terrain: 'plains',
    lat: 36.8, lng: 10.2,
    adjacentIds: ['cairo', 'malta', 'madrid', 'lisbon'],
    resourceOutput: { grain: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  // ── Neutral Territories ──
  {
    id: 'paris',
    name: 'Paris Sector',
    owner: 'neutral',
    terrain: 'city',
    lat: 48.9, lng: 2.3,
    adjacentIds: ['london', 'brussels', 'amsterdam', 'alps'],
    resourceOutput: { gold: 3 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'madrid',
    name: 'Madrid Front',
    owner: 'neutral',
    terrain: 'plains',
    lat: 40.4, lng: -3.7,
    adjacentIds: ['lisbon', 'tunis'],
    resourceOutput: { grain: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'lisbon',
    name: 'Lisbon Port',
    owner: 'neutral',
    terrain: 'port',
    lat: 38.7, lng: -9.1,
    adjacentIds: ['madrid', 'tunis'],
    resourceOutput: { gold: 2, grain: 1 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'rome',
    name: 'Rome Outpost',
    owner: 'neutral',
    terrain: 'temple',
    lat: 41.9, lng: 12.5,
    adjacentIds: ['alps', 'athens', 'malta'],
    resourceOutput: { glory: 1 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'vienna',
    name: 'Vienna Depot',
    owner: 'neutral',
    terrain: 'mine',
    lat: 48.2, lng: 16.4,
    adjacentIds: ['alps', 'prague', 'budapest'],
    resourceOutput: { iron: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'amsterdam',
    name: 'Amsterdam Delta',
    owner: 'neutral',
    terrain: 'swamp',
    lat: 52.4, lng: 4.9,
    adjacentIds: ['brussels', 'paris', 'prague'],
    resourceOutput: { grain: 1 },
    chessModifier: { type: 'noCastling', description: 'No castling in the swamps' },
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'alps',
    name: 'Alpine Pass',
    owner: 'neutral',
    terrain: 'mountain',
    lat: 47.0, lng: 8.5,
    adjacentIds: ['paris', 'rome', 'vienna'],
    resourceOutput: { iron: 1 },
    chessModifier: { type: 'noCastling', description: 'Impassable terrain — no castling' },
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'athens',
    name: 'Athens Stronghold',
    owner: 'neutral',
    terrain: 'city',
    lat: 37.9, lng: 23.7,
    adjacentIds: ['rome', 'cairo', 'istanbul', 'budapest'],
    resourceOutput: { gold: 3, glory: 1 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'malta',
    name: 'Malta Strait',
    owner: 'neutral',
    terrain: 'coast',
    lat: 35.9, lng: 14.5,
    adjacentIds: ['tunis', 'rome'],
    resourceOutput: { gold: 1, grain: 1 },
    chessModifier: { type: 'slowPawns', description: 'Infantry advance 1 sq only for first 3 turns' },
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'prague',
    name: 'Prague Forest',
    owner: 'neutral',
    terrain: 'forest',
    lat: 50.1, lng: 14.4,
    adjacentIds: ['amsterdam', 'vienna', 'warsaw', 'budapest'],
    resourceOutput: { grain: 2 },
    chessModifier: { type: 'knightBonus', description: 'Drones get one extra L-move per game' },
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'warsaw',
    name: 'Warsaw Front',
    owner: 'neutral',
    terrain: 'plains',
    lat: 52.2, lng: 21.0,
    adjacentIds: ['prague', 'budapest'],
    resourceOutput: { grain: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'budapest',
    name: 'Budapest Fortress',
    owner: 'neutral',
    terrain: 'fortress',
    lat: 47.5, lng: 19.0,
    adjacentIds: ['vienna', 'prague', 'athens', 'istanbul'],
    resourceOutput: { iron: 1 },
    chessModifier: { type: 'extraPawn', description: 'Defender starts with an extra Infantry' },
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'istanbul',
    name: 'Istanbul Crossing',
    owner: 'neutral',
    terrain: 'plains',
    lat: 41.0, lng: 29.0,
    adjacentIds: ['cairo', 'riyadh', 'athens', 'budapest'],
    resourceOutput: { grain: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
  {
    id: 'brussels',
    name: 'Brussels Junction',
    owner: 'neutral',
    terrain: 'plains',
    lat: 50.8, lng: 4.4,
    adjacentIds: ['london', 'paris', 'amsterdam'],
    resourceOutput: { grain: 2 },
    chessModifier: null,
    bufferTurns: 0, damagedTurns: 0, lockedTurns: 0,
  },
];

export const PIECE_UPGRADES_DATA = [
  // Infantry upgrades
  { id: 'pawn_t1', piece: 'p', tier: 1, name: 'Shield Wall',      cost: { iron: 2 },            effect: 'shieldWall',       desc: 'Infantry may advance 2 squares on any turn.' },
  { id: 'pawn_t2', piece: 'p', tier: 2, name: 'Veterans',         cost: { gold: 3, iron: 3 },   effect: 'veteranPromo',     desc: 'On promotion, gain 1 glory. New unit starts upgraded.' },
  // Drone (knight) upgrades
  { id: 'knight_t1', piece: 'n', tier: 1, name: 'Strike Package', cost: { gold: 2, grain: 1 },  effect: 'mountedCharge',    desc: 'Once per game, Drone may strike on a diagonal.' },
  { id: 'knight_t2', piece: 'n', tier: 2, name: 'Stealth Frame',  cost: { gold: 4, iron: 2 },   effect: 'warHorse',         desc: 'Enemy Infantry cannot capture this Drone.' },
  // Sniper (bishop) upgrades
  { id: 'bishop_t1', piece: 'b', tier: 1, name: 'Dark Network',   cost: { gold: 2 },             effect: 'darkNetwork',      desc: 'Once per game, Sniper teleports on diagonal color.' },
  { id: 'bishop_t2', piece: 'b', tier: 2, name: 'Overwatch',      cost: { glory: 2, gold: 3 },  effect: 'grandInquisitor',  desc: 'Highlights extended diagonal threat to General.' },
  // Tank (rook) upgrades
  { id: 'rook_t1', piece: 'r', tier: 1, name: 'Siege Mode',       cost: { iron: 3 },             effect: 'siegeEngine',      desc: 'Highlights entire rank/file as exclusion zone.' },
  { id: 'rook_t2', piece: 'r', tier: 2, name: 'Iron Citadel',     cost: { gold: 5, iron: 4 },   effect: 'ironCitadel',      desc: 'Castle from any Tank position once per game.' },
  // Combat Droid (queen) upgrades
  { id: 'queen_t1', piece: 'q', tier: 1, name: "Droid Overload",  cost: { gold: 4, glory: 1 },  effect: 'conquerorReach',   desc: 'Once per game, Droid moves twice in one turn.' },
  { id: 'queen_pres', piece: 'q', tier: 3, name: 'Eternal Unit',  cost: { glory: 4, gold: 8 },  effect: 'eternalEmpress',   desc: 'On capture, Droid returns after 2 strategic turns.' },
  // General (king) upgrades
  { id: 'king_t1', piece: 'k', tier: 1, name: 'Royal Escort',     cost: { gold: 3, glory: 1 },  effect: 'royalGuard',       desc: 'Once per game, General moves 2 squares in any direction.' },
  { id: 'king_pres', piece: 'k', tier: 3, name: 'Living Legend',  cost: { glory: 5, gold: 10 }, effect: 'livingLegend',     desc: 'After 5 battles survived, all pieces gain a bonus move.' },
];

export const ARMY_UPGRADES_DATA = [
  { id: 'supply_lines',    name: 'Supply Lines',    cost: { grain: 3, gold: 2 },  desc: 'Grain costs halved; armies sustain 2 battles without resupply.' },
  { id: 'war_council',     name: 'Intel Package',   cost: { gold: 4, glory: 1 },  desc: 'Before battle, reveal opponent\'s 2 lost pieces.' },
  { id: 'fortification',   name: 'Fortification',   cost: { iron: 4, gold: 3 },   desc: 'When defending own territory, start with an extra Infantry.' },
  { id: 'merchant_guilds', name: 'Black Market',    cost: { gold: 5 },             desc: 'Cities produce +1 gold; connected territories earn 1 bonus gold/turn.' },
  { id: 'battle_hymns',    name: 'War Protocols',   cost: { glory: 2, gold: 3 },  desc: 'After checkmate win, Combat Droid starts 1 row advanced next battle.' },
  { id: 'imperial_decree', name: 'Command Override',cost: { glory: 4, gold: 8 },  desc: 'Once per campaign, convert a stalemate into attacker victory.' },
];

export const STARTING_RESOURCES = { gold: 5, iron: 5, grain: 5, glory: 0 };

export const BRIBE_COST = 4; // gold to flip neutral territory without battle

export const SURRENDER_THRESHOLD = 0.6; // 60% territory control triggers neutral auto-flip

export const CAPITAL_ATTACK_REQUIREMENT = 2; // opponent home territories needed before capital attack
