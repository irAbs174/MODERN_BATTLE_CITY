import { GameMode } from './GameMode';
import type { LevelDef } from '../world/levels';
import { getLevel, CAMPAIGN_STAGE_COUNT } from '../world/levels';
import { composeWave } from '../world/LevelGen';
import { Rng } from '../core/Rng';
import { getEnemy, type EnemyId } from '../data/enemies';
import { clamp } from '../core/math';
import type { World } from '../world/World';
import type { PowerUpId } from '../data/powerups';

/* ------------------------------------------------------------------ */
/* Campaign                                                            */
/* ------------------------------------------------------------------ */

export class CampaignMode extends GameMode {
  readonly id = 'campaign';
  readonly displayName: string;
  level: LevelDef;

  constructor(levelId: number) {
    super();
    this.level = getLevel(levelId);
    this.displayName = `STAGE ${this.level.id} · ${this.level.name}`;
  }

  protected onAttach(): void {
    this.waveTotal = this.level.waves.length;
    this.maxConcurrent = clamp(4 + Math.floor(this.level.id / 3), 4, 11);
    if (this.level.boss) this.maxConcurrent = Math.min(this.maxConcurrent, this.world.difficulty.bossSummonCap);
    this.modifiers = [];
    if (this.level.hazard) this.modifiers.push(this.level.hazard);
  }

  startWave(index: number): void {
    if (index >= this.level.waves.length) {
      this.waveActive = this.world.enemies.length > 0 || this.spawnQueue.length > 0;
      if (!this.waveActive) this.showBanner('SECTOR SECURED', 2.4);
      return;
    }
    const skipLast =
      this.world.difficulty.bossSkipEarlyLastWave &&
      !!this.level.boss &&
      (this.level.id === 4 || this.level.id === 8) &&
      index === this.level.waves.length - 1;
    if (skipLast) {
      this.waveIndex = index + 1;
      this.startWave(this.waveIndex);
      return;
    }
    let wave = this.level.waves[index];
    const mul = this.world.difficulty.bossEscortMul;
    if (this.level.boss && mul < 1) {
      wave = {
        ...wave,
        groups: wave.groups.map((g) =>
          getEnemy(g.type).boss ? g : { ...g, count: Math.max(1, Math.floor(g.count * mul)) },
        ),
      };
    }
    this.queueWave(wave, (this.level.intensity - 1) * 0.25);
  }

  checkVictory(): boolean {
    return (
      this.waveIndex >= this.level.waves.length &&
      this.spawnQueue.length === 0 &&
      this.world.enemies.length === 0
    );
  }

  objectiveText(): string {
    if (this.level.boss && this.world.enemies.some((e) => e.isBoss)) return 'Destroy the boss';
    return `Stage ${this.level.id} · ${this.wavesCleared}/${this.level.waves.length} waves cleared`;
  }
}

/* ------------------------------------------------------------------ */
/* Endless                                                             */
/* ------------------------------------------------------------------ */

export class EndlessMode extends GameMode {
  readonly id = 'endless';
  readonly displayName = 'ENDLESS';
  rng: Rng;
  private mutateEvery = 5;

  constructor(seed: number) {
    super();
    this.rng = new Rng(seed ^ 0x9e3779b9);
  }

  protected onAttach(): void {
    this.maxConcurrent = 6;
    this.waveTotal = 999;
    this.modifiers = ['Infinite waves · escalating budget'];
  }

  startWave(index: number): void {
    const wave = composeWave({ wave: index, budget: 0, seed: this.rng.seed }, this.rng, 'endless');
    this.maxConcurrent = clamp(6 + Math.floor(index / 2), 6, 14);
    this.queueWave(wave, Math.min(0.45, index * 0.02));
    if (index > 0 && index % this.mutateEvery === 0) this.mutateArena();
  }

  /** Keep the arena interesting: clear rubble and drop supplies. */
  private mutateArena(): void {
    const w = this.world;
    for (let i = 0; i < 2; i++) {
      const spot = w.randomOpenSpot(true);
      if (spot) w.spawnPowerUp(spot.x, spot.y);
    }
    this.showBanner('ARENA SHIFT', 2.2);
  }

  checkVictory(): boolean {
    return false;
  }

  objectiveText(): string {
    return `Wave ${this.waveIndex + 1} · survive the swarm`;
  }
}

/* ------------------------------------------------------------------ */
/* Survival (no base — pure endurance)                                 */
/* ------------------------------------------------------------------ */

export class SurvivalMode extends GameMode {
  readonly id = 'survival';
  readonly displayName = 'SURVIVAL';
  rng: Rng;

  constructor(seed: number) {
    super();
    this.rng = new Rng(seed ^ 0x5bf03635);
  }

  protected onAttach(): void {
    this.maxConcurrent = 5;
    this.waveTotal = 999;
    this.world.base.alive = false;
    this.world.base.hp = 0;
    this.modifiers = ['No HQ to defend · survive as long as you can'];
  }

  protected requiresBase(): boolean {
    return false;
  }

  startWave(index: number): void {
    const wave = composeWave({ wave: index, budget: 0, seed: this.rng.seed }, this.rng, 'survival');
    this.maxConcurrent = clamp(5 + Math.floor(index / 2), 5, 12);
    // survival waves arrive faster and never stop
    wave.delay = Math.max(0.9, wave.delay * 0.6);
    this.queueWave(wave, Math.min(0.4, index * 0.022));
    if (index > 0 && index % 4 === 0) {
      const w = this.world;
      for (let i = 0; i < 2; i++) {
        const spot = w.randomOpenSpot(true);
        if (spot) w.spawnPowerUp(spot.x, spot.y, i === 0 ? 'health' : undefined);
      }
    }
  }

  checkVictory(): boolean {
    return false;
  }

  objectiveText(): string {
    return `Survive · wave ${this.waveIndex + 1}`;
  }
}

/* ------------------------------------------------------------------ */
/* Boss rush                                                           */
/* ------------------------------------------------------------------ */

const BOSS_SEQUENCE: { boss: EnemyId; escorts: [EnemyId, number][]; name: string }[] = [
  { boss: 'fortress', escorts: [['scout', 2]], name: 'THE FORTRESS' },
  { boss: 'fortress', escorts: [['assault', 2], ['hunter', 1]], name: 'FORTRESS MK-II' },
  { boss: 'colossus', escorts: [['shield', 2]], name: 'COLOSSUS' },
  { boss: 'fortress', escorts: [['elite', 2]], name: 'SIEGE PRIME · ELITE' },
  { boss: 'colossus', escorts: [['wraith', 2], ['elite', 1]], name: 'IRON GOD · OMEGA' },
];

export class BossRushMode extends GameMode {
  readonly id = 'bossrush';
  readonly displayName = 'BOSS RUSH';
  private sequence = BOSS_SEQUENCE;

  protected onAttach(): void {
    this.maxConcurrent = 6;
    this.waveTotal = this.sequence.length;
    this.modifiers = ['Hull restored between fights'];
  }

  startWave(index: number): void {
    if (index >= this.sequence.length) {
      this.waveActive = false;
      return;
    }
    const entry = this.sequence[index];
    this.showBanner(`⚠ ${entry.name}`, 2.6);
    const delay = 2.4;
    this.spawnQueue.push({
      type: entry.boss,
      at: this.elapsed + delay,
      spawnIndex: 1,
      elite: false,
    });
    this.waveEnemiesTotal += 1 + entry.escorts.reduce((s, e) => s + e[1], 0);
    let t = this.elapsed + delay + 3;
    for (const [type, count] of entry.escorts) {
      for (let i = 0; i < count; i++) {
        this.spawnQueue.push({ type, at: t, spawnIndex: i % 4, elite: index >= 3 });
        t += 0.9;
      }
    }
    this.waveActive = true;
    // restore the player between fights
    const p = this.world.player;
    if (p && index > 0) {
      p.hp = p.maxHp;
      p.shield = p.shieldMax;
      p.abilityCooldown = 0;
      this.world.particles.text(p.x, p.y - 34, 'SYSTEMS RESTORED', '#8dff9a', 13, { bold: true, vy: -40, life: 1.4 });
      const spot = this.world.randomOpenSpot(true);
      if (spot) this.world.spawnPowerUp(spot.x, spot.y, 'shield');
    }
    this.world.events.emit('sfx', { name: 'boss_warn', volume: 1 });
  }

  protected onWaveCleared(): void {
    this.bossesKilled++;
    const w = this.world;
    w.score += 1500;
    w.flash(0.25, '#ffd447', 0.4);
    super.onWaveCleared();
  }

  checkVictory(): boolean {
    return (
      this.waveIndex >= this.sequence.length &&
      this.spawnQueue.length === 0 &&
      this.world.enemies.length === 0
    );
  }

  objectiveText(): string {
    return `Boss ${Math.min(this.waveIndex + 1, this.sequence.length)}/${this.sequence.length}`;
  }
}

/* ------------------------------------------------------------------ */
/* Challenge (rotating modifiers)                                      */
/* ------------------------------------------------------------------ */

export interface ChallengeModifier {
  id: string;
  name: string;
  desc: string;
  apply: (world: World, mode: ChallengeMode) => void;
}

export const CHALLENGE_MODIFIERS: ChallengeModifier[] = [
  {
    id: 'glass',
    name: 'GLASS CANNON',
    desc: 'Double damage, half hull.',
    apply: (w) => {
      const p = w.player;
      if (!p) return;
      // Mutate after any stat rebuild — recalcStats restores hull from the chassis.
      p.stats.damageMul *= 2;
      p.maxHp = Math.max(25, Math.round(p.maxHp * 0.5));
      p.hp = Math.min(p.hp, p.maxHp);
    },
  },
  {
    id: 'swarm',
    name: 'SWARM DOCTRINE',
    desc: 'Far more enemies at once.',
    apply: (_w, m) => {
      m.maxConcurrent = 16;
    },
  },
  {
    id: 'raiders',
    name: 'BASE HUNTERS',
    desc: 'Every enemy prioritises your HQ.',
    apply: (w) => {
      w.difficultyAcc *= 1.1;
    },
  },
  {
    id: 'armored',
    name: 'COMPOSITE PLATING',
    desc: 'All enemies gain +30% armor.',
    apply: (w) => {
      w.enemyScaling = { ...w.enemyScaling, armor: (w.enemyScaling.armor ?? 1) * 1.3 };
    },
  },
  {
    id: 'noability',
    name: 'SYSTEMS LOCKED',
    desc: 'Your special ability is disabled.',
    apply: (w) => {
      const p = w.player;
      if (!p) return;
      p.abilityCooldown = 99999;
      p.stats.abilityCdMul = 99;
    },
  },
  {
    id: 'scrap',
    name: 'SCRAP ECONOMY',
    desc: 'No ambient power-up drops — earn them.',
    apply: (w) => {
      for (const e of w.enemies) e.dropChance = 0;
      (w as unknown as { powerupTimer: number }).powerupTimer = 9999;
    },
  },
  {
    id: 'volatiles',
    name: 'VOLATILE FIELD',
    desc: 'Surface hazards stay off this run.',
    apply: () => {
      /* no extra terrain seeded */
    },
  },
  {
    id: 'elite',
    name: 'ELITE ONLY',
    desc: 'Every spawn is an elite variant.',
    apply: () => {
      /* handled via eliteBias */
    },
  },
];

export class ChallengeMode extends GameMode {
  readonly id = 'challenge';
  readonly displayName = 'CHALLENGE';
  rng: Rng;
  mods: ChallengeModifier[] = [];
  seed: number;

  constructor(seed: number) {
    super();
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x2545f491);
  }

  protected onAttach(): void {
    this.maxConcurrent = 8;
    this.waveTotal = 999;
    // pick 2 modifiers deterministically from the seed
    const pool = [...CHALLENGE_MODIFIERS];
    this.rng.shuffle(pool);
    this.mods = pool.slice(0, 2);
    this.modifiers = this.mods.map((m) => `${m.name} — ${m.desc}`);
    for (const m of this.mods) m.apply(this.world, this);
    if (this.mods.some((m) => m.id === 'raiders')) {
      // convert half the composition to raiders
      this.raiderBias = true;
    }
  }

  raiderBias = false;
  private eliteOnly = false;

  startWave(index: number): void {
    const wave = composeWave({ wave: index, budget: 0, seed: this.rng.seed }, this.rng, 'challenge');
    if (this.mods.some((m) => m.id === 'elite')) this.eliteOnly = true;
    if (this.raiderBias && index % 2 === 1) {
      wave.groups.push({ type: 'raider', count: 3, interval: 0.5, spawn: 2 });
    }
    this.maxConcurrent = clamp(this.maxConcurrent, 6, 16);
    this.queueWave(wave, this.eliteOnly ? 1 : Math.min(0.4, index * 0.03));
  }

  protected processSpawns(dt: number): void {
    if (this.eliteOnly) {
      for (const q of this.spawnQueue) {
        if (!getEnemy(q.type).boss) q.elite = true;
      }
    }
    super.processSpawns(dt);
  }

  checkVictory(): boolean {
    return false;
  }

  objectiveText(): string {
    return `Challenge · wave ${this.waveIndex + 1}`;
  }
}

/* ------------------------------------------------------------------ */

export const MODE_INFO = [
  {
    id: 'campaign',
    name: 'CAMPAIGN',
    desc: '24 handcrafted stages across 6 warzones. Clear them, beat the bosses, upgrade your forge.',
    accent: '#ffb547',
    icon: '⚑',
  },
  {
    id: 'endless',
    name: 'ENDLESS',
    desc: 'Procedurally generated arena, infinite escalating waves. Chase a high score.',
    accent: '#7ce7ff',
    icon: '∞',
  },
  {
    id: 'survival',
    name: 'SURVIVAL',
    desc: 'No HQ to defend. Just you, an open field and everything they can throw at it.',
    accent: '#8dff9a',
    icon: '☠',
  },
  {
    id: 'challenge',
    name: 'CHALLENGE',
    desc: 'Two random modifiers reshape the fight. New seed, new problem.',
    accent: '#ff7ab8',
    icon: '✦',
  },
  {
    id: 'bossrush',
    name: 'BOSS RUSH',
    desc: 'Five back-to-back super-heavies. Hull restored between kills.',
    accent: '#ff6b3d',
    icon: '⚔',
  },
] as const;

export type ModeId = (typeof MODE_INFO)[number]['id'];

export const STAGE_COUNT = CAMPAIGN_STAGE_COUNT;

export const randomSeed = (): number => (Math.random() * 1e9) | 0;

/** Power-ups that are fun to guarantee at the start of a long run. */
export const STARTER_DROPS: PowerUpId[] = ['health', 'shield'];
