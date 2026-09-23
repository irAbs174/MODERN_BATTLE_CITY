import { CELL, CHAR_TO_TERRAIN, TERRAIN, Terrain, type ThemeId, THEMES } from './terrain';
import type { Rect } from '../core/math';
import { clamp } from '../core/math';

export interface RayHit {
  cx: number;
  cy: number;
  x: number;
  y: number;
  t: number;
  nx: number;
  ny: number;
  terrain: Terrain;
}

export interface DamageResult {
  destroyed: boolean;
  terrain: Terrain;
  cx: number;
  cy: number;
  overflow: number;
}

export interface MoveProfile {
  hover: boolean;
  offroad: boolean;
}

const DEFAULT_PROFILE: MoveProfile = { hover: false, offroad: false };

/**
 * Tile grid holding terrain type + structural HP per cell.
 * Handles solidity queries, axis-separated movement resolution, DDA raycasts
 * and area destruction. Zero allocation on hot paths.
 */
export class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  theme: ThemeId;

  private types: Uint8Array;
  private hp: Float32Array;
  /** Per-cell random detail seed, keeps debris/texture stable. */
  readonly detail: Uint8Array;

  private dirty: number[] = [];
  private dirtySet: Set<number> = new Set();

  constructor(cols: number, rows: number, theme: ThemeId = 'arid') {
    this.cols = cols;
    this.rows = rows;
    this.width = cols * CELL;
    this.height = rows * CELL;
    this.theme = theme;
    const n = cols * rows;
    this.types = new Uint8Array(n);
    this.hp = new Float32Array(n);
    this.detail = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.detail[i] = (Math.random() * 255) | 0;
  }

  get palette() {
    return THEMES[this.theme];
  }

  idx(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  at(cx: number, cy: number): Terrain {
    if (!this.inBounds(cx, cy)) return Terrain.Empty;
    return this.types[this.idx(cx, cy)] as Terrain;
  }

  hpAt(cx: number, cy: number): number {
    if (!this.inBounds(cx, cy)) return Infinity;
    return this.hp[this.idx(cx, cy)];
  }

  private blocksProfile(t: Terrain, profile: MoveProfile): boolean {
    const def = TERRAIN[t];
    if (def.liquid) return !profile.hover;
    return def.solid;
  }

  /** Terrain solidity for a point, respecting a movement profile. */
  solidAtPoint(x: number, y: number, profile: MoveProfile = DEFAULT_PROFILE): boolean {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
    const t = this.types[this.idx(cx, cy)] as Terrain;
    return this.blocksProfile(t, profile);
  }

  /** Movement modifiers (speed + grip) sampled over an AABB. */
  surfaceFactors(x: number, y: number, w: number, h: number): { speed: number; grip: number; terrain: Terrain } {
    const x0 = Math.max(0, Math.floor(x / CELL));
    const y0 = Math.max(0, Math.floor(y / CELL));
    const x1 = Math.min(this.cols - 1, Math.floor((x + w - 0.001) / CELL));
    const y1 = Math.min(this.rows - 1, Math.floor((y + h - 0.001) / CELL));
    let minSpeed = 1;
    let maxSpeed = 1;
    let grip = 1;
    let found: Terrain = Terrain.Empty;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const t = this.types[this.idx(cx, cy)] as Terrain;
        const def = TERRAIN[t];
        if (def.speedFactor !== 1 || def.grip !== 1) {
          minSpeed = Math.min(minSpeed, def.speedFactor);
          maxSpeed = Math.max(maxSpeed, def.speedFactor);
          grip = Math.min(grip, def.grip);
          found = t;
        }
      }
    }
    return { speed: minSpeed < 1 ? minSpeed : maxSpeed, grip, terrain: found };
  }

  cellBlocksMovement(cx: number, cy: number, profile: MoveProfile = DEFAULT_PROFILE): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
    const t = this.types[this.idx(cx, cy)] as Terrain;
    return this.blocksProfile(t, profile);
  }

  rectHitsSolid(rect: Rect, profile: MoveProfile = DEFAULT_PROFILE): boolean {
    const x0 = Math.floor(rect.x / CELL);
    const y0 = Math.floor(rect.y / CELL);
    const x1 = Math.floor((rect.x + rect.w - 0.001) / CELL);
    const y1 = Math.floor((rect.y + rect.h - 0.001) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (this.cellBlocksMovement(cx, cy, profile)) return true;
      }
    }
    return false;
  }

  private bodyHits(x: number, y: number, size: number, profile: MoveProfile): boolean {
    const half = size / 2;
    return this.rectHitsSolid({ x: x - half, y: y - half, w: size, h: size }, profile);
  }

  /**
   * Push a body out of any overlapping solid cells. Used after knockback /
   * tank separation, which can otherwise lodge a tank inside a wall and make
   * the next corridor look "blocked" by an invisible obstacle.
   *
   * Resolves the deepest overlapping tile along the axis of greater overlap,
   * always away from that tile's centre — never the geometrically shorter
   * "through the wall" exit, which used to teleport tanks onto the far side.
   */
  depenetrate(
    pos: { x: number; y: number },
    size: number,
    profile: MoveProfile = DEFAULT_PROFILE,
  ): boolean {
    const half = size / 2;
    if (!this.bodyHits(pos.x, pos.y, size, profile)) return false;
    const fromX = pos.x;
    const fromY = pos.y;
    for (let iter = 0; iter < 12; iter++) {
      if (!this.bodyHits(pos.x, pos.y, size, profile)) break;
      const x0 = Math.floor((pos.x - half) / CELL);
      const y0 = Math.floor((pos.y - half) / CELL);
      const x1 = Math.floor((pos.x + half - 0.001) / CELL);
      const y1 = Math.floor((pos.y + half - 0.001) / CELL);
      let bestOx = 0;
      let bestOy = 0;
      let bestCx = 0;
      let bestCy = 0;
      let found = false;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          if (!this.cellBlocksMovement(cx, cy, profile)) continue;
          const left = cx * CELL;
          const top = cy * CELL;
          const ox = Math.min(pos.x + half, left + CELL) - Math.max(pos.x - half, left);
          const oy = Math.min(pos.y + half, top + CELL) - Math.max(pos.y - half, top);
          if (ox <= 0 || oy <= 0) continue;
          if (!found || ox * oy > bestOx * bestOy) {
            found = true;
            bestOx = ox;
            bestOy = oy;
            bestCx = cx;
            bestCy = cy;
          }
        }
      }
      if (!found) break;
      const cellCx = bestCx * CELL + CELL / 2;
      const cellCy = bestCy * CELL + CELL / 2;
      if (bestOx <= bestOy) {
        const dir = pos.x >= cellCx ? 1 : -1;
        pos.x += dir * (bestOx + 0.2);
      } else {
        const dir = pos.y >= cellCy ? 1 : -1;
        pos.y += dir * (bestOy + 0.2);
      }
    }
    let bestD = Infinity;
    let bestX = pos.x;
    let bestY = pos.y;
    if (this.bodyHits(pos.x, pos.y, size, profile)) {
      const dirs: [number, number][] = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ];
      const limit = size + CELL + 2;
      for (const [dx, dy] of dirs) {
        const len = Math.hypot(dx, dy);
        for (let d = 1; d <= limit; d += 1) {
          const nx = pos.x + (dx / len) * d;
          const ny = pos.y + (dy / len) * d;
          if (!this.bodyHits(nx, ny, size, profile)) {
            if (d < bestD) {
              bestD = d;
              bestX = nx;
              bestY = ny;
            }
            break;
          }
        }
      }
      if (bestD === Infinity) {
        pos.x = fromX;
        pos.y = fromY;
        return false;
      }
    } else {
      bestX = pos.x;
      bestY = pos.y;
      bestD = Math.hypot(bestX - fromX, bestY - fromY) || 0.2;
    }
    // #region agent log
    {
      const now = Date.now();
      if (!(Grid as unknown as { _dbgDepAt?: number })._dbgDepAt || now - ((Grid as unknown as { _dbgDepAt?: number })._dbgDepAt ?? 0) > 250) {
        (Grid as unknown as { _dbgDepAt?: number })._dbgDepAt = now;
        fetch('http://127.0.0.1:7884/ingest/bbf8ac5e-bb5d-4c8d-bcf5-3ea2aee662a4', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '46aec3' },
          body: JSON.stringify({
            sessionId: '46aec3',
            runId: 'pre-fix',
            hypothesisId: 'A',
            location: 'Grid.ts:depenetrate',
            message: 'depenetrate escaped overlap',
            data: {
              fromX: Math.round(fromX * 10) / 10,
              fromY: Math.round(fromY * 10) / 10,
              toX: Math.round(bestX * 10) / 10,
              toY: Math.round(bestY * 10) / 10,
              dist: bestD,
              size,
            },
            timestamp: now,
          }),
        }).catch(() => {});
      }
    }
    // #endregion
    pos.x = clamp(bestX, half, this.width - half);
    pos.y = clamp(bestY, half, this.height - half);
    return true;
  }

  private scanAxis(
    start: number,
    other: number,
    delta: number,
    size: number,
    profile: MoveProfile,
    axis: 'x' | 'y',
  ): number {
    if (Math.abs(delta) < 1e-8) return start;
    let lo = 0;
    let hi = delta;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const x = axis === 'x' ? start + mid : other;
      const y = axis === 'y' ? start + mid : other;
      if (this.bodyHits(x, y, size, profile)) hi = mid;
      else lo = mid;
    }
    return start + lo;
  }

  private slideAxis(
    x: number,
    y: number,
    delta: number,
    size: number,
    profile: MoveProfile,
    axis: 'x' | 'y',
  ): { pos: number; blocked: boolean } {
    const start = axis === 'x' ? x : y;
    const other = axis === 'x' ? y : x;
    if (delta === 0) return { pos: start, blocked: false };
    const maxStep = CELL * 0.45;
    let cur = start;
    let rem = delta;
    let blocked = false;
    while (Math.abs(rem) > 1e-6) {
      const step = Math.abs(rem) > maxStep ? Math.sign(rem) * maxStep : rem;
      const next = cur + step;
      const nx = axis === 'x' ? next : other;
      const ny = axis === 'y' ? next : other;
      if (this.bodyHits(nx, ny, size, profile)) {
        blocked = true;
        cur = this.scanAxis(cur, other, step, size, profile, axis);
        cur -= Math.sign(step) * 0.2;
        break;
      }
      cur = next;
      rem -= step;
    }
    return { pos: cur, blocked };
  }

  /**
   * Axis-separated movement with slide. Mutates `pos` and returns which axes
   * were blocked so callers can kill velocity / trigger scrapes.
   */
  moveAndSlide(
    pos: { x: number; y: number },
    size: number,
    dx: number,
    dy: number,
    profile: MoveProfile = DEFAULT_PROFILE,
  ): { blockedX: boolean; blockedY: boolean } {
    const half = size / 2;
    this.depenetrate(pos, size, profile);

    let blockedX = false;
    let blockedY = false;

    if (dx !== 0) {
      const r = this.slideAxis(pos.x, pos.y, dx, size, profile, 'x');
      pos.x = r.pos;
      blockedX = r.blocked;
    }
    if (dy !== 0) {
      const r = this.slideAxis(pos.x, pos.y, dy, size, profile, 'y');
      pos.y = r.pos;
      blockedY = r.blocked;
    }

    pos.x = clamp(pos.x, half, this.width - half);
    pos.y = clamp(pos.y, half, this.height - half);
    if (this.bodyHits(pos.x, pos.y, size, profile)) this.depenetrate(pos, size, profile);
    return { blockedX, blockedY };
  }

  /** DDA raycast through the grid. `t` is normalised 0..1 along the segment. */
  raycast(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    mode: 'bullet' | 'sight' = 'bullet',
  ): RayHit | null {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;

    let cx = Math.floor(x0 / CELL);
    let cy = Math.floor(y0 / CELL);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(CELL / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(CELL / dy);
    let tMaxX =
      stepX === 0 ? Infinity : dx > 0 ? ((cx + 1) * CELL - x0) / dx : (cx * CELL - x0) / dx;
    let tMaxY =
      stepY === 0 ? Infinity : dy > 0 ? ((cy + 1) * CELL - y0) / dy : (cy * CELL - y0) / dy;

    let nx = 0;
    let ny = 0;
    let travel = 0; // world distance at which we entered the current cell
    const maxSteps = this.cols + this.rows + 4;

    for (let i = 0; i < maxSteps; i++) {
      // `travel` is the normalised entry parameter (0..1) of the current cell.
      if (!this.inBounds(cx, cy)) {
        const tn = clamp(travel, 0, 1);
        return { cx, cy, x: x0 + dx * tn, y: y0 + dy * tn, t: tn, nx, ny, terrain: Terrain.Empty };
      }
      const t = this.types[this.idx(cx, cy)] as Terrain;
      const blocks = mode === 'sight' ? TERRAIN[t].blocksSight : TERRAIN[t].blocksBullets;
      if (blocks) {
        const tn = clamp(travel, 0, 1);
        return {
          cx,
          cy,
          x: x0 + dx * tn,
          y: y0 + dy * tn,
          t: tn,
          nx,
          ny,
          terrain: t,
        };
      }
      if (tMaxX < tMaxY) {
        travel = tMaxX;
        cx += stepX;
        tMaxX += tDeltaX;
        nx = -stepX;
        ny = 0;
      } else {
        travel = tMaxY;
        cy += stepY;
        tMaxY += tDeltaY;
        nx = 0;
        ny = -stepY;
      }
      if (travel > 1) break; // passed the segment end (x1,y1) — stop, don't overshoot
    }
    return null;
  }

  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.raycast(x0, y0, x1, y1, 'sight') === null;
  }

  /** Spawn a muzzle in front of the hull, never on the far side of a wall. */
  muzzlePoint(x: number, y: number, angle: number, dist: number): { x: number; y: number; clipped: boolean } {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const x1 = x + dx * dist;
    const y1 = y + dy * dist;
    const hit = this.raycast(x, y, x1, y1, 'bullet');
    if (!hit) return { x: x1, y: y1, clipped: false };
    return { x: hit.x - dx * 1.6, y: hit.y - dy * 1.6, clipped: true };
  }

  setCell(cx: number, cy: number, type: Terrain, hp?: number): void {
    if (!this.inBounds(cx, cy)) return;
    const i = this.idx(cx, cy);
    this.types[i] = type;
    this.hp[i] = hp !== undefined ? hp : TERRAIN[type].hp;
    this.markDirty(cx, cy);
  }

  markDirty(cx: number, cy: number): void {
    if (!this.inBounds(cx, cy)) return;
    const i = this.idx(cx, cy);
    if (!this.dirtySet.has(i)) {
      this.dirtySet.add(i);
      this.dirty.push(i);
    }
  }

  consumeDirty(): number[] {
    const d = this.dirty;
    this.dirty = [];
    this.dirtySet.clear();
    return d;
  }

  /**
   * Apply damage to a single cell. Open ground is not destructible.
   */
  damageCell(cx: number, cy: number, amount: number, pierceArmor = 0): DamageResult {
    if (!this.inBounds(cx, cy)) {
      return { destroyed: false, terrain: Terrain.Empty, cx, cy, overflow: 0 };
    }
    const i = this.idx(cx, cy);
    const t = this.types[i] as Terrain;
    const def = TERRAIN[t];
    if (!def.destructible || def.hp <= 0) {
      return { destroyed: false, terrain: t, cx, cy, overflow: 0 };
    }
    const incoming = Math.max(0, amount) * (1 - def.armor * (1 - clamp(pierceArmor, 0, 1)));
    this.hp[i] -= incoming;
    this.markDirty(cx, cy);
    if (this.hp[i] > 0) {
      return { destroyed: false, terrain: t, cx, cy, overflow: 0 };
    }
    const overflow = -this.hp[i];
    this.types[i] = Terrain.Empty;
    this.hp[i] = 0;
    return { destroyed: true, terrain: t, cx, cy, overflow };
  }

  damageWallBlock(cx: number, cy: number, amount: number, pierceArmor = 0): DamageResult[] {
    return [this.damageCell(cx, cy, amount, pierceArmor)];
  }

  /**
   * Radial destruction used by explosions. Returns the list of destroyed cells
   * (typed array views) so the caller can spawn debris + chain reactions.
   */
  damageArea(
    x: number,
    y: number,
    radius: number,
    amount: number,
    pierceArmor = 0,
    out?: DamageResult[],
  ): DamageResult[] {
    const results = out ?? [];
    results.length = 0;
    const c0x = Math.floor((x - radius) / CELL);
    const c1x = Math.floor((x + radius) / CELL);
    const c0y = Math.floor((y - radius) / CELL);
    const c1y = Math.floor((y + radius) / CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (!this.inBounds(cx, cy)) continue;
        const ccx = cx * CELL + CELL / 2;
        const ccy = cy * CELL + CELL / 2;
        const d = Math.hypot(ccx - x, ccy - y);
        if (d > radius) continue;
        const falloff = 1 - (d / radius) * 0.6;
        const r = this.damageCell(cx, cy, amount * falloff, pierceArmor);
        if (r.destroyed) results.push(r);
      }
    }
    return results;
  }

  /** Fill a rect of authoring blocks (bx,by in 2-cell units). */
  fillBlock(bx: number, by: number, bw: number, bh: number, type: Terrain, hp?: number): void {
    for (let y = by * 2; y < (by + bh) * 2; y++) {
      for (let x = bx * 2; x < (bx + bw) * 2; x++) {
        this.setCell(x, y, type, hp);
      }
    }
  }

  clear(): void {
    this.types.fill(Terrain.Empty);
    this.hp.fill(0);
    this.dirtySet.clear();
    this.dirty.length = 0;
    for (let cy = 0; cy < this.rows; cy++)
      for (let cx = 0; cx < this.cols; cx++) this.markDirty(cx, cy);
  }

  /** Load from ASCII rows where each character covers a 2x2 cell block. */
  loadFromAscii(rows: string[]): void {
    this.clear();
    for (let by = 0; by < rows.length; by++) {
      const row = rows[by];
      for (let bx = 0; bx < row.length; bx++) {
        const ch = row[bx];
        const t = CHAR_TO_TERRAIN[ch];
        if (t === undefined) continue;
        if (t === Terrain.Empty) continue;
        this.fillBlock(bx, by, 1, 1, t);
      }
    }
  }

  countType(type: Terrain): number {
    let c = 0;
    for (let i = 0; i < this.types.length; i++) if (this.types[i] === type) c++;
    return c;
  }

  /** Snapshot for tests / save-state diffing. */
  serialize(): { cols: number; rows: number; types: number[] } {
    return { cols: this.cols, rows: this.rows, types: Array.from(this.types) };
  }
}
