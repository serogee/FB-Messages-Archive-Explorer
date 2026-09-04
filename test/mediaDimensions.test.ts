import { describe, expect, it, vi } from 'vitest';
import {
  MediaDimensionsCache,
  parseImageDimensions,
  readMediaDimensionsFromEntry,
} from '../src/services/mediaDimensions';
import type { MediaEntry } from '../src/types/messenger';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function gif(version: '87a' | '89a', width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([...`GIF${version}`].map(value => value.charCodeAt(0)));
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

function webpPrefix(chunk: 'VP8 ' | 'VP8L' | 'VP8X', chunkSize: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([...`RIFF`].map(value => value.charCodeAt(0)));
  bytes.set([...`WEBP`].map(value => value.charCodeAt(0)), 8);
  bytes.set([...chunk].map(value => value.charCodeAt(0)), 12);
  new DataView(bytes.buffer).setUint32(16, chunkSize, true);
  return bytes;
}

function webpVp8(width: number, height: number): Uint8Array {
  const bytes = webpPrefix('VP8 ', 10);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  new DataView(bytes.buffer).setUint16(26, width, true);
  new DataView(bytes.buffer).setUint16(28, height, true);
  return bytes;
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = webpPrefix('VP8L', 5);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[20] = 0x2f;
  bytes[21] = encodedWidth & 0xff;
  bytes[22] = ((encodedWidth >> 8) & 0x3f) | ((encodedHeight & 0x03) << 6);
  bytes[23] = (encodedHeight >> 2) & 0xff;
  bytes[24] = (encodedHeight >> 10) & 0x0f;
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = webpPrefix('VP8X', 10);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[24] = encodedWidth & 0xff;
  bytes[25] = (encodedWidth >> 8) & 0xff;
  bytes[26] = (encodedWidth >> 16) & 0xff;
  bytes[27] = encodedHeight & 0xff;
  bytes[28] = (encodedHeight >> 8) & 0xff;
  bytes[29] = (encodedHeight >> 16) & 0xff;
  return bytes;
}

function jpeg(width: number, height: number, progressive = false, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation) {
    const payload = new Uint8Array(32);
    payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    payload.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 6);
    payload.set([0x01, 0x00], 14);
    payload.set([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00], 16);
    parts.push(0xff, 0xe1, 0x00, payload.length + 2, ...payload);
  }
  parts.push(
    0xff, progressive ? 0xc2 : 0xc0,
    0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  );
  return new Uint8Array(parts);
}

function entry(name = 'image.bin'): MediaEntry {
  return { type: 'image', handle: { kind: 'file', name, getFile: vi.fn() } };
}

describe('image dimension parsing', () => {
  it('parses PNG and both GIF signatures', () => {
    expect(parseImageDimensions(png(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(parseImageDimensions(gif('87a', 320, 240))).toEqual({ width: 320, height: 240 });
    expect(parseImageDimensions(gif('89a', 640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('parses all three WebP dimension encodings', () => {
    expect(parseImageDimensions(webpVp8(800, 600))).toEqual({ width: 800, height: 600 });
    expect(parseImageDimensions(webpVp8l(1024, 777))).toEqual({ width: 1024, height: 777 });
    expect(parseImageDimensions(webpVp8x(4096, 2160))).toEqual({ width: 4096, height: 2160 });
  });

  it('parses baseline and progressive JPEGs and applies Exif orientation', () => {
    expect(parseImageDimensions(jpeg(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(parseImageDimensions(jpeg(1600, 900, true))).toEqual({ width: 1600, height: 900 });
    for (const orientation of [5, 6, 7, 8]) {
      expect(parseImageDimensions(jpeg(1600, 900, false, orientation))).toEqual({ width: 900, height: 1600 });
    }
  });

  it('rejects malformed, truncated, and zero-sized data', () => {
    expect(parseImageDimensions(new Uint8Array())).toBeNull();
    expect(parseImageDimensions(png(0, 10))).toBeNull();
    expect(parseImageDimensions(jpeg(100, 50).slice(0, 8))).toBeNull();
    const malformedWebp = webpVp8(100, 50);
    malformedWebp[23] = 0;
    expect(parseImageDimensions(malformedWebp)).toBeNull();
  });

  it('reads only a small prefix for simple formats and caps JPEG reads at 64KiB', async () => {
    const pngBytes = png(300, 200);
    const pngEnds: number[] = [];
    const pngEntry: MediaEntry = {
      type: 'image',
      handle: {
        kind: 'file',
        name: 'a.png',
        getFile: async () => ({
          size: 1_000_000,
          slice: (_start: number, end: number) => {
            pngEnds.push(end);
            return new Blob([pngBytes]);
          },
        }) as File,
      },
    };
    await expect(readMediaDimensionsFromEntry(pngEntry)).resolves.toEqual({ width: 300, height: 200 });
    expect(pngEnds).toEqual([32]);

    const jpegBytes = jpeg(640, 360);
    const jpegEnds: number[] = [];
    const jpegEntry: MediaEntry = {
      type: 'image',
      handle: {
        kind: 'file',
        name: 'a.jpg',
        getFile: async () => ({
          size: 1_000_000,
          slice: (_start: number, end: number) => {
            jpegEnds.push(end);
            return new Blob([jpegBytes]);
          },
        }) as File,
      },
    };
    await expect(readMediaDimensionsFromEntry(jpegEntry)).resolves.toEqual({ width: 640, height: 360 });
    expect(jpegEnds).toEqual([32, 64 * 1024]);
  });
});

describe('media dimension cache', () => {
  it('deduplicates pending reads, caches results, and notifies subscribers once', async () => {
    let finish: ((value: { width: number; height: number }) => void) | undefined;
    const reader = vi.fn(() => new Promise<{ width: number; height: number }>(resolve => { finish = resolve; }));
    const cache = new MediaDimensionsCache(1, reader);
    const media = entry();
    const listener = vi.fn();
    cache.subscribe(media, listener);

    const first = cache.read(media);
    const second = cache.read(media);
    expect(reader).toHaveBeenCalledOnce();
    finish?.({ width: 400, height: 300 });

    await expect(first).resolves.toEqual({ width: 400, height: 300 });
    await expect(second).resolves.toEqual({ width: 400, height: 300 });
    await expect(cache.read(media)).resolves.toEqual({ width: 400, height: 300 });
    expect(reader).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('negatively caches failures', async () => {
    const reader = vi.fn(async () => null);
    const cache = new MediaDimensionsCache(1, reader);
    const media = entry();
    await expect(cache.read(media)).resolves.toBeNull();
    await expect(cache.read(media)).resolves.toBeNull();
    expect(reader).toHaveBeenCalledOnce();
  });

  it('times out a stalled read, releases the queue, and negatively caches it', async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const reader = vi.fn((media: MediaEntry) => {
        const name = media.handle?.name || 'unknown';
        started.push(name);
        return name === 'stalled'
          ? new Promise<null>(() => {})
          : Promise.resolve({ width: 10, height: 10 });
      });
      const cache = new MediaDimensionsCache(1, reader, 25);
      const stalled = entry('stalled');
      const following = entry('following');

      const scanning = cache.scan([stalled, following]);
      await vi.advanceTimersByTimeAsync(25);

      await expect(scanning).resolves.toBeUndefined();
      await expect(cache.read(stalled)).resolves.toBeNull();
      await expect(cache.read(following)).resolves.toEqual({ width: 10, height: 10 });
      expect(started).toEqual(['stalled', 'following']);
      expect(reader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds global reader concurrency and deduplicates scan input', async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const reader = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return { width: 10, height: 10 };
    });
    const cache = new MediaDimensionsCache(2, reader);
    const entries = [entry('1'), entry('2'), entry('3'), entry('4')];
    const scanning = cache.scan([entries[0], ...entries, entries[3]]);

    await vi.waitFor(() => expect(active).toBe(2));
    while (releases.length > 0) releases.shift()?.();
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    while (releases.length > 0) releases.shift()?.();
    await scanning;

    expect(maximum).toBe(2);
    expect(reader).toHaveBeenCalledTimes(4);
  });

  it('moves jump reads ahead of queued preload reads', async () => {
    let releaseBlocker = () => {};
    const started: string[] = [];
    const reader = vi.fn(async (media: MediaEntry) => {
      started.push(media.handle?.name || 'unknown');
      if (media.handle?.name === 'blocker') {
        await new Promise<void>(resolve => { releaseBlocker = resolve; });
      }
      return { width: 10, height: 10 };
    });
    const cache = new MediaDimensionsCache(1, reader);
    const blocker = entry('blocker');
    const preload = entry('preload');
    const jump = entry('jump');

    const tasks = [cache.read(blocker), cache.read(preload, 1), cache.read(jump, 0)];
    releaseBlocker();
    await Promise.all(tasks);

    expect(started).toEqual(['blocker', 'jump', 'preload']);
  });

  it('promotes an existing queued dimension read', async () => {
    let releaseBlocker = () => {};
    const started: string[] = [];
    const reader = vi.fn(async (media: MediaEntry) => {
      started.push(media.handle?.name || 'unknown');
      if (media.handle?.name === 'blocker') {
        await new Promise<void>(resolve => { releaseBlocker = resolve; });
      }
      return { width: 10, height: 10 };
    });
    const cache = new MediaDimensionsCache(1, reader);
    const blocker = entry('blocker');
    const promoted = entry('promoted');
    const other = entry('other');

    const tasks = [cache.read(blocker), cache.read(promoted, 2), cache.read(other, 1)];
    tasks.push(cache.read(promoted, 0));
    releaseBlocker();
    await Promise.all(tasks);

    expect(started).toEqual(['blocker', 'promoted', 'other']);
  });
});
