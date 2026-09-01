import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoPoster, VideoPosterCache } from '../src/services/videoPosterCache';
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
    finish?.(null);

    await expect(staleRequest).resolves.toBeNull();
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
});

describe('video poster creation', () => {
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
