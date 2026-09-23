import { describe, it, expect } from 'vitest';
import {
  TAU,
  clamp,
  lerp,
  damp,
  approach,
  dist,
  dist2,
  angleLerp,
  angleDiff,
  snapAngle4,
  rectsOverlap,
  rectContains,
  circleRectOverlap,
  segmentAABB,
  formatNumber,
  formatTime,
} from '../src/core/math';
import { Rng, hashString } from '../src/core/Rng';

describe('math: interpolation & clamping', () => {
  it('clamps to the inclusive range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 1)).toBe(0);
  });

  it('lerps linearly across t', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(10, 0, 0.25)).toBe(7.5);
  });

  it('damp converges toward the target without overshooting', () => {
    let v = 0;
    for (let i = 0; i < 240; i++) v = damp(v, 100, 6, 1 / 60);
    expect(v).toBeGreaterThan(99);
    expect(v).toBeLessThanOrEqual(100);
    // a single small step moves partway, never past the target
    expect(damp(0, 100, 6, 1 / 60)).toBeGreaterThan(0);
    expect(damp(0, 100, 6, 1 / 60)).toBeLessThan(100);
  });

  it('approach steps by a fixed amount and never overshoots', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(8, 10, 3)).toBe(10);
    expect(approach(10, 0, 3)).toBe(7);
    expect(approach(2, 0, 3)).toBe(0);
  });
});

describe('math: distance & angles', () => {
  it('computes squared and euclidean distance', () => {
    expect(dist2(0, 0, 3, 4)).toBe(25);
    expect(dist(0, 0, 3, 4)).toBe(5);
  });

  it('angleDiff wraps to the shortest signed delta in [-PI, PI]', () => {
    expect(angleDiff(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
    // from just below PI to just above -PI should be a tiny positive step
    expect(Math.abs(angleDiff(3.0, -3.0))).toBeLessThan(0.4);
    expect(angleDiff(0, 0)).toBe(0);
  });

  it('angleLerp interpolates along the short way', () => {
    expect(angleLerp(0, Math.PI / 2, 1)).toBeCloseTo(Math.PI / 2, 6);
    expect(angleLerp(0, Math.PI / 2, 0)).toBeCloseTo(0, 6);
    const mid = angleLerp(0, Math.PI / 2, 0.5);
    expect(mid).toBeCloseTo(Math.PI / 4, 6);
  });

  it('snapAngle4 snaps to the nearest cardinal and normalizes to [0, TAU)', () => {
    expect(snapAngle4(0.1)).toBeCloseTo(0, 6);
    expect(snapAngle4(Math.PI / 2 + 0.1)).toBeCloseTo(Math.PI / 2, 6);
    const snapped = snapAngle4(-Math.PI / 2);
    expect(snapped).toBeGreaterThanOrEqual(0);
    expect(snapped).toBeLessThan(TAU);
  });
});

describe('math: geometry overlap', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };

  it('rectsOverlap detects intersection and separation', () => {
    expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 20, y: 0, w: 5, h: 5 })).toBe(false);
    // touching edges do not overlap (strict <)
    expect(rectsOverlap(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
  });

  it('rectContains is inclusive of bounds', () => {
    expect(rectContains(a, 0, 0)).toBe(true);
    expect(rectContains(a, 10, 10)).toBe(true);
    expect(rectContains(a, 5, 5)).toBe(true);
    expect(rectContains(a, 11, 5)).toBe(false);
  });

  it('circleRectOverlap accounts for radius', () => {
    expect(circleRectOverlap(5, 5, 1, a)).toBe(true); // centre inside
    expect(circleRectOverlap(15, 5, 6, a)).toBe(true); // radius reaches the box
    expect(circleRectOverlap(15, 5, 4, a)).toBe(false); // radius falls short
  });

  it('segmentAABB returns entry time + normal on a hit, null on a miss', () => {
    const box = { x: 10, y: -5, w: 10, h: 10 };
    const hit = segmentAABB(0, 0, 20, 0, box);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0.5, 6); // enters x=10 halfway along
    expect(hit!.nx).toBe(-1); // hit the left face travelling +x
    expect(hit!.ny).toBe(0);

    // a segment that clearly misses returns null
    expect(segmentAABB(0, 100, 20, 100, box)).toBeNull();
    // a segment pointing away returns null
    expect(segmentAABB(30, 0, 40, 0, box)).toBeNull();
  });
});

describe('math: formatting', () => {
  it('formatTime renders m:ss and floors negatives to zero', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(600)).toBe('10:00');
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(59.9)).toBe('0:59');
  });

  it('formatNumber rounds and groups thousands', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(1000000)).toBe('1,000,000');
    expect(formatNumber(99.6)).toBe('100');
  });
});

describe('Rng: deterministic pseudo-randomness', () => {
  it('produces an identical stream for the same seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 50; i++) if (a.next() === b.next()) same++;
    expect(same).toBeLessThan(5);
  });

  it('next() stays in [0, 1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('range/int respect their bounds (int inclusive)', () => {
    const r = new Rng(99);
    for (let i = 0; i < 500; i++) {
      const f = r.range(2, 5);
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThan(5);
      const n = r.int(1, 6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it('chance(0) never fires and chance(1) always fires', () => {
    const r = new Rng(5);
    for (let i = 0; i < 50; i++) expect(r.chance(0)).toBe(false);
    for (let i = 0; i < 50; i++) expect(r.chance(1)).toBe(true);
  });

  it('pick always returns a member of the array', () => {
    const r = new Rng(3);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) expect(arr).toContain(r.pick(arr));
  });

  it('shuffle is a permutation (same multiset) and deterministic per seed', () => {
    const base = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = new Rng(42).shuffle([...base]);
    const s2 = new Rng(42).shuffle([...base]);
    expect(s1).toEqual(s2);
    expect([...s1].sort((x, y) => x - y)).toEqual(base);
  });

  it('weighted honours extreme weights', () => {
    const r = new Rng(11);
    const items = ['rare', 'common'];
    // zero weight on 'rare' => never picked
    for (let i = 0; i < 200; i++) expect(r.weighted(items, [0, 1])).toBe('common');
    // zero weight on 'common' => always 'rare'
    for (let i = 0; i < 200; i++) expect(r.weighted(items, [1, 0])).toBe('rare');
  });

  it('state can be captured and restored via fromState', () => {
    const r = new Rng(2024);
    for (let i = 0; i < 10; i++) r.next();
    const snapshot = r.stateValue;
    const expected = r.next();
    const restored = Rng.fromState(2024, snapshot);
    expect(restored.next()).toBe(expected);
  });

  it('hashString is stable and varies with input', () => {
    expect(hashString('tankforge')).toBe(hashString('tankforge'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});
