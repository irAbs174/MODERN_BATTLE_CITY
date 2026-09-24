import type { AbilityId } from '../data/abilities';
import type { WeaponId } from '../data/weapons';
import type { ChassisId, UpgradeLevels } from '../data/progression';
import { emptyUpgrades } from '../data/progression';
import type { DifficultyId } from '../core/config';

export const SAVE_VERSION = 3;
export const SAVE_KEY = 'tankforge.save.v3';

export interface ScoreEntry {
  score: number;
  wave: number;
  time: number;
  kills: number;
  difficulty: DifficultyId;
  chassis: ChassisId;
  date: number;
  seed?: number;
}

export interface Settings {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  screenShake: boolean;
  shakeIntensity: number;
  reducedMotion: boolean;
  colorblind: boolean;
  damageNumbers: boolean;
  difficulty: DifficultyId;
  controlScheme: 'modern' | 'classic';
  quality: 'low' | 'medium' | 'high';
  showFps: boolean;
  showMinimap: boolean;
  hitmarkers: boolean;
  mouseAim: boolean;
  autoFire: boolean;
  keybinds: Record<string, string>;
  touchControls: boolean;
}

export interface BaseLoadout {
  level: number;
  turrets: number;
  barrier: number; // 0 none, 1 brick, 2 reinforced, 3 steel
  hp: number;
}

export interface SaveData {
  version: number;
  createdAt: number;
  updatedAt: number;
  campaign: {
    completed: number[];
    stars: Record<string, number>;
    bestScore: Record<string, number>;
    bestTime: Record<string, number>;
    highestStage: number;
    bossRushBest: number;
  };
  meta: {
    coins: number;
    xp: number;
    level: number;
    upgrades: UpgradeLevels;
    chassis: ChassisId;
    unlockedChassis: ChassisId[];
    unlockedWeapons: WeaponId[];
    unlockedAbilities: AbilityId[];
    loadout: WeaponId[];
    equippedAbility: AbilityId;
    skin: string;
    trail: string;
    turretStyle: string;
    baseDecor: string;
    unlockedSkins: string[];
    unlockedTrails: string[];
    unlockedTurrets: string[];
    unlockedDecor: string[];
  };
  base: BaseLoadout;
  settings: Settings;
  records: {
    endless: ScoreEntry[];
    survival: ScoreEntry[];
    bossRush: ScoreEntry[];
    challenge: ScoreEntry[];
  };
  stats: {
    totalKills: number;
    totalRuns: number;
    totalPlaytime: number;
    shotsFired: number;
    shotsHit: number;
    damageDealt: number;
    powerupsCollected: number;
    bossesKilled: number;
    barrelsDetonated: number;
    terrainDestroyed: number;
    bestCombo: number;
    deaths: number;
  };
  /** Set by the menu Konami-style code; persists across sessions. */
  devUnlocked: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.85,
  sfxVolume: 0.9,
  musicVolume: 0.55,
  screenShake: true,
  shakeIntensity: 1,
  reducedMotion: false,
  colorblind: false,
  damageNumbers: true,
  difficulty: 'veteran',
  controlScheme: 'modern',
  quality: 'high',
  showFps: false,
  showMinimap: true,
  hitmarkers: true,
  mouseAim: true,
  autoFire: true,
  touchControls: false,
  keybinds: {},
};

export const defaultSave = (): SaveData => ({
  version: SAVE_VERSION,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  campaign: { completed: [], stars: {}, bestScore: {}, bestTime: {}, highestStage: 1, bossRushBest: 0 },
  meta: {
    coins: 0,
    xp: 0,
    level: 1,
    upgrades: emptyUpgrades(),
    chassis: 'ranger',
    unlockedChassis: ['ranger'],
    unlockedWeapons: ['cannon'],
    unlockedAbilities: ['dash'],
    loadout: ['cannon'],
    equippedAbility: 'dash',
    skin: 'standard',
    trail: 'standard',
    turretStyle: 'standard',
    baseDecor: 'standard',
    unlockedSkins: ['standard'],
    unlockedTrails: ['standard'],
    unlockedTurrets: ['standard'],
    unlockedDecor: ['standard'],
  },
  base: { level: 1, turrets: 0, barrier: 1, hp: 500 },
  settings: { ...DEFAULT_SETTINGS },
  records: { endless: [], survival: [], bossRush: [], challenge: [] },
  stats: {
    totalKills: 0,
    totalRuns: 0,
    totalPlaytime: 0,
    shotsFired: 0,
    shotsHit: 0,
    damageDealt: 0,
    powerupsCollected: 0,
    bossesKilled: 0,
    barrelsDetonated: 0,
    terrainDestroyed: 0,
    bestCombo: 0,
    deaths: 0,
  },
  devUnlocked: false,
});

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** In-memory fallback so the game (and tests) work without localStorage. */
class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * localStorage-backed save with versioning, migration and deep-merge against
 * defaults so new fields never break an old save file.
 */
export class SaveSystem {
  private storage: StorageLike;
  private data: SaveData;
  private dirty = false;
  private flushTimer: number | null = null;
  readonly key: string;
  lastError: string | null = null;

  constructor(storage?: StorageLike, key = SAVE_KEY) {
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    this.key = key;
    this.data = defaultSave();
    this.load();
  }

  get save(): SaveData {
    return this.data;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  load(): SaveData {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) {
        this.data = defaultSave();
        return this.data;
      }
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      this.data = migrate(mergeDeep(defaultSave(), parsed));
      return this.data;
    } catch (e) {
      this.lastError = String(e);
      this.data = defaultSave();
      return this.data;
    }
  }

  /** Queue a write; flushes on a debounce so we never thrash localStorage. */
  markDirty(): void {
    this.dirty = true;
    if (typeof window === 'undefined') {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => this.flush(), 400);
    }
  }

  flush(): boolean {
    if (this.flushTimer !== null && typeof window !== 'undefined') {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return true;
    try {
      this.data.updatedAt = Date.now();
      this.data.version = SAVE_VERSION;
      this.storage.setItem(this.key, JSON.stringify(this.data));
      this.dirty = false;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  reset(): void {
    this.data = defaultSave();
    try {
      this.storage.removeItem(this.key);
    } catch {
      /* ignore */
    }
    this.dirty = true;
    this.flush();
  }

  update(fn: (data: SaveData) => void): void {
    fn(this.data);
    this.markDirty();
  }

  exportString(): string {
    return btoa(encodeURIComponent(JSON.stringify(this.data)));
  }

  importString(s: string): boolean {
    try {
      const parsed = JSON.parse(decodeURIComponent(atob(s.trim()))) as Partial<SaveData>;
      this.data = migrate(mergeDeep(defaultSave(), parsed));
      this.markDirty();
      return this.flush();
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge where `src` overrides `base`, keeping arrays from src. */
export function mergeDeep<T>(base: T, src: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(src)) return (src ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(src as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[key];
    const s = (src as Record<string, unknown>)[key];
    if (s === undefined) continue;
    if (isPlainObject(b) && isPlainObject(s)) out[key] = mergeDeep(b, s as Partial<typeof b>);
    else out[key] = s;
  }
  return out as T;
}

/** Forward-migrate older save shapes. */
export function migrate(data: SaveData): SaveData {
  const d = data;
  if (!d.campaign.completed) d.campaign.completed = [];
  if (!d.meta.loadout || d.meta.loadout.length === 0) d.meta.loadout = ['cannon'];
  if (!d.meta.unlockedWeapons.includes('cannon')) d.meta.unlockedWeapons.unshift('cannon');
  if (!d.meta.unlockedAbilities.includes('dash')) d.meta.unlockedAbilities.unshift('dash');
  if (!d.meta.unlockedChassis.includes('ranger')) d.meta.unlockedChassis.unshift('ranger');
  if (d.base.hp <= 0) d.base.hp = 500;
  // clamp settings into valid ranges
  const s = d.settings;
  s.masterVolume = clamp01(s.masterVolume);
  s.sfxVolume = clamp01(s.sfxVolume);
  s.musicVolume = clamp01(s.musicVolume);
  s.shakeIntensity = Math.max(0, Math.min(2, s.shakeIntensity ?? 1));
  if (!['low', 'medium', 'high'].includes(s.quality)) s.quality = 'high';
  if (s.controlScheme !== 'classic') s.controlScheme = 'modern';
  d.version = SAVE_VERSION;
  return d;
}

const clamp01 = (v: number): number => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

/** Submit a score to a mode leaderboard; keeps the top 10 sorted. */
export function submitScore(save: SaveData, mode: keyof SaveData['records'], entry: ScoreEntry): number {
  const list = save.records[mode];
  list.push(entry);
  list.sort((a, b) => b.score - a.score || b.wave - a.wave);
  const trimmed = list.slice(0, 10);
  save.records[mode] = trimmed;
  return trimmed.findIndex((e) => e === entry);
}
