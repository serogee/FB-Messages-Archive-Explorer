import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobLRUCache } from '../src/services/blobCache';
import type { MediaEntry } from '../src/types/messenger';

const mediaEntry = (url?: string): MediaEntry => ({ type: 'image', url });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('blob URL cache', () => {
  it('promotes cache hits before evicting the least recently used entry', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const cache = new BlobLRUCache(2);
    const first = mediaEntry('blob:first');
    const second = mediaEntry('blob:second');
    const third = mediaEntry('blob:third');

    cache.put(first, first.url!);
    cache.put(second, second.url!);
    expect(cache.get(first)).toBe('blob:first');
    cache.put(third, third.url!);

    expect(cache.get(first)).toBe('blob:first');
    expect(cache.get(second)).toBeNull();
    expect(cache.get(third)).toBe('blob:third');
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:second');
    expect(second.url).toBeUndefined();
  });

  it('takes ownership of an eagerly resolved entry URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const cache = new BlobLRUCache(1);
    const resolved = mediaEntry('blob:resolved');

    await expect(cache.getOrCreate(resolved)).resolves.toBe('blob:resolved');
    cache.put(mediaEntry('blob:next'), 'blob:next');

    expect(revoke).toHaveBeenCalledWith('blob:resolved');
    expect(resolved.url).toBeUndefined();
  });

  it('clears and revokes every cached URL', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const cache = new BlobLRUCache(2);
    const first = mediaEntry('blob:first');
    const second = mediaEntry('blob:second');

    cache.put(first, first.url!);
    cache.put(second, second.url!);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:first');
    expect(revoke).toHaveBeenCalledWith('blob:second');
    expect(first.url).toBeUndefined();
    expect(second.url).toBeUndefined();
  });

  it('does not clear a URL alias replaced by a consumer', () => {
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const cache = new BlobLRUCache(1);
    const entry = mediaEntry('blob:cached');

    cache.put(entry, entry.url!);
    entry.url = 'blob:replacement';
    cache.put(mediaEntry('blob:next'), 'blob:next');

    expect(entry.url).toBe('blob:replacement');
  });
});
