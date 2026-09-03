import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoPoster, createVideoPosterDetails, VideoPosterCache } from '../src/services/videoPosterCache';
import type { MediaEntry } from '../src/types/messenger';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('video poster cache', () => {
  it('does not remember a failed request that completed after clear', async () => {
    let finish: ((poster: { url: string; duration: number | null } | null) => void) | undefined;
    const create = vi.fn<() => Promise<{ url: string; duration: number | null } | null>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ url: 'blob:fresh', duration: 12 });
    const cache = new VideoPosterCache(2, 1, create);
    const entry: MediaEntry = { type: 'video' };

    const staleRequest = cache.getOrCreate(entry);
    await Promise.resolve();
    cache.clear();
    await expect(staleRequest).resolves.toBeNull();
    finish?.(null);
    await Promise.resolve();
    await Promise.resolve();
    await expect(cache.getOrCreate(entry)).resolves.toBe('blob:fresh');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns cached poster details with duration', async () => {
    const create = vi.fn(async () => ({ url: 'blob:poster', duration: 73 }));
    const cache = new VideoPosterCache(2, 1, create);
    const entry: MediaEntry = { type: 'video' };

    await expect(cache.getOrCreateDetails(entry)).resolves.toEqual({ url: 'blob:poster', duration: 73 });
    expect(cache.getDetails(entry)).toEqual({ url: 'blob:poster', duration: 73 });
    await expect(cache.getOrCreate(entry)).resolves.toBe('blob:poster');
    expect(create).toHaveBeenCalledOnce();
  });

  it('does not remember a cancelled running request as a failed video', async () => {
    const create = vi.fn((_entry: MediaEntry, signal: AbortSignal) => {
      if (create.mock.calls.length === 1) {
        return new Promise<null>(resolve => {
          signal.addEventListener('abort', () => resolve(null), { once: true });
        });
      }
      return Promise.resolve({ url: 'blob:retry', duration: 5 });
    });
    const cache = new VideoPosterCache(2, 1, create);
    const media: MediaEntry = { type: 'video' };

    const unsubscribe = cache.subscribe(media, () => {});
    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();

    await expect(cache.getOrCreateDetails(media)).resolves.toEqual({ url: 'blob:retry', duration: 5 });
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('video poster creation', () => {
  it('stops waiting for metadata when poster generation is cancelled', async () => {
    class WaitingVideo extends EventTarget {
      preload = '';
      muted = false;
      playsInline = false;
      readyState = 0;
      src = '';
      pauseCalls = 0;
      loadCalls = 0;
      removedSource = false;

      load(): void {
        this.loadCalls++;
      }

      pause(): void {
        this.pauseCalls++;
      }

      removeAttribute(name: string): void {
        if (name !== 'src') return;
        this.src = '';
        this.removedSource = true;
      }
    }

    const video = new WaitingVideo();
    vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => video),
    });
    const controller = new AbortController();
    const request = createVideoPosterDetails('blob:source', controller.signal);

    controller.abort();

    await expect(request).resolves.toBeNull();
    expect(video.pauseCalls).toBe(1);
    expect(video.removedSource).toBe(true);
    expect(video.loadCalls).toBe(2);
  });

  it('loads metadata, seeks for a frame, and releases the video source', async () => {
    class FakeVideo extends EventTarget {
      preload = '';
      muted = false;
      playsInline = false;
      readyState = 0;
      duration = 10;
      videoWidth = 320;
      videoHeight = 180;
      src = '';
      pauseCalls = 0;
      loadCalls = 0;
      removedSource = false;
      private playbackTime = 0;

      get currentTime(): number {
        return this.playbackTime;
      }

      set currentTime(value: number) {
        this.playbackTime = value;
        queueMicrotask(() => {
          this.readyState = 2;
          this.dispatchEvent(new Event('seeked'));
        });
      }

      load(): void {
        this.loadCalls++;
        if (!this.src || this.readyState !== 0) return;
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event('loadedmetadata'));
        });
      }

      pause(): void {
        this.pauseCalls++;
      }

      removeAttribute(name: string): void {
        if (name !== 'src') return;
        this.src = '';
        this.removedSource = true;
      }
    }

    const video = new FakeVideo();
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((resolve: (blob: Blob | null) => void) => resolve(new Blob())),
    };
    vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('document', {
      createElement: vi.fn((tagName: string) => tagName === 'video' ? video : canvas),
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:poster');

    await expect(createVideoPoster('blob:source')).resolves.toBe('blob:poster');

    expect(video.preload).toBe('metadata');
    expect(video.currentTime).toBe(0.5);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(video.pauseCalls).toBe(1);
    expect(video.removedSource).toBe(true);
    expect(video.loadCalls).toBe(2);
  });
});
