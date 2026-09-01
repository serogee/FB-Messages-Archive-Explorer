import type { MediaEntry } from '../types/messenger';

const sizeCache = new WeakMap<MediaEntry, number | null>();
const pendingSizes = new WeakMap<MediaEntry, Promise<number | null>>();

export function getMediaFileSize(entry: MediaEntry): Promise<number | null> {
  if (sizeCache.has(entry)) return Promise.resolve(sizeCache.get(entry) ?? null);

  const pending = pendingSizes.get(entry);
  if (pending) return pending;

  const request = (async () => {
    try {
      if (entry.handle) return (await entry.handle.getFile()).size;
      if (entry.url) return (await fetch(entry.url)).blob().then(blob => blob.size);
    } catch { /* Unreadable metadata must not hide the attachment. */ }
    return null;
  })().then(size => {
    sizeCache.set(entry, size);
    pendingSizes.delete(entry);
    return size;
  });

  pendingSizes.set(entry, request);
  return request;
}
