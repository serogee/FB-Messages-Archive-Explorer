/**
 * Bounds live blob URLs for large galleries. The cache owns every registered
 * URL and revokes it on eviction or clear.
 */

import type { MediaEntry } from '../types/messenger';

const DEFAULT_MAX_SIZE = 300;

export class BlobLRUCache {
  private maxSize: number;
  /** Map insertion order tracks recency, with the newest entry last. */
  private cache = new Map<MediaEntry, string>();

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Get an existing blob URL for this entry, promoting it to most-recently-used.
   * Returns null if not cached.
   */
  get(entry: MediaEntry): string | null {
    const cached = this.cache.get(entry);
    if (!cached) return null;

    // Promote to most-recently-used by re-inserting
    this.cache.delete(entry);
    this.cache.set(entry, cached);
    return cached;
  }

  /**
   * Get an existing blob URL or create one from the entry's file handle.
   * Returns null if the entry has no handle and no cached URL.
   */
  async getOrCreate(entry: MediaEntry): Promise<string | null> {
    const existing = this.get(entry);
    if (existing) return existing;

    // Register eagerly resolved URLs so the cache owns their eventual revocation.
    if (entry.url) {
      this.put(entry, entry.url);
      return entry.url;
    }

    if (!entry.handle) return null;

    try {
      const file = await entry.handle.getFile();
      const url = URL.createObjectURL(file);
      this.put(entry, url);
      entry.url = url;
      return url;
    } catch {
      return null;
    }
  }

  /**
   * Store a blob URL in the cache, evicting the oldest if at capacity.
   */
  put(entry: MediaEntry, url: string): void {
    if (this.cache.has(entry)) {
      this.cache.delete(entry);
    }

    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      const [oldEntry, oldUrl] = oldest;
      this.cache.delete(oldEntry);
      this.revoke(oldUrl, oldEntry);
    }

    this.cache.set(entry, url);
  }

  /**
   * Revoke a specific blob URL and clear it from the entry.
   */
  private revoke(url: string, entry: MediaEntry): void {
    try {
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    // A consumer may have replaced the alias since this URL entered the cache.
    if (entry.url === url) {
      entry.url = undefined;
    }
  }

  /**
   * Revoke and clear all cached blob URLs.
   */
  clear(): void {
    for (const [entry, url] of this.cache) {
      this.revoke(url, entry);
    }
    this.cache.clear();
  }

  /** Current number of cached blob URLs */
  get size(): number {
    return this.cache.size;
  }
}

/** Global singleton blob URL cache */
export const blobCache = new BlobLRUCache(DEFAULT_MAX_SIZE);
