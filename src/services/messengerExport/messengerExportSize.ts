import { getMessageAttachmentReferences } from '../media';
import { parseMessengerExportJson } from './messengerExportParser';

type MediaSizeIndex = Map<string, number>;

function normalizeMediaPath(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function getBasename(path: string): string {
  return normalizeMediaPath(path).split('/').pop() || '';
}

function isMessengerMediaRef(path: string): boolean {
  const normalized = normalizeMediaPath(path);
  return normalized.startsWith('media/') || /^[^/]+\.[a-z0-9]{2,5}$/i.test(normalized);
}

async function collectMediaSizes(
  dirHandle: FileSystemDirectoryHandle,
  prefix: string,
  index: MediaSizeIndex,
  signal?: AbortSignal
): Promise<void> {
  let lastYield = performance.now();

  for await (const [name, entry] of dirHandle.entries()) {
    if (signal?.aborted) return;

    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') {
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        const normalizedPath = normalizeMediaPath(path);
        const basename = getBasename(path);

        index.set(normalizedPath, file.size);
        if (basename && !index.has(basename)) {
          index.set(basename, file.size);
        }
      } catch { /* ignore unreadable files */ }
    } else if (entry.kind === 'directory') {
      await collectMediaSizes(entry as FileSystemDirectoryHandle, path, index, signal);
    }

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}

export async function buildMessengerExportMediaSizeIndex(
  rootHandle: FileSystemDirectoryHandle,
  signal?: AbortSignal
): Promise<MediaSizeIndex> {
  const index: MediaSizeIndex = new Map();

  try {
    const mediaHandle = await rootHandle.getDirectoryHandle('media');
    await collectMediaSizes(mediaHandle, 'media', index, signal);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    // A Messenger export may validly omit media when it contains only JSON.
  }

  return index;
}

export async function computeMessengerExportChatSize(
  rootHandle: FileSystemDirectoryHandle,
  jsonFileName: string,
  mediaSizeIndex?: MediaSizeIndex,
  signal?: AbortSignal
): Promise<number> {
  const fileHandle = await rootHandle.getFileHandle(jsonFileName);
  const file = await fileHandle.getFile();
  if (signal?.aborted) return file.size;

  const index = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  const content = await file.text();
  if (signal?.aborted) return file.size;

  const thread = parseMessengerExportJson(content);
  const referencedMedia = new Set<string>();

  for (const msg of thread.messages || []) {
    for (const { path } of getMessageAttachmentReferences(msg)) {
      if (!isMessengerMediaRef(path)) continue;
      const normalized = normalizeMediaPath(path);
      referencedMedia.add(normalized);
    }
  }

  let mediaSize = 0;
  for (const path of referencedMedia) {
    mediaSize += index.get(path) || index.get(getBasename(path)) || 0;
  }

  return file.size + mediaSize;
}
