import { describe, it, expect } from 'vitest';
import {
  SaveSystem,
  defaultSave,
  DEFAULT_SETTINGS,
  SAVE_VERSION,
  SAVE_KEY,
  mergeDeep,
  submitScore,
  type ScoreEntry,
} from '../src/meta/SaveSystem';

/** Minimal in-memory StorageLike so tests never touch real localStorage. */
class MockStorage {
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

const scoreEntry = (score: number): ScoreEntry => ({
  score,
  wave: 1,
  time: 60,
  kills: 0,
  difficulty: 'veteran',
  chassis: 'ranger',
  date: Date.now(),
});

describe('defaultSave', () => {
  it('is a fresh, valid profile', () => {
    const s = defaultSave();
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.meta.coins).toBe(0);
    expect(s.meta.level).toBe(1);
    expect(s.meta.chassis).toBe('ranger');
    expect(s.meta.unlockedWeapons).toContain('cannon');
    expect(s.meta.unlockedAbilities).toContain('dash');
    expect(s.base.hp).toBe(500);
    expect(s.campaign.highestStage).toBe(1);
    expect(s.devUnlocked).toBe(false);
    expect(s.settings.quality).toBe('high');
    expect(DEFAULT_SETTINGS.controlScheme).toBe('modern');
  });
});

describe('SaveSystem persistence', () => {
  it('starts from defaults on empty storage', () => {
    const sys = new SaveSystem(new MockStorage());
    expect(sys.save.meta.coins).toBe(0);
    expect(sys.save.version).toBe(SAVE_VERSION);
  });

  it('persists updates and reloads them from the same storage', () => {
    const storage = new MockStorage();
    const sys = new SaveSystem(storage);
    sys.update((s) => {
      s.meta.coins = 500;
      s.meta.level = 3;
    });
    // in node, markDirty flushes synchronously
    const reloaded = new SaveSystem(storage);
    expect(reloaded.save.meta.coins).toBe(500);
    expect(reloaded.save.meta.level).toBe(3);
  });

  it('flush() reports success', () => {
    const sys = new SaveSystem(new MockStorage());
    sys.update((s) => (s.meta.coins = 10));
    expect(sys.flush()).toBe(true);
  });

  it('reset() wipes back to defaults in memory and storage', () => {
    const storage = new MockStorage();
    const sys = new SaveSystem(storage);
    sys.update((s) => (s.meta.coins = 999));
    sys.reset();
    expect(sys.save.meta.coins).toBe(0);
    expect(new SaveSystem(storage).save.meta.coins).toBe(0);
  });
});

describe('SaveSystem migration & merge', () => {
  it('merges a partial save against defaults and migrates bad values', () => {
    const storage = new MockStorage();
    const partial = {
      version: 1,
      settings: { quality: 'ultra', masterVolume: 5, sfxVolume: -2, controlScheme: 'weird' },
      base: { hp: 0 },
      meta: { unlockedWeapons: [], coins: 123 },
    };
    storage.setItem(SAVE_KEY, JSON.stringify(partial));
    const s = new SaveSystem(storage).save;

    // settings clamped / coerced into valid ranges
    expect(s.settings.quality).toBe('high');
    expect(s.settings.masterVolume).toBe(1);
    expect(s.settings.sfxVolume).toBe(0);
    expect(s.settings.controlScheme).toBe('modern');
    // base hp repaired
    expect(s.base.hp).toBe(500);
    // starter kit always present
    expect(s.meta.unlockedWeapons).toContain('cannon');
    expect(s.meta.unlockedAbilities).toContain('dash');
    expect(s.meta.unlockedChassis).toContain('ranger');
    // user value preserved, missing fields filled from defaults
    expect(s.meta.coins).toBe(123);
    expect(s.meta.level).toBe(1);
    expect(s.version).toBe(SAVE_VERSION);
  });

  it('recovers gracefully from corrupt JSON', () => {
    const storage = new MockStorage();
    storage.setItem(SAVE_KEY, '{ this is not json ');
    const sys = new SaveSystem(storage);
    expect(sys.save.meta.coins).toBe(0); // fell back to defaults
    expect(sys.lastError).toBeTruthy();
  });

  it('mergeDeep overrides scalars, recurses objects, replaces arrays', () => {
    const out = mergeDeep<any>({ a: 1, b: { c: 2, d: 3 }, list: [1, 2] }, { b: { c: 9 }, list: [7] });
    expect(out.a).toBe(1);
    expect(out.b.c).toBe(9);
    expect(out.b.d).toBe(3);
    expect(out.list).toEqual([7]);
  });
});

describe('SaveSystem export / import', () => {
  it('round-trips a profile through a string', () => {
    const a = new SaveSystem(new MockStorage());
    a.update((s) => {
      s.meta.coins = 777;
      s.campaign.completed = [1, 2, 3];
    });
    const str = a.exportString();
    expect(typeof str).toBe('string');

    const b = new SaveSystem(new MockStorage());
    expect(b.importString(str)).toBe(true);
    expect(b.save.meta.coins).toBe(777);
    expect(b.save.campaign.completed).toEqual([1, 2, 3]);
  });

  it('rejects a malformed import string', () => {
    const sys = new SaveSystem(new MockStorage());
    expect(sys.importString('@@@@not-base64@@@@')).toBe(false);
    expect(sys.lastError).toBeTruthy();
  });
});

describe('submitScore', () => {
  it('keeps the leaderboard sorted and trimmed', () => {
    const save = defaultSave();
    submitScore(save, 'endless', scoreEntry(100));
    submitScore(save, 'endless', scoreEntry(400));
    submitScore(save, 'endless', scoreEntry(250));
    expect(save.records.endless.map((e) => e.score)).toEqual([400, 250, 100]);

    for (let i = 0; i < 30; i++) submitScore(save, 'endless', scoreEntry(i));
    expect(save.records.endless).toHaveLength(10);
    expect(save.records.endless[0].score).toBe(400);
  });

  it('returns the rank of the submitted entry', () => {
    const save = defaultSave();
    submitScore(save, 'survival', scoreEntry(10));
    const rank = submitScore(save, 'survival', scoreEntry(999));
    expect(rank).toBe(0);
  });
});
