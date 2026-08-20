import type { MediaEntry } from '../types/messenger';
import { blobCache } from './blobCache';

interface PosterCacheEntry {
  url: string;
}

const DEFAULT_MAX_POSTERS = 200;
const POSTER_WIDTH = 140;
const MAX_CONCURRENT_POSTER_JOBS = 2;
const SEEK_FALLBACK_SECONDS = 0.5;

class VideoPosterCache {
  private maxSize: number;
  private cache = new Map<MediaEntry, PosterCacheEntry>();
  private pending = new Map<MediaEntry, Promise<string | null>>();
  private activeJobs = 0;
  private waitingJobs: (() => void)[] = [];

  constructor(maxSize = DEFAULT_MAX_POSTERS) {
    this.maxSize = maxSize;
  }

  get(entry: MediaEntry): string | null {
    const cached = this.cache.get(entry);
    if (!cached) return null;

    this.cache.delete(entry);
    this.cache.set(entry, cached);
    return cached.url;
  }

  getOrCreate(entry: MediaEntry): Promise<string | null> {
    const cached = this.get(entry);
    if (cached) return Promise.resolve(cached);

    const existing = this.pending.get(entry);
    if (existing) return existing;

    const task = this.enqueue(async () => {
      const afterWait = this.get(entry);
      if (afterWait) return afterWait;

      const videoUrl = await blobCache.getOrCreate(entry);
      if (!videoUrl) return null;

      const posterUrl = await createVideoPoster(videoUrl);
      if (!posterUrl) return null;

      this.put(entry, posterUrl);
      return posterUrl;
    }).finally(() => {
      this.pending.delete(entry);
    });

    this.pending.set(entry, task);
    return task;
  }

  clear(): void {
    for (const cached of this.cache.values()) {
      this.revoke(cached.url);
    }
    this.cache.clear();
    this.pending.clear();
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeJobs >= MAX_CONCURRENT_POSTER_JOBS) {
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

  private put(entry: MediaEntry, url: string): void {
    if (this.cache.has(entry)) {
      const previous = this.cache.get(entry);
      if (previous?.url !== url) this.revoke(previous!.url);
      this.cache.delete(entry);
    }

    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      const [oldEntry, oldCached] = oldest;
      this.cache.delete(oldEntry);
      this.revoke(oldCached.url);
    }

    this.cache.set(entry, { url });
  }

  private revoke(url: string): void {
    try {
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  }
}

function waitForEvent(target: EventTarget, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleSuccess);
      target.removeEventListener('error', handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Video ${eventName} failed`));
    };
    target.addEventListener(eventName, handleSuccess, { once: true });
    target.addEventListener('error', handleError, { once: true });
  });
}

async function createVideoPoster(videoUrl: string): Promise<string | null> {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = videoUrl;

  try {
    await waitForEvent(video, 'loadedmetadata');

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const targetTime = duration > 1 ? Math.min(duration * 0.1, SEEK_FALLBACK_SECONDS) : 0;

    if (targetTime > 0) {
      video.currentTime = targetTime;
      await waitForEvent(video, 'seeked');
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, 'loadeddata');
    }

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
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export const videoPosterCache = new VideoPosterCache(DEFAULT_MAX_POSTERS);
