import type { MediaEntry } from '../types/messenger';
import { blobCache } from './blobCache';
import { getMediaFileSize } from './mediaMetadata';

export interface AudioMetadata {
  duration: number | null;
  size: number | null;
}

const metadataCache = new WeakMap<MediaEntry, AudioMetadata>();
const pendingMetadata = new WeakMap<MediaEntry, Promise<AudioMetadata>>();
const AUDIO_METADATA_TIMEOUT_MS = 10_000;

async function readDuration(entry: MediaEntry): Promise<number | null> {
  const url = await blobCache.getOrCreate(entry);
  if (!url) return null;

  return new Promise(resolve => {
    const audio = new Audio();
    let settled = false;
    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      resolve(duration);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => finish(null);
    const timeout = setTimeout(() => finish(null), AUDIO_METADATA_TIMEOUT_MS);
    audio.src = url;
  });
}

export function getAudioMetadata(entry: MediaEntry): Promise<AudioMetadata> {
  const cached = metadataCache.get(entry);
  if (cached) return Promise.resolve(cached);

  const pending = pendingMetadata.get(entry);
  if (pending) return pending;

  const request = Promise.all([readDuration(entry), getMediaFileSize(entry)])
    .then(([duration, size]) => {
      const metadata = { duration, size };
      metadataCache.set(entry, metadata);
      pendingMetadata.delete(entry);
      return metadata;
    });
  pendingMetadata.set(entry, request);
  return request;
}
