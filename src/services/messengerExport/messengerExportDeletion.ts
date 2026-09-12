import type { ChatListEntry } from '../../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../../types/fileSystem';
import { classifyMessengerExportJson } from './messengerExportParser';
import { buildMessengerExportMediaSizeIndex, type MediaSizeIndex } from './messengerExportSize';
import {
  addConversationToChatIndex,
  createMessengerExportChatIndex,
  getMessengerMediaBasename,
  isMessengerExportChatIndex,
  markMessengerExportIndexIncomplete,
  removeConversationFromChatIndex,
  removeConversationFromReferenceIndex,
  type MessengerExportChatIndex,
  type MessengerExportReferenceIndex,
} from './messengerExportIndex';

export type { MessengerExportReferenceIndex } from './messengerExportIndex';

export interface MessengerExportDeletionInfo {
  jsonSize: number;
  chatFileCount: number;
  mediaSize: number;
  totalSize: number;
  exclusiveMediaFiles: string[];
  exclusiveMediaCount: number;
  sharedMediaCount: number;
}

export class MessengerExportIndexIncompleteError extends Error {
  constructor() {
    super('Messenger media ownership could not be verified for every conversation.');
    this.name = 'MessengerExportIndexIncompleteError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function getReferenceIndex(
  index: MessengerExportChatIndex | MessengerExportReferenceIndex
): MessengerExportReferenceIndex {
  return isMessengerExportChatIndex(index) ? index.referenceIndex : index;
}

function assertCompleteReferenceIndex(index: MessengerExportReferenceIndex): void {
  if (!index.complete) throw new MessengerExportIndexIncompleteError();
}

function getMediaFilePath(index: MessengerExportReferenceIndex, identity: string): string {
  return index.mediaFiles.get(identity) || identity.replace(/^media\//i, '');
}

function getMediaSize(index: MediaSizeIndex, identity: string): number {
  return index.get(identity) || index.get(getMessengerMediaBasename(identity)) || 0;
}

export async function buildMessengerExportReferenceIndex(
  rootHandle: ReadableDirectoryHandle,
  signal?: AbortSignal
): Promise<MessengerExportReferenceIndex> {
  const chatIndex = createMessengerExportChatIndex();
  let lastYield = performance.now();

  for await (const [name, entry] of rootHandle.entries()) {
    throwIfAborted(signal);
    if (entry.kind !== 'file' || !/\.json$/i.test(name)) continue;

    try {
      const file = await entry.getFile();
      throwIfAborted(signal);
      const classification = classifyMessengerExportJson(await file.text());
      throwIfAborted(signal);
      if (classification.kind === 'conversation') {
        addConversationToChatIndex(chatIndex, name, file.size, classification.thread);
      } else if (classification.kind === 'malformed-conversation') {
        markMessengerExportIndexIncomplete(chatIndex, {
          jsonFileName: name,
          reason: 'malformed-conversation',
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      markMessengerExportIndexIncomplete(chatIndex, { jsonFileName: name, reason: 'unreadable' });
    }

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      throwIfAborted(signal);
      lastYield = performance.now();
    }
  }

  return chatIndex.referenceIndex;
}

async function removeMediaFile(rootHandle: WritableDirectoryHandle, relativePath: string): Promise<void> {
  try {
    let directory = await rootHandle.getDirectoryHandle('media');
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..') || parts.length === 0) {
      throw new DOMException(`Invalid media path: ${relativePath}`, 'SecurityError');
    }
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part);
    }
    await directory.removeEntry(parts[parts.length - 1]);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    // Already-missing media is an acceptable idempotent deletion result.
  }
}

async function getJsonSize(
  rootHandle: ReadableDirectoryHandle,
  jsonFileName: string,
  chatIndex?: MessengerExportChatIndex
): Promise<number> {
  const indexedSize = chatIndex?.jsonSizes.get(jsonFileName);
  if (indexedSize != null) return indexedSize;
  const fileHandle = await rootHandle.getFileHandle(jsonFileName);
  const file = await fileHandle.getFile();
  return file.size;
}

export async function getMessengerExportDeletionInfo(
  rootHandle: ReadableDirectoryHandle,
  entry: ChatListEntry,
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  signal?: AbortSignal,
  mediaSizeIndex?: MediaSizeIndex
): Promise<MessengerExportDeletionInfo> {
  const jsonFileName = entry._jsonFileName!;
  const referenceIndex = getReferenceIndex(index);
  const chatIndex = isMessengerExportChatIndex(index) ? index : undefined;
  assertCompleteReferenceIndex(referenceIndex);
  throwIfAborted(signal);
  const resolvedMediaSizeIndex = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  throwIfAborted(signal);
  const jsonSize = await getJsonSize(rootHandle, jsonFileName, chatIndex);
  throwIfAborted(signal);
  const chatMedia = referenceIndex.chatMedia.get(jsonFileName) || new Set<string>();
  const exclusiveMediaFiles: string[] = [];
  let sharedMediaCount = 0;
  let mediaSize = 0;

  for (const identity of chatMedia) {
    throwIfAborted(signal);
    const owners = referenceIndex.mediaOwners.get(identity);
    if (!owners || owners.size <= 1) {
      exclusiveMediaFiles.push(getMediaFilePath(referenceIndex, identity));
      mediaSize += getMediaSize(resolvedMediaSizeIndex, identity);
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
  rootHandle: ReadableDirectoryHandle,
  entries: ChatListEntry[],
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  signal?: AbortSignal,
  mediaSizeIndex?: MediaSizeIndex
): Promise<MessengerExportDeletionInfo> {
  const referenceIndex = getReferenceIndex(index);
  const chatIndex = isMessengerExportChatIndex(index) ? index : undefined;
  assertCompleteReferenceIndex(referenceIndex);
  throwIfAborted(signal);
  const resolvedMediaSizeIndex = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  throwIfAborted(signal);
  const selectedJson = new Set(entries.map(entry => entry._jsonFileName).filter(Boolean) as string[]);
  const referencedMedia = new Set<string>();
  let jsonSize = 0;
  let chatFileCount = 0;

  for (const entry of entries) {
    throwIfAborted(signal);
    const jsonFileName = entry._jsonFileName!;
    jsonSize += await getJsonSize(rootHandle, jsonFileName, chatIndex);
    chatFileCount++;
    const chatMedia = referenceIndex.chatMedia.get(jsonFileName);
    if (!chatMedia) continue;
    for (const identity of chatMedia) referencedMedia.add(identity);
  }

  const exclusiveMediaFiles: string[] = [];
  let sharedMediaCount = 0;
  let mediaSize = 0;

  for (const identity of referencedMedia) {
    throwIfAborted(signal);
    const owners = referenceIndex.mediaOwners.get(identity);
    const shouldDelete = owners ? Array.from(owners).every(owner => selectedJson.has(owner)) : true;
    if (shouldDelete) {
      exclusiveMediaFiles.push(getMediaFilePath(referenceIndex, identity));
      mediaSize += getMediaSize(resolvedMediaSizeIndex, identity);
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
  rootHandle: WritableDirectoryHandle,
  entry: ChatListEntry,
  index: MessengerExportChatIndex | MessengerExportReferenceIndex
): Promise<void> {
  const jsonFileName = entry._jsonFileName!;
  const referenceIndex = getReferenceIndex(index);
  assertCompleteReferenceIndex(referenceIndex);
  const chatMedia = referenceIndex.chatMedia.get(jsonFileName) || new Set<string>();
  const mediaToDelete: string[] = [];

  for (const identity of chatMedia) {
    const owners = referenceIndex.mediaOwners.get(identity);
    if (!owners || owners.size <= 1) {
      mediaToDelete.push(getMediaFilePath(referenceIndex, identity));
    }
  }

  await rootHandle.removeEntry(jsonFileName);

  for (const relativePath of mediaToDelete) {
    await removeMediaFile(rootHandle, relativePath);
  }

  if (isMessengerExportChatIndex(index)) {
    removeConversationFromChatIndex(index, jsonFileName);
  } else {
    removeConversationFromReferenceIndex(referenceIndex, jsonFileName);
  }
}
