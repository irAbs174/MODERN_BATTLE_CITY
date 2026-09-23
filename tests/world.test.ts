import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/World';
import { buildLevel } from '../src/world/LevelBuilder';
import { getLevel } from '../src/world/levels';
import { PlayerTank, emptyInput } from '../src/entities/PlayerTank';
import { CHASSIS, emptyUpgrades } from '../src/data/progression';
import { Terrain, CELL } from '../src/world/terrain';
import { CFG, combatFromDifficulty, getDifficulty } from '../src/core/config';
import { getEnemy } from '../src/data/enemies';
import type { BuiltLevel } from '../src/world/LevelBuilder';

function makeWorld(): { built: BuiltLevel; world: World; player: PlayerTank } {
  const built = buildLevel(getLevel(1), { seed: 1234 });
  const world = built.world;
  const player = new PlayerTank(CHASSIS.ranger, emptyUpgrades(), ['cannon'], 'dash');
  player.x = built.playerSpawn.x;
  player.y = built.playerSpawn.y;
  world.setPlayer(player);
  return { built, world, player };
}

/** Enemies spawn with ~0.9s of protection; clear it so damage lands immediately. */
function vulnerable<T extends { invuln: number }>(e: T): T {
  e.invuln = 0;
  return e;
}

let ctx: ReturnType<typeof makeWorld>;
let world: World;
let player: PlayerTank;
let built: BuiltLevel;

beforeEach(() => {
  ctx = makeWorld();
  world = ctx.world;
  player = ctx.player;
  built = ctx.built;
});

describe('World: construction', () => {
  it('wires up grid, base and player', () => {
    expect(world.grid).toBe(built.grid);
    expect(world.grid.cols).toBe(built.cols);
    expect(world.base.alive).toBe(true);
    expect(world.player).toBe(player);
    expect(world.time).toBe(0);
    expect(world.enemies).toHaveLength(0);
  });
});

describe('World: spawning enemies', () => {
  it('adds a live enemy tank at the requested spot', () => {
    const spot = built.enemySpawns[0];
    const e = world.spawnEnemy('assault', spot.x, spot.y);
    expect(world.enemies).toHaveLength(1);
    expect(world.enemies[0]).toBe(e);
    expect(e.alive).toBe(true);
    expect(e.team).toBe('enemy');
    expect(e.def.id).toBe('assault');
    expect(e.hp).toBeGreaterThan(0);
    expect(world.aliveEnemies).toBe(1);
  });

  it('elite flag is honoured', () => {
    const spot = built.enemySpawns[0];
    const normal = world.spawnEnemy('scout', spot.x, spot.y, false);
    const elite = world.spawnEnemy('scout', spot.x + 40, spot.y, true);
    expect(normal.elite).toBe(false);
    expect(elite.elite).toBe(true);
    // elites are beefier
    expect(elite.maxHp).toBeGreaterThanOrEqual(normal.maxHp);
  });
});

describe('World: firing', () => {
  it('playerFire spawns projectiles and counts the shot', () => {
    player.turret = 0;
    const before = world.projectiles.activeCount;
    world.playerFire(player);
    expect(world.shotsFired).toBe(1);
    expect(player.shotsFired).toBe(1);
    expect(world.projectiles.activeCount).toBeGreaterThan(before);
    expect(player.fireCooldown).toBeGreaterThan(0);
  });

  it('accuracy is 0 with no hits and stays within [0,1]', () => {
    expect(world.accuracy).toBe(0);
    player.turret = 0;
    world.playerFire(player);
    expect(world.accuracy).toBe(0); // fired but nothing hit yet
    world.shotsHit = 1;
    world.shotsFired = 2;
    expect(world.accuracy).toBeCloseTo(0.5, 6);
  });
});

describe('World: damage, kills & scoring', () => {
  it('spawn protection absorbs damage briefly, then expires', () => {
    const spot = built.enemySpawns[0];
    const e = world.spawnEnemy('scout', spot.x, spot.y);
    expect(e.invuln).toBeGreaterThan(0);

    const hp0 = e.hp;
    const blocked = e.takeDamage(world, {
      amount: 50,
      fromX: e.x,
      fromY: e.y,
      source: 'bullet',
      team: 'player',
    });
    expect(blocked.applied).toBe(0);
    expect(blocked.blocked).toBe(50);
    expect(blocked.killed).toBe(false);
    expect(e.hp).toBe(hp0);

    // once protection lapses the same hit lands
    e.invuln = 0;
    const landed = e.takeDamage(world, {
      amount: 50,
      fromX: e.x,
      fromY: e.y,
      source: 'bullet',
      team: 'player',
    });
    expect(landed.applied).toBeGreaterThan(0);
    expect(e.hp).toBeLessThan(hp0);
  });

  it('lethal damage kills an enemy and awards score/combo/kill', () => {
    const spot = built.enemySpawns[0];
    const e = vulnerable(world.spawnEnemy('assault', spot.x, spot.y));
    e.takeDamage(world, {
      amount: 99999,
      fromX: e.x,
      fromY: e.y,
      source: 'explosion',
      team: 'player',
    });
    expect(e.alive).toBe(false);
    expect(world.kills).toBe(1);
    expect(world.score).toBeGreaterThan(0);
    expect(world.combo).toBe(1);
    expect(world.bestCombo).toBe(1);
  });

  it('combo stacks across consecutive kills', () => {
    const spot = built.enemySpawns[0];
    const a = vulnerable(world.spawnEnemy('scout', spot.x, spot.y));
    const b = vulnerable(world.spawnEnemy('scout', spot.x + 50, spot.y));
    for (const e of [a, b])
      e.takeDamage(world, { amount: 99999, fromX: e.x, fromY: e.y, source: 'bullet', team: 'player' });
    expect(world.kills).toBe(2);
    expect(world.combo).toBe(2);
    expect(world.bestCombo).toBe(2);
  });

  it('dead enemies are dropped from the active list immediately', () => {
    const spot = built.enemySpawns[0];
    const e = vulnerable(world.spawnEnemy('scout', spot.x, spot.y));
    expect(world.enemies).toHaveLength(1);

    e.takeDamage(world, { amount: 99999, fromX: e.x, fromY: e.y, source: 'bullet', team: 'player' });
    expect(e.alive).toBe(false);
    // onEnemyDeath prunes synchronously, so the sim never iterates a corpse
    expect(world.enemies).toHaveLength(0);
    expect(world.aliveEnemies).toBe(0);

    world.update(1 / 60, emptyInput());
    expect(world.enemies).toHaveLength(0);
  });

  it('explosions chip enemy HP without friendly fire', () => {
    const spot = built.enemySpawns[0];
    const e = vulnerable(world.spawnEnemy('heavy', spot.x, spot.y));
    const hp0 = e.hp;
    world.explode(e.x, e.y, 70, 12, { team: 'player' });
    expect(e.hp).toBeLessThan(hp0);
    // an enemy-team explosion does not hurt other enemies
    const e2 = vulnerable(world.spawnEnemy('heavy', spot.x + 60, spot.y));
    const hp2 = e2.hp;
    world.explode(e2.x, e2.y, 70, 12, { team: 'enemy' });
    expect(e2.hp).toBe(hp2);
  });
});

describe('World: terrain destruction', () => {
  it('explosions do not change open ground', () => {
    const cx = 4;
    const cy = 4;
    expect(world.grid.at(cx, cy)).toBe(Terrain.Empty);
    world.explode(cx * CELL + CELL / 2, cy * CELL + CELL / 2, 40, 120, {
      team: 'player',
      damageTerrain: true,
    });
    expect(world.grid.at(cx, cy)).toBe(Terrain.Empty);
  });

  it('explosions demolish nearby brick', () => {
    const cx = 6;
    const cy = 6;
    world.grid.setCell(cx, cy, Terrain.Brick);
    world.explode(cx * CELL + CELL / 2, cy * CELL + CELL / 2, 40, 120, {
      team: 'player',
      damageTerrain: true,
    });
    expect(world.grid.at(cx, cy)).toBe(Terrain.Empty);
    expect(world.terrainDestroyed).toBeGreaterThan(0);
  });

  it('lava burns a tank that sits on it', () => {
    const cx = Math.floor(player.x / CELL);
    const cy = Math.floor(player.y / CELL);
    world.grid.setCell(cx, cy, Terrain.Lava);
    player.invuln = 0;
    player.invulnOnSpawn = 0;
    const hp0 = player.hp;
    for (let i = 0; i < 90; i++) world.update(1 / 60, emptyInput());
    expect(player.hp).toBeLessThan(hp0);
  });
});

describe('World: the base (HQ)', () => {
  it('enemy explosions damage the base', () => {
    const hp0 = world.base.hp;
    world.explode(world.base.x, world.base.y, 90, 120, { team: 'enemy' });
    expect(world.base.hp).toBeLessThan(hp0);
    expect(world.base.alive).toBe(true);
  });

  it('player-team explosions do not hurt your own base', () => {
    const hp0 = world.base.hp;
    world.explode(world.base.x, world.base.y, 90, 120, { team: 'player' });
    expect(world.base.hp).toBe(hp0);
  });

  it('destroying the base emits baseDestroyed and marks it dead', () => {
    let fired = false;
    world.events.on('baseDestroyed', () => (fired = true));
    world.base.takeDamage(world, 999999, world.base.x, world.base.y);
    expect(world.base.alive).toBe(false);
    expect(world.base.hp).toBe(0);
    expect(fired).toBe(true);
  });
});

describe('World: power-ups', () => {
  it('spawns a power-up and collecting it heals + counts', () => {
    player.hp = 10;
    const pu = world.spawnPowerUp(player.x + 30, player.y, 'health');
    expect(pu).not.toBeNull();
    expect(pu!.def.id).toBe('health');
    world.collectPowerUp(pu!);
    expect(player.hp).toBeGreaterThan(10);
    expect(world.powerupsCollected).toBe(1);
  });

  it('a coin power-up adds to the run economy', () => {
    const coins0 = world.coinsEarned;
    const pu = world.spawnPowerUp(player.x + 30, player.y, 'coin');
    world.collectPowerUp(pu!);
    expect(world.coinsEarned).toBeGreaterThan(coins0);
  });
});

describe('World: player death', () => {
  it('costs a life, resets combo and arms the respawn timer', () => {
    const lives0 = player.lives;
    player.takeDamage(world, {
      amount: 999999,
      fromX: player.x,
      fromY: player.y,
      source: 'explosion',
      team: 'enemy',
    });
    expect(player.alive).toBe(false);
    expect(player.lives).toBe(lives0 - 1);
    expect(world.combo).toBe(0);
    expect(player.respawnTimer).toBeGreaterThan(0);
  });

  it('respawns at the spawn point after the timer if lives remain', () => {
    player.takeDamage(world, {
      amount: 999999,
      fromX: player.x,
      fromY: player.y,
      source: 'explosion',
      team: 'enemy',
    });
    expect(player.alive).toBe(false);
    for (let i = 0; i < 150; i++) world.update(1 / 60, emptyInput());
    expect(player.alive).toBe(true);
    expect(player.hp).toBe(player.maxHp);
    expect(player.lives).toBe(CFG.player.lives - 1);
  });

  it('does not respawn after the last life', () => {
    player.lives = 1;
    player.takeDamage(world, {
      amount: 999999,
      fromX: player.x,
      fromY: player.y,
      source: 'explosion',
      team: 'enemy',
    });
    expect(player.alive).toBe(false);
    expect(player.lives).toBe(0);
    expect(player.respawnTimer).toBe(0);
    for (let i = 0; i < 30; i++) world.update(1 / 60, emptyInput());
    expect(player.alive).toBe(false);
  });
});

describe('World: simulation step', () => {
  it('advances time and runs many frames without throwing', () => {
    const spot = built.enemySpawns[0];
    world.spawnEnemy('assault', spot.x, spot.y);
    world.spawnEnemy('scout', spot.x + 40, spot.y + 20);
    for (let i = 0; i < 180; i++) world.update(1 / 60, emptyInput());
    expect(world.time).toBeCloseTo(3, 1);
    expect(world.time).toBeGreaterThan(2.5);
  });

  it('reset clears entities, combo and projectiles', () => {
    const spot = built.enemySpawns[0];
    world.spawnEnemy('scout', spot.x, spot.y);
    player.turret = 0;
    world.playerFire(player);
    world.combo = 4;
    expect(world.projectiles.activeCount).toBeGreaterThan(0);
    world.reset();
    expect(world.enemies).toHaveLength(0);
    expect(world.combo).toBe(0);
    expect(world.projectiles.activeCount).toBe(0);
  });
});

describe('World: boss difficulty scaling', () => {
  it('applies dedicated Recruit vs Veteran boss multipliers to hull, shield, armor and damage', () => {
    const scaling = { hp: 1, damage: 1, speed: 1, rate: 1 };
    const recruit = combatFromDifficulty(getDifficulty('recruit'));
    const veteran = combatFromDifficulty(getDifficulty('veteran'));
    const def = getEnemy('fortress');

    world.setScaling(scaling, recruit, 1);
    const r = world.spawnEnemy('fortress', built.enemySpawns[0].x, built.enemySpawns[0].y);
    world.setScaling(scaling, veteran, 1);
    const v = world.spawnEnemy('fortress', built.enemySpawns[0].x + 80, built.enemySpawns[0].y);

    expect(r.maxHp).toBe(Math.round(def.hp * recruit.bossHp));
    expect(v.maxHp).toBe(Math.round(def.hp * veteran.bossHp));
    expect(r.maxHp).toBeLessThan(v.maxHp);
    expect(r.shieldMax).toBe(Math.round((def.shield?.amount ?? 0) * recruit.bossShield));
    expect(v.shieldMax).toBe(Math.round((def.shield?.amount ?? 0) * veteran.bossShield));
    expect(r.armor).toBeCloseTo(def.armor * recruit.bossArmor, 5);
    expect(v.armor).toBeCloseTo(def.armor * veteran.bossArmor, 5);
    expect(r.damageBase).toBeCloseTo(def.damage * recruit.bossDmg, 5);
    expect(v.damageBase).toBeCloseTo(def.damage * veteran.bossDmg, 5);
    expect(r.fireDelay).toBeCloseTo(def.fireDelay / recruit.bossRate, 5);
  });

  it('caps late-stage HP scaling for bosses', () => {
    const recruit = combatFromDifficulty(getDifficulty('recruit'));
    const def = getEnemy('colossus');
    world.setScaling({ hp: 1.825, damage: 1.75, speed: 1.22, rate: 1.45 }, recruit, 1);
    const boss = world.spawnEnemy('colossus', built.enemySpawns[0].x, built.enemySpawns[0].y);
    expect(boss.maxHp).toBe(Math.round(def.hp * recruit.bossHpScaleCap * recruit.bossHp));
  });
});

describe('World: tank separation (regression)', () => {
  it('never injects the player into the enemy list', () => {
    const spot = built.enemySpawns[0];
    // stack enemies on top of each other so separateTank does real work every frame
    world.spawnEnemy('scout', spot.x, spot.y);
    world.spawnEnemy('scout', spot.x + 2, spot.y + 2);
    world.spawnEnemy('assault', spot.x + 4, spot.y);

    for (let i = 0; i < 120; i++) world.update(1 / 60, emptyInput());

    expect(world.enemies).not.toContain(player);
    expect(world.enemies.every((e) => e.team === 'enemy')).toBe(true);
    // the buggy version appended the player once per enemy per frame
    expect(world.enemies.length).toBeLessThanOrEqual(3);
    expect(world.player).toBe(player);
    expect(world.aliveEnemies).toBeLessThanOrEqual(3);
  });

  it('still pushes overlapping tanks apart', () => {
    const spot = built.enemySpawns[0];
    const a = world.spawnEnemy('scout', spot.x, spot.y);
    const b = world.spawnEnemy('scout', spot.x + 1, spot.y);
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    for (let i = 0; i < 30; i++) world.update(1 / 60, emptyInput());
    const after = Math.hypot(a.x - b.x, a.y - b.y);
    expect(after).toBeGreaterThan(before);
  });
});
