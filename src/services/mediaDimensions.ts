import type { MediaEntry } from '../types/messenger';

export interface MediaDimensions {
  width: number;
  height: number;
}

type DimensionListener = () => void;
type DimensionReader = (entry: MediaEntry) => Promise<MediaDimensions | null>;

const DEFAULT_MAX_CONCURRENT_READS = 4;
const DEFAULT_READ_TIMEOUT_MS = 2_000;
const INITIAL_HEADER_BYTES = 32;
const MAX_JPEG_HEADER_BYTES = 64 * 1024;
const MAX_MEDIA_DIMENSION = 1 << 24;

interface QueuedRead {
  entry: MediaEntry;
  priority: number;
  promise: Promise<MediaDimensions | null>;
  resolve: (dimensions: MediaDimensions | null) => void;
}

function validDimensions(width: number, height: number): MediaDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_MEDIA_DIMENSION || height > MAX_MEDIA_DIMENSION) return null;
  return { width, height };
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint24LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 3 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, littleEndian);
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function parsePngDimensions(bytes: Uint8Array): MediaDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (readUint32(bytes, 8, false) !== 13) return null;
  if (!matchesAscii(bytes, 12, 'IHDR')) return null;
  const width = readUint32(bytes, 16, false);
  const height = readUint32(bytes, 20, false);
  return width === null || height === null ? null : validDimensions(width, height);
}

function parseGifDimensions(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 10 || (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a'))) {
    return null;
  }
  const width = readUint16(bytes, 6, true);
  const height = readUint16(bytes, 8, true);
  return width === null || height === null ? null : validDimensions(width, height);
}

function parseWebpDimensions(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 20 || !matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) return null;
  const chunkSize = readUint32(bytes, 16, true);
  if (chunkSize === null) return null;

  if (matchesAscii(bytes, 12, 'VP8X')) {
    if (chunkSize < 10 || bytes.length < 30) return null;
    const encodedWidth = readUint24LE(bytes, 24);
    const encodedHeight = readUint24LE(bytes, 27);
    return encodedWidth === null || encodedHeight === null
      ? null
      : validDimensions(encodedWidth + 1, encodedHeight + 1);
  }

  if (matchesAscii(bytes, 12, 'VP8L')) {
    if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    const height = 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    return validDimensions(width, height);
  }

  if (matchesAscii(bytes, 12, 'VP8 ')) {
    if (chunkSize < 10 || bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return validDimensions(width, height);
  }

  return null;
}

function parseExifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  if (end - start < 14 || !matchesAscii(bytes, start, 'Exif\0\0')) return null;
  const tiffStart = start + 6;
  const littleEndian = matchesAscii(bytes, tiffStart, 'II');
  if (!littleEndian && !matchesAscii(bytes, tiffStart, 'MM')) return null;
  if (readUint16(bytes, tiffStart + 2, littleEndian) !== 42) return null;
  const ifdOffset = readUint32(bytes, tiffStart + 4, littleEndian);
  if (ifdOffset === null) return null;
  const ifdStart = tiffStart + ifdOffset;
  if (ifdStart < tiffStart || ifdStart + 2 > end) return null;
  const entryCount = readUint16(bytes, ifdStart, littleEndian);
  if (entryCount === null) return null;

  for (let index = 0; index < entryCount; index++) {
    const entryOffset = ifdStart + 2 + index * 12;
    if (entryOffset + 12 > end || entryOffset + 12 > bytes.length) return null;
    const tag = readUint16(bytes, entryOffset, littleEndian);
    if (tag !== 0x0112) continue;
    const type = readUint16(bytes, entryOffset + 2, littleEndian);
    const count = readUint32(bytes, entryOffset + 4, littleEndian);
    if (type !== 3 || count !== 1) return null;
    const orientation = readUint16(bytes, entryOffset + 8, littleEndian);
    return orientation !== null && orientation >= 1 && orientation <= 8 ? orientation : null;
  }
  return null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function parseJpegDimensions(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let orientation: number | null = null;

  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0x00) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = readUint16(bytes, offset, false);
    if (segmentLength === null || segmentLength < 2) return null;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > bytes.length) break;

    if (marker === 0xe1 && orientation === null) {
      orientation = parseExifOrientation(bytes, offset + 2, segmentEnd);
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      height = readUint16(bytes, offset + 3, false);
      width = readUint16(bytes, offset + 5, false);
    }
    offset = segmentEnd;
  }

  if (width === null || height === null) return null;
  return orientation !== null && orientation >= 5 && orientation <= 8
    ? validDimensions(height, width)
    : validDimensions(width, height);
}

export function parseImageDimensions(bytes: Uint8Array): MediaDimensions | null {
  return parsePngDimensions(bytes)
    || parseGifDimensions(bytes)
    || parseWebpDimensions(bytes)
    || parseJpegDimensions(bytes);
}

export async function readMediaDimensionsFromEntry(entry: MediaEntry): Promise<MediaDimensions | null> {
  if (!entry.handle) return null;
  try {
    const file = await entry.handle.getFile();
    const initial = new Uint8Array(await file.slice(0, Math.min(file.size, INITIAL_HEADER_BYTES)).arrayBuffer());
    if (initial.length >= 2 && initial[0] === 0xff && initial[1] === 0xd8) {
      const jpegPrefix = new Uint8Array(
        await file.slice(0, Math.min(file.size, MAX_JPEG_HEADER_BYTES)).arrayBuffer(),
      );
      return parseJpegDimensions(jpegPrefix);
    }
    return parseImageDimensions(initial);
  } catch {
    return null;
  }
}

export class MediaDimensionsCache {
  private readonly dimensions = new WeakMap<MediaEntry, MediaDimensions>();
  private readonly pending = new WeakMap<MediaEntry, QueuedRead>();
  private readonly failed = new WeakSet<MediaEntry>();
  private readonly listeners = new WeakMap<MediaEntry, Set<DimensionListener>>();
  private readonly queue: QueuedRead[] = [];
  private readonly maxConcurrentReads: number;
  private readonly reader: DimensionReader;
  private readonly readTimeoutMs: number;
  private activeReads = 0;

  constructor(
    maxConcurrentReads = DEFAULT_MAX_CONCURRENT_READS,
    reader: DimensionReader = readMediaDimensionsFromEntry,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
  ) {
    this.maxConcurrentReads = maxConcurrentReads;
    this.reader = reader;
    this.readTimeoutMs = Math.max(1, readTimeoutMs);
  }

  get(entry: MediaEntry | null): MediaDimensions | null {
    return entry ? this.dimensions.get(entry) || null : null;
  }

  subscribe(entry: MediaEntry | null, listener: DimensionListener): () => void {
    if (!entry) return () => {};
    let entryListeners = this.listeners.get(entry);
    if (!entryListeners) {
      entryListeners = new Set();
      this.listeners.set(entry, entryListeners);
    }
    entryListeners.add(listener);
    return () => {
      entryListeners?.delete(listener);
      if (entryListeners?.size === 0) this.listeners.delete(entry);
    };
  }

  read(entry: MediaEntry, priority = 1): Promise<MediaDimensions | null> {
    const cached = this.get(entry);
    if (cached) return Promise.resolve(cached);
    if (this.failed.has(entry)) return Promise.resolve(null);
    const existing = this.pending.get(entry);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }

    let resolveTask!: (dimensions: MediaDimensions | null) => void;
    const promise = new Promise<MediaDimensions | null>(resolve => {
      resolveTask = resolve;
    });
    const task: QueuedRead = { entry, priority, promise, resolve: resolveTask };
    this.queue.push(task);
    this.pending.set(entry, task);
    this.drain();
    return promise;
  }

  async scan(entries: readonly MediaEntry[], priority = 1): Promise<void> {
    const uniqueEntries = [...new Set(entries)];
    await Promise.all(uniqueEntries.map(entry => this.read(entry, priority)));
  }

  remember(entry: MediaEntry, dimensions: MediaDimensions): void {
    const valid = validDimensions(dimensions.width, dimensions.height);
    if (!valid) return;
    const previous = this.dimensions.get(entry);
    if (previous?.width === valid.width && previous.height === valid.height) return;
    this.failed.delete(entry);
    this.dimensions.set(entry, valid);
    this.notify(entry);
  }

  private drain(): void {
    while (this.activeReads < Math.max(1, this.maxConcurrentReads) && this.queue.length > 0) {
      let nextIndex = 0;
      for (let index = 1; index < this.queue.length; index++) {
        if (this.queue[index].priority < this.queue[nextIndex].priority) nextIndex = index;
      }
      const [queued] = this.queue.splice(nextIndex, 1);
      if (!queued) return;
      this.activeReads++;
      void this.run(queued);
    }
  }

  private async run(queued: QueuedRead): Promise<void> {
    let result = this.get(queued.entry);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      if (!result) {
        // File-system handles cannot be aborted consistently across browsers.
        // Release the logical queue slot and negatively cache the entry if a
        // read stalls, while safely ignoring any later completion.
        result = await Promise.race([
          this.reader(queued.entry),
          new Promise<null>(resolve => {
            timeout = setTimeout(() => resolve(null), this.readTimeoutMs);
          }),
        ]);
      }
    } catch {
      result = null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (result) this.remember(queued.entry, result);
    else this.failed.add(queued.entry);
    this.pending.delete(queued.entry);
    queued.resolve(result);
    this.activeReads--;
    this.drain();
  }

  private notify(entry: MediaEntry): void {
    for (const listener of [...(this.listeners.get(entry) || [])]) {
      try {
        listener();
      } catch {
        // A cache listener must not interrupt other subscribers.
      }
    }
  }
}

const mediaDimensionsCache = new MediaDimensionsCache();

export function getCachedMediaDimensions(entry: MediaEntry | null): MediaDimensions | null {
  return mediaDimensionsCache.get(entry);
}

export function subscribeMediaDimensions(entry: MediaEntry | null, listener: DimensionListener): () => void {
  return mediaDimensionsCache.subscribe(entry, listener);
}

export function readMediaDimensions(entry: MediaEntry, priority = 1): Promise<MediaDimensions | null> {
  return mediaDimensionsCache.read(entry, priority);
}

export function scanMediaDimensions(entries: readonly MediaEntry[], priority = 1): Promise<void> {
  return mediaDimensionsCache.scan(entries, priority);
}

export function rememberMediaDimensions(entry: MediaEntry, dimensions: MediaDimensions): void {
  mediaDimensionsCache.remember(entry, dimensions);
}
