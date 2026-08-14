/**
 * LRU cache for blob URLs created from FileSystemFileHandle objects.
 *
 * Tracks the N most recently accessed blob URLs globally. When the limit is
 * exceeded, the oldest entry is revoked via URL.revokeObjectURL(). This prevents
 * unbounded memory growth from blob URL accumulation — critical when users
 * scroll through thousands of media attachments.
 *
 * Usage:
 *   const url = await blobCache.getOrCreate(mediaEntry);
 *   // url is a blob URL that can be used in <img src>, <video src>, etc.
 *   // When evicted from cache, the URL is automatically revoked.
 */

import type { MediaEntry } from '../types/messenger';

interface CacheEntry {
  url: string;
  /** Key used in the ordered map — the MediaEntry reference identity */
  key: MediaEntry;
}

const DEFAULT_MAX_SIZE = 300;

class BlobLRUCache {
  private maxSize: number;
  /** Ordered map: insertion order = access order (most recent at end) */
  private cache = new Map<MediaEntry, CacheEntry>();

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
    return cached.url;
  }

  /**
   * Get an existing blob URL or create one from the entry's file handle.
   * Returns null if the entry has no handle and no cached URL.
   */
  async getOrCreate(entry: MediaEntry): Promise<string | null> {
    // Check cache first
    const existing = this.get(entry);
    if (existing) return existing;

    // Also check if the entry already has a URL set (from before LRU was introduced)
    if (entry.url) {
      this.put(entry, entry.url);
      return entry.url;
    }

    // No handle → can't create
    if (!entry.handle) return null;

    try {
      const file = await entry.handle.getFile();
      const url = URL.createObjectURL(file);
      this.put(entry, url);
      // Also set on the entry for backward compatibility
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
    // If already present, remove and re-add to update position
    if (this.cache.has(entry)) {
      this.cache.delete(entry);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      const [oldEntry, oldCached] = oldest;
      this.cache.delete(oldEntry);
      this.revoke(oldCached.url, oldEntry);
    }

    this.cache.set(entry, { url, key: entry });
  }

  /**
   * Revoke a specific blob URL and clear it from the entry.
   */
  private revoke(url: string, entry: MediaEntry): void {
    try {
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    // Clear the cached url on the entry so it will be re-created on next access
    if (entry.url === url) {
      entry.url = undefined;
    }
  }

  /**
   * Revoke and remove all blob URLs associated with a specific set of entries.
   * Used when evicting a chat from the multi-chat ring buffer.
   */
  revokeForEntries(entries: Iterable<MediaEntry>): void {
    for (const entry of entries) {
      const cached = this.cache.get(entry);
      if (cached) {
        this.revoke(cached.url, entry);
        this.cache.delete(entry);
      }
    }
  }

  /**
   * Revoke and clear all cached blob URLs.
   */
  clear(): void {
    for (const [entry, cached] of this.cache) {
      this.revoke(cached.url, entry);
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
