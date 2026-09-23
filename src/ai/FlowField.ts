import { Grid } from '../world/Grid';
import { CELL } from '../world/terrain';

/**
 * Block-resolution flow field (BFS distance + best-neighbour direction).
 * One field is shared per target archetype and refreshed on a timer, so 20+
 * enemies path for the cost of a couple of BFS passes per second.
 */
export class FlowField {
  readonly bw: number;
  readonly bh: number;
  readonly dist: Int16Array;
  readonly dirX: Int8Array;
  readonly dirY: Int8Array;
  private passable: Uint8Array;
  private queue: Int32Array;
  targetBX = -1;
  targetBY = -1;
  version = 0;

  constructor(bw: number, bh: number) {
    this.bw = bw;
    this.bh = bh;
    const n = bw * bh;
    this.dist = new Int16Array(n);
    this.dirX = new Int8Array(n);
    this.dirY = new Int8Array(n);
    this.passable = new Uint8Array(n);
    this.queue = new Int32Array(n);
  }

  private idx(bx: number, by: number): number {
    return by * this.bw + bx;
  }

  /** Rebuild the passability mask from the fine grid. */
  refreshPassability(grid: Grid, hover = false): void {
    const pad = 2;
    const span = CELL * 2 - pad * 2;
    for (let by = 0; by < this.bh; by++) {
      for (let bx = 0; bx < this.bw; bx++) {
        const x = bx * CELL * 2 + pad;
        const y = by * CELL * 2 + pad;
        // A 2×2 authoring block is only a path if a tank AABB actually fits.
        // Treating "1 solid quadrant" as open routed units into 16px gaps they
        // cannot physically enter — which felt like invisible walls.
        this.passable[this.idx(bx, by)] = grid.rectHitsSolid(
          { x, y, w: span, h: span },
          { hover, offroad: false },
        )
          ? 0
          : 1;
      }
    }
  }

  compute(grid: Grid, targetBX: number, targetBY: number, hover = false): void {
    this.refreshPassability(grid, hover);
    this.targetBX = targetBX;
    this.targetBY = targetBY;
    this.version++;
    const n = this.bw * this.bh;
    this.dist.fill(-1);
    this.dirX.fill(0);
    this.dirY.fill(0);

    const sx = Math.max(0, Math.min(this.bw - 1, targetBX));
    const sy = Math.max(0, Math.min(this.bh - 1, targetBY));
    let head = 0;
    let tail = 0;
    const start = this.idx(sx, sy);
    this.dist[start] = 0;
    this.queue[tail++] = start;

    while (head < tail) {
      const cur = this.queue[head++];
      const cx = cur % this.bw;
      const cy = (cur / this.bw) | 0;
      const d = this.dist[cur];
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= this.bw || ny >= this.bh) continue;
        const ni = this.idx(nx, ny);
        if (this.dist[ni] !== -1) continue;
        if (!this.passable[ni]) continue;
        this.dist[ni] = d + 1;
        this.queue[tail++] = ni;
        if (tail >= n) break;
      }
    }

    // derive directions toward the lowest-distance neighbour (8-way)
    for (let by = 0; by < this.bh; by++) {
      for (let bx = 0; bx < this.bw; bx++) {
        const i = this.idx(bx, by);
        const d = this.dist[i];
        if (d < 0) continue;
        let best = d;
        let bdx = 0;
        let bdy = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = bx + ox;
            const ny = by + oy;
            if (nx < 0 || ny < 0 || nx >= this.bw || ny >= this.bh) continue;
            const ni = this.idx(nx, ny);
            const nd = this.dist[ni];
            if (nd < 0) continue;
            const diag = ox !== 0 && oy !== 0;
            if (diag && (!this.passable[this.idx(nx, by)] || !this.passable[this.idx(bx, ny)])) continue;
            const cost = nd + (diag ? 0.4 : 0);
            if (cost < best - 0.001) {
              best = cost;
              bdx = ox;
              bdy = oy;
            }
          }
        }
        this.dirX[i] = bdx;
        this.dirY[i] = bdy;
      }
    }
  }

  /** Sample the recommended travel direction at a world position. */
  sample(x: number, y: number): { dx: number; dy: number; dist: number } {
    const bx = Math.max(0, Math.min(this.bw - 1, Math.floor(x / (CELL * 2))));
    const by = Math.max(0, Math.min(this.bh - 1, Math.floor(y / (CELL * 2))));
    const i = this.idx(bx, by);
    let dx = this.dirX[i];
    let dy = this.dirY[i];
    const d = this.dist[i];
    if (dx === 0 && dy === 0 && d > 0) {
      // inside an unreachable pocket: head straight for the target
      const tx = this.targetBX * CELL * 2 + CELL;
      const ty = this.targetBY * CELL * 2 + CELL;
      const vx = tx - x;
      const vy = ty - y;
      const l = Math.hypot(vx, vy) || 1;
      dx = vx / l;
      dy = vy / l;
      return { dx, dy, dist: d };
    }
    const l = Math.hypot(dx, dy) || 1;
    return { dx: dx / l, dy: dy / l, dist: d };
  }

  isReachable(x: number, y: number): boolean {
    const bx = Math.max(0, Math.min(this.bw - 1, Math.floor(x / (CELL * 2))));
    const by = Math.max(0, Math.min(this.bh - 1, Math.floor(y / (CELL * 2))));
    return this.dist[this.idx(bx, by)] >= 0;
  }
}
