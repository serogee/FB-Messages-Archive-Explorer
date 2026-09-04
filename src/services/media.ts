import type { MediaItem, MediaState, MediaEntry, MessengerMessage } from '../types/messenger';
import type { ReadableDirectoryHandle, ReadableFileHandle } from '../types/fileSystem';
import { blobCache } from './blobCache';
import { imageThumbnailCache } from './imageThumbnailCache';
import { chatImagePreviewCache } from './chatImagePreviewCache';
import { chatVideoPosterCache, videoPosterCache } from './videoPosterCache';


function normalizeMediaPath(path: string): string {
  return String(path || '').replace(/\\/g, '/').toLowerCase();
}

function getMediaBasename(path: string): string {
  return normalizeMediaPath(path).split('/').pop() || '';
}


export function getMediaType(filename: string): 'image' | 'video' | 'audio' | 'unknown' {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'aac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  return 'unknown';
}

export interface ResolvedMessageMediaItem {
  media: MediaItem;
  mediaPath: string;
  mediaFile: MediaEntry | null;
  mediaType: 'image' | 'video' | 'audio' | 'unknown';
  preferredType?: 'image' | 'video' | 'audio';
  isSticker: boolean;
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
    mediaFileCount: 0,
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
  chatImagePreviewCache.clear();
  imageThumbnailCache.clear();
  chatVideoPosterCache.clear();
  videoPosterCache.clear();
  blobCache.clear();
  for (const url of Object.values(state.files)) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  state.files = {};
  state.types = {};
  state.lookup = new Map();
  state.pathIndex = new Set();
  state.basenameIndex = new Set();
  state.mediaFileCount = 0;
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
    msg?.files || [],
    msg?.sticker ? [msg.sticker] : []
  );

  return items.filter(item => {
    const path = getMediaReferencePath(item).toLowerCase();
    if (!path) return false;
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

export function resolveMessageMediaItems(
  msg: MessengerMessage,
  mediaState: MediaState,
): ResolvedMessageMediaItem[] {
  const seen = new Set<string>();
  const items = [
    ...(msg.photos || []).map(media => ({ media, preferredType: 'image' as const, isSticker: false })),
    ...(msg.videos || []).map(media => ({ media, preferredType: 'video' as const, isSticker: false })),
    ...(msg.audio || []).map(media => ({ media, preferredType: 'audio' as const, isSticker: false })),
    ...(msg.audio_files || []).map(media => ({ media, preferredType: 'audio' as const, isSticker: false })),
    ...(msg.gifs || []).map(media => ({ media, preferredType: 'image' as const, isSticker: false })),
    ...(msg.files || []).map(media => ({ media, preferredType: undefined, isSticker: false })),
    ...(msg.media || []).map(media => ({ media, preferredType: undefined, isSticker: false })),
    ...(msg.sticker ? [{ media: msg.sticker, preferredType: 'image' as const, isSticker: true }] : []),
  ].filter(({ media }) => {
    const mediaPath = getMediaReferencePath(media).toLowerCase();
    if (!mediaPath || seen.has(mediaPath)) return false;
    seen.add(mediaPath);
    return true;
  });

  return items.map(({ media, preferredType, isSticker }) => {
    const mediaPath = getMediaReferencePath(media);
    const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
    const mediaFile = findMediaFile(mediaState, mediaPath);
    const detectedType = preferredType || (
      ext === 'mp4' || ext === 'webm'
        ? 'video'
        : mediaFile?.type || getMediaType(mediaPath)
    );
    const mediaType = detectedType === 'image' || detectedType === 'video' || detectedType === 'audio'
      ? detectedType
      : 'unknown';
    return { media, preferredType, mediaPath, mediaFile, mediaType, isSticker };
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
): Array<{ path: string; category: string; shared?: boolean }> {
  const refs: Array<{ path: string; category: string; shared?: boolean }> = [];
  const seen = new Set<string>();
  const addRef = (item: MediaItem, category: string, shared = false) => {
    const path = getMediaReferencePath(item);
    const key = `${category}:${path.toLowerCase()}`;
    if (!path || seen.has(key)) return;
    seen.add(key);
    refs.push(shared ? { path, category, shared: true } : { path, category });
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
  if (msg?.sticker) addRef(msg.sticker, 'stickers', true);
  return refs;
}

export function getFacebookStickerFileName(path: string): string | null {
  const cleanPath = String(path || '').replace(/\\/g, '/').split(/[?#]/, 1)[0];
  const parts = cleanPath.split('/').filter(Boolean);
  const stickerDirectoryIndex = parts.findIndex(part => part.toLowerCase() === 'stickers_used');
  if (stickerDirectoryIndex < 0 || stickerDirectoryIndex !== parts.length - 2) return null;

  const fileName = parts[stickerDirectoryIndex + 1];
  if (!fileName || !/\.(?:jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(fileName) || fileName === '.' || fileName === '..') return null;
  return fileName;
}

export async function processFacebookStickerReferences(
  messagesRootHandle: ReadableDirectoryHandle,
  messages: MessengerMessage[],
  state: MediaState,
  signal?: AbortSignal
): Promise<void> {
  const pathsByFileName = new Map<string, Set<string>>();
  for (const message of messages) {
    const path = message.sticker ? getMediaReferencePath(message.sticker) : '';
    const fileName = getFacebookStickerFileName(path);
    if (!fileName) continue;
    const normalizedFileName = fileName.toLowerCase();
    let paths = pathsByFileName.get(normalizedFileName);
    if (!paths) {
      paths = new Set();
      pathsByFileName.set(normalizedFileName, paths);
    }
    paths.add(path);
  }
  if (pathsByFileName.size === 0 || signal?.aborted) return;

  let stickerDirectory: ReadableDirectoryHandle;
  try {
    stickerDirectory = await messagesRootHandle.getDirectoryHandle('stickers_used');
  } catch {
    return;
  }

  await Promise.all(Array.from(pathsByFileName.entries()).map(async ([, paths]) => {
    if (signal?.aborted) return;
    const firstPath = paths.values().next().value as string | undefined;
    const fileName = firstPath ? getFacebookStickerFileName(firstPath) : null;
    if (!fileName) return;
    try {
      const handle = await stickerDirectory.getFileHandle(fileName);
      const entry: MediaEntry = { handle, type: 'image' };
      for (const path of paths) {
        state.types[path] = 'image';
        addMediaToIndex(state, path, entry);
      }
      addMediaToIndex(state, `stickers_used/${fileName}`, entry);
    } catch { /* A missing shared sticker should remain visible as an unresolved reference. */ }
  }));
}

export async function processMediaFromDirectory(
  dirHandle: ReadableDirectoryHandle,
  state: MediaState,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const MEDIA_SUBDIRS = ['photos', 'videos', 'audio', 'gifs', 'files'];
  const BATCH_SIZE = 20;

  const fileHandles: Array<{ handle: ReadableFileHandle; path: string }> = [];

  let lastYield = performance.now();

  for (const subdirName of MEDIA_SUBDIRS) {
    if (signal?.aborted) return;
    let subdirHandle: ReadableDirectoryHandle;
    try {
      subdirHandle = await dirHandle.getDirectoryHandle(subdirName);
    } catch {
      continue;
    }
    for await (const [name, entry] of subdirHandle.entries()) {
      if (signal?.aborted) return;
      if (entry.kind === 'file') {
        fileHandles.push({
          handle: entry,
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
  state.mediaFileCount = total;
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
        } catch { /* One unreadable attachment must not stop media indexing. */ }
      })
    );
    done += batch.length;
    onProgress?.(done, total);
    // Yield only after a frame budget to balance throughput and responsiveness.
    if (performance.now() - lastYield > 16) {
      await new Promise(r => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
}
