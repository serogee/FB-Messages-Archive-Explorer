import type { MediaEntry } from '../types/messenger';
import { MEDIA_THUMBNAIL_SIZE } from './mediaThumbnailConfig';

interface PosterCacheEntry {
  url: string;
  duration: number | null;
}

const DEFAULT_MAX_POSTERS = 200;
const POSTER_WIDTH = MEDIA_THUMBNAIL_SIZE;
const MAX_CONCURRENT_POSTER_JOBS = 2;
const VIDEO_EVENT_TIMEOUT_MS = 5_000;
const SEEK_FALLBACK_SECONDS = 0.5;

export interface VideoPosterDetails {
  url: string;
  duration: number | null;
}

type PosterCreator = (entry: MediaEntry) => Promise<VideoPosterDetails | null>;

export class VideoPosterCache {
  private maxSize: number;
  private maxConcurrentJobs: number;
  private createPoster: PosterCreator;
  private cache = new Map<MediaEntry, PosterCacheEntry>();
  private pending = new Map<MediaEntry, Promise<VideoPosterDetails | null>>();
  private activeJobs = 0;
  private waitingJobs: (() => void)[] = [];
  private generation = 0;
  private failed = new WeakSet<MediaEntry>();

  constructor(
    maxSize = DEFAULT_MAX_POSTERS,
    maxConcurrentJobs = MAX_CONCURRENT_POSTER_JOBS,
    createPoster: PosterCreator = createVideoPosterForEntry,
  ) {
    this.maxSize = maxSize;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.createPoster = createPoster;
  }

  get(entry: MediaEntry): string | null {
    return this.getDetails(entry)?.url ?? null;
  }

  getDetails(entry: MediaEntry): VideoPosterDetails | null {
    const cached = this.cache.get(entry);
    if (!cached) return null;

    this.cache.delete(entry);
    this.cache.set(entry, cached);
    return { url: cached.url, duration: cached.duration };
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

    const requestGeneration = this.generation;
    const task = this.enqueue(async () => {
      if (requestGeneration !== this.generation) return null;

      const afterWait = this.getDetails(entry);
      if (afterWait) return afterWait;

      const poster = await this.createPoster(entry);
      if (!poster) {
        if (requestGeneration === this.generation) this.failed.add(entry);
        return null;
      }

      if (requestGeneration !== this.generation) {
        this.revoke(poster.url);
        return null;
      }

      this.put(entry, poster);
      return poster;
    }).finally(() => {
      if (this.pending.get(entry) === task) this.pending.delete(entry);
    });

    this.pending.set(entry, task);
    return task;
  }

  clear(): void {
    this.generation++;
    for (const cached of this.cache.values()) {
      this.revoke(cached.url);
    }
    this.cache.clear();
    this.pending.clear();
    this.failed = new WeakSet();
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeJobs >= this.maxConcurrentJobs) {
      await new Promise<void>(resolve => {
        this.waitingJobs.push(resolve);
      });
    }

    this.activeJobs++;
    try {
      return await task();
    } finally {
      this.activeJobs--;
      const next = this.waitingJobs.shift();
      if (next) next();
    }
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

async function createVideoPosterForEntry(entry: MediaEntry): Promise<VideoPosterDetails | null> {
  if (entry.handle) {
    let temporaryUrl: string | null = null;
    try {
      const file = await entry.handle.getFile();
      const source = file.type ? file : new Blob([file], { type: getVideoMimeType(entry.handle.name) });
      temporaryUrl = URL.createObjectURL(source);
      return await createVideoPosterDetails(temporaryUrl);
    } catch {
      return null;
    } finally {
      if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
    }
  }

  return entry.url ? createVideoPosterDetails(entry.url) : null;
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
): Promise<void> {
  if (video.readyState >= minimumReadyState) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener('error', handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Video ${eventName} failed`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Video ${eventName} timed out`));
    }, VIDEO_EVENT_TIMEOUT_MS);

    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener('error', handleError, { once: true });
    // Close the small race between the initial readyState check and listener setup.
    if (video.readyState >= minimumReadyState) handleSuccess();
  });
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener('error', handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Video ${eventName} failed`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Video ${eventName} timed out`));
    }, VIDEO_EVENT_TIMEOUT_MS);

    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener('error', handleError, { once: true });
  });
}

export async function createVideoPoster(videoUrl: string): Promise<string | null> {
  return createVideoPosterDetails(videoUrl).then(details => details?.url ?? null);
}

export async function createVideoPosterDetails(videoUrl: string): Promise<VideoPosterDetails | null> {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  try {
    // Register readiness listeners before assigning src; local blob URLs can load
    // metadata quickly enough to otherwise fire before a listener is attached.
    const metadataReady = waitForVideoState(video, 'loadedmetadata', HTMLMediaElement.HAVE_METADATA);
    video.src = videoUrl;
    video.load();
    await metadataReady;

    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const targetTime = duration && duration > 0 ? Math.min(duration * 0.1, SEEK_FALLBACK_SECONDS) : 0;
    if (targetTime > 0) {
      const seeked = waitForVideoEvent(video, 'seeked');
      video.currentTime = targetTime;
      await seeked;
    }
    await waitForVideoState(video, 'loadeddata', HTMLMediaElement.HAVE_CURRENT_DATA);

    const sourceWidth = video.videoWidth || POSTER_WIDTH;
    const sourceHeight = video.videoHeight || POSTER_WIDTH;
    const width = POSTER_WIDTH;
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.72);
    });
    return blob ? { url: URL.createObjectURL(blob), duration } : null;
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

export const videoPosterCache = new VideoPosterCache(DEFAULT_MAX_POSTERS);
