/** Global tuning constants. Everything balance-related lives here. */

export const CFG = {
  /** Logic runs on a fixed timestep for deterministic, stable physics. */
  fixedDt: 1 / 60,
  maxFrameDt: 0.25,
  accumulatorClamp: 5, // max fixed steps per frame

  player: {
    size: 26,
    baseSpeed: 118,
    baseAccel: 620,
    baseHp: 100,
    turretTurn: 11, // rad/s
    bodyTurn: 9,
    lives: 5,
    respawnInvuln: 2.6,
    iframes: 0.35,
  },

  combat: {
    /** Combo window in seconds; resets when it expires. */
    comboWindow: 3.2,
    maxCombo: 99,
    critMul: 1.8,
    friendlyFire: false,
    bulletVsBullet: true,
  },

  scoring: {
    killBase: 100,
    comboStep: 0.12,
    noDamageBonus: 1500,
    baseIntactBonus: 800,
    timeBonusPerSecond: 12,
    perfectBonus: 2500,
  },

  economy: {
    xpPerLevelBase: 120,
    xpPerLevelGrowth: 1.22,
    coinPerScore: 220, // score needed per coin
  },

  camera: {
    shakeDecay: 5.2,
    basePadding: 40,
    maxZoom: 2.2,
    minZoom: 0.45,
    /** Extra zoom after fitting the arena so tanks read slightly larger. */
    fitScale: 1.1,
  },

  particles: {
    maxParticles: 1400,
    maxTrails: 900,
    maxTexts: 90,
    qualityScale: 1,
  },

  powerups: {
    dropChanceOnKill: 0.085,
    eliteDropChance: 0.5,
    lifetime: 16,
    maxAlive: 5,
    spawnInterval: 13,
  },

  ai: {
    flowFieldInterval: 0.28,
    sightRange: 460,
    reactionBase: 0.32,
  },
} as const;

/** Combat multipliers applied at spawn / boss AI. */
export interface DifficultyCombat {
  enemyHp: number;
  enemyDmg: number;
  enemySpeed: number;
  enemyRate: number;
  /** Replaces enemyHp / enemyDmg / enemyRate for bosses. */
  bossHp: number;
  bossDmg: number;
  bossRate: number;
  bossShield: number;
  bossArmor: number;
  /** Applied once to fireDelay on enrage (no extra fireCooldown stack). */
  bossEnrageFire: number;
  /** Extra boss pellet when phase >= this. 99 = never, -1 = last phase only. */
  bossExtraPelletFromPhase: number;
  bossSummonCap: number;
  bossSummonElites: boolean;
  /** Caps stageScaling.hp for bosses so late fights don't become sponges. */
  bossHpScaleCap: number;
  bossPhaseBurst: number;
  bossEscortMul: number;
  /** Skip the last timed escort wave on early Fortress stages (4 and 8). */
  bossSkipEarlyLastWave: boolean;
}

export const DEFAULT_COMBAT: DifficultyCombat = {
  enemyHp: 1,
  enemyDmg: 1,
  enemySpeed: 1,
  enemyRate: 1,
  bossHp: 0.88,
  bossDmg: 0.82,
  bossRate: 0.9,
  bossShield: 0.8,
  bossArmor: 0.9,
  bossEnrageFire: 0.75,
  bossExtraPelletFromPhase: -1,
  bossSummonCap: 9,
  bossSummonElites: true,
  bossHpScaleCap: 1.65,
  bossPhaseBurst: 18,
  bossEscortMul: 1,
  bossSkipEarlyLastWave: false,
};

export const DIFFICULTIES = [
  {
    id: 'recruit',
    name: 'Recruit',
    desc: 'Forgiving damage, slower enemies. Great for learning the arenas.',
    enemyHp: 0.78,
    enemyDmg: 0.62,
    enemySpeed: 0.86,
    enemyRate: 0.82,
    scoreMul: 0.8,
    rewardMul: 0.85,
    playerHp: 1.25,
    lives: 7,
    bossHp: 0.52,
    bossDmg: 0.18,
    bossRate: 0.68,
    bossShield: 0.0,
    bossArmor: 0.0,
    bossEnrageFire: 0.85,
    bossExtraPelletFromPhase: 99,
    bossSummonCap: 6,
    bossSummonElites: false,
    bossHpScaleCap: 1.45,
    bossPhaseBurst: 10,
    bossEscortMul: 0.5,
    bossSkipEarlyLastWave: true,
  },
  {
    id: 'veteran',
    name: 'Veteran',
    desc: 'The intended TANKFORGE experience.',
    scoreMul: 1,
    rewardMul: 1,
    playerHp: 1,
    lives: 5,
    ...DEFAULT_COMBAT,
  },
  {
    id: 'elite',
    name: 'Elite',
    desc: 'Sharper AI, tighter waves, heavier armor.',
    enemyHp: 1.28,
    enemyDmg: 1.4,
    enemySpeed: 1.09,
    enemyRate: 1.22,
    scoreMul: 1.35,
    rewardMul: 1.2,
    playerHp: 0.9,
    lives: 5,
    bossHp: 1.1,
    bossDmg: 1.22,
    bossRate: 1.08,
    bossShield: 1.05,
    bossArmor: 1,
    bossEnrageFire: 0.7,
    bossExtraPelletFromPhase: 1,
    bossSummonCap: 9,
    bossSummonElites: true,
    bossHpScaleCap: 1.85,
    bossPhaseBurst: 18,
    bossEscortMul: 1,
    bossSkipEarlyLastWave: false,
  },
  {
    id: 'nightmare',
    name: 'Nightmare',
    desc: 'No mercy. Elites everywhere, bosses enrage fast.',
    enemyHp: 1.6,
    enemyDmg: 1.85,
    enemySpeed: 1.18,
    enemyRate: 1.45,
    scoreMul: 1.85,
    rewardMul: 1.45,
    playerHp: 0.8,
    lives: 3,
    bossHp: 1.25,
    bossDmg: 1.45,
    bossRate: 1.22,
    bossShield: 1.2,
    bossArmor: 1.1,
    bossEnrageFire: 0.66,
    bossExtraPelletFromPhase: 1,
    bossSummonCap: 9,
    bossSummonElites: true,
    bossHpScaleCap: 2.1,
    bossPhaseBurst: 18,
    bossEscortMul: 1,
    bossSkipEarlyLastWave: false,
  },
] as const;

export type DifficultyId = (typeof DIFFICULTIES)[number]['id'];

export const getDifficulty = (id: DifficultyId) =>
  DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[1];

export const combatFromDifficulty = (d: (typeof DIFFICULTIES)[number]): DifficultyCombat => ({
  enemyHp: d.enemyHp,
  enemyDmg: d.enemyDmg,
  enemySpeed: d.enemySpeed,
  enemyRate: d.enemyRate,
  bossHp: d.bossHp,
  bossDmg: d.bossDmg,
  bossRate: d.bossRate,
  bossShield: d.bossShield,
  bossArmor: d.bossArmor,
  bossEnrageFire: d.bossEnrageFire,
  bossExtraPelletFromPhase: d.bossExtraPelletFromPhase,
  bossSummonCap: d.bossSummonCap,
  bossSummonElites: d.bossSummonElites,
  bossHpScaleCap: d.bossHpScaleCap,
  bossPhaseBurst: d.bossPhaseBurst,
  bossEscortMul: d.bossEscortMul,
  bossSkipEarlyLastWave: d.bossSkipEarlyLastWave,
});
