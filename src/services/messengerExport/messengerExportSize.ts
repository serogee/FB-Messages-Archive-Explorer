import { getMessageAttachmentReferences } from '../media';
import { parseMessengerExportJson } from './messengerExportParser';
import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import {
  getMessengerMediaBasename,
  getMessengerMediaIdentity,
  type MessengerExportChatIndex,
} from './messengerExportIndex';

export type MediaSizeIndex = Map<string, number>;

function normalizeMediaPath(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function getBasename(path: string): string {
  return getMessengerMediaBasename(path);
}

function isMessengerMediaRef(path: string): boolean {
  const normalized = normalizeMediaPath(path);
  return normalized.startsWith('media/') || /^[^/]+\.[a-z0-9]{2,5}$/i.test(normalized);
}

async function collectMediaSizes(
  dirHandle: ReadableDirectoryHandle,
  prefix: string,
  index: MediaSizeIndex,
  basenamePaths: Map<string, string>,
  ambiguousBasenames: Set<string>,
  signal?: AbortSignal
): Promise<void> {
  let lastYield = performance.now();

  for await (const [name, entry] of dirHandle.entries()) {
    throwIfAborted(signal);

    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') {
      try {
        const file = await entry.getFile();
        throwIfAborted(signal);
        const normalizedPath = normalizeMediaPath(path);
        const sourcePath = path.replace(/\\/g, '/').replace(/^\.?\//, '');
        const basename = getBasename(path);

        index.set(normalizedPath, file.size);
        if (basename && !ambiguousBasenames.has(basename)) {
          const existingPath = basenamePaths.get(basename);
          if (existingPath && existingPath !== sourcePath) {
            basenamePaths.delete(basename);
            ambiguousBasenames.add(basename);
            index.delete(basename);
          } else if (!existingPath) {
            basenamePaths.set(basename, sourcePath);
            index.set(basename, file.size);
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        /* ignore unreadable files */
      }
    } else if (entry.kind === 'directory') {
      await collectMediaSizes(entry, path, index, basenamePaths, ambiguousBasenames, signal);
    }

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      throwIfAborted(signal);
      lastYield = performance.now();
    }
  }
}

export async function buildMessengerExportMediaSizeIndex(
  rootHandle: ReadableDirectoryHandle,
  signal?: AbortSignal
): Promise<MediaSizeIndex> {
  const index: MediaSizeIndex = new Map();
  const basenamePaths = new Map<string, string>();
  const ambiguousBasenames = new Set<string>();

  try {
    throwIfAborted(signal);
    const mediaHandle = await rootHandle.getDirectoryHandle('media');
    throwIfAborted(signal);
    await collectMediaSizes(mediaHandle, 'media', index, basenamePaths, ambiguousBasenames, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    // A Messenger export may validly omit media when it contains only JSON.
  }

  return index;
}

export async function computeMessengerExportChatSize(
  rootHandle: ReadableDirectoryHandle,
  jsonFileName: string,
  mediaSizeIndex?: MediaSizeIndex,
  signal?: AbortSignal
): Promise<number> {
  throwIfAborted(signal);
  const fileHandle = await rootHandle.getFileHandle(jsonFileName);
  const file = await fileHandle.getFile();
  throwIfAborted(signal);

  const index = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  const content = await file.text();
  throwIfAborted(signal);

  const thread = parseMessengerExportJson(content);
  const referencedMedia = new Set<string>();

  for (const msg of thread.messages || []) {
    for (const { path, shared } of getMessageAttachmentReferences(msg)) {
      if (shared) continue;
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

export function computeMessengerExportChatSizeFromIndex(
  jsonFileName: string,
  chatIndex: MessengerExportChatIndex,
  mediaSizeIndex: MediaSizeIndex
): number {
  const jsonSize = chatIndex.jsonSizes.get(jsonFileName);
  if (jsonSize == null) {
    throw new Error(`Missing indexed JSON size for ${jsonFileName}`);
  }

  let mediaSize = 0;
  for (const path of chatIndex.chatMediaPaths.get(jsonFileName) || []) {
    const identity = getMessengerMediaIdentity(path) || normalizeMediaPath(path);
    mediaSize += mediaSizeIndex.get(identity) || mediaSizeIndex.get(getBasename(path)) || 0;
  }
  return jsonSize + mediaSize;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
