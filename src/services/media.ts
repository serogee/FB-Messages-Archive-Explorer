import type { MediaItem, MediaState, MediaEntry, MessengerMessage } from '../types/messenger';
import { blobCache } from './blobCache';

// ── Internal helpers ───────────────────────────────────────────────

function normalizeMediaPath(path: string): string {
  return String(path || '').replace(/\\/g, '/').toLowerCase();
}

function getMediaBasename(path: string): string {
  return normalizeMediaPath(path).split('/').pop() || '';
}

// ── Exported functions ─────────────────────────────────────────────

export function getMediaType(filename: string): 'image' | 'video' | 'audio' | 'unknown' {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'aac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  return 'unknown';
}

export function getMediaReferencePath(media: MediaItem): string {
  return String(media?.uri || media?.filename || media?.path || media?.name || '');
}

export function createMediaState(): MediaState {
  return {
    files: {},
    types: {},
    lookup: new Map(),
    pathIndex: new Set(),
    basenameIndex: new Set(),
  };
}

export function addMediaToIndex(
  state: MediaState,
  path: string,
  entry: MediaEntry
): void {
  const normalizedPath = normalizeMediaPath(path);
  const basename = getMediaBasename(path);

  if (normalizedPath) {
    state.pathIndex.add(normalizedPath);
    state.lookup.set(normalizedPath, entry);
  }
  if (basename) {
    state.basenameIndex.add(basename);
    if (!state.lookup.has(basename)) {
      state.lookup.set(basename, entry);
    }
  }
}

export function isMediaReferenceFound(state: MediaState, path: string): boolean {
  const normalizedPath = normalizeMediaPath(path);
  const basename = getMediaBasename(path);
  return (
    (!!normalizedPath && state.pathIndex.has(normalizedPath)) ||
    (!!basename && state.basenameIndex.has(basename))
  );
}

export function findMediaFile(state: MediaState, path: string): MediaEntry | null {
  const normalizedPath = normalizeMediaPath(path);
  const basename = getMediaBasename(path);
  return state.lookup.get(normalizedPath) || state.lookup.get(basename) || null;
}

export function revokeAllMedia(state: MediaState): void {
  blobCache.clear();
  for (const url of Object.values(state.files)) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  state.files = {};
  state.types = {};
  state.lookup = new Map();
  state.pathIndex = new Set();
  state.basenameIndex = new Set();
}

export function getMessageMediaItems(msg: MessengerMessage): MediaItem[] {
  const seen = new Set<string>();
  const items = ([] as MediaItem[]).concat(
    msg?.media || [],
    msg?.photos || [],
    msg?.videos || [],
    msg?.audio || [],
    msg?.audio_files || [],
    msg?.gifs || [],
    msg?.files || []
  );

  return items.filter(item => {
    const path = getMediaReferencePath(item).toLowerCase();
    if (!path) return false;
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function categorizeAttachment(path: string, preferredType?: string): string {
  const ext = String(path || '').split('.').pop()?.toLowerCase() || '';
  const type = preferredType || getMediaType(path || '');
  if (type === 'image') return ext === 'gif' ? 'gifs' : 'photos';
  if (type === 'video') return 'videos';
  if (type === 'audio') return 'audio';
  if (ext === 'gif') return 'gifs';
  return 'files';
}

function getMediaTypeFromDirectory(path: string): 'image' | 'video' | 'audio' | 'unknown' | null {
  const topLevel = normalizeMediaPath(path).split('/')[0];
  if (topLevel === 'photos' || topLevel === 'gifs') return 'image';
  if (topLevel === 'videos') return 'video';
  if (topLevel === 'audio') return 'audio';
  return null;
}

export function getMessageAttachmentReferences(
  msg: MessengerMessage
): Array<{ path: string; category: string }> {
  const refs: Array<{ path: string; category: string }> = [];
  const seen = new Set<string>();
  const addRef = (item: MediaItem, category: string) => {
    const path = getMediaReferencePath(item);
    const key = `${category}:${path.toLowerCase()}`;
    if (!path || seen.has(key)) return;
    seen.add(key);
    refs.push({ path, category });
  };

  (msg?.photos || []).forEach(item => addRef(item, 'photos'));
  (msg?.videos || []).forEach(item => addRef(item, 'videos'));
  (msg?.audio || []).forEach(item => addRef(item, 'audio'));
  (msg?.audio_files || []).forEach(item => addRef(item, 'audio'));
  (msg?.gifs || []).forEach(item => addRef(item, 'gifs'));
  (msg?.files || []).forEach(item => addRef(item, 'files'));
  (msg?.media || []).forEach(item => {
    const path = getMediaReferencePath(item);
    addRef(item, categorizeAttachment(path));
  });
  return refs;
}

export async function processMediaFromDirectory(
  dirHandle: FileSystemDirectoryHandle,
  state: MediaState,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const MEDIA_SUBDIRS = ['photos', 'videos', 'audio', 'gifs', 'files'];
  const BATCH_SIZE = 20;

  const fileHandles: Array<{ handle: FileSystemFileHandle; path: string }> = [];

  let lastYield = performance.now();

  for (const subdirName of MEDIA_SUBDIRS) {
    if (signal?.aborted) return;
    let subdirHandle: FileSystemDirectoryHandle;
    try {
      subdirHandle = await dirHandle.getDirectoryHandle(subdirName);
    } catch {
      continue;
    }
    for await (const [name, entry] of subdirHandle.entries()) {
      if (signal?.aborted) return;
      if (entry.kind === 'file') {
        fileHandles.push({
          handle: entry as FileSystemFileHandle,
          path: `${subdirName}/${name}`,
        });
      }
      if (performance.now() - lastYield > 16) {
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
  }

  if (signal?.aborted) return;
  const total = fileHandles.length;
  let done = 0;
  onProgress?.(0, total);

  for (let i = 0; i < fileHandles.length; i += BATCH_SIZE) {
    if (signal?.aborted) return;
    const batch = fileHandles.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ handle, path }) => {
        try {
          const type = getMediaTypeFromDirectory(path) || getMediaType(handle.name);
          const entry: MediaEntry = { handle, type };
          state.types[path] = type;
          addMediaToIndex(state, path, entry);
        } catch { /* ignore individual failures */ }
        done++;
        onProgress?.(done, total);
      })
    );
    // Yield event loop based on time to maximize speed without freezing
    if (performance.now() - lastYield > 16) {
      await new Promise(r => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
}
