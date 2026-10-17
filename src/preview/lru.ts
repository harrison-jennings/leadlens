/**
 * A cache bounded by the total size of its values, dropping the least recently
 * used entries first.
 *
 * Encoded preview images are large strings. Keeping every one ever previewed
 * would grow without limit over a long session; keeping none would re-read
 * and re-encode every image on every keystroke.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; size: number }>();
  private total = 0;

  constructor(
    private readonly maxSize: number,
    private readonly sizeOf: (value: V) => number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-inserting moves it to the end: Map iteration order is the eviction order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    // A value larger than the whole cache isn't kept; it would evict everything.
    if (size > this.maxSize) return;
    this.entries.set(key, { value, size });
    this.total += size;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxSize) break;
      this.entries.delete(oldest);
      this.total -= entry.size;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.size;
  }

  get size(): number {
    return this.total;
  }

  get count(): number {
    return this.entries.size;
  }
}
