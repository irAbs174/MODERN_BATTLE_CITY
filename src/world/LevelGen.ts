import { Grid } from './Grid';
import { CELL, THEMES, Terrain, type ThemeId } from './terrain';
import { Rng } from '../core/Rng';
import type { LevelDef, WaveDef } from './levels';
import type { EnemyId } from '../data/enemies';

export interface GenOptions {
  seed: number;
  theme?: ThemeId;
  /** Authoring dimensions (each unit = 2x2 cells). */
  blocksX?: number;
  blocksY?: number;
  density?: number;
  openness?: number;
  symmetric?: boolean;
  name?: string;
  id?: number;
}

export interface GenResult {
  level: LevelDef;
  grid: Grid;
  base: { bx: number; by: number };
  playerSpawn: { bx: number; by: number };
  enemySpawns: { bx: number; by: number }[];
}

const THEMES_ORDER: ThemeId[] = ['arid', 'tundra', 'jungle', 'industrial', 'night', 'volcanic', 'void'];

function pickCover(theme: ThemeId, rng: Rng): Terrain {
  if (theme === 'industrial' || theme === 'void') {
    if (rng.chance(0.48)) return Terrain.Metal;
    return rng.chance(0.28) ? Terrain.Stone : Terrain.Brick;
  }
  if (theme === 'night' && rng.chance(0.2)) return Terrain.Metal;
  if (theme === 'volcanic' && rng.chance(0.16)) return Terrain.Metal;
  return rng.chance(0.18) ? Terrain.Stone : Terrain.Brick;
}

function pickFloor(theme: ThemeId, rng: Rng): Terrain {
  switch (theme) {
    case 'tundra':
      return rng.chance(0.72) ? Terrain.Ice : Terrain.Water;
    case 'jungle':
      return rng.chance(0.62) ? Terrain.Forest : Terrain.Water;
    case 'arid':
      return Terrain.Sand;
    case 'volcanic':
      return rng.chance(0.78) ? Terrain.Lava : Terrain.Sand;
    case 'industrial':
      return rng.chance(0.5) ? Terrain.Sand : Terrain.Metal;
    case 'night':
      return rng.chance(0.55) ? Terrain.Forest : Terrain.Water;
    case 'void':
      return rng.chance(0.5) ? Terrain.Ice : Terrain.Lava;
  }
}

function floorChance(theme: ThemeId): number {
  switch (theme) {
    case 'tundra':
      return 0.16;
    case 'jungle':
      return 0.18;
    case 'arid':
      return 0.12;
    case 'volcanic':
      return 0.14;
    case 'industrial':
      return 0.04;
    case 'night':
      return 0.1;
    case 'void':
      return 0.08;
  }
}

function scatterElements(
  grid: Grid,
  rng: Rng,
  theme: ThemeId,
  bx: number,
  by: number,
  stamp: (x: number, y: number, t: Terrain) => void,
  mirror: boolean,
): void {
  const chance = floorChance(theme);
  if (chance <= 0) return;
  const xMax = mirror ? Math.ceil(bx / 2) : bx - 1;
  for (let y = 2; y < by - 5; y++) {
    for (let x = 1; x < xMax; x++) {
      if (grid.at(x * 2, y * 2) !== Terrain.Empty) continue;
      if (rng.next() > chance) continue;
      stamp(x, y, pickFloor(theme, rng));
    }
  }
}

/**
 * Seeded procedural arena generator. Scatters brick, metal and elemental
 * ground with guaranteed spawn pads for the HQ, the player, and enemy entries.
 */
export function generateArena(opts: GenOptions): GenResult {
  const rng = new Rng(opts.seed);
  const theme = opts.theme ?? THEMES_ORDER[rng.int(0, THEMES_ORDER.length - 1)];
  const bx = opts.blocksX ?? rng.pick([22, 24, 24, 26]);
  const by = opts.blocksY ?? rng.pick([22, 24, 24, 26]);

  const cols = bx * 2;
  const rows = by * 2;
  const grid = new Grid(cols, rows, theme);
  grid.clear();

  const baseBX = Math.floor(bx / 2) - 1;
  const baseBY = by - 4;
  const playerBX = Math.max(2, baseBX - 4);
  const playerBY = baseBY + 1;
  const enemySpawns: { bx: number; by: number }[] = [
    { bx: 2, by: 1 },
    { bx: Math.floor(bx / 2), by: 1 },
    { bx: bx - 3, by: 1 },
    { bx: 1, by: Math.floor(by / 2) },
    { bx: bx - 2, by: Math.floor(by / 2) },
  ];

  const density = opts.density ?? 0.3;
  const openness = opts.openness ?? 0.4;
  const chance = density * (1 - openness * 0.35);
  const mirror = opts.symmetric ?? rng.chance(0.45);

  const stamp = (x: number, y: number, t: Terrain): void => {
    if (x < 1 || y < 1 || x >= bx - 1 || y >= by - 1) return;
    grid.fillBlock(x, y, 1, 1, t);
    if (mirror) grid.fillBlock(bx - 1 - x, y, 1, 1, t);
  };

  if (density > 0) {
    for (let y = 2; y < by - 5; y++) {
      for (let x = 1; x < (mirror ? Math.ceil(bx / 2) : bx - 1); x++) {
        if (rng.next() > chance) continue;
        stamp(x, y, pickCover(theme, rng));
      }
    }

    const runs = 4 + rng.int(0, 6);
    for (let i = 0; i < runs; i++) {
      const horiz = rng.chance(0.5);
      const len = rng.int(3, 7);
      const t = pickCover(theme, rng);
      if (horiz) {
        const y = rng.int(3, by - 6);
        const x0 = rng.int(2, Math.max(2, bx - len - 2));
        for (let k = 0; k < len; k++) stamp(x0 + k, y, t);
      } else {
        const x = rng.int(2, bx - 3);
        const y0 = rng.int(2, Math.max(2, by - len - 6));
        for (let k = 0; k < len; k++) stamp(x, y0 + k, t);
      }
    }

    scatterElements(grid, rng, theme, bx, by, stamp, mirror);
  }

  const clearPad = (px: number, py: number, r: number): void => {
    for (let y = py - r; y <= py + r; y++)
      for (let x = px - r; x <= px + r; x++) {
        if (x < 0 || y < 0 || x >= bx || y >= by) continue;
        grid.fillBlock(x, y, 1, 1, Terrain.Empty);
      }
  };
  clearPad(baseBX, baseBY, 2);
  clearPad(playerBX, playerBY, 2);
  for (const s of enemySpawns) clearPad(s.bx, s.by, 1);

  return {
    grid,
    base: { bx: baseBX, by: baseBY },
    playerSpawn: { bx: playerBX, by: playerBY },
    enemySpawns,
    level: {
      id: opts.id ?? -1,
      name: opts.name ?? 'GENERATED ARENA',
      subtitle: `${THEMES[theme].name} · seed ${opts.seed}`,
      world: 0,
      theme,
      map: [],
      waves: [] as WaveDef[],
      parTime: 0,
      intensity: 1,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Endless / survival wave director                                    */
/* ------------------------------------------------------------------ */

export interface DirectorState {
  wave: number;
  budget: number;
  seed: number;
}

const COSTS: Record<EnemyId, number> = {
  scout: 1,
  raider: 1.4,
  assault: 2,
  sniper: 2.6,
  missile: 3,
  shield: 3.2,
  hunter: 3.4,
  heavy: 4.2,
  elite: 5.6,
  wraith: 6.4,
  fortress: 26,
  colossus: 38,
};

/** Compose a wave from a budget, unlocking tougher units as waves rise. */
export function composeWave(state: DirectorState, rng: Rng, mode: 'endless' | 'survival' | 'challenge'): WaveDef {
  const w = state.wave;
  const budget = Math.round(6 + w * 3.1 + Math.pow(w, 1.28));
  const pool: EnemyId[] = ['scout'];
  if (w >= 2) pool.push('assault');
  if (w >= 3) pool.push('raider');
  if (w >= 4) pool.push('sniper');
  if (w >= 5) pool.push('shield', 'heavy');
  if (w >= 7) pool.push('missile', 'hunter');
  if (w >= 10) pool.push('elite');
  if (w >= 13) pool.push('wraith');

  const groups: { type: EnemyId; count: number; interval: number; spawn: number }[] = [];
  let remaining = budget;
  let guard = 0;
  while (remaining > 0.5 && guard++ < 60) {
    const affordable = pool.filter((p) => COSTS[p] <= remaining + 0.001);
    if (!affordable.length) break;
    // bias toward cheaper units early, mix in elites later
    const weights = affordable.map((p) => {
      const base = 1 / COSTS[p];
      const late = w > 8 ? 1 + (COSTS[p] - 1) * 0.16 : 1;
      return base * late;
    });
    const type = rng.weighted(affordable, weights);
    const maxCount = Math.max(1, Math.min(6, Math.floor(remaining / COSTS[type])));
    const count = mode === 'survival' ? Math.max(1, Math.ceil(maxCount * 0.6)) : rng.int(1, maxCount);
    groups.push({
      type,
      count,
      interval: type === 'scout' ? 0.45 : type === 'elite' || type === 'wraith' ? 1.3 : 0.85,
      spawn: groups.length % 5,
    });
    remaining -= count * COSTS[type];
  }

  const isBossWave = w > 0 && w % 8 === 0;
  if (isBossWave) {
    groups.unshift({
      type: w >= 24 ? 'colossus' : 'fortress',
      count: 1,
      interval: 0,
      spawn: 1,
    });
  }

  return {
    index: w,
    delay: isBossWave ? 3.2 : Math.max(1.4, 4.2 - w * 0.12),
    groups,
    announce: isBossWave ? '⚠ BOSS DETECTED' : mode === 'survival' ? `HOLD — WAVE ${w + 1}` : `WAVE ${w + 1}`,
  };
}

export const enemyCost = (id: EnemyId): number => COSTS[id] ?? 2;
export { CELL };
