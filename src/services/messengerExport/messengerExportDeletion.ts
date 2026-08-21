import type { ChatListEntry } from '../../types/messenger';
import { getMessageAttachmentReferences } from '../media';
import { tryParseMessengerExportJson } from './messengerExportParser';
import { buildMessengerExportMediaSizeIndex } from './messengerExportSize';

export interface MessengerExportReferenceIndex {
  mediaOwners: Map<string, Set<string>>;
  chatMedia: Map<string, Set<string>>;
}

export interface MessengerExportDeletionInfo {
  jsonSize: number;
  chatFileCount: number;
  mediaSize: number;
  totalSize: number;
  exclusiveMediaFiles: string[];
  exclusiveMediaCount: number;
  sharedMediaCount: number;
}

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

async function getConversationMediaBasenames(file: File): Promise<Set<string>> {
  const content = await file.text();
  const media = new Set<string>();
  const thread = tryParseMessengerExportJson(content);
  if (!thread) return media;
  for (const msg of thread.messages || []) {
    for (const { path } of getMessageAttachmentReferences(msg)) {
      if (!isMessengerMediaRef(path)) continue;
      const basename = getBasename(path);
      if (basename) media.add(basename);
    }
  }

  return media;
}

export async function buildMessengerExportReferenceIndex(
  rootHandle: FileSystemDirectoryHandle,
  signal?: AbortSignal
): Promise<MessengerExportReferenceIndex> {
  const mediaOwners = new Map<string, Set<string>>();
  const chatMedia = new Map<string, Set<string>>();
  let lastYield = performance.now();

  for await (const [name, entry] of rootHandle.entries()) {
    if (signal?.aborted) break;
    if (entry.kind !== 'file' || !/\.json$/i.test(name)) continue;

    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      const media = await getConversationMediaBasenames(file);
      chatMedia.set(name, media);

      for (const basename of media) {
        let owners = mediaOwners.get(basename);
        if (!owners) {
          owners = new Set();
          mediaOwners.set(basename, owners);
        }
        owners.add(name);
      }
    } catch { /* skip unreadable JSON files */ }

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }

  return { mediaOwners, chatMedia };
}

function removeChatFromReferenceIndex(index: MessengerExportReferenceIndex, jsonFileName: string): void {
  const media = index.chatMedia.get(jsonFileName);
  if (!media) return;

  for (const basename of media) {
    const owners = index.mediaOwners.get(basename);
    if (!owners) continue;
    owners.delete(jsonFileName);
    if (owners.size === 0) {
      index.mediaOwners.delete(basename);
    }
  }

  index.chatMedia.delete(jsonFileName);
}

async function removeMediaFile(rootHandle: FileSystemDirectoryHandle, basename: string): Promise<void> {
  try {
    const mediaHandle = await rootHandle.getDirectoryHandle('media');
    await mediaHandle.removeEntry(basename);
  } catch {
    // Missing media files are already gone; deletion can continue.
  }
}

async function getJsonSize(rootHandle: FileSystemDirectoryHandle, jsonFileName: string): Promise<number> {
  const fileHandle = await rootHandle.getFileHandle(jsonFileName);
  const file = await fileHandle.getFile();
  return file.size;
}

export async function getMessengerExportDeletionInfo(
  rootHandle: FileSystemDirectoryHandle,
  entry: ChatListEntry,
  referenceIndex: MessengerExportReferenceIndex,
  signal?: AbortSignal,
  mediaSizeIndex?: Map<string, number>
): Promise<MessengerExportDeletionInfo> {
  const jsonFileName = entry._jsonFileName!;
  const resolvedMediaSizeIndex = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  const jsonSize = await getJsonSize(rootHandle, jsonFileName);
  const chatMedia = referenceIndex.chatMedia.get(jsonFileName) || new Set<string>();
  const exclusiveMediaFiles: string[] = [];
  let sharedMediaCount = 0;
  let mediaSize = 0;

  for (const basename of chatMedia) {
    const owners = referenceIndex.mediaOwners.get(basename);
    if (!owners || owners.size <= 1) {
      exclusiveMediaFiles.push(basename);
      mediaSize += resolvedMediaSizeIndex.get(basename) || 0;
    } else {
      sharedMediaCount++;
    }
  }

  return {
    jsonSize,
    chatFileCount: 1,
    mediaSize,
    totalSize: jsonSize + mediaSize,
    exclusiveMediaFiles,
    exclusiveMediaCount: exclusiveMediaFiles.length,
    sharedMediaCount,
  };
}

export async function getMessengerExportBatchDeletionInfo(
  rootHandle: FileSystemDirectoryHandle,
  entries: ChatListEntry[],
  referenceIndex: MessengerExportReferenceIndex,
  signal?: AbortSignal,
  mediaSizeIndex?: Map<string, number>
): Promise<MessengerExportDeletionInfo> {
  const resolvedMediaSizeIndex = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  const selectedJson = new Set(entries.map(entry => entry._jsonFileName).filter(Boolean) as string[]);
  const referencedMedia = new Set<string>();
  let jsonSize = 0;
  let chatFileCount = 0;

  for (const entry of entries) {
    const jsonFileName = entry._jsonFileName!;
    jsonSize += await getJsonSize(rootHandle, jsonFileName);
    chatFileCount++;
    const chatMedia = referenceIndex.chatMedia.get(jsonFileName);
    if (!chatMedia) continue;
    for (const basename of chatMedia) {
      referencedMedia.add(basename);
    }
  }

  const exclusiveMediaFiles: string[] = [];
  let sharedMediaCount = 0;
  let mediaSize = 0;

  for (const basename of referencedMedia) {
    const owners = referenceIndex.mediaOwners.get(basename);
    const shouldDelete = owners ? Array.from(owners).every(owner => selectedJson.has(owner)) : true;
    if (shouldDelete) {
      exclusiveMediaFiles.push(basename);
      mediaSize += resolvedMediaSizeIndex.get(basename) || 0;
    } else {
      sharedMediaCount++;
    }
  }

  return {
    jsonSize,
    chatFileCount,
    mediaSize,
    totalSize: jsonSize + mediaSize,
    exclusiveMediaFiles,
    exclusiveMediaCount: exclusiveMediaFiles.length,
    sharedMediaCount,
  };
}

export async function deleteMessengerExportChat(
  rootHandle: FileSystemDirectoryHandle,
  entry: ChatListEntry,
  referenceIndex: MessengerExportReferenceIndex
): Promise<void> {
  const jsonFileName = entry._jsonFileName!;
  const chatMedia = referenceIndex.chatMedia.get(jsonFileName) || new Set<string>();
  const mediaToDelete: string[] = [];

  for (const basename of chatMedia) {
    const owners = referenceIndex.mediaOwners.get(basename);
    if (!owners || owners.size <= 1) {
      mediaToDelete.push(basename);
    }
  }

  await rootHandle.removeEntry(jsonFileName);

  for (const basename of mediaToDelete) {
    await removeMediaFile(rootHandle, basename);
  }

  removeChatFromReferenceIndex(referenceIndex, jsonFileName);
}
