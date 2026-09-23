/** Terrain type definitions and per-theme palette data. */

export const CELL = 16; // fine grid cell size in world units

export const enum Terrain {
  Empty = 0,
  Brick = 1,
  Stone = 2,
  Ice = 3,
  Metal = 4,
  Water = 5,
  Forest = 6,
  Sand = 7,
  Lava = 8,
}

export interface TerrainDef {
  name: string;
  solid: boolean;
  blocksBullets: boolean;
  hp: number;
  /** 0..1 damage reduction before armor pierce is applied. */
  armor: number;
  /** Multiplier applied to tank max speed while on this cell. */
  speedFactor: number;
  /** Multiplier applied to tank traction (accel + friction). */
  grip: number;
  destructible: boolean;
  /** Blocks line of sight for AI. */
  blocksSight: boolean;
  /** Impassable to treads; hover chassis can cross. */
  liquid: boolean;
  /** Hull DPS while occupying this cell (0 = none). */
  hazardDps: number;
  /** Hides tanks from the minimap and dulls their silhouette. */
  conceals: boolean;
  dust: string;
}

const ground: Pick<TerrainDef, 'solid' | 'blocksBullets' | 'hp' | 'armor' | 'destructible' | 'blocksSight' | 'liquid' | 'hazardDps' | 'conceals'> = {
  solid: false,
  blocksBullets: false,
  hp: 0,
  armor: 0,
  destructible: false,
  blocksSight: false,
  liquid: false,
  hazardDps: 0,
  conceals: false,
};

export const TERRAIN: Record<Terrain, TerrainDef> = {
  [Terrain.Empty]: {
    ...ground,
    name: 'Ground',
    speedFactor: 1,
    grip: 1,
    dust: '#c9a06a',
  },
  [Terrain.Brick]: {
    name: 'Brick',
    solid: true,
    blocksBullets: true,
    hp: 26,
    armor: 0,
    speedFactor: 1,
    grip: 1,
    destructible: true,
    blocksSight: true,
    liquid: false,
    hazardDps: 0,
    conceals: false,
    dust: '#d46a48',
  },
  [Terrain.Stone]: {
    name: 'Stone',
    solid: true,
    blocksBullets: true,
    hp: 140,
    armor: 0.72,
    speedFactor: 1,
    grip: 1,
    destructible: true,
    blocksSight: true,
    liquid: false,
    hazardDps: 0,
    conceals: false,
    dust: '#9aa3b0',
  },
  [Terrain.Ice]: {
    ...ground,
    name: 'Ice',
    hp: 18,
    speedFactor: 1.22,
    grip: 0.2,
    destructible: true,
    dust: '#cfe9ff',
  },
  [Terrain.Metal]: {
    name: 'Metal',
    solid: true,
    blocksBullets: true,
    hp: 210,
    armor: 0.86,
    speedFactor: 1,
    grip: 1,
    destructible: true,
    blocksSight: true,
    liquid: false,
    hazardDps: 0,
    conceals: false,
    dust: '#c8b48a',
  },
  [Terrain.Water]: {
    ...ground,
    name: 'Water',
    liquid: true,
    speedFactor: 0.55,
    grip: 0.4,
    dust: '#6ec4e8',
  },
  [Terrain.Forest]: {
    ...ground,
    name: 'Forest',
    hp: 16,
    speedFactor: 0.82,
    grip: 0.88,
    destructible: true,
    blocksSight: true,
    conceals: true,
    dust: '#6a8f48',
  },
  [Terrain.Sand]: {
    ...ground,
    name: 'Sand',
    speedFactor: 0.62,
    grip: 0.72,
    dust: '#e0c48a',
  },
  [Terrain.Lava]: {
    ...ground,
    name: 'Lava',
    speedFactor: 0.7,
    grip: 0.8,
    hazardDps: 22,
    dust: '#ff7a3a',
  },
};

/** Authoring characters used by handcrafted level maps (each = a 2x2 cell block). */
export const CHAR_TO_TERRAIN: Record<string, Terrain> = {
  '.': Terrain.Empty,
  ' ': Terrain.Empty,
  '#': Terrain.Brick,
  '@': Terrain.Stone,
  I: Terrain.Ice,
  M: Terrain.Metal,
  '~': Terrain.Water,
  T: Terrain.Forest,
  B: Terrain.Forest,
  ',': Terrain.Sand,
  A: Terrain.Lava,
};

export interface TilePalette {
  fill: string;
  mortar: string;
  lite: string;
  shade: string;
}

/** Palette used by the terrain atlas / minimap (independent of biome). */
export const WALL_COLORS: Record<Terrain.Brick | Terrain.Stone | Terrain.Metal, TilePalette> = {
  [Terrain.Brick]: { fill: '#b44a32', mortar: '#3a2218', lite: '#d46a48', shade: '#7a2e22' },
  [Terrain.Stone]: { fill: '#6d7584', mortar: '#2a3038', lite: '#9aa3b0', shade: '#4a525e' },
  [Terrain.Metal]: { fill: '#8a93a3', mortar: '#1c222c', lite: '#d4dbe8', shade: '#4e5968' },
};

export const TILE_COLORS: Record<Terrain, string> = {
  [Terrain.Empty]: 'transparent',
  [Terrain.Brick]: WALL_COLORS[Terrain.Brick].fill,
  [Terrain.Stone]: WALL_COLORS[Terrain.Stone].fill,
  [Terrain.Ice]: '#8fd4f0',
  [Terrain.Metal]: WALL_COLORS[Terrain.Metal].fill,
  [Terrain.Water]: '#2a6ea8',
  [Terrain.Forest]: '#2f6b32',
  [Terrain.Sand]: '#c4a05a',
  [Terrain.Lava]: '#e24a18',
};

export const isSolidTerrain = (t: Terrain): boolean => TERRAIN[t].solid;
export const blocksBullets = (t: Terrain): boolean => TERRAIN[t].blocksBullets;
export const isArmoredTerrain = (t: Terrain): boolean => t === Terrain.Stone || t === Terrain.Metal;
export const isHazardTerrain = (t: Terrain): boolean => TERRAIN[t].hazardDps > 0;

export type ThemeId = 'arid' | 'tundra' | 'jungle' | 'industrial' | 'night' | 'volcanic' | 'void';

export interface ThemePalette {
  id: ThemeId;
  name: string;
  ground: [string, string]; // base + checker
  groundAccent: string;
  grid: string;
  fog: string;
  vignette: string;
  accent: string;
  dust: string;
  /** Background music key */
  music: 'desert' | 'frost' | 'jungle' | 'steel' | 'night' | 'inferno';
}

export const THEMES: Record<ThemeId, ThemePalette> = {
  arid: {
    id: 'arid',
    name: 'Arid Basin',
    ground: ['#2b2418', '#322a1c'],
    groundAccent: '#4a3d26',
    grid: 'rgba(255,220,150,0.035)',
    fog: 'rgba(120,90,40,0.06)',
    vignette: 'rgba(20,12,4,0.55)',
    accent: '#ffb547',
    dust: '#c9a06a',
    music: 'desert',
  },
  tundra: {
    id: 'tundra',
    name: 'Tundra Front',
    ground: ['#1c2530', '#212c39'],
    groundAccent: '#2f3f52',
    grid: 'rgba(150,220,255,0.04)',
    fog: 'rgba(160,210,255,0.05)',
    vignette: 'rgba(6,12,22,0.6)',
    accent: '#6fe3ff',
    dust: '#cfe9ff',
    music: 'frost',
  },
  jungle: {
    id: 'jungle',
    name: 'Verdant Reach',
    ground: ['#18230f', '#1d2a13'],
    groundAccent: '#2b3d1b',
    grid: 'rgba(180,255,140,0.035)',
    fog: 'rgba(90,180,90,0.05)',
    vignette: 'rgba(4,14,4,0.6)',
    accent: '#7cff6b',
    dust: '#9fd47a',
    music: 'jungle',
  },
  industrial: {
    id: 'industrial',
    name: 'Foundry Sector',
    ground: ['#1a1a1e', '#202026'],
    groundAccent: '#2d2d35',
    grid: 'rgba(255,190,80,0.035)',
    fog: 'rgba(255,160,60,0.045)',
    vignette: 'rgba(8,8,10,0.62)',
    accent: '#ff9c3a',
    dust: '#b8a894',
    music: 'steel',
  },
  night: {
    id: 'night',
    name: 'Blackout Grid',
    ground: ['#0e1018', '#12151f'],
    groundAccent: '#1b2030',
    grid: 'rgba(120,160,255,0.05)',
    fog: 'rgba(70,90,200,0.06)',
    vignette: 'rgba(2,4,12,0.72)',
    accent: '#7aa2ff',
    dust: '#8fa0d8',
    music: 'night',
  },
  volcanic: {
    id: 'volcanic',
    name: 'Ember Wastes',
    ground: ['#241210', '#2b1714'],
    groundAccent: '#3d201a',
    grid: 'rgba(255,120,60,0.04)',
    fog: 'rgba(255,80,30,0.07)',
    vignette: 'rgba(16,4,2,0.66)',
    accent: '#ff5e2b',
    dust: '#ff9a6a',
    music: 'inferno',
  },
  void: {
    id: 'void',
    name: 'Sim Core',
    ground: ['#0b0a14', '#100e1c'],
    groundAccent: '#1a1630',
    grid: 'rgba(190,120,255,0.06)',
    fog: 'rgba(150,90,255,0.06)',
    vignette: 'rgba(6,2,16,0.7)',
    accent: '#c47bff',
    dust: '#b99cff',
    music: 'night',
  },
};
