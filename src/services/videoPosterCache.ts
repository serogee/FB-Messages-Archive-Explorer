import type { MediaEntry } from '../types/messenger';
import { blobCache } from './blobCache';
import { MEDIA_THUMBNAIL_SIZE } from './mediaThumbnailConfig';
import { SubscribableTaskQueue } from './subscribableTaskQueue';

interface PosterCacheEntry {
  url: string;
  duration: number | null;
  sourceWidth?: number;
  sourceHeight?: number;
}

const DEFAULT_MAX_POSTERS = 200;
const POSTER_WIDTH = MEDIA_THUMBNAIL_SIZE;
const CHAT_POSTER_WIDTH = 1024;
const CHAT_POSTER_HEIGHT = 768;
const MAX_CONCURRENT_POSTER_JOBS = 2;
const VIDEO_EVENT_TIMEOUT_MS = 5_000;

export interface VideoPosterDetails {
  url: string;
  duration: number | null;
  sourceWidth?: number;
  sourceHeight?: number;
}

type PosterCreator = (entry: MediaEntry, signal: AbortSignal) => Promise<VideoPosterDetails | null>;
type PosterSubscriber = (details: VideoPosterDetails | null) => void;

export class VideoPosterCache {
  private maxSize: number;
  private createPoster: PosterCreator;
  private cache = new Map<MediaEntry, PosterCacheEntry>();
  private pending = new Map<MediaEntry, Promise<VideoPosterDetails | null>>();
  private generation = 0;
  private failed = new WeakSet<MediaEntry>();
  private readonly scheduler: SubscribableTaskQueue<MediaEntry, VideoPosterDetails | null>;

  constructor(
    maxSize = DEFAULT_MAX_POSTERS,
    maxConcurrentJobs = MAX_CONCURRENT_POSTER_JOBS,
    createPoster: PosterCreator = createVideoPosterForEntry,
  ) {
    this.maxSize = maxSize;
    this.createPoster = createPoster;
    this.scheduler = new SubscribableTaskQueue(maxConcurrentJobs, (entry, signal) => (
      this.generate(entry, signal)
    ));
  }

  get(entry: MediaEntry): string | null {
    return this.getDetails(entry)?.url ?? null;
  }

  getDetails(entry: MediaEntry): VideoPosterDetails | null {
    const cached = this.cache.get(entry);
    if (!cached) return null;

    this.cache.delete(entry);
    this.cache.set(entry, cached);
    return {
      url: cached.url,
      duration: cached.duration,
      sourceWidth: cached.sourceWidth,
      sourceHeight: cached.sourceHeight,
    };
  }

  getOrCreate(entry: MediaEntry): Promise<string | null> {
    return this.getOrCreateDetails(entry).then(details => details?.url ?? null);
  }

  getOrCreateDetails(entry: MediaEntry): Promise<VideoPosterDetails | null> {
    const cached = this.getDetails(entry);
    if (cached) return Promise.resolve(cached);
    if (this.failed.has(entry)) return Promise.resolve(null);

    const existing = this.pending.get(entry);
    if (existing) return existing;

    let unsubscribe = () => {};
    const request = new Promise<VideoPosterDetails | null>(resolve => {
      unsubscribe = this.subscribe(entry, resolve);
    });
    const task = request.finally(() => {
      unsubscribe();
      if (this.pending.get(entry) === task) this.pending.delete(entry);
    });

    this.pending.set(entry, task);
    return task;
  }

  subscribe(entry: MediaEntry, subscriber: PosterSubscriber): () => void {
    const cached = this.getDetails(entry);
    if (cached || this.failed.has(entry)) {
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
    for (const cached of this.cache.values()) {
      this.revoke(cached.url);
    }
    this.cache.clear();
    this.pending.clear();
    this.failed = new WeakSet();
  }

  private async generate(entry: MediaEntry, signal: AbortSignal): Promise<VideoPosterDetails | null> {
    const requestGeneration = this.generation;
    if (signal.aborted) return null;

    const cached = this.getDetails(entry);
    if (cached) return cached;

    const poster = await this.createPoster(entry, signal);
    if (!poster) {
      if (!signal.aborted && requestGeneration === this.generation) this.failed.add(entry);
      return null;
    }

    if (signal.aborted || requestGeneration !== this.generation) {
      this.revoke(poster.url);
      return null;
    }

    this.put(entry, poster);
    return poster;
  }

  private put(entry: MediaEntry, poster: VideoPosterDetails): void {
    if (this.cache.has(entry)) {
      const previous = this.cache.get(entry);
      if (previous?.url !== poster.url) this.revoke(previous!.url);
      this.cache.delete(entry);
    }

    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      const [oldEntry, oldCached] = oldest;
      this.cache.delete(oldEntry);
      this.revoke(oldCached.url);
    }

    this.cache.set(entry, poster);
  }

  private revoke(url: string): void {
    try {
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  }
}

async function createVideoPosterForEntry(
  entry: MediaEntry,
  signal: AbortSignal,
  posterWidth = POSTER_WIDTH,
  posterHeight?: number,
): Promise<VideoPosterDetails | null> {
  if (entry.handle) {
    let temporaryUrl: string | null = null;
    try {
      const file = await entry.handle.getFile();
      if (signal.aborted) return null;
      const source = file.type ? file : new Blob([file], { type: getVideoMimeType(entry.handle.name) });
      temporaryUrl = URL.createObjectURL(source);
      return await createVideoPosterDetails(temporaryUrl, signal, posterWidth, posterHeight);
    } catch {
      return null;
    } finally {
      if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
    }
  }

  return entry.url ? createVideoPosterDetails(entry.url, signal, posterWidth, posterHeight) : null;
}

async function createChatVideoPosterForEntry(
  entry: MediaEntry,
  signal: AbortSignal,
): Promise<VideoPosterDetails | null> {
  const sourceUrl = await blobCache.getOrCreate(entry);
  if (!sourceUrl || signal.aborted) return null;
  return createVideoPosterDetails(sourceUrl, signal, CHAT_POSTER_WIDTH, CHAT_POSTER_HEIGHT);
}

function getVideoMimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension === 'webm') return 'video/webm';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'mkv') return 'video/x-matroska';
  if (extension === 'avi') return 'video/x-msvideo';
  return 'video/mp4';
}

function waitForVideoState(
  video: HTMLVideoElement,
  eventName: string,
  minimumReadyState: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Poster generation cancelled', 'AbortError'));
  if (video.readyState >= minimumReadyState) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Video ${eventName} failed`));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Poster generation cancelled', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Video ${eventName} timed out`));
    }, VIDEO_EVENT_TIMEOUT_MS);

    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener('error', handleError, { once: true });
    signal.addEventListener('abort', handleAbort, { once: true });
    // Close the small race between the initial readyState check and listener setup.
    if (video.readyState >= minimumReadyState) handleSuccess();
  });
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Poster generation cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Video ${eventName} failed`));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Poster generation cancelled', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Video ${eventName} timed out`));
    }, VIDEO_EVENT_TIMEOUT_MS);

    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener('error', handleError, { once: true });
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

export async function createVideoPoster(videoUrl: string): Promise<string | null> {
  return createVideoPosterDetails(videoUrl).then(details => details?.url ?? null);
}

export async function createVideoPosterDetails(
  videoUrl: string,
  signal: AbortSignal = new AbortController().signal,
  posterWidth = POSTER_WIDTH,
  posterHeight?: number,
): Promise<VideoPosterDetails | null> {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  try {
    // Register readiness listeners before assigning src; local blob URLs can load
    // metadata quickly enough to otherwise fire before a listener is attached.
    const metadataReady = waitForVideoState(video, 'loadedmetadata', HTMLMediaElement.HAVE_METADATA, signal);
    video.src = videoUrl;
    video.load();
    await metadataReady;
    if (signal.aborted) return null;

    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const sourceWidth = video.videoWidth || POSTER_WIDTH;
    const sourceHeight = video.videoHeight || POSTER_WIDTH;
    const scale = posterHeight
      ? Math.min(posterWidth / sourceWidth, posterHeight / sourceHeight, 1)
      : posterWidth / sourceWidth;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let foundVisibleFrame = false;
    for (const targetTime of getPosterCandidateTimes(duration)) {
      if (targetTime !== video.currentTime) {
        const seeked = waitForVideoEvent(video, 'seeked', signal);
        video.currentTime = targetTime;
        await seeked;
      }
      await waitForVideoState(video, 'loadeddata', HTMLMediaElement.HAVE_CURRENT_DATA, signal);
      if (signal.aborted) return null;

      ctx.drawImage(video, 0, 0, width, height);
      if (!isVideoFrameMostlyBlack(ctx, width, height)) {
        foundVisibleFrame = true;
        break;
      }
    }
    if (!foundVisibleFrame) return null;

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/webp', 0.86);
    });
    if (signal.aborted) return null;
    return blob ? { url: URL.createObjectURL(blob), duration, sourceWidth, sourceHeight } : null;
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

export const videoPosterCache = new VideoPosterCache(DEFAULT_MAX_POSTERS);
export const chatVideoPosterCache = new VideoPosterCache(
  DEFAULT_MAX_POSTERS,
  MAX_CONCURRENT_POSTER_JOBS,
  createChatVideoPosterForEntry,
);

export function getPosterCandidateTimes(duration: number | null): number[] {
  if (!duration || duration <= 0) return [0];
  const lastUsefulFrame = Math.max(0, duration * 0.9);
  const candidates = [
    Math.min(duration * 0.1, lastUsefulFrame),
    Math.min(duration * 0.25, lastUsefulFrame),
    Math.min(duration * 0.5, lastUsefulFrame),
  ];
  return [...new Set(candidates.map(time => Math.max(0, time)))];
}

export function isVideoFrameMostlyBlack(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  if (typeof context.getImageData !== 'function') return false;
  try {
    const pixels = context.getImageData(0, 0, width, height).data;
    const sampleStride = Math.max(1, Math.floor((width * height) / 4096));
    let visible = 0;
    let dark = 0;
    for (let pixel = 0; pixel < width * height; pixel += sampleStride) {
      const offset = pixel * 4;
      if (pixels[offset + 3] < 16) continue;
      visible++;
      const luminance = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
      if (luminance < 18) dark++;
    }
    return visible > 0 && dark / visible > 0.96;
  } catch {
    // A frame that cannot be inspected is still preferable to no poster.
    return false;
  }
}
