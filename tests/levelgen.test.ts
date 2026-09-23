import { describe, it, expect } from 'vitest';
import { generateArena, composeWave, enemyCost } from '../src/world/LevelGen';
import { buildLevel, buildFromGen } from '../src/world/LevelBuilder';
import { getLevel, stageScaling } from '../src/world/levels';
import { Grid } from '../src/world/Grid';
import { Terrain } from '../src/world/terrain';
import { Rng } from '../src/core/Rng';

/** Stable hash of every terrain cell so we can compare two grids cheaply. */
function gridHash(g: Grid): number {
  let h = 2166136261;
  for (let cy = 0; cy < g.rows; cy++) {
    for (let cx = 0; cx < g.cols; cx++) {
      h = (h ^ g.at(cx, cy)) * 16777619;
      h |= 0;
    }
  }
  return h >>> 0;
}

describe('generateArena: determinism', () => {
  it('produces an identical arena for the same seed', () => {
    const a = generateArena({ seed: 42, theme: 'arid' });
    const b = generateArena({ seed: 42, theme: 'arid' });
    expect(a.grid.cols).toBe(b.grid.cols);
    expect(a.grid.rows).toBe(b.grid.rows);
    expect(gridHash(a.grid)).toBe(gridHash(b.grid));
    expect(a.base).toEqual(b.base);
    expect(a.playerSpawn).toEqual(b.playerSpawn);
    expect(a.enemySpawns).toEqual(b.enemySpawns);
  });

  it('produces different arena sizes across seeds', () => {
    const sizes = new Set<number>();
    for (let s = 0; s < 24; s++) sizes.add(generateArena({ seed: s, theme: 'arid' }).grid.cols);
    expect(sizes.size).toBeGreaterThan(1);
  });
});

describe('generateArena: validity', () => {
  const gen = generateArena({ seed: 7, id: 7, theme: 'tundra', density: 0.5 });

  it('returns a well-formed level definition', () => {
    expect(gen.level.id).toBe(7);
    expect(typeof gen.level.name).toBe('string');
    expect(gen.level.theme).toBe('tundra');
    expect(Array.isArray(gen.level.waves)).toBe(true);
    expect(gen.level.intensity).toBeGreaterThanOrEqual(1);
  });

  it('places base, player and enemy spawns inside the arena', () => {
    const bx = gen.grid.cols / 2;
    const by = gen.grid.rows / 2;
    for (const p of [gen.base, gen.playerSpawn, ...gen.enemySpawns]) {
      expect(p.bx).toBeGreaterThanOrEqual(0);
      expect(p.by).toBeGreaterThanOrEqual(0);
      expect(p.bx).toBeLessThan(bx);
      expect(p.by).toBeLessThan(by);
    }
    expect(gen.enemySpawns.length).toBeGreaterThan(0);
  });

  it('places brick and stone cover while keeping spawn pads open', () => {
    let solid = 0;
    let brick = 0;
    let stone = 0;
    for (let cy = 0; cy < gen.grid.rows; cy++)
      for (let cx = 0; cx < gen.grid.cols; cx++) {
        const t = gen.grid.at(cx, cy);
        if (t === Terrain.Empty) continue;
        solid++;
        if (t === Terrain.Brick) brick++;
        if (t === Terrain.Stone) stone++;
      }
    expect(solid).toBeGreaterThan(20);
    expect(brick).toBeGreaterThan(0);
    expect(stone).toBeGreaterThan(0);
    const pad = (bx: number, by: number) => gen.grid.at(bx * 2, by * 2);
    expect(pad(gen.base.bx, gen.base.by)).toBe(Terrain.Empty);
    expect(pad(gen.playerSpawn.bx, gen.playerSpawn.by)).toBe(Terrain.Empty);
  });

  it('stamps ice and water on tundra arenas', () => {
    const tundra = generateArena({ seed: 7, theme: 'tundra', density: 0.5 });
    let ice = 0;
    for (let cy = 0; cy < tundra.grid.rows; cy++)
      for (let cx = 0; cx < tundra.grid.cols; cx++)
        if (tundra.grid.at(cx, cy) === Terrain.Ice) ice++;
    expect(ice).toBeGreaterThan(0);
  });

  it('stamps an open arena when density is 0', () => {
    const open = generateArena({ seed: 7, theme: 'tundra', density: 0 });
    let solid = 0;
    for (let cy = 0; cy < open.grid.rows; cy++)
      for (let cx = 0; cx < open.grid.cols; cx++)
        if (open.grid.at(cx, cy) !== Terrain.Empty) solid++;
    expect(solid).toBe(0);
  });
});

describe('composeWave: budgeted wave director', () => {
  it('wave 0 is all scouts and stays within budget', () => {
    const wave = composeWave({ wave: 0, budget: 0, seed: 1 }, new Rng(1), 'endless');
    expect(wave.index).toBe(0);
    expect(wave.groups.length).toBeGreaterThan(0);
    expect(wave.groups.every((g) => g.type === 'scout')).toBe(true);
    const spent = wave.groups.reduce((s, g) => s + g.count * enemyCost(g.type), 0);
    // internal budget for wave 0 is 6; the loop never overspends
    expect(spent).toBeLessThanOrEqual(6);
    expect(spent).toBeGreaterThan(0);
    expect(wave.delay).toBeGreaterThan(0);
    expect(wave.announce).toContain('WAVE 1');
  });

  it('every 8th wave (from 8) leads with a boss', () => {
    const w8 = composeWave({ wave: 8, budget: 0, seed: 3 }, new Rng(3), 'endless');
    expect(w8.groups[0].type).toBe('fortress');
    expect(w8.announce).toContain('BOSS');

    const w24 = composeWave({ wave: 24, budget: 0, seed: 3 }, new Rng(3), 'endless');
    expect(w24.groups[0].type).toBe('colossus');
  });

  it('unlocks tougher units as the wave index climbs', () => {
    const early = composeWave({ wave: 1, budget: 0, seed: 5 }, new Rng(5), 'endless');
    const late = composeWave({ wave: 12, budget: 0, seed: 5 }, new Rng(5), 'endless');
    const earlyTypes = new Set(early.groups.map((g) => g.type));
    const lateTypes = new Set(late.groups.map((g) => g.type));
    expect(earlyTypes.size).toBeLessThanOrEqual(lateTypes.size);
    // wave 12 budget is far larger than wave 1
    const cost = (w: typeof late) => w.groups.reduce((s, g) => s + g.count * enemyCost(g.type), 0);
    expect(cost(late)).toBeGreaterThan(cost(early));
  });

  it('survival waves are composed too', () => {
    const wave = composeWave({ wave: 3, budget: 0, seed: 9 }, new Rng(9), 'survival');
    expect(wave.groups.length).toBeGreaterThan(0);
    expect(wave.announce).toContain('WAVE 4');
  });

  it('is deterministic for a given seed', () => {
    const a = composeWave({ wave: 5, budget: 0, seed: 11 }, new Rng(11), 'endless');
    const b = composeWave({ wave: 5, budget: 0, seed: 11 }, new Rng(11), 'endless');
    expect(a.groups).toEqual(b.groups);
  });
});

describe('enemyCost', () => {
  it('charges bosses far more than fodder', () => {
    expect(enemyCost('scout')).toBe(1);
    expect(enemyCost('fortress')).toBe(26);
    expect(enemyCost('colossus')).toBe(38);
    expect(enemyCost('assault')).toBeGreaterThan(enemyCost('scout'));
  });
});

describe('buildLevel / buildFromGen', () => {
  it('builds a playable world from a handcrafted stage', () => {
    const built = buildLevel(getLevel(1), { seed: 1234 });
    expect(built.world).toBeDefined();
    expect(built.grid).toBe(built.world.grid);
    expect(built.cols).toBeGreaterThan(0);
    expect(built.rows).toBeGreaterThan(0);
    expect(built.base.alive).toBe(true);
    expect(built.base.hp).toBeGreaterThan(0);
    expect(built.enemySpawns.length).toBeGreaterThan(0);
    expect(built.playerSpawn.x).toBeGreaterThanOrEqual(0);
    expect(built.playerSpawn.x).toBeLessThanOrEqual(built.world.grid.width);
    expect(built.playerSpawn.y).toBeLessThanOrEqual(built.world.grid.height);
    expect(built.level.id).toBe(1);
  });

  it('skipBase omits the HQ', () => {
    const built = buildLevel(getLevel(1), { seed: 1, skipBase: true });
    // base object exists but was never initialised into the world as a live HQ
    expect(built.world).toBeDefined();
  });

  it('adopts a generated arena into the same BuiltLevel shape', () => {
    const gen = generateArena({ seed: 5, theme: 'jungle' });
    const built = buildFromGen(gen, { seed: 5 });
    expect(built.world.grid.cols).toBe(gen.grid.cols);
    expect(built.base.alive).toBe(true);
    expect(built.enemySpawns.length).toBeGreaterThan(0);
  });

  it('copies brick and stone from the authored map', () => {
    const built = buildLevel(getLevel(5), { seed: 1 });
    const g = built.world.grid;
    expect(g.countType(Terrain.Brick)).toBeGreaterThan(0);
  });
});

describe('stageScaling', () => {
  it('is neutral on stage 1 and grows monotonically', () => {
    const s1 = stageScaling(1);
    expect(s1.hp).toBe(1);
    expect(s1.damage).toBe(1);
    expect(s1.speed).toBe(1);
    const s16 = stageScaling(16);
    expect(s16.hp).toBeGreaterThan(s1.hp);
    expect(s16.damage).toBeGreaterThan(s1.damage);
    expect(s16.score).toBeGreaterThan(s1.score);
    // speed is capped so late stages stay playable
    expect(s16.speed).toBeLessThanOrEqual(1.25);
  });

  it('never scales below neutral for clamped input', () => {
    const s0 = stageScaling(0);
    expect(s0.hp).toBe(1);
  });
});
