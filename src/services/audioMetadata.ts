import type { MediaEntry } from '../types/messenger';
import { blobCache } from './blobCache';
import { getMediaFileSize } from './mediaMetadata';

export interface AudioMetadata {
  duration: number | null;
  size: number | null;
}

const metadataCache = new WeakMap<MediaEntry, AudioMetadata>();
const pendingMetadata = new WeakMap<MediaEntry, Promise<AudioMetadata>>();

async function readDuration(entry: MediaEntry): Promise<number | null> {
  const url = await blobCache.getOrCreate(entry);
  if (!url) return null;

  return new Promise(resolve => {
    const audio = new Audio();
    const finish = (duration: number | null) => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      resolve(duration);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => finish(null);
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
