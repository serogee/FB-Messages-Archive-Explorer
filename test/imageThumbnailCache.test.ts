import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageThumbnailCache } from '../src/services/imageThumbnailCache';
import type { MediaEntry } from '../src/types/messenger';

const entry = (): MediaEntry => ({ type: 'image' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('image thumbnail cache', () => {
  it('deduplicates concurrent requests for the same media entry', async () => {
    const create = vi.fn(async () => 'blob:thumbnail');
    const cache = new ImageThumbnailCache(10, 4, create);
    const media = entry();

    const first = cache.getOrCreate(media);
    const second = cache.getOrCreate(media);

    expect(first).toBe(second);
    await expect(first).resolves.toBe('blob:thumbnail');
    expect(create).toHaveBeenCalledOnce();
  });

  it('bounds concurrent thumbnail jobs', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const create = vi.fn(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return `blob:${releases.length}`;
    });
    const cache = new ImageThumbnailCache(10, 2, create);
    const requests = Array.from({ length: 5 }, () => cache.getOrCreate(entry()));

    await Promise.resolve();
    expect(active).toBe(2);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(maximumActive).toBe(2);

    while (releases.length > 0 || create.mock.calls.length < requests.length) {
      releases.splice(0).forEach(release => release());
      await Promise.resolve();
      await Promise.resolve();
    }
    releases.splice(0).forEach(release => release());
    await Promise.all(requests);

    expect(maximumActive).toBe(2);
  });

  it('evicts and revokes the least recently used thumbnail', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let next = 0;
    const cache = new ImageThumbnailCache(2, 1, async () => `blob:${++next}`);
    const first = entry();
    const second = entry();
    const third = entry();

    await cache.getOrCreate(first);
    await cache.getOrCreate(second);
    cache.get(first);
    await cache.getOrCreate(third);

    expect(cache.get(first)).toBe('blob:1');
    expect(cache.get(second)).toBeNull();
    expect(cache.get(third)).toBe('blob:3');
    expect(revoke).toHaveBeenCalledWith('blob:2');
  });

  it('does not retain a thumbnail completed after the cache is cleared', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let finish: ((url: string) => void) | undefined;
    const cache = new ImageThumbnailCache(2, 1, () => new Promise(resolve => { finish = resolve; }));
    const request = cache.getOrCreate(entry());

    cache.clear();
    await expect(request).resolves.toBeNull();
    finish?.('blob:stale');
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.size).toBe(0);
    expect(revoke).toHaveBeenCalledWith('blob:stale');
  });

  it('skips an abandoned queued thumbnail in favor of current subscribers', async () => {
    const blocker = entry();
    const abandoned = entry();
    const current = entry();
    let releaseBlocker = () => {};
    const started: MediaEntry[] = [];
    const create = vi.fn(async (media: MediaEntry) => {
      started.push(media);
      if (media === blocker) await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return media === current ? 'blob:current' : 'blob:other';
    });
    const cache = new ImageThumbnailCache(10, 1, create);

    cache.subscribe(blocker, () => {});
    const unsubscribe = cache.subscribe(abandoned, () => {});
    unsubscribe();
    const received: Array<string | null> = [];
    const loaded = new Promise<void>(resolve => {
      cache.subscribe(current, url => {
        received.push(url);
        resolve();
      });
    });
    releaseBlocker();
    await loaded;

    expect(started).toEqual([blocker, current]);
    expect(received).toEqual(['blob:current']);
  });
});
