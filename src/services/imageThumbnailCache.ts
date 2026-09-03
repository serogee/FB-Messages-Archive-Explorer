import type { MediaEntry } from '../types/messenger';
import { MEDIA_THUMBNAIL_SIZE } from './mediaThumbnailConfig';
import { SubscribableTaskQueue } from './subscribableTaskQueue';

export const IMAGE_THUMBNAIL_SIZE = MEDIA_THUMBNAIL_SIZE;
const DEFAULT_MAX_THUMBNAILS = 300;
const DEFAULT_MAX_CONCURRENT_JOBS = 4;

type ThumbnailCreator = (entry: MediaEntry, signal: AbortSignal) => Promise<string | null>;
type ThumbnailSubscriber = (url: string | null) => void;

/** Owns generated thumbnail URLs and bounds both memory and decode pressure. */
export class ImageThumbnailCache {
  private cache = new Map<MediaEntry, string>();
  private pending = new Map<MediaEntry, Promise<string | null>>();
  private generation = 0;
  private readonly maxSize: number;
  private readonly createThumbnail: ThumbnailCreator;
  private readonly scheduler: SubscribableTaskQueue<MediaEntry, string | null>;

  constructor(
    maxSize = DEFAULT_MAX_THUMBNAILS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
    createThumbnail: ThumbnailCreator = createImageThumbnail,
  ) {
    this.maxSize = maxSize;
    this.createThumbnail = createThumbnail;
    this.scheduler = new SubscribableTaskQueue(maxConcurrentJobs, (entry, signal) => (
      this.generate(entry, signal)
    ));
  }

  get(entry: MediaEntry): string | null {
    const cached = this.cache.get(entry);
    if (!cached) return null;

    this.cache.delete(entry);
    this.cache.set(entry, cached);
    return cached;
  }

  getOrCreate(entry: MediaEntry): Promise<string | null> {
    const cached = this.get(entry);
    if (cached) return Promise.resolve(cached);

    const existing = this.pending.get(entry);
    if (existing) return existing;

    let unsubscribe = () => {};
    const request = new Promise<string | null>(resolve => {
      unsubscribe = this.subscribe(entry, resolve);
    });
    const task = request.finally(() => {
      unsubscribe();
      if (this.pending.get(entry) === task) this.pending.delete(entry);
    });

    this.pending.set(entry, task);
    return task;
  }

  subscribe(entry: MediaEntry, subscriber: ThumbnailSubscriber): () => void {
    const cached = this.get(entry);
    if (cached) {
      try {
        subscriber(cached);
      } catch {
        // Keep cache reads isolated from consumer callback failures.
      }
      return () => {};
    }

    return this.scheduler.subscribe(entry, completion => {
      subscriber(completion.status === 'completed' ? completion.value : null);
    });
  }

  clear(): void {
    this.generation++;
    this.scheduler.clear();
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private put(entry: MediaEntry, url: string): void {
    const previous = this.cache.get(entry);
    if (previous && previous !== url) URL.revokeObjectURL(previous);
    if (previous) this.cache.delete(entry);

    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      URL.revokeObjectURL(oldest[1]);
    }

    this.cache.set(entry, url);
  }

  private async generate(entry: MediaEntry, signal: AbortSignal): Promise<string | null> {
    const requestGeneration = this.generation;
    const cached = this.get(entry);
    if (cached) return cached;

    const url = await this.createThumbnail(entry, signal);
    if (!url) return null;

    if (signal.aborted || requestGeneration !== this.generation) {
      URL.revokeObjectURL(url);
      return null;
    }

    this.put(entry, url);
    return url;
  }
}

async function loadImage(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      image.src = '';
      reject(new DOMException('Thumbnail generation cancelled', 'AbortError'));
    };
    image.decoding = 'async';
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('Image decode failed'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    image.src = source;
  });
}

async function createImageThumbnail(entry: MediaEntry, signal: AbortSignal): Promise<string | null> {
  let temporaryUrl: string | null = null;
  let bitmap: ImageBitmap | null = null;

  try {
    let blob: Blob | null = entry.handle ? await entry.handle.getFile() : null;
    if (signal.aborted) return null;
    if (!blob && entry.url) {
      try {
        blob = await fetch(entry.url, { signal }).then(response => response.blob());
      } catch { /* Fall back to decoding the URL directly below. */ }
    }
    if (signal.aborted) return null;

    let source: CanvasImageSource;
    let sourceWidth: number;
    let sourceHeight: number;
    if (blob && typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: IMAGE_THUMBNAIL_SIZE,
        resizeQuality: 'high',
      });
      if (signal.aborted) return null;
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } else {
      const sourceUrl = entry.url || (blob ? URL.createObjectURL(blob) : null);
      if (!sourceUrl) return null;
      if (!entry.url) temporaryUrl = sourceUrl;
      const image = await loadImage(sourceUrl, signal);
      source = image;
      sourceWidth = image.naturalWidth || IMAGE_THUMBNAIL_SIZE;
      sourceHeight = image.naturalHeight || IMAGE_THUMBNAIL_SIZE;
    }

    const sourceSize = Math.min(sourceWidth, sourceHeight);
    const sourceX = Math.max(0, (sourceWidth - sourceSize) / 2);
    const sourceY = Math.max(0, (sourceHeight - sourceSize) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_THUMBNAIL_SIZE;
    canvas.height = IMAGE_THUMBNAIL_SIZE;
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (signal.aborted) return null;

    context.drawImage(
      source,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      IMAGE_THUMBNAIL_SIZE,
      IMAGE_THUMBNAIL_SIZE,
    );

    const thumbnailBlob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.76);
    });
    if (signal.aborted) return null;
    return thumbnailBlob ? URL.createObjectURL(thumbnailBlob) : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
  }
}

export const imageThumbnailCache = new ImageThumbnailCache();
