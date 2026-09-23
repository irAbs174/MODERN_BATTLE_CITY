/** Core math helpers. All game logic uses world units (1 unit = 1px at zoom 1). */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential smoothing. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

export const approach = (v: number, target: number, step: number): number =>
  v < target ? Math.min(v + step, target) : Math.max(v - step, target);

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.sqrt(dist2(ax, ay, bx, by));

export const angleLerp = (a: number, b: number, t: number): number => {
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
};

export const angleDiff = (a: number, b: number): number => {
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return d;
};

export const snapAngle4 = (a: number): number => {
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  return ((q % TAU) + TAU) % TAU;
};

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

export const circleRectOverlap = (
  cx: number,
  cy: number,
  cr: number,
  r: Rect,
): boolean => {
  const nx = clamp(cx, r.x, r.x + r.w);
  const ny = clamp(cy, r.y, r.y + r.h);
  return dist2(cx, cy, nx, ny) <= cr * cr;
};

/**
 * Segment (p0 -> p1) vs AABB intersection.
 * Returns hit time t in [0,1] plus the surface normal, or null when it misses.
 * Used for fast projectile/LOS tests so tunneling cannot happen.
 */
export const segmentAABB = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Rect,
): { t: number; nx: number; ny: number } | null => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let tmin = 0;
  let tmax = 1;
  let nx = 0;
  let ny = 0;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (x0 < r.x || x0 > r.x + r.w) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (r.x - x0) * inv;
    let t2 = (r.x + r.w - x0) * inv;
    let n = -1;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
      n = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = Math.sign(dx) * n;
      ny = 0;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (y0 < r.y || y0 > r.y + r.h) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (r.y - y0) * inv;
    let t2 = (r.y + r.h - y0) * inv;
    let n = -1;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
      n = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = 0;
      ny = Math.sign(dy) * n;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  return { t: tmin, nx, ny };
};

export const randRange = (min: number, max: number): number => min + Math.random() * (max - min);

export const randInt = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min + 1));

export const pick = <T>(arr: readonly T[]): T => arr[(Math.random() * arr.length) | 0];

export const chance = (p: number): boolean => Math.random() < p;

/** Smooth 0..1 pulse used for telegraphs and glows. */
export const pulse = (t: number): number => 0.5 - 0.5 * Math.cos(clamp(t, 0, 1) * Math.PI * 2);

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number): number => t * t * t;
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutElastic = (t: number): number => {
  const c4 = (2 * Math.PI) / 3;
  return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

export const formatNumber = (n: number): string => Math.round(n).toLocaleString('en-US');

export const formatTime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
