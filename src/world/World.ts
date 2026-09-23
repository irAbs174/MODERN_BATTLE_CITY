import { Grid } from './Grid';
import { CELL, Terrain, TERRAIN, isArmoredTerrain } from './terrain';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from './events';
import { SFX_WEAPON_MAP } from './events';
import { Pool } from '../core/Pool';
import { ParticleSystem } from '../systems/ParticleSystem';
import { Projectile, resetProjectile, type ProjectileInit, type Team } from '../entities/Projectile';
import { Tank } from '../entities/Tank';
import { PlayerTank, emptyInput, type PlayerInput } from '../entities/PlayerTank';
import { EnemyTank, type EnemySpawnOpts } from '../entities/EnemyTank';
import { Base, Turret, Mine, Drone } from '../entities/structures';
import { PowerUpEntity } from '../entities/PowerUpEntity';
import { FlowField } from '../ai/FlowField';
import { Rng } from '../core/Rng';
import { CFG, DEFAULT_COMBAT, type DifficultyCombat } from '../core/config';
import { clamp, randRange, TAU } from '../core/math';
import type { EnemyId } from '../data/enemies';
import { getEnemy } from '../data/enemies';
import type { PowerUpId } from '../data/powerups';
import { POWERUPS } from '../data/powerups';
import { getAbility } from '../data/abilities';

export interface ExplosionOpts {
  color?: string;
  big?: boolean;
  shake?: number;
  team?: Team;
  damageTerrain?: boolean;
  pierceArmor?: number;
  knockback?: number;
  silent?: boolean;
  /** Force damage on the player's own base (used by enemy fire). */
  hitsBase?: boolean;
  ownerId?: number;
}

export interface Beam {
  active: boolean;
  owner: EnemyTank | null;
  x: number;
  y: number;
  angle: number;
  sweepFrom: number;
  sweepTo: number;
  t: number;
  duration: number;
  length: number;
  width: number;
  damage: number;
  team: Team;
  color: string;
  telegraph: number;
  hitCooldown: Map<number, number>;
}

export interface WorldConfig {
  cols: number;
  rows: number;
  theme: import('./terrain').ThemeId;
  seed?: number;
  difficultyAcc?: number;
}

/**
 * The authoritative simulation. Owns the grid, entities, projectiles, effects
 * and combat rules. It has no DOM/canvas dependency, which keeps it unit-testable.
 */
export class World {
  grid: Grid;
  events = new EventBus<GameEvents>();
  particles = new ParticleSystem();
  rng: Rng;

  time = 0;
  timeScale = 1;
  frame = 0;

  player: PlayerTank | null = null;
  spawnX = 0;
  spawnY = 0;
  enemies: EnemyTank[] = [];
  base: Base = new Base();
  powerups: PowerUpEntity[] = [];
  mines: Mine[] = [];
  drones: Drone[] = [];
  beams: Beam[] = [];
  shockwaves: { x: number; y: number; r: number; maxR: number; life: number; color: string }[] = [];

  projectiles: Pool<Projectile>;

  flowToPlayer: FlowField;
  flowToBase: FlowField;
  private flowTimer = 0;
  private flowTimerBase = 0;

  score = 0;
  combo = 0;
  comboTimer = 0;
  bestCombo = 0;
  kills = 0;
  coinsEarned = 0;
  xpEarned = 0;
  shotsFired = 0;
  shotsHit = 0;
  damageDealt = 0;
  damageTaken = 0;
  powerupsCollected = 0;
  barrelsDetonated = 0;
  terrainDestroyed = 0;

  shakeAmount = 0;
  shakeTime = 0;
  shakeX = 0;
  shakeY = 0;
  flashAlpha = 0;
  flashColor = '#fff';
  flashTime = 0;
  hitStop = 0;

  difficultyAcc = 1;
  enemyScaling = { hp: 1, damage: 1, speed: 1, rate: 1, armor: 1 };
  difficulty: DifficultyCombat = { ...DEFAULT_COMBAT };

  private powerupTimer: number = CFG.powerups.spawnInterval;

  constructor(cfg: WorldConfig) {
    this.grid = new Grid(cfg.cols, cfg.rows, cfg.theme);
    this.rng = new Rng(cfg.seed ?? (Math.random() * 1e9) | 0);
    const bw = Math.ceil(cfg.cols / 2);
    const bh = Math.ceil(cfg.rows / 2);
    this.flowToPlayer = new FlowField(bw, bh);
    this.flowToBase = new FlowField(bw, bh);
    this.projectiles = new Pool<Projectile>(
      () => new Projectile(),
      resetProjectile,
      90,
      900,
    );
    if (cfg.difficultyAcc !== undefined) this.difficultyAcc = cfg.difficultyAcc;
  }

  /* ---------------------------------------------------------------- */
  /* setup                                                             */
  /* ---------------------------------------------------------------- */

  setPlayer(p: PlayerTank): void {
    this.player = p;
    this.spawnX = p.x;
    this.spawnY = p.y;
  }

  setBase(x: number, y: number, hp: number, level: number): void {
    this.base.init(x, y, hp, level);
  }

  setScaling(
    scaling: { hp: number; damage: number; speed: number; rate: number; armor?: number },
    difficulty: DifficultyCombat,
    acc: number,
  ): void {
    this.enemyScaling = { ...scaling, armor: scaling.armor ?? 1 };
    this.difficulty = { ...DEFAULT_COMBAT, ...difficulty };
    this.difficultyAcc = acc;
  }

  /* ---------------------------------------------------------------- */
  /* spawning                                                          */
  /* ---------------------------------------------------------------- */

  spawnEnemy(type: EnemyId, x: number, y: number, elite = false): EnemyTank {
    const def = getEnemy(type);
    const opts: EnemySpawnOpts = {
      x,
      y,
      type,
      elite,
      scaling: this.enemyScaling,
      difficulty: this.difficulty,
    };
    const e = new EnemyTank(opts);
    if (elite) e.colorOverride = '#ffd447';
    this.enemies.push(e);
    // spawn-in effect
    this.particles.emit('ring', x, y, {
      count: 1,
      speed: [0, 0],
      life: [0.5, 0.5],
      size: [6, 6],
      sizeEnd: 46,
      color: def.colors.glow,
      layer: 2,
    });
    this.particles.emit('spark', x, y, {
      count: 14,
      speed: [40, 180],
      life: [0.2, 0.5],
      size: [1.5, 3],
      color: def.colors.accent,
      layer: 2,
    });
    this.events.emit('enemySpawn', { x, y, enemy: type, elite });
    this.events.emit('sfx', { name: def.boss ? 'boss_warn' : 'ui_move', x, y, volume: def.boss ? 1 : 0.3, pitch: 0.7 });
    return e;
  }

  spawnPowerUp(x: number, y: number, id?: PowerUpId): PowerUpEntity | null {
    if (this.powerups.filter((p) => p.active).length >= CFG.powerups.maxAlive && !id) return null;
    const chosen: PowerUpId = id ?? this.rollPowerUpId();
    const pu = new PowerUpEntity();
    // nudge out of walls
    let px = x;
    let py = y;
    if (this.grid.rectHitsSolid({ x: px - 12, y: py - 12, w: 24, h: 24 }, { hover: false, offroad: false })) {
      const spot = this.findOpenSpot(px, py, 90);
      px = spot.x;
      py = spot.y;
    }
    pu.init(px, py, chosen);
    this.powerups.push(pu);
    this.events.emit('powerupSpawned', { x: px, y: py, id: chosen });
    this.events.emit('sfx', { name: 'ui_move', x: px, y: py, volume: 0.25, pitch: 1.7 });
    return pu;
  }

  private rollPowerUpId(): PowerUpId {
    const luck = this.player?.stats.luck ?? 0;
    const pool: PowerUpId[] = [];
    const weights: number[] = [];
    for (const def of Object.values(POWERUPS)) {
      let w = def.weight;
      // low HP => bias toward healing
      if (this.player && this.player.hpFrac < 0.45 && (def.id === 'health' || def.id === 'fullrepair' || def.id === 'shield')) w *= 3.2;
      if (def.id === 'life') w *= this.player && this.player.lives <= 1 ? 2.4 : 0.6;
      w *= 1 + luck * 0.5;
      pool.push(def.id);
      weights.push(w);
    }
    return this.rng.weighted(pool, weights);
  }

  findOpenSpot(x: number, y: number, maxRadius: number): { x: number; y: number } {
    for (let r = 0; r < maxRadius; r += 12) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * TAU + r * 0.11;
        const px = clamp(x + Math.cos(ang) * r, 20, this.grid.width - 20);
        const py = clamp(y + Math.sin(ang) * r, 20, this.grid.height - 20);
        if (!this.grid.rectHitsSolid({ x: px - 14, y: py - 14, w: 28, h: 28 }, { hover: false, offroad: false })) {
          return { x: px, y: py };
        }
      }
    }
    return { x, y };
  }

  spawnMine(x: number, y: number, team: Team, damage: number): void {
    const m = new Mine();
    m.init(x, y, team, damage);
    this.mines.push(m);
  }

  /* ---------------------------------------------------------------- */
  /* firing                                                            */
  /* ---------------------------------------------------------------- */

  fireShell(init: ProjectileInit): Projectile | null {
    const p = this.projectiles.obtain();
    if (!p) return null;
    p.id = this.frame * 1000 + this.projectiles.activeCount;
    p.init(init);
    p.pushTrail();
    return p;
  }

  playerFire(tank: PlayerTank): void {
    const w = tank.weapon;
    const rateMul = tank.fireRateMul;
    const dmgMul = tank.damageMul;
    const speedMul = tank.projSpeedMul;

    tank.fireCooldown = Math.max(0.045, w.fireDelay / rateMul);
    tank.lastFireTime = this.time;
    this.shotsFired++;
    tank.shotsFired++;

    const baseAngle = tank.turret;
    const muzzleDist = tank.size * 0.5 + 7;
    const muzzle = this.grid.muzzlePoint(tank.x, tank.y, baseAngle, muzzleDist);
    const mx = muzzle.x;
    const my = muzzle.y;
    // #region agent log
    {
      const mcx = Math.floor(mx / CELL);
      const mcy = Math.floor(my / CELL);
      fetch('http://127.0.0.1:7884/ingest/bbf8ac5e-bb5d-4c8d-bcf5-3ea2aee662a4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'46aec3'},body:JSON.stringify({sessionId:'46aec3',runId:'post-fix',hypothesisId:'G',location:'World.ts:playerFire',message:'player fire muzzle',data:{tankX:Math.round(tank.x),tankY:Math.round(tank.y),turret:Math.round(baseAngle*100)/100,mx:Math.round(mx),my:Math.round(my),clipped:muzzle.clipped,muzzleTerrain:this.grid.at(mcx,mcy),muzzleBlocks:TERRAIN[this.grid.at(mcx,mcy)].blocksBullets,weapon:w.id},timestamp:Date.now()})}).catch(()=>{});
    }
    // #endregion

    const volley = tank.volleyCount;
    const totalShots = w.pellets * volley;
    const spreadBase = w.spread + (volley > 1 ? 0.2 : 0);

    for (let i = 0; i < totalShots; i++) {
      const f = totalShots === 1 ? 0 : i / (totalShots - 1) - 0.5;
      const angle = baseAngle + f * spreadBase * 2 + (w.spread > 0.2 ? randRange(-w.spread, w.spread) : 0);
      const crit = this.rng.next() < tank.stats.crit;
      const dmg = w.damage * dmgMul * (crit ? tank.stats.critDmg : 1);
      this.fireShell({
        x: mx,
        y: my,
        angle,
        speed: w.projSpeed * speedMul,
        damage: dmg,
        radius: w.radius,
        team: 'player',
        weapon: w.id,
        pierce: w.pierce + tank.pierceBonus,
        armorPierce: w.armorPierce + (tank.hasBuff('pierce') ? 0.45 : 0),
        splash: w.splash,
        splashDamage: w.splashDamage * dmgMul,
        knockback: w.knockback,
        shake: w.shake,
        cutWidth: w.cutWidth,
        color: w.color,
        glow: w.glow,
        trail: w.trail,
        homing: w.homing,
        arc: w.arc,
        dot: w.dot,
        lifetime: w.lifetime,
        crit,
        owner: tank.id,
        interceptable: false,
        targetX: w.arc ? tank.x + Math.cos(angle) * 300 : undefined,
        targetY: w.arc ? tank.y + Math.sin(angle) * 300 : undefined,
      });
    }

    // muzzle flash + smoke + recoil
    tank.muzzleFlash = 1;
    tank.recoil = w.recoil;
    tank.squash = Math.min(0.6, tank.squash + w.shake * 0.02);
    tank.vx -= Math.cos(baseAngle) * w.recoil * 0.6;
    tank.vy -= Math.sin(baseAngle) * w.recoil * 0.6;
    this.particles.emit('flash', mx, my, {
      count: 1,
      speed: [0, 0],
      life: [0.09, 0.12],
      size: [w.radius * 3.4, w.radius * 4.2],
      sizeEnd: 0,
      color: w.color,
      angle: baseAngle,
      layer: 2,
      stretch: 1.6,
    });
    this.particles.emit('spark', mx, my, {
      count: w.id === 'flame' ? 2 : 5,
      speed: [60, 210],
      life: [0.08, 0.26],
      size: [1.2, 2.6],
      color: w.glow,
      angle: baseAngle,
      spread: w.id === 'flame' ? 0.8 : 0.7,
      layer: 2,
    });
    if (w.id !== 'flame' && w.id !== 'rapid') {
      this.particles.emit('smoke', mx, my, {
        count: 3,
        speed: [10, 46],
        life: [0.35, 0.8],
        size: [3, 7],
        sizeEnd: 14,
        color: '#6b6b6b',
        additive: false,
        angle: baseAngle,
        spread: 1.1,
        layer: 2,
      });
    }
    this.shake(w.shake * 0.62, 0.16);
    this.events.emit('shot', { x: mx, y: my, angle: baseAngle, weapon: w.id, team: 'player', power: w.damage * dmgMul });
    this.events.emit('sfx', {
      name: SFX_WEAPON_MAP[w.id] ?? 'shot_cannon',
      x: mx,
      y: my,
      volume: clamp(0.35 + w.shake * 0.09, 0.2, 1),
      pitch: 0.94 + Math.random() * 0.12,
    });
  }

  enemyFire(tank: EnemyTank): void {
    const def = tank.def;
    tank.fireCooldown = tank.fireDelay * (tank.enraged && !tank.isBoss ? 0.62 : 1);
    const charged = tank.brain.charging || def.abilities?.includes('charge');
    const angle = tank.turret;
    const muzzle = this.grid.muzzlePoint(tank.x, tank.y, angle, tank.size * 0.5 + 6);
    const mx = muzzle.x;
    const my = muzzle.y;
    const dmgMul = (tank.enraged ? 1.35 : 1) * (tank.phase >= 1 && tank.isBoss ? 1.12 : 1);

    const pellets = tank.isBoss ? def.pellets + this.bossExtraPellets(tank) : def.pellets;
    for (let i = 0; i < pellets; i++) {
      const f = pellets === 1 ? 0 : i / (pellets - 1) - 0.5;
      const a = angle + f * def.spread * 2 + randRange(-def.spread, def.spread) * (1 - def.accuracy) * 2;
      this.fireShell({
        x: mx,
        y: my,
        angle: a,
        speed: def.projSpeed * this.enemyScaling.speed,
        damage: tank.damageBase * dmgMul * (charged ? 1.5 : 1),
        radius: def.projRadius * (charged ? 1.3 : 1),
        team: 'enemy',
        weapon: def.splash > 0 ? 'rocket' : 'cannon',
        pierce: 0,
        armorPierce: charged ? 0.4 : 0,
        splash: def.splash,
        splashDamage: def.splash * 0.6 * dmgMul,
        knockback: def.splash > 0 ? 90 : 26,
        shake: def.boss ? 3 : 1,
        cutWidth: 1,
        color: def.colors.accent,
        glow: def.colors.glow,
        trail: def.boss ? 1.8 : 1.1,
        homing: def.abilities?.includes('missiles') ? 1.5 : 0,
        arc: false,
        lifetime: 3,
        crit: false,
        owner: tank.id,
        interceptable: !def.boss,
        fromBoss: !!def.boss,
      });
    }
    tank.muzzleFlash = 1;
    tank.recoil = def.boss ? 40 : 18;
    tank.vx -= Math.cos(angle) * (def.boss ? 30 : 12);
    tank.vy -= Math.sin(angle) * (def.boss ? 30 : 12);
    this.particles.emit('flash', mx, my, {
      count: 1,
      speed: [0, 0],
      life: [0.08, 0.1],
      size: [def.projRadius * 3, def.projRadius * 3.6],
      color: def.colors.glow,
      angle,
      layer: 2,
      stretch: 1.4,
    });
    this.particles.emit('spark', mx, my, {
      count: 4,
      speed: [50, 160],
      life: [0.08, 0.2],
      size: [1, 2.2],
      color: def.colors.accent,
      angle,
      spread: 0.7,
      layer: 2,
    });
    this.events.emit('shot', { x: mx, y: my, angle, weapon: 'cannon', team: 'enemy', power: tank.damageBase });
    this.events.emit('sfx', {
      name: def.boss ? 'shot_heavy' : 'enemy_shot',
      x: mx,
      y: my,
      volume: def.boss ? 0.85 : 0.5,
      pitch: def.boss ? 0.8 : 0.9 + Math.random() * 0.25,
    });
  }

  /* ---------------------------------------------------------------- */
  /* explosions                                                        */
  /* ---------------------------------------------------------------- */

  explode(x: number, y: number, radius: number, damage: number, opts: ExplosionOpts = {}): void {
    const color = opts.color ?? '#ff9d2e';
    const big = opts.big ?? radius > 60;
    const team: Team = opts.team ?? 'player';

    // damage tanks
    if (damage > 0) {
      const targets: Tank[] = [...this.enemies];
      if (this.player && this.player.alive) targets.push(this.player);
      for (const t of targets) {
        if (!t.alive) continue;
        if (t.team === team) continue; // no friendly fire
        const d = Math.hypot(t.x - x, t.y - y) - t.size * 0.4;
        if (d > radius) continue;
        const falloff = clamp(1 - d / radius, 0.25, 1);
        const res = t.takeDamage(this, {
          amount: damage * falloff,
          fromX: x,
          fromY: y,
          source: 'explosion',
          team,
          knockback: (opts.knockback ?? 120) * falloff,
          armorPierce: opts.pierceArmor ?? 0.15,
          ownerId: opts.ownerId,
        });
        if (team === 'player' && res.applied > 0) {
          this.registerPlayerDamage(res.applied, t, res.crit, res.killed);
        }
        if (team === 'enemy' && this.player && t === this.player && res.applied > 0) {
          this.damageTaken += res.applied;
          this.events.emit('playerDamaged', { hp: this.player.hp, maxHp: this.player.maxHp, amount: res.applied });
        }
      }
      // base damage
      if (this.base.alive && team !== 'player' && (opts.hitsBase ?? true)) {
        const d = Math.hypot(this.base.x - x, this.base.y - y) - this.base.size * 0.4;
        if (d < radius) {
          const falloff = clamp(1 - d / radius, 0.3, 1);
          this.base.takeDamage(this, damage * falloff, x, y);
        }
      }
      for (const t of this.base.turrets) {
        if (!t.alive || team === 'player') continue;
        const d = Math.hypot(t.x - x, t.y - y);
        if (d < radius) t.takeDamage(this, damage * clamp(1 - d / radius, 0.3, 1));
      }
    }

    // terrain destruction
    if (opts.damageTerrain ?? big) {
      const destroyed = this.grid.damageArea(x, y, radius * 0.95, damage * 1.5, opts.pierceArmor ?? 0.1);
      for (const d of destroyed) {
        this.onTerrainDestroyed(d.cx, d.cy, d.terrain, 0.6);
      }
    }

    // visuals
    this.particles.emit('ring', x, y, {
      count: 1,
      speed: [0, 0],
      life: [big ? 0.5 : 0.34, big ? 0.6 : 0.4],
      size: [radius * 0.3, radius * 0.35],
      sizeEnd: radius * (big ? 2.3 : 1.9),
      color,
      layer: 2,
    });
    this.particles.emit('fire', x, y, {
      count: big ? 26 : 14,
      speed: [30, big ? 300 : 190],
      life: [0.18, big ? 0.6 : 0.42],
      size: [big ? 6 : 3.5, big ? 16 : 9],
      sizeEnd: 0,
      color: '#ffd27a',
      color2: color,
      layer: 2,
    });
    this.particles.emit('smoke', x, y, {
      count: big ? 14 : 7,
      speed: [10, 70],
      life: [0.5, 1.3],
      size: [5, 13],
      sizeEnd: big ? 34 : 22,
      color: '#4a4a4a',
      additive: false,
      layer: 2,
      drag: 1.4,
    });
    this.particles.emit('debris', x, y, {
      count: big ? 16 : 8,
      speed: [60, 320],
      life: [0.3, 0.8],
      size: [1.6, 4],
      color: '#c9b48f',
      color2: '#7a6a52',
      additive: false,
      gravity: 120,
      layer: 1,
      rotSpeed: 14,
    });
    this.shockwaves.push({ x, y, r: radius * 0.25, maxR: radius * 2.1, life: big ? 0.45 : 0.3, color });

    this.shake(opts.shake ?? (big ? 9 : 4.5), big ? 0.4 : 0.24);
    this.events.emit('explosion', { x, y, radius, power: damage, color, big });
    if (!opts.silent) {
      this.events.emit('sfx', {
        name: big ? 'explosion_big' : damage > 90 ? 'explosion_huge' : 'explosion_small',
        x,
        y,
        volume: big ? 1 : 0.75,
      });
    }
  }

  private onTerrainDestroyed(cx: number, cy: number, terrain: Terrain, power: number): void {
    this.terrainDestroyed++;
    const x = cx * CELL + CELL / 2;
    const y = cy * CELL + CELL / 2;
    const pal = this.grid.palette;
    const debris: Record<number, [string, string]> = {
      [Terrain.Brick]: ['#d46a48', '#7a2e22'],
      [Terrain.Stone]: ['#9aa3b0', '#4a525e'],
      [Terrain.Metal]: ['#d4dbe8', '#4e5968'],
      [Terrain.Ice]: ['#d8f4ff', '#6aa8c8'],
      [Terrain.Forest]: ['#6a8f48', '#2a4018'],
    };
    const [c1, c2] = debris[terrain] ?? [pal.groundAccent, pal.dust];
    this.particles.emit('debris', x, y, {
      count: terrain === Terrain.Brick ? 8 : 7,
      speed: [40, 210],
      life: [0.3, 0.85],
      size: [1.6, 4.4],
      color: c1,
      color2: c2,
      additive: false,
      gravity: 190,
      layer: 1,
      rotSpeed: 16,
    });
    this.particles.emit('dust', x, y, {
      count: 4,
      speed: [8, 50],
      life: [0.3, 0.75],
      size: [3, 8],
      sizeEnd: 16,
      color: pal.dust,
      additive: false,
      layer: 1,
      drag: 2,
    });
    this.events.emit('terrainDestroyed', { cx, cy, x, y, terrain, power });
    this.flowTimer = Math.min(this.flowTimer, 0.05);
    this.events.emit('sfx', {
      name: terrain === Terrain.Brick || terrain === Terrain.Forest ? 'brick' : 'steel',
      x,
      y,
      volume: 0.5,
    });
  }

  /* ---------------------------------------------------------------- */
  /* projectile collisions                                             */
  /* ---------------------------------------------------------------- */

  private updateProjectiles(dt: number): void {
    const grid = this.grid;
    this.projectiles.forEach((p) => {
      if (!p.active) return;
      const slow = p.team === 'enemy' ? this.timeScale : 1;
      const sdt = dt * slow;
      p.lifetime -= sdt;

      // homing steering
      let sx: number | undefined;
      let sy: number | undefined;
      if (p.homing > 0) {
        const t = this.findNearestHostile(p.x, p.y, p.team, 420);
        if (t) {
          sx = t.x;
          sy = t.y;
        }
      }
      p.step(sdt, sx, sy);
      p.pushTrail();

      if (p.lifetime <= 0) {
        this.detonate(p, p.x, p.y, 0, 0, null);
        return;
      }
      if (p.x < -20 || p.y < -20 || p.x > grid.width + 20 || p.y > grid.height + 20) {
        this.projectiles.release(p);
        return;
      }

      // --- terrain ---
      let bestT = 1;
      let hitKind: 'terrain' | 'tank' | 'base' | 'turret' | null = null;
      let hitRef: Tank | Base | Turret | null = null;
      let hitNx = 0;
      let hitNy = 0;
      let hitCx = 0;
      let hitCy = 0;
      let hitTerrain: Terrain = Terrain.Empty;

      if (!p.airborne) {
        const rh = grid.raycast(p.px, p.py, p.x, p.y, 'bullet');
        if (rh && rh.t < bestT) {
          bestT = rh.t;
          hitKind = 'terrain';
          hitNx = rh.nx;
          hitNy = rh.ny;
          hitCx = rh.cx;
          hitCy = rh.cy;
          hitTerrain = rh.terrain;
        }
        // #region agent log
        if (p.team === 'player' && !rh) {
          const ecx = Math.floor(p.x / CELL);
          const ecy = Math.floor(p.y / CELL);
          const et = grid.at(ecx, ecy);
          if (TERRAIN[et].blocksBullets) {
            fetch('http://127.0.0.1:7884/ingest/bbf8ac5e-bb5d-4c8d-bcf5-3ea2aee662a4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'46aec3'},body:JSON.stringify({sessionId:'46aec3',runId:'pre-fix',hypothesisId:'C',location:'World.ts:updateProjectiles',message:'bullet inside blocking cell without raycast hit',data:{weapon:p.weapon,airborne:p.airborne,ecx,ecy,et,px:p.px,py:p.py,x:p.x,y:p.y},timestamp:Date.now()})}).catch(()=>{});
          }
        }
        // #endregion
      }

      // --- tanks ---
      if (p.team === 'player') {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const hb = p.hitBox(e.x, e.y, e.size + p.radius * 1.6, e.size + p.radius * 1.6);
          if (hb && hb.t < bestT && !p.hitList.includes(e.id)) {
            bestT = hb.t;
            hitKind = 'tank';
            hitRef = e;
            hitNx = hb.nx;
            hitNy = hb.ny;
          }
        }
        // player bullets never hurt the player base, but they do hit enemy turrets/mines? (none exist)
      } else {
        const pl = this.player;
        if (pl && pl.alive) {
          const hb = p.hitBox(pl.x, pl.y, pl.size + p.radius * 1.6, pl.size + p.radius * 1.6);
          if (hb && hb.t < bestT && !p.hitList.includes(pl.id)) {
            bestT = hb.t;
            hitKind = 'tank';
            hitRef = pl;
            hitNx = hb.nx;
            hitNy = hb.ny;
          }
        }
        if (this.base.alive) {
          const b = this.base;
          const hb = p.hitBox(b.x, b.y, b.size + p.radius * 1.4, b.size + p.radius * 1.4);
          if (hb && hb.t < bestT) {
            bestT = hb.t;
            hitKind = 'base';
            hitRef = b;
            hitNx = hb.nx;
            hitNy = hb.ny;
          }
        }
        for (const t of this.base.turrets) {
          if (!t.alive) continue;
          const hb = p.hitBox(t.x, t.y, t.size + p.radius * 1.6, t.size + p.radius * 1.6);
          if (hb && hb.t < bestT) {
            bestT = hb.t;
            hitKind = 'turret';
            hitRef = t;
            hitNx = hb.nx;
            hitNy = hb.ny;
          }
        }
        for (const d of this.drones) {
          if (!d.active) continue;
          const hb = p.hitBox(d.x, d.y, d.radius * 2, d.radius * 2);
          if (hb && hb.t < bestT) {
            bestT = hb.t;
            d.active = false;
            this.explode(d.x, d.y, 34, 0, { color: '#ffd66b', shake: 2, silent: false });
            hitKind = null;
            hitRef = null;
          }
        }
      }

      // --- bullet vs bullet ---
      if (CFG.combat.bulletVsBullet && bestT === 1) {
        this.projectiles.forEach((o) => {
          if (o === p || !o.active || o.team === p.team || !o.interceptable || !p.interceptable) return;
          const hb = p.hitBox(o.x, o.y, o.radius * 2.4, o.radius * 2.4);
          if (hb && hb.t < bestT) {
            bestT = hb.t;
            hitKind = null;
            hitRef = null;
            this.particles.emit('spark', o.x, o.y, {
              count: 8,
              speed: [50, 190],
              life: [0.1, 0.3],
              size: [1, 2.4],
              color: '#fff3c4',
              layer: 2,
            });
            this.events.emit('sfx', { name: 'hit_metal', x: o.x, y: o.y, volume: 0.3, pitch: 1.6 });
            this.events.emit('impact', { x: o.x, y: o.y, nx: 0, ny: 0, kind: 'bullet', damage: 0, crit: false, color: '#fff', power: 0 });
            this.projectiles.release(o);
            this.shake(1.2, 0.1);
          }
        });
        if (bestT < 1) {
          const ix = p.px + (p.x - p.px) * bestT;
          const iy = p.py + (p.y - p.py) * bestT;
          p.x = ix;
          p.y = iy;
          this.projectiles.release(p);
          return;
        }
      }

      if (hitKind === null) return;

      const ix = p.px + (p.x - p.px) * bestT;
      const iy = p.py + (p.y - p.py) * bestT;
      p.x = ix;
      p.y = iy;

      if (hitKind === 'terrain') {
        this.hitTerrain(p, hitCx, hitCy, hitTerrain, hitNx, hitNy);
        return;
      }
      if (hitKind === 'base') {
        const b = hitRef as Base;
        const dmg = b.takeDamage(this, p.damage, p.x, p.y);
        this.events.emit('impact', { x: ix, y: iy, nx: hitNx, ny: hitNy, kind: 'shield', damage: dmg, crit: false, color: '#ff6b3d', power: p.damage });
        this.particles.emit('spark', ix, iy, { count: 10, speed: [50, 220], life: [0.12, 0.34], size: [1.4, 3], color: '#ffb547', angle: Math.atan2(hitNy, hitNx), spread: 2.2, layer: 2 });
        if (p.splash > 0) this.detonate(p, ix, iy, 0, 0, null);
        this.projectiles.release(p);
        return;
      }
      if (hitKind === 'turret') {
        const t = hitRef as Turret;
        t.takeDamage(this, p.damage);
        this.particles.emit('spark', ix, iy, { count: 8, speed: [40, 180], life: [0.1, 0.3], size: [1.2, 2.6], color: '#ffb547', layer: 2 });
        if (p.splash > 0) this.detonate(p, ix, iy, 0, 0, null);
        this.projectiles.release(p);
        return;
      }

      const tank = hitRef as Tank;
      const res = tank.takeDamage(this, {
        amount: p.damage,
        fromX: p.x - Math.cos(p.angle) * 6,
        fromY: p.y - Math.sin(p.angle) * 6,
        source: 'bullet',
        team: p.team,
        crit: p.crit,
        knockback: p.knockback,
        armorPierce: p.armorPierce,
        ownerId: p.owner,
        dot: p.dot,
      });

      p.hitList.push(tank.id);
      if (p.team === 'player') {
        this.shotsHit++;
        if (this.player) this.player.shotsHit++;
      }

      this.events.emit('impact', {
        x: ix,
        y: iy,
        nx: hitNx,
        ny: hitNy,
        kind: res.blocked > res.applied ? 'shield' : 'tank',
        damage: res.applied,
        crit: res.crit,
        color: p.glow,
        power: p.damage,
      });
      this.hitMarker(ix, iy, res.applied, res.crit, res.killed, p.team, res.blocked > 0);

      if (p.team === 'player') this.registerPlayerDamage(res.applied, tank, res.crit, res.killed);
      if (p.team === 'enemy' && tank === this.player) {
        this.damageTaken += res.applied;
        this.events.emit('playerDamaged', { hp: this.player.hp, maxHp: this.player.maxHp, amount: res.applied });
        this.shake(2.4 + res.applied * 0.06, 0.2);
      }

      if (p.splash > 0) {
        this.detonate(p, ix, iy, hitNx, hitNy, tank);
        return;
      }

      if (p.pierce > 0 && !res.killed) {
        p.pierce--;
        p.damage *= 0.82;
        this.particles.emit('spark', ix, iy, { count: 5, speed: [40, 160], life: [0.1, 0.25], size: [1.2, 2.6], color: p.color, layer: 2 });
        return; // keep flying
      }
      if (p.pierce > 0) {
        p.pierce--;
        return;
      }
      this.projectiles.release(p);
    });

  }

  private hitTerrain(p: Projectile, cx: number, cy: number, terrain: Terrain, nx: number, ny: number): void {
    const ix = p.x;
    const iy = p.y;
    const pal = this.grid.palette;
    const hits: { cx: number; cy: number; terrain: Terrain; destroyed: boolean }[] = [];
    const apply = (tx: number, ty: number, amount: number) => {
      if (!this.grid.inBounds(tx, ty)) return;
      const before = this.grid.at(tx, ty);
      if (!TERRAIN[before].destructible && !TERRAIN[before].blocksBullets) return;
      const res = this.grid.damageCell(tx, ty, amount, p.armorPierce);
      hits.push({ cx: tx, cy: ty, terrain: res.terrain === Terrain.Empty ? before : res.terrain, destroyed: res.destroyed });
      if (res.destroyed) this.onTerrainDestroyed(tx, ty, res.terrain, p.damage);
    };
    apply(cx, cy, p.damage);
    if (p.cutWidth > 1) {
      const extra = Math.floor(p.cutWidth / 2);
      const sx = Math.abs(nx) >= Math.abs(ny) ? 0 : 1;
      const sy = Math.abs(nx) >= Math.abs(ny) ? 1 : 0;
      for (let i = 1; i <= extra; i++) {
        apply(cx + sx * i, cy + sy * i, p.damage * 0.82);
        apply(cx - sx * i, cy - sy * i, p.damage * 0.82);
      }
    }

    const armored = isArmoredTerrain(terrain);
    const spark = armored ? '#cfd8ff' : '#e8a078';
    this.particles.emit('spark', ix, iy, { count: 6, speed: [40, 160], life: [0.1, 0.28], size: [1.2, 2.4], color: spark, layer: 2 });
    this.events.emit('sfx', { name: armored ? 'steel' : 'brick', x: ix, y: iy, volume: 0.32 });
    this.events.emit('impact', {
      x: ix,
      y: iy,
      nx,
      ny,
      kind: armored ? 'steel' : 'terrain',
      damage: p.damage,
      crit: p.crit,
      color: pal.dust,
      power: p.damage,
    });
    if (p.splash > 0) {
      this.detonate(p, ix, iy, nx, ny, null);
      return;
    }
    const brokePrimary = hits.some((h) => h.cx === cx && h.cy === cy && h.destroyed);
    if (brokePrimary && p.pierce > 0) {
      p.pierce--;
      return;
    }
    this.projectiles.release(p);
  }

  private detonate(p: Projectile, x: number, y: number, _nx: number, _ny: number, _direct: Tank | null): void {
    this.explode(x, y, p.splash, p.splashDamage + p.damage * 0.55, {
      color: p.glow,
      big: p.splash > 55,
      team: p.team,
      shake: p.shake,
      damageTerrain: true,
      pierceArmor: p.armorPierce,
      ownerId: p.owner,
      knockback: p.knockback,
    });
    this.projectiles.release(p);
  }

  private hitMarker(x: number, y: number, damage: number, crit: boolean, kill: boolean, team: Team, blocked: boolean): void {
    if (team !== 'player') return;
    this.events.emit('hitmarker', { x, y, damage, crit, kill });
    if (damage <= 0 && !blocked) return;
    const txt = blocked && damage <= 0 ? 'BLOCK' : `${Math.round(damage)}`;
    this.particles.text(
      x + randRange(-6, 6),
      y - 6,
      crit ? `${txt}!` : txt,
      kill ? '#ff6b6b' : crit ? '#ffd447' : blocked ? '#7ce7ff' : '#ffffff',
      crit ? 17 : kill ? 15 : 12,
      { bold: crit || kill, vy: -60, life: crit ? 1 : 0.7 },
    );
  }

  private registerPlayerDamage(applied: number, target: Tank, crit: boolean, killed: boolean): void {
    if (!this.player) return;
    this.damageDealt += applied;
    this.player.damageDealt += applied;
    if (crit) {
      this.events.emit('sfx', { name: 'crit', x: target.x, y: target.y, volume: 0.35 });
    }
    if (killed) void 0;
  }

  /* ---------------------------------------------------------------- */
  /* callbacks from entities                                           */
  /* ---------------------------------------------------------------- */

  onEnemyDeath(tank: EnemyTank, _info: unknown): void {
    const def = tank.def;
    const big = def.boss || tank.size > 30;
    this.kills++;
    if (this.player) this.player.kills++;

    // combo
    this.combo = Math.min(CFG.combat.maxCombo, this.combo + 1);
    this.comboTimer = CFG.combat.comboWindow;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const comboMul = 1 + (this.combo - 1) * CFG.scoring.comboStep;
    const gained = Math.round(tank.scoreValue * comboMul * this.difficultyAcc);
    this.score += gained;
    const xp = Math.round(tank.xpValue * (this.player?.stats.xpMul ?? 1));
    const coins = Math.round(tank.coinValue * (this.player?.stats.coinMul ?? 1));
    this.xpEarned += xp;
    this.coinsEarned += coins;

    this.particles.text(tank.x, tank.y - tank.size * 0.6, `+${gained}`, def.boss ? '#ffd447' : '#ffe6a8', def.boss ? 20 : 14, {
      bold: true,
      vy: -70,
      life: 1.1,
    });
    if (this.combo > 1) {
      this.particles.text(tank.x, tank.y - tank.size * 0.6 - 18, `x${this.combo} COMBO`, '#ff8bd0', 13, { bold: true, vy: -50, life: 1 });
      this.events.emit('combo', { count: this.combo, x: tank.x, y: tank.y });
      if (this.combo % 5 === 0) this.events.emit('sfx', { name: 'combo', volume: 0.5, pitch: 1 + this.combo * 0.02 });
    }
    this.particles.text(tank.x + randRange(-14, 14), tank.y + 8, `+${xp} XP`, '#8dff9a', 11, { vy: -46, life: 0.95 });
    if (coins > 0) this.particles.text(tank.x + randRange(-14, 14), tank.y + 20, `+${coins}c`, '#ffe08a', 11, { vy: -40, life: 0.95 });

    this.explode(tank.x, tank.y, big ? 96 : 54, big ? 40 : 0, {
      color: def.colors.glow,
      big,
      team: 'neutral',
      shake: big ? 14 : 6,
      damageTerrain: big,
    });
    // wreck debris
    this.particles.emit('shard', tank.x, tank.y, {
      count: big ? 22 : 12,
      speed: [70, big ? 420 : 300],
      life: [0.5, 1.2],
      size: [2.5, big ? 8 : 5.5],
      color: def.colors.hull,
      color2: def.colors.hull2,
      additive: false,
      gravity: 260,
      layer: 1,
      rotSpeed: 18,
    });
    this.particles.emit('fire', tank.x, tank.y, {
      count: big ? 20 : 10,
      speed: [20, 130],
      life: [0.3, 0.85],
      size: [4, big ? 16 : 10],
      sizeEnd: 0,
      color: '#ffdf9a',
      color2: def.colors.glow,
      layer: 2,
    });

    this.events.emit('tankDestroyed', {
      x: tank.x,
      y: tank.y,
      enemy: def.id,
      boss: !!def.boss,
      color: def.colors.glow,
      size: tank.size,
      byPlayer: true,
    });
    this.events.emit('sfx', {
      name: def.boss ? 'boss_die' : 'explosion_big',
      x: tank.x,
      y: tank.y,
      volume: def.boss ? 1 : 0.8,
    });

    if (def.boss) {
      this.hitStop = 0.5;
      this.flash(0.55, '#fff', 0.5);
      this.events.emit('slowmo', { scale: 0.25, duration: 1.6 });
      this.shake(22, 1.1);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        this.explode(tank.x + Math.cos(a) * 46, tank.y + Math.sin(a) * 46, 62, 0, {
          color: def.colors.glow,
          big: true,
          team: 'neutral',
          shake: 6,
          silent: i > 0,
        });
      }
    }

    // drops
    const luck = this.player?.stats.luck ?? 0;
    const dropRoll = this.rng.next();
    if (dropRoll < tank.dropChance * (1 + luck)) {
      this.spawnPowerUp(tank.x, tank.y);
    }
    // coin shards
    const shards = clamp(Math.round(coins / 8), 1, 8);
    for (let i = 0; i < shards; i++) {
      this.particles.emit('glow', tank.x, tank.y, {
        count: 1,
        speed: [40, 150],
        life: [0.4, 0.9],
        size: [2, 3.4],
        color: '#ffe08a',
        gravity: 90,
        layer: 1,
      });
    }

    tank.alive = false;
    this.enemies = this.enemies.filter((e) => e !== tank);
  }

  onPlayerDeath(tank: PlayerTank, _info: unknown): void {
    this.explode(tank.x, tank.y, 86, 0, { color: '#7ce7ff', big: true, team: 'neutral', shake: 16 });
    this.particles.emit('shard', tank.x, tank.y, {
      count: 20,
      speed: [80, 380],
      life: [0.5, 1.3],
      size: [2.5, 7],
      color: tank.chassis.color.hull,
      color2: tank.chassis.color.hull2,
      additive: false,
      gravity: 250,
      layer: 1,
      rotSpeed: 16,
    });
    this.events.emit('playerDied', { x: tank.x, y: tank.y });
    this.events.emit('sfx', { name: 'explosion_huge', volume: 1 });
    this.events.emit('slowmo', { scale: 0.3, duration: 1.1 });
    this.hitStop = 0.28;
    this.combo = 0;
    tank.lives--;
    if (tank.lives > 0) {
      tank.respawnTimer = 2.1;
    }
  }

  onPlayerRespawn(tank: PlayerTank): void {
    this.particles.emit('ring', tank.x, tank.y, {
      count: 2,
      speed: [0, 0],
      life: [0.45, 0.6],
      size: [8, 10],
      sizeEnd: 60,
      color: '#7ce7ff',
      layer: 2,
    });
    this.events.emit('sfx', { name: 'shield_up', volume: 0.6 });
    tank.invuln = CFG.player.respawnInvuln;
  }

  onBaseDestroyed(base: Base): void {
    this.explode(base.x, base.y, 150, 0, { color: '#ff4d2e', big: true, team: 'neutral', shake: 26 });
    this.flash(0.7, '#ff4d2e', 0.8);
    this.hitStop = 0.5;
    this.events.emit('baseDestroyed', { x: base.x, y: base.y });
    this.events.emit('sfx', { name: 'explosion_huge', volume: 1 });
    this.events.emit('slowmo', { scale: 0.22, duration: 1.8 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      this.particles.emit('shard', base.x + Math.cos(a) * 20, base.y + Math.sin(a) * 20, {
        count: 6,
        speed: [80, 320],
        life: [0.6, 1.4],
        size: [3, 9],
        color: '#ffb547',
        color2: '#8a5a2a',
        additive: false,
        gravity: 240,
        layer: 1,
        angle: a,
        spread: 0.9,
      });
    }
  }

  onShieldBreak(tank: Tank): void {
    this.particles.emit('ring', tank.x, tank.y, {
      count: 1,
      speed: [0, 0],
      life: [0.32, 0.36],
      size: [tank.size * 0.8, tank.size * 0.85],
      sizeEnd: tank.size * 1.9,
      color: '#64ffd0',
      layer: 2,
    });
    this.particles.emit('shard', tank.x, tank.y, {
      count: 12,
      speed: [60, 240],
      life: [0.2, 0.5],
      size: [1.5, 3.5],
      color: '#a8fff0',
      layer: 2,
    });
    this.events.emit('sfx', { name: 'shield_break', x: tank.x, y: tank.y, volume: 0.6 });
  }

  onWallScrape(tank: Tank, nx: number, ny: number): void {
    this.particles.emit('spark', tank.x + nx * tank.size * 0.5, tank.y + ny * tank.size * 0.5, {
      count: 4,
      speed: [30, 130],
      life: [0.1, 0.28],
      size: [1, 2.2],
      color: '#ffd9a0',
      angle: Math.atan2(ny, nx),
      spread: 1.6,
      layer: 2,
    });
    this.events.emit('sfx', { name: 'tread', x: tank.x, y: tank.y, volume: 0.22, pitch: 1.4 });
  }

  onBuffExpire(tank: PlayerTank, id: PowerUpId): void {
    this.particles.text(tank.x, tank.y - 26, `${POWERUPS[id].name.toUpperCase()} ENDED`, '#9aa7b8', 10, { vy: -30, life: 0.9 });
  }

  /* ---------------------------------------------------------------- */
  /* power-ups                                                         */
  /* ---------------------------------------------------------------- */

  collectPowerUp(pu: PowerUpEntity): void {
    const p = this.player;
    if (!p) return;
    const def = pu.def;
    this.powerupsCollected++;
    let text = def.name.toUpperCase();

    switch (def.id) {
      case 'health':
        p.heal(def.magnitude);
        break;
      case 'shield':
        p.shield = Math.min(Math.max(p.shieldMax, def.magnitude), p.shield + def.magnitude);
        p.shieldMax = Math.max(p.shieldMax, 1);
        break;
      case 'life':
        p.lives++;
        break;
      case 'coin':
        this.coinsEarned += def.magnitude;
        this.score += def.magnitude * 2;
        break;
      case 'fullrepair':
        p.heal(p.maxHp);
        this.base.repair(this.base.maxHp * 0.5);
        break;
      case 'emp':
        p.abilityCooldown = 0;
        p.abilityActive = 0;
        this.empPulse(p.x, p.y, 210, 3.2);
        break;
      case 'nuke':
        this.flash(0.8, '#fff', 0.6);
        this.shake(20, 0.9);
        for (const e of [...this.enemies]) {
          if (e.isBoss) e.takeDamage(this, { amount: def.magnitude * 0.5, fromX: p.x, fromY: p.y, source: 'ability', team: 'player' });
          else e.takeDamage(this, { amount: def.magnitude, fromX: p.x, fromY: p.y, source: 'ability', team: 'player' });
        }
        this.events.emit('sfx', { name: 'nuke', volume: 1 });
        break;
      case 'freeze':
        for (const e of this.enemies) e.freeze = Math.max(e.freeze, def.magnitude);
        this.particles.emit('ring', p.x, p.y, { count: 1, speed: [0, 0], life: [0.7, 0.7], size: [20, 20], sizeEnd: 700, color: '#a8ecff', layer: 2 });
        this.events.emit('sfx', { name: 'freeze', volume: 0.9 });
        break;
      case 'basekit':
        this.fortifyBase();
        break;
      default:
        p.addBuff(def.id, def.magnitude, def.duration);
        break;
    }

    this.events.emit('powerupCollected', { x: pu.x, y: pu.y, id: def.id, text });
    this.particles.text(pu.x, pu.y - 12, text, def.color, 13, { bold: true, vy: -54, life: 1.15 });
    this.particles.emit('ring', pu.x, pu.y, {
      count: 1,
      speed: [0, 0],
      life: [0.34, 0.38],
      size: [8, 9],
      sizeEnd: 52,
      color: def.color,
      layer: 2,
    });
    this.particles.emit('glow', pu.x, pu.y, {
      count: 14,
      speed: [40, 180],
      life: [0.25, 0.6],
      size: [1.6, 3.4],
      color: def.color,
      layer: 2,
    });
    this.events.emit('sfx', { name: def.sfx === 'life' ? 'life' : def.sfx === 'power' ? 'power' : 'pickup', x: pu.x, y: pu.y, volume: 0.8 });
    this.score += 50;
  }

  fortifyBase(): void {
    const b = this.base;
    b.repair(b.maxHp * 0.45);
    if (b.turrets.length < 4) {
      const corners = [
        [-b.size * 0.62, -b.size * 0.62],
        [b.size * 0.62, -b.size * 0.62],
        [-b.size * 0.62, b.size * 0.62],
        [b.size * 0.62, b.size * 0.62],
      ];
      const c = corners[b.turrets.length];
      const spot = this.findOpenSpot(b.x + c[0], b.y + c[1], 40);
      b.addTurret(this, spot.x - b.x, spot.y - b.y);
    }
    const bx0 = Math.round(b.x / (CELL * 2) - 1);
    const by0 = Math.round(b.y / (CELL * 2) - 1);
    const barrierCells: { cx: number; cy: number }[] = [];
    for (let x = bx0 - 1; x <= bx0 + 2; x++) {
      for (const y of [by0 - 1, by0 + 2]) {
        this.grid.fillBlock(x, y, 1, 1, Terrain.Brick);
        for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) barrierCells.push({ cx: x * 2 + ox, cy: y * 2 + oy });
      }
    }
    for (let y = by0; y <= by0 + 1; y++) {
      for (const x of [bx0 - 1, bx0 + 2]) {
        this.grid.fillBlock(x, y, 1, 1, Terrain.Brick);
        for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) barrierCells.push({ cx: x * 2 + ox, cy: y * 2 + oy });
      }
    }
    this.grid.fillBlock(bx0, by0 - 1, 2, 1, Terrain.Empty);
    b.barrierCells = barrierCells;
    this.particles.emit('ring', b.x, b.y, { count: 1, speed: [0, 0], life: [0.5, 0.5], size: [20, 20], sizeEnd: 130, color: '#ffc46b', layer: 2 });
    this.events.emit('sfx', { name: 'repair', volume: 0.8 });
  }

  /* ---------------------------------------------------------------- */
  /* abilities                                                         */
  /* ---------------------------------------------------------------- */

  useAbility(p: PlayerTank, input: PlayerInput): void {
    const def = getAbility(p.ability);
    const cd = def.cooldown * p.stats.abilityCdMul;
    p.abilityCooldown = cd;
    p.abilityActive = def.duration;
    p.abilityUsedAt = this.time;
    this.events.emit('abilityUsed', { id: def.id, x: p.x, y: p.y });
    this.events.emit('sfx', { name: def.id === 'dash' ? 'dash' : def.id === 'emp' ? 'emp' : def.id === 'shield' ? 'shield_up' : def.id === 'teleport' ? 'teleport' : def.id === 'airstrike' ? 'airstrike' : def.id === 'drone' ? 'drone' : def.id === 'repair' ? 'repair' : 'power', volume: 0.85 });

    switch (def.id) {
      case 'dash': {
        const a = input.aimMode === 'mouse' && !input.classic ? Math.atan2(input.aimY - p.y, input.aimX - p.x) : p.angle;
        const dirX = Math.abs(input.mx) + Math.abs(input.my) > 0.1 ? Math.atan2(input.my, input.mx) : a;
        p.vx += Math.cos(dirX) * def.params.impulse;
        p.vy += Math.sin(dirX) * def.params.impulse;
        p.invuln = Math.max(p.invuln, def.params.iframe);
        this.particles.emit('dust', p.x, p.y, { count: 16, speed: [40, 180], life: [0.2, 0.5], size: [2, 5], color: def.color, angle: dirX + Math.PI, spread: 1.2, layer: 2 });
        this.shake(3.4, 0.18);
        break;
      }
      case 'shield': {
        p.shieldMax = Math.max(p.shieldMax, 1);
        p.shield = Math.max(p.shield, def.params.absorb * (1 + p.stats.shieldMax / 400));
        p.shieldDownTimer = 0;
        this.particles.emit('ring', p.x, p.y, { count: 1, speed: [0, 0], life: [0.4, 0.4], size: [10, 10], sizeEnd: 70, color: def.color, layer: 2 });
        break;
      }
      case 'emp': {
        this.empPulse(p.x, p.y, def.params.radius * (1 + p.stats.shieldMax / 600), def.params.stun);
        break;
      }
      case 'airstrike': {
        const a = Math.atan2(input.aimY - p.y, input.aimX - p.x);
        this.callAirstrike(p.x, p.y, a, def.params.bombs, def.params.damage, def.params.radius);
        break;
      }
      case 'repair': {
        // handled per-frame in tickAbility
        break;
      }
      case 'drone': {
        const count = def.params.count + (p.stats.maxHp > 220 ? 1 : 0);
        for (let i = 0; i < count; i++) {
          const d = new Drone();
          d.init(p.x, p.y, 46 + i * 16, def.duration, def.params.damage * p.stats.damageMul);
          this.drones.push(d);
        }
        break;
      }
      case 'cluster': {
        const n = def.params.shards;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU;
          this.fireShell({
            x: p.x + Math.cos(a) * 14,
            y: p.y + Math.sin(a) * 14,
            angle: a,
            speed: 330,
            damage: def.params.damage * p.stats.damageMul,
            radius: 4,
            team: 'player',
            weapon: 'rocket',
            pierce: 0,
            armorPierce: 0.2,
            splash: 40,
            splashDamage: 22 * p.stats.damageMul,
            knockback: 90,
            shake: 1.2,
            cutWidth: 1,
            color: '#ffc0e0',
            glow: def.color,
            trail: 1.6,
            homing: 0,
            arc: false,
            lifetime: 1.2,
            crit: false,
            owner: p.id,
            interceptable: false,
          });
        }
        this.shake(6, 0.3);
        break;
      }
      case 'timeslow': {
        this.timeScale = def.params.scale;
        this.events.emit('slowmo', { scale: def.params.scale, duration: def.duration });
        this.flash(0.24, def.color, 0.4);
        break;
      }
      case 'magnet': {
        p.addBuff('magnet', def.params.radius, def.duration);
        break;
      }
      case 'teleport': {
        const a = Math.atan2(input.aimY - p.y, input.aimX - p.x);
        const range = def.params.range;
        let tx = p.x + Math.cos(a) * range;
        let ty = p.y + Math.sin(a) * range;
        // step back until the destination is free
        for (let d = range; d >= 40; d -= 16) {
          const cx = clamp(p.x + Math.cos(a) * d, 20, this.grid.width - 20);
          const cy = clamp(p.y + Math.sin(a) * d, 20, this.grid.height - 20);
          if (!this.grid.rectHitsSolid({ x: cx - p.size / 2, y: cy - p.size / 2, w: p.size, h: p.size }, { hover: p.hover, offroad: false })) {
            tx = cx;
            ty = cy;
            break;
          }
        }
        const ox = p.x;
        const oy = p.y;
        p.x = tx;
        p.y = ty;
        p.invuln = Math.max(p.invuln, 0.6);
        this.particles.emit('ring', ox, oy, { count: 1, speed: [0, 0], life: [0.36, 0.4], size: [8, 8], sizeEnd: 60, color: def.color, layer: 2 });
        this.particles.emit('ring', tx, ty, { count: 1, speed: [0, 0], life: [0.36, 0.4], size: [8, 8], sizeEnd: 60, color: def.color, layer: 2 });
        this.explode(ox, oy, def.params.decoyRadius, def.params.decoyDamage * p.stats.damageMul, { color: def.color, big: false, team: 'player', shake: 8, damageTerrain: true });
        break;
      }
    }
  }

  tickAbility(p: PlayerTank, dt: number): void {
    const def = getAbility(p.ability);
    if (def.id === 'repair') {
      p.hp = Math.min(p.maxHp, p.hp + def.params.hpPerSec * dt);
      this.base.repair(def.params.baseHeal * dt * 0.35);
      if (Math.random() < dt * 22) {
        this.particles.emit('glow', p.x + randRange(-14, 14), p.y + randRange(-14, 14), {
          count: 1,
          speed: [6, 30],
          life: [0.3, 0.7],
          size: [1.6, 3.4],
          color: def.color,
          gravity: -40,
          layer: 2,
        });
      }
    } else if (def.id === 'shield') {
      p.shield = Math.max(p.shield, def.params.absorb * 0.55);
      p.shieldDownTimer = 0;
    } else if (def.id === 'dash') {
      this.particles.emit('dust', p.x, p.y, { count: 2, speed: [10, 60], life: [0.12, 0.3], size: [2, 4.5], color: def.color, layer: 1 });
    } else if (def.id === 'timeslow') {
      this.timeScale = def.params.scale;
    }
  }

  endAbility(p: PlayerTank): void {
    const def = getAbility(p.ability);
    if (def.id === 'timeslow') {
      this.timeScale = 1;
      this.flash(0.16, '#fff', 0.24);
    }
    if (def.id === 'shield') {
      p.shieldDownTimer = 1.4;
    }
    p.abilityActive = 0;
  }

  empPulse(x: number, y: number, radius: number, stun: number): void {
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < radius + e.size) {
        e.stun = Math.max(e.stun, stun * (e.isBoss ? 0.45 : 1));
        e.empTimer = Math.max(e.empTimer, stun);
        e.shield = Math.max(0, e.shield - e.shieldMax);
        e.takeDamage(this, { amount: 14, fromX: x, fromY: y, source: 'ability', team: 'player', ignoreShield: true });
        this.particles.emit('bolt', e.x, e.y, { count: 6, speed: [30, 120], life: [0.16, 0.4], size: [1.4, 3], color: '#bcd0ff', layer: 2 });
      }
    }
    for (const m of this.mines) {
      if (Math.hypot(m.x - x, m.y - y) < radius) {
        m.active = false;
        this.explode(m.x, m.y, m.blastRadius, m.damage, { color: '#ff8a3c', team: m.team, shake: 4 });
      }
    }
    this.particles.emit('ring', x, y, { count: 2, speed: [0, 0], life: [0.42, 0.55], size: [12, 16], sizeEnd: radius * 1.5, color: '#9ab4ff', layer: 2 });
    this.shockwaves.push({ x, y, r: 10, maxR: radius * 1.4, life: 0.45, color: '#9ab4ff' });
    this.flash(0.2, '#9ab4ff', 0.3);
    this.shake(7, 0.35);
    this.events.emit('sfx', { name: 'emp', volume: 0.9 });
  }

  private airstrikeQueue: { x: number; y: number; t: number; damage: number; radius: number }[] = [];

  callAirstrike(x: number, y: number, angle: number, bombs: number, damage: number, radius: number): void {
    for (let i = 0; i < bombs; i++) {
      const d = (i - (bombs - 1) / 2) * 62;
      this.airstrikeQueue.push({
        x: x + Math.cos(angle) * d + randRange(-14, 14),
        y: y + Math.sin(angle) * d + randRange(-14, 14),
        t: 0.35 + i * 0.16,
        damage,
        radius,
      });
    }
    this.flash(0.2, '#ff9d5c', 0.3);
    this.events.emit('sfx', { name: 'alarm', volume: 0.8 });
  }

  enemyBlink(tank: EnemyTank): void {
    const spot = this.findOpenSpot(tank.x + randRange(-150, 150), tank.y + randRange(-150, 150), 60);
    this.particles.emit('ring', tank.x, tank.y, { count: 1, speed: [0, 0], life: [0.3, 0.34], size: [8, 8], sizeEnd: 46, color: tank.def.colors.glow, layer: 2 });
    tank.x = spot.x;
    tank.y = spot.y;
    tank.vx = tank.vy = 0;
    tank.invuln = Math.max(tank.invuln, 0.4);
    this.particles.emit('ring', tank.x, tank.y, { count: 1, speed: [0, 0], life: [0.3, 0.34], size: [8, 8], sizeEnd: 46, color: tank.def.colors.glow, layer: 2 });
    this.events.emit('sfx', { name: 'teleport', x: tank.x, y: tank.y, volume: 0.5, pitch: 0.8 });
  }

  /* ---------------------------------------------------------------- */
  /* boss control                                                      */
  /* ---------------------------------------------------------------- */

  updateBoss(boss: EnemyTank, dt: number): void {
    const phases = boss.def.phases ?? 1;
    const newPhase = boss.phaseForHp();
    if (newPhase > boss.phase) {
      boss.phase = newPhase;
      boss.patternTimer = 0;
      boss.patternIndex = 0;
      this.events.emit('bossPhase', { phase: newPhase + 1, name: this.bossPhaseName(boss, newPhase) });
      this.flash(0.35, boss.def.colors.glow, 0.5);
      this.shake(14, 0.7);
      this.hitStop = 0.22;
      this.events.emit('sfx', { name: 'boss_warn', volume: 1, pitch: 0.85 + newPhase * 0.1 });
      if (newPhase >= phases - 1) {
        boss.enraged = true;
        boss.speed *= 1.42;
        boss.accel *= 1.5;
        boss.fireDelay *= this.difficulty.bossEnrageFire;
      }
      // phase-transition shockwave
      this.radialBurst(boss, this.difficulty.bossPhaseBurst, boss.damageBase * 0.7);
      this.particles.emit('ring', boss.x, boss.y, {
        count: 1,
        speed: [0, 0],
        life: [0.6, 0.65],
        size: [boss.size, boss.size],
        sizeEnd: boss.size * 6,
        color: boss.def.colors.glow,
        layer: 2,
      });
    }

    boss.patternTimer -= dt;
    if (boss.patternTimer > 0) return;

    const p = this.player;
    const abilities = boss.def.abilities ?? [];
    const roll = this.rng.next();

    if (abilities.includes('laser') && roll < 0.26) {
      boss.patternTimer = 5.2;
      this.startLaserSweep(boss);
    } else if (abilities.includes('charge') && roll < 0.46 && p && p.alive) {
      boss.patternTimer = 4.4;
      this.bossCharge(boss, p.x, p.y);
    } else if (abilities.includes('summon') && roll < 0.62 && this.enemies.length < this.difficulty.bossSummonCap) {
      boss.patternTimer = 6.5;
      this.bossSummon(boss);
    } else if (abilities.includes('missiles') && roll < 0.8) {
      boss.patternTimer = 3.4;
      this.radialBurst(boss, 8 + boss.phase * 2, boss.damageBase * 0.8, true);
    } else {
      boss.patternTimer = 2.8;
      this.radialBurst(boss, 12 + boss.phase * 4, boss.damageBase * 0.55);
    }
  }

  private bossPhaseName(boss: EnemyTank, phase: number): string {
    const names = boss.def.id === 'colossus'
      ? ['IRON WAKE', 'SIEGE MODE', 'OVERCLOCK', 'EXTINCTION PROTOCOL']
      : ['ARMORED PUSH', 'SHIELD CYCLE', 'ENRAGED'];
    return names[phase] ?? 'PHASE ' + (phase + 1);
  }

  radialBurst(boss: EnemyTank, count: number, damage: number, homing = false): void {
    const offset = this.rng.range(0, TAU);
    for (let i = 0; i < count; i++) {
      const a = offset + (i / count) * TAU;
      this.fireShell({
        x: boss.x + Math.cos(a) * (boss.size * 0.55),
        y: boss.y + Math.sin(a) * (boss.size * 0.55),
        angle: a,
        speed: homing ? 220 : 265,
        damage,
        radius: 5,
        team: 'enemy',
        weapon: 'rocket',
        pierce: 0,
        armorPierce: 0.15,
        splash: homing ? 44 : 26,
        splashDamage: damage * 0.5,
        knockback: 90,
        shake: 1.4,
        cutWidth: 1,
        color: boss.def.colors.accent,
        glow: boss.def.colors.glow,
        trail: 1.6,
        homing: homing ? 1.1 : 0,
        arc: false,
        lifetime: 3.4,
        crit: false,
        owner: boss.id,
        interceptable: !homing,
        fromBoss: true,
      });
    }
    this.shake(6, 0.3);
    this.events.emit('sfx', { name: 'shot_rocket', x: boss.x, y: boss.y, volume: 0.8, pitch: 0.7 });
  }

  private bossExtraPellets(boss: EnemyTank): number {
    const from = this.difficulty.bossExtraPelletFromPhase;
    if (from >= 99) return 0;
    const last = (boss.def.phases ?? 1) - 1;
    if (from < 0) return boss.phase >= last ? 1 : 0;
    return boss.phase >= from ? 1 : 0;
  }

  bossSummon(boss: EnemyTank): void {
    const count = boss.phase >= 1 ? 3 : 2;
    const elites = this.difficulty.bossSummonElites && boss.phase >= 2;
    const types: EnemyId[] = elites ? ['hunter', 'elite'] : ['scout', 'assault'];
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, TAU);
      const spot = this.findOpenSpot(boss.x + Math.cos(a) * 90, boss.y + Math.sin(a) * 90, 80);
      this.spawnEnemy(this.rng.pick(types), spot.x, spot.y, elites);
    }
    this.events.emit('sfx', { name: 'alarm', volume: 0.6 });
    this.particles.text(boss.x, boss.y - boss.size, 'DEPLOYING MINIONS', '#ffd447', 13, { bold: true, vy: -40, life: 1.4 });
  }

  bossCharge(boss: EnemyTank, tx: number, ty: number): void {
    const a = Math.atan2(ty - boss.y, tx - boss.x);
    boss.brain.state = 'charge';
    boss.brain.chargeTime = 1.2;
    boss.vx += Math.cos(a) * 520;
    boss.vy += Math.sin(a) * 520;
    boss.brain.override = (t, w, dt, cmd) => {
      t.brain.chargeTime -= dt;
      cmd.dirX = Math.cos(a);
      cmd.dirY = Math.sin(a);
      cmd.throttle = 1.9;
      w.particles.emit('dust', t.x, t.y, { count: 3, speed: [20, 90], life: [0.2, 0.5], size: [3, 7], color: '#8a7358', additive: false, layer: 0 });
      // ram damage
      const pl = w.player;
      if (pl && pl.alive && Math.hypot(pl.x - t.x, pl.y - t.y) < (t.size + pl.size) * 0.5 && t.contactCooldown <= 0) {
        t.contactCooldown = 0.5;
        pl.takeDamage(w, { amount: t.damageBase * 1.2, fromX: t.x, fromY: t.y, source: 'ram', team: 'enemy', knockback: 260 });
        w.shake(10, 0.4);
      }
      if (t.brain.chargeTime <= 0) {
        t.brain.override = null;
        t.brain.state = 'engage';
        w.explode(t.x, t.y, 80, t.damageBase * 0.6, { color: t.def.colors.glow, big: true, team: 'enemy', shake: 12, damageTerrain: true });
      }
    };
    this.particles.text(boss.x, boss.y - boss.size, 'CHARGING!', '#ff6b3d', 15, { bold: true, vy: -50, life: 1.1 });
    this.events.emit('sfx', { name: 'alarm', volume: 0.7 });
  }

  startLaserSweep(boss: EnemyTank): void {
    const p = this.player;
    if (!p) return;
    const base = Math.atan2(p.y - boss.y, p.x - boss.x);
    const beam: Beam = {
      active: true,
      owner: boss,
      x: boss.x,
      y: boss.y,
      angle: base - 0.85,
      sweepFrom: base - 0.85,
      sweepTo: base + 0.85,
      t: 0,
      duration: 2.4,
      length: 900,
      width: 12,
      damage: boss.damageBase * 0.9,
      team: 'enemy',
      color: boss.def.colors.glow,
      telegraph: 0.9,
      hitCooldown: new Map(),
    };
    this.beams.push(beam);
    this.particles.text(boss.x, boss.y - boss.size, 'LASER SWEEP', '#7ce7ff', 15, { bold: true, vy: -50, life: 1.2 });
    this.events.emit('sfx', { name: 'alarm', volume: 0.8 });
    this.events.emit('shake', { amount: 4 });
  }

  private updateBeams(dt: number): void {
    for (const b of this.beams) {
      if (!b.active) continue;
      b.t += dt;
      if (b.owner && b.owner.alive) {
        b.x = b.owner.x;
        b.y = b.owner.y;
      } else if (!b.owner || !b.owner.alive) {
        b.active = false;
        continue;
      }
      if (b.t < b.telegraph) {
        continue; // telegraph phase: no damage
      }
      const k = clamp((b.t - b.telegraph) / (b.duration - b.telegraph), 0, 1);
      b.angle = b.sweepFrom + (b.sweepTo - b.sweepFrom) * k;
      const ex = b.x + Math.cos(b.angle) * b.length;
      const ey = b.y + Math.sin(b.angle) * b.length;

      // terrain damage along the beam
      const hit = this.grid.raycast(b.x, b.y, ex, ey, 'bullet');
      const endX = hit ? hit.x : ex;
      const endY = hit ? hit.y : ey;
      if (hit && this.grid.inBounds(hit.cx, hit.cy)) {
        const res = this.grid.damageCell(hit.cx, hit.cy, b.damage * dt * 3.2, 0.4);
        if (res.destroyed) this.onTerrainDestroyed(hit.cx, hit.cy, res.terrain, b.damage);
      }

      // tanks
      const targets: Tank[] = [];
      if (this.player && this.player.alive) targets.push(this.player);
      for (const t of targets) {
        const last = b.hitCooldown.get(t.id) ?? -99;
        if (b.t - last < 0.25) continue;
        const seg = this.segmentPointDist(b.x, b.y, endX, endY, t.x, t.y);
        if (seg < t.size * 0.5 + b.width * 0.5) {
          b.hitCooldown.set(t.id, b.t);
          const res = t.takeDamage(this, { amount: b.damage * 0.28, fromX: b.x, fromY: b.y, source: 'laser', team: b.team, armorPierce: 0.3 });
          if (this.player && t === this.player) {
            this.damageTaken += res.applied;
            this.events.emit('playerDamaged', { hp: t.hp, maxHp: t.maxHp, amount: res.applied });
          }
          this.particles.emit('spark', t.x, t.y, { count: 6, speed: [40, 180], life: [0.1, 0.3], size: [1.2, 2.6], color: b.color, layer: 2 });
        }
      }
      if (this.base.alive) {
        const seg = this.segmentPointDist(b.x, b.y, endX, endY, this.base.x, this.base.y);
        if (seg < this.base.size * 0.5 + b.width * 0.5) {
          const last = b.hitCooldown.get(-1) ?? -99;
          if (b.t - last > 0.3) {
            b.hitCooldown.set(-1, b.t);
            this.base.takeDamage(this, b.damage * 0.22, b.x, b.y);
          }
        }
      }
      // beam particles
      if (Math.random() < dt * 60) {
        const d = this.rng.range(0, 1);
        this.particles.emit('glow', b.x + (endX - b.x) * d, b.y + (endY - b.y) * d, {
          count: 1,
          speed: [10, 60],
          life: [0.14, 0.34],
          size: [1.4, 3.4],
          color: b.color,
          layer: 2,
        });
      }
      if (b.t > b.duration) b.active = false;
    }
    this.beams = this.beams.filter((b) => b.active);
  }

  private segmentPointDist(x0: number, y0: number, x1: number, y1: number, px: number, py: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) return Math.hypot(px - x0, py - y0);
    let t = ((px - x0) * dx + (py - y0) * dy) / l2;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  findNearestHostile(x: number, y: number, team: Team, range: number): { x: number; y: number; ref: Tank | Base | null } | null {
    let best: { x: number; y: number; ref: Tank | Base | null } | null = null;
    let bestD = range * range;
    if (team === 'player') {
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const d = (e.x - x) ** 2 + (e.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: e.x, y: e.y, ref: e };
        }
      }
    } else {
      const p = this.player;
      if (p && p.alive) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: p.x, y: p.y, ref: p };
        }
      }
      if (this.base.alive) {
        const d = (this.base.x - x) ** 2 + (this.base.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: this.base.x, y: this.base.y, ref: this.base };
        }
      }
    }
    return best;
  }

  /**
   * Resolve one overlapping pair: mass-weighted push-apart plus ram damage.
   * Split out of `separateTank` so the caller can walk the enemy list *and* the
   * player without ever building a combined array.
   */
  private separatePair(tank: Tank, other: Tank, dt: number): void {
    if (other === tank || !other.alive) return;
    const dx = other.x - tank.x;
    const dy = other.y - tank.y;
    const minD = (tank.size + other.size) * 0.5;
    const d2 = dx * dx + dy * dy;
    if (d2 > minD * minD || d2 < 1e-6) return;
    const d = Math.sqrt(d2);
    const push = (minD - d) * 0.5;
    const nx = dx / d;
    const ny = dy / d;
    const massA = tank.isBossTank ? 4 : 1;
    const massB = other.isBossTank ? 4 : 1;
    const total = massA + massB;
    const k = Math.min(1, dt * 60);
    tank.x -= nx * push * (massB / total) * k;
    tank.y -= ny * push * (massB / total) * k;
    other.x += nx * push * (massA / total) * k;
    other.y += ny * push * (massA / total) * k;
    const profile = { hover: tank.hover, offroad: false };
    this.grid.depenetrate(tank, tank.size, profile);
    this.grid.depenetrate(other, other.size, { hover: other.hover, offroad: false });
    // ram damage from charging tanks
    if (tank.contactCooldown <= 0 && tank instanceof EnemyTank && tank.brain.state === 'charge') {
      tank.contactCooldown = 0.4;
      other.takeDamage(this, {
        amount: tank.damageBase,
        fromX: tank.x,
        fromY: tank.y,
        source: 'ram',
        team: tank.team,
        knockback: 220,
      });
    }
  }

  separateTank(tank: Tank, dt: number): void {
    // Never alias or push onto `this.enemies` here: doing so injects the player
    // into the enemy list, where World.update would then call
    // `player.update(world, dt)` with no input. An index loop is also safe
    // against the list changing while we walk it.
    for (let i = 0; i < this.enemies.length; i++) this.separatePair(tank, this.enemies[i], dt);
    if (this.player && this.player.alive) this.separatePair(tank, this.player, dt);
    // keep off the base
    if (this.base.alive) {
      const b = this.base;
      const dx = tank.x - b.x;
      const dy = tank.y - b.y;
      const minD = (tank.size + b.size) * 0.5;
      const d = Math.hypot(dx, dy);
      if (d < minD && d > 0.001) {
        tank.x = b.x + (dx / d) * minD;
        tank.y = b.y + (dy / d) * minD;
        this.grid.depenetrate(tank, tank.size, { hover: tank.hover, offroad: false });
      }
    }
  }

  shake(amount: number, duration = 0.25): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
    this.shakeTime = Math.max(this.shakeTime, duration);
  }

  flash(alpha: number, color: string, duration = 0.3): void {
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
    this.flashColor = color;
    this.flashTime = Math.max(this.flashTime, duration);
  }

  private updateFlowFields(dt: number): void {
    this.flowTimer -= dt;
    this.flowTimerBase -= dt;
    const p = this.player;
    if (this.flowTimer <= 0) {
      this.flowTimer = CFG.ai.flowFieldInterval;
      const tx = p && p.alive ? p.x : this.base.x;
      const ty = p && p.alive ? p.y : this.base.y;
      this.flowToPlayer.compute(
        this.grid,
        clamp(Math.floor(tx / (CELL * 2)), 0, this.flowToPlayer.bw - 1),
        clamp(Math.floor(ty / (CELL * 2)), 0, this.flowToPlayer.bh - 1),
        false,
      );
    }
    if (this.flowTimerBase <= 0) {
      this.flowTimerBase = CFG.ai.flowFieldInterval * 1.7;
      this.flowToBase.compute(
        this.grid,
        clamp(Math.floor(this.base.x / (CELL * 2)), 0, this.flowToBase.bw - 1),
        clamp(Math.floor(this.base.y / (CELL * 2)), 0, this.flowToBase.bh - 1),
        false,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* main update                                                       */
  /* ---------------------------------------------------------------- */

  update(dt: number, input: PlayerInput = emptyInput()): void {
    this.frame++;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt *= 0.12;
    }
    this.time += dt;

    // combo decay
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    this.updateFlowFields(dt);

    const p = this.player;
    if (p) {
      if (p.alive) p.update(this, dt, input);
      else {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0 && p.lives > 0) {
          const spot = this.findOpenSpot(this.spawnX, this.spawnY, 90);
          p.respawn(this, spot.x, spot.y);
        }
      }
    }

    const edtBase = dt * this.timeScale;
    for (const e of this.enemies) e.update(this, edtBase);
    this.enemies = this.enemies.filter((e) => e.alive);

    this.base.update(this, dt);

    // drones
    for (const d of this.drones) d.update(this, dt);
    this.drones = this.drones.filter((d) => d.active);

    // mines
    for (const m of this.mines) m.update(this, edtBase);
    this.mines = this.mines.filter((m) => m.active);

    // power-ups
    for (const pu of this.powerups) pu.update(this, dt);
    this.powerups = this.powerups.filter((pu) => pu.active);

    // periodic ambient power-up drop
    this.powerupTimer -= dt;
    if (this.powerupTimer <= 0) {
      this.powerupTimer = CFG.powerups.spawnInterval * (1 - Math.min(0.4, (this.player?.stats.luck ?? 0) * 0.5));
      this.dropAmbientPowerUp();
    }

    // airstrike bombs
    if (this.airstrikeQueue.length) {
      for (const b of this.airstrikeQueue) b.t -= dt;
      const ready = this.airstrikeQueue.filter((b) => b.t <= 0);
      this.airstrikeQueue = this.airstrikeQueue.filter((b) => b.t > 0);
      for (const b of ready) {
        this.explode(b.x, b.y, b.radius, b.damage * (this.player?.stats.damageMul ?? 1), {
          color: '#ff9d5c',
          big: true,
          team: 'player',
          shake: 12,
          damageTerrain: true,
          pierceArmor: 0.3,
        });
      }
    }

    this.applySurfaceHazards(dt);
    this.updateProjectiles(dt);
    this.updateBeams(dt);
    this.particles.update(dt);

    // shockwaves
    for (const s of this.shockwaves) {
      s.life -= dt;
      s.r += (s.maxR - s.r) * Math.min(1, dt * 9);
    }
    this.shockwaves = this.shockwaves.filter((s) => s.life > 0);

    // camera shake + flash
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const k = clamp(this.shakeTime * 4, 0, 1);
      const amp = this.shakeAmount * k;
      this.shakeX = (Math.random() * 2 - 1) * amp;
      this.shakeY = (Math.random() * 2 - 1) * amp;
      if (this.shakeTime <= 0) {
        this.shakeAmount = 0;
        this.shakeX = this.shakeY = 0;
      }
    } else {
      this.shakeAmount *= Math.exp(-CFG.camera.shakeDecay * dt);
      this.shakeX *= Math.exp(-CFG.camera.shakeDecay * dt);
      this.shakeY *= Math.exp(-CFG.camera.shakeDecay * dt);
    }
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) this.flashAlpha = 0;
    } else {
      this.flashAlpha *= Math.exp(-8 * dt);
    }
    // chrono field expiry safety
    if (this.timeScale !== 1 && (!p || p.ability !== 'timeslow' || p.abilityActive <= 0)) {
      this.timeScale = clamp(this.timeScale + dt * 1.6, 0, 1);
      if (this.timeScale > 0.995) this.timeScale = 1;
    }
  }

  private applySurfaceHazards(dt: number): void {
    const tick = (tank: Tank | null, attacker: Team): void => {
      if (!tank || !tank.alive || tank.invuln > 0) return;
      const cell = this.grid.at(Math.floor(tank.x / CELL), Math.floor(tank.y / CELL));
      const dps = TERRAIN[cell].hazardDps;
      if (dps <= 0) return;
      const amount = dps * dt * (tank.hover ? 0.35 : 1);
      const res = tank.takeDamage(this, {
        amount,
        fromX: tank.x,
        fromY: tank.y,
        source: 'fire',
        team: attacker,
        silent: true,
      });
      if (attacker === 'enemy' && this.player && tank === this.player && res.applied > 0) {
        this.damageTaken += res.applied;
      }
      if (Math.random() < dt * 9) {
        this.particles.emit('spark', tank.x, tank.y, {
          count: 2,
          speed: [12, 48],
          life: [0.12, 0.32],
          size: [1.2, 2.6],
          color: TERRAIN[cell].dust,
          layer: 2,
        });
      }
    };
    tick(this.player, 'enemy');
    for (const e of this.enemies) tick(e, 'player');
  }

  private dropAmbientPowerUp(): void {
    const alive = this.powerups.filter((p) => p.active).length;
    if (alive >= CFG.powerups.maxAlive) return;
    const spot = this.randomOpenSpot();
    if (!spot) return;
    this.spawnPowerUp(spot.x, spot.y);
  }

  randomOpenSpot(preferAwayFromPlayer = true): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = this.rng.range(30, this.grid.width - 30);
      const y = this.rng.range(30, this.grid.height - 30);
      if (this.grid.rectHitsSolid({ x: x - 13, y: y - 13, w: 26, h: 26 }, { hover: false, offroad: false })) continue;
      if (preferAwayFromPlayer && this.player && this.player.alive) {
        const d = Math.hypot(this.player.x - x, this.player.y - y);
        if (d < 120 && attempt < 40) continue;
      }
      if (this.base.alive && Math.hypot(this.base.x - x, this.base.y - y) < 70) continue;
      return { x, y };
    }
    return null;
  }

  reset(): void {
    this.enemies.length = 0;
    this.powerups.length = 0;
    this.mines.length = 0;
    this.drones.length = 0;
    this.beams.length = 0;
    this.shockwaves.length = 0;
    this.airstrikeQueue.length = 0;
    this.projectiles.releaseAll();
    this.particles.clear();
    this.combo = 0;
    this.comboTimer = 0;
    this.timeScale = 1;
    this.hitStop = 0;
    this.shakeAmount = 0;
    this.shakeTime = 0;
  }

  get aliveEnemies(): number {
    return this.enemies.length;
  }

  get accuracy(): number {
    return this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0;
  }
}
