import type { MediaEntry } from '../types/messenger';
import { MEDIA_THUMBNAIL_SIZE } from './mediaThumbnailConfig';

export const IMAGE_THUMBNAIL_SIZE = MEDIA_THUMBNAIL_SIZE;
const DEFAULT_MAX_THUMBNAILS = 300;
const DEFAULT_MAX_CONCURRENT_JOBS = 4;

type ThumbnailCreator = (entry: MediaEntry) => Promise<string | null>;

/** Owns generated thumbnail URLs and bounds both memory and decode pressure. */
export class ImageThumbnailCache {
  private cache = new Map<MediaEntry, string>();
  private pending = new Map<MediaEntry, Promise<string | null>>();
  private activeJobs = 0;
  private waitingJobs: Array<() => void> = [];
  private generation = 0;
  private readonly maxSize: number;
  private readonly maxConcurrentJobs: number;
  private readonly createThumbnail: ThumbnailCreator;

  constructor(
    maxSize = DEFAULT_MAX_THUMBNAILS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
    createThumbnail: ThumbnailCreator = createImageThumbnail,
  ) {
    this.maxSize = maxSize;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.createThumbnail = createThumbnail;
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

    const requestGeneration = this.generation;
    const task = this.enqueue(async () => {
      const afterWait = this.get(entry);
      if (afterWait) return afterWait;

      const url = await this.createThumbnail(entry);
      if (!url) return null;

      if (requestGeneration !== this.generation) {
        URL.revokeObjectURL(url);
        return null;
      }

      this.put(entry, url);
      return url;
    }).finally(() => {
      if (this.pending.get(entry) === task) this.pending.delete(entry);
    });

    this.pending.set(entry, task);
    return task;
  }

  clear(): void {
    this.generation++;
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

  private async enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.activeJobs >= this.maxConcurrentJobs) {
      await new Promise<void>(resolve => this.waitingJobs.push(resolve));
    }

    this.activeJobs++;
    try {
      return await job();
    } finally {
      this.activeJobs--;
      this.waitingJobs.shift()?.();
    }
  }
}

async function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image decode failed'));
    image.src = source;
  });
}

async function createImageThumbnail(entry: MediaEntry): Promise<string | null> {
  let temporaryUrl: string | null = null;
  let bitmap: ImageBitmap | null = null;

  try {
    let blob: Blob | null = entry.handle ? await entry.handle.getFile() : null;
    if (!blob && entry.url) {
      try {
        blob = await fetch(entry.url).then(response => response.blob());
      } catch { /* Fall back to decoding the URL directly below. */ }
    }

    let source: CanvasImageSource;
    let sourceWidth: number;
    let sourceHeight: number;
    if (blob && typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: IMAGE_THUMBNAIL_SIZE,
        resizeQuality: 'high',
      });
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } else {
      const sourceUrl = entry.url || (blob ? URL.createObjectURL(blob) : null);
      if (!sourceUrl) return null;
      if (!entry.url) temporaryUrl = sourceUrl;
      const image = await loadImage(sourceUrl);
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
    return thumbnailBlob ? URL.createObjectURL(thumbnailBlob) : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
  }
}

export const imageThumbnailCache = new ImageThumbnailCache();
