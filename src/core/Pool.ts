/**
 * Generic fixed-capacity pool. Avoids per-frame allocation for projectiles,
 * particles and floating text — the three hottest object types in the game.
 */
export interface Poolable {
  active: boolean;
}

export class Pool<T extends Poolable> {
  readonly items: T[] = [];
  private factory: () => T;
  private reset: (item: T) => void;
  private cursor = 0;
  private cap: number;
  /** Count of objects ever created (diagnostics). */
  created = 0;

  constructor(factory: () => T, reset: (item: T) => void, prealloc = 0, cap = 4096) {
    this.factory = factory;
    this.reset = reset;
    this.cap = cap;
    for (let i = 0; i < prealloc; i++) {
      const it = this.factory();
      it.active = false;
      this.items.push(it);
      this.created++;
    }
  }

  /** Obtain an inactive object, growing the pool when below the cap. */
  obtain(): T | null {
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const it = this.items[idx];
      if (!it.active) {
        this.cursor = (idx + 1) % n;
        it.active = true;
        return it;
      }
    }
    if (n >= this.cap) {
      // Recycle the oldest active object rather than stalling gameplay.
      const it = this.items[this.cursor];
      this.reset(it);
      this.cursor = (this.cursor + 1) % n;
      it.active = true;
      return it;
    }
    const fresh = this.factory();
    fresh.active = true;
    this.items.push(fresh);
    this.created++;
    this.cursor = (this.cursor + 1) % this.items.length;
    return fresh;
  }

  release(item: T): void {
    if (!item.active) return;
    item.active = false;
    this.reset(item);
  }

  releaseAll(): void {
    for (const it of this.items) {
      it.active = false;
      this.reset(it);
    }
  }

  get activeCount(): number {
    let c = 0;
    for (const it of this.items) if (it.active) c++;
    return c;
  }

  /** Iterate only active items. Callback may release the item. */
  forEach(fn: (item: T, index: number) => void): void {
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.active) fn(it, i);
    }
  }
}
