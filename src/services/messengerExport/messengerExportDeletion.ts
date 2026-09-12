import type { ChatListEntry } from '../../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../../types/fileSystem';
import { mapWithConcurrency } from '../concurrency';
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

export interface MessengerExportMediaDeletionTarget {
  identity: string;
  path: string;
}

export interface MessengerExportChatDeletionPlan {
  entry: ChatListEntry;
  jsonFileName: string;
  jsonBytes: number;
  mediaFiles: MessengerExportMediaDeletionTarget[];
}

export interface MessengerExportDeletionPlan {
  chats: MessengerExportChatDeletionPlan[];
  totalJsonBytes: number;
  totalMediaBytes: number;
  totalOperations: number;
}

export interface MessengerExportMediaRemovalFailure {
  path: string;
  error: unknown;
}

export interface MessengerExportMediaRemovalResult {
  completed: MessengerExportMediaDeletionTarget[];
  removed: MessengerExportMediaDeletionTarget[];
  failures: MessengerExportMediaRemovalFailure[];
}

export interface MessengerExportChatDeletionResult {
  entry: ChatListEntry;
  deleted: boolean;
  partial: boolean;
  completedMedia: MessengerExportMediaDeletionTarget[];
  error?: unknown;
}

export interface MessengerExportDeletionResult {
  plan: MessengerExportDeletionPlan;
  chats: MessengerExportChatDeletionResult[];
}

export interface MessengerExportDeletionProgress {
  stage: 'media' | 'chat';
  done: number;
  total: number;
  entry: ChatListEntry;
}

export class MessengerExportIndexIncompleteError extends Error {
  constructor() {
    super('Messenger media ownership could not be verified for every conversation.');
    this.name = 'MessengerExportIndexIncompleteError';
  }
}

export class MessengerExportDeletionPartialError extends Error {
  readonly partial: boolean;
  readonly mediaFailures: MessengerExportMediaRemovalFailure[];
  readonly cause?: unknown;

  constructor(
    message: string,
    partial: boolean,
    mediaFailures: MessengerExportMediaRemovalFailure[] = [],
    cause?: unknown
  ) {
    super(message);
    this.name = 'MessengerExportDeletionPartialError';
    this.partial = partial;
    this.mediaFailures = mediaFailures;
    this.cause = cause;
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

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function getJsonFileName(entry: ChatListEntry): string {
  if (!entry._jsonFileName) throw new Error(`Missing Messenger JSON filename for ${entry.title}`);
  return entry._jsonFileName;
}

export function buildMessengerExportDeletionPlan(
  entries: readonly ChatListEntry[],
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  mediaSizeIndex: MediaSizeIndex = new Map()
): MessengerExportDeletionPlan {
  const referenceIndex = getReferenceIndex(index);
  const chatIndex = isMessengerExportChatIndex(index) ? index : undefined;
  assertCompleteReferenceIndex(referenceIndex);

  const chats: MessengerExportChatDeletionPlan[] = [];
  const selectedPositions = new Map<string, number>();
  for (const entry of entries) {
    const jsonFileName = getJsonFileName(entry);
    if (selectedPositions.has(jsonFileName)) continue;
    selectedPositions.set(jsonFileName, chats.length);
    chats.push({
      entry,
      jsonFileName,
      jsonBytes: chatIndex?.jsonSizes.get(jsonFileName) || 0,
      mediaFiles: [],
    });
  }

  const referencedMedia = new Set<string>();
  for (const chat of chats) {
    for (const identity of referenceIndex.chatMedia.get(chat.jsonFileName) || []) {
      referencedMedia.add(identity);
    }
  }

  let totalMediaBytes = 0;
  for (const identity of referencedMedia) {
    const owners = referenceIndex.mediaOwners.get(identity);
    if (!owners || owners.size === 0) continue;
    let targetPosition = -1;
    let allOwnersSelected = true;
    for (const owner of owners) {
      const position = selectedPositions.get(owner);
      if (position == null) {
        allOwnersSelected = false;
        break;
      }
      targetPosition = Math.max(targetPosition, position);
    }
    if (!allOwnersSelected || targetPosition < 0) continue;

    chats[targetPosition].mediaFiles.push({
      identity,
      path: getMediaFilePath(referenceIndex, identity),
    });
    totalMediaBytes += getMediaSize(mediaSizeIndex, identity);
  }

  const totalJsonBytes = chats.reduce((sum, chat) => sum + chat.jsonBytes, 0);
  const mediaOperationCount = chats.reduce((sum, chat) => sum + chat.mediaFiles.length, 0);
  return {
    chats,
    totalJsonBytes,
    totalMediaBytes,
    totalOperations: chats.length + mediaOperationCount,
  };
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

async function removeMediaFile(
  mediaHandle: WritableDirectoryHandle,
  relativePath: string
): Promise<'removed' | 'missing'> {
  try {
    let directory = mediaHandle;
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..') || parts.length === 0) {
      throw new DOMException(`Invalid media path: ${relativePath}`, 'SecurityError');
    }
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part);
    }
    await directory.removeEntry(parts[parts.length - 1]);
    return 'removed';
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    // Already-missing media is an acceptable idempotent deletion result.
    return 'missing';
  }
}

export async function removeMediaFiles(
  mediaHandle: WritableDirectoryHandle | null,
  files: readonly MessengerExportMediaDeletionTarget[],
  concurrency = 4,
  onProgress?: (
    completed: number,
    total: number,
    file: MessengerExportMediaDeletionTarget
  ) => void
): Promise<MessengerExportMediaRemovalResult> {
  let completedCount = 0;
  const outcomes = await mapWithConcurrency(files, concurrency, async file => {
    try {
      const status = mediaHandle ? await removeMediaFile(mediaHandle, file.path) : 'missing';
      return { file, status } as const;
    } catch (error) {
      return { file, status: 'failed' as const, error };
    } finally {
      completedCount++;
      onProgress?.(completedCount, files.length, file);
    }
  });

  const result: MessengerExportMediaRemovalResult = {
    completed: [],
    removed: [],
    failures: [],
  };
  for (const outcome of outcomes) {
    if (outcome.status === 'failed') {
      result.failures.push({ path: outcome.file.path, error: outcome.error });
    } else {
      result.completed.push(outcome.file);
      if (outcome.status === 'removed') result.removed.push(outcome.file);
    }
  }
  return result;
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
  const plan = buildMessengerExportDeletionPlan([entry], index, resolvedMediaSizeIndex);
  const mediaFiles = plan.chats[0]?.mediaFiles || [];
  const exclusiveMediaFiles = mediaFiles.map(file => file.path);
  const mediaSize = mediaFiles.reduce(
    (sum, file) => sum + getMediaSize(resolvedMediaSizeIndex, file.identity),
    0
  );

  return {
    jsonSize,
    chatFileCount: 1,
    mediaSize,
    totalSize: jsonSize + mediaSize,
    exclusiveMediaFiles,
    exclusiveMediaCount: exclusiveMediaFiles.length,
    sharedMediaCount: chatMedia.size - exclusiveMediaFiles.length,
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

  const plan = buildMessengerExportDeletionPlan(entries, index, resolvedMediaSizeIndex);
  const mediaFiles = plan.chats.flatMap(chat => chat.mediaFiles);
  const exclusiveMediaFiles = mediaFiles.map(file => file.path);
  const mediaSize = mediaFiles.reduce(
    (sum, file) => sum + getMediaSize(resolvedMediaSizeIndex, file.identity),
    0
  );

  return {
    jsonSize,
    chatFileCount,
    mediaSize,
    totalSize: jsonSize + mediaSize,
    exclusiveMediaFiles,
    exclusiveMediaCount: exclusiveMediaFiles.length,
    sharedMediaCount: referencedMedia.size - exclusiveMediaFiles.length,
  };
}

function removeConversationFromIndex(
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  jsonFileName: string
): void {
  if (isMessengerExportChatIndex(index)) {
    removeConversationFromChatIndex(index, jsonFileName);
  } else {
    removeConversationFromReferenceIndex(index, jsonFileName);
  }
}

function canRemoveMediaForChat(
  referenceIndex: MessengerExportReferenceIndex,
  identity: string,
  jsonFileName: string
): boolean {
  const owners = referenceIndex.mediaOwners.get(identity);
  return !!owners && owners.size === 1 && owners.has(jsonFileName);
}

export async function executeMessengerExportDeletionPlan(
  rootHandle: WritableDirectoryHandle,
  plan: MessengerExportDeletionPlan,
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  onProgress?: (progress: MessengerExportDeletionProgress) => void
): Promise<MessengerExportDeletionResult> {
  const referenceIndex = getReferenceIndex(index);
  assertCompleteReferenceIndex(referenceIndex);
  let mediaHandle: WritableDirectoryHandle | null = null;
  let mediaDirectoryError: unknown;
  if (plan.chats.some(chat => chat.mediaFiles.length > 0)) {
    try {
      mediaHandle = await rootHandle.getDirectoryHandle('media');
    } catch (error) {
      if (!isNotFoundError(error)) mediaDirectoryError = error;
    }
  }

  let completedOperations = 0;
  const results: MessengerExportChatDeletionResult[] = [];
  const reportProgress = (
    stage: MessengerExportDeletionProgress['stage'],
    entry: ChatListEntry,
    count = 1
  ) => {
    completedOperations += count;
    onProgress?.({
      stage,
      done: completedOperations,
      total: plan.totalOperations,
      entry,
    });
  };

  for (const chat of plan.chats) {
    const mediaToDelete = chat.mediaFiles.filter(file =>
      canRemoveMediaForChat(referenceIndex, file.identity, chat.jsonFileName)
    );
    const skippedMediaCount = chat.mediaFiles.length - mediaToDelete.length;
    if (skippedMediaCount > 0) reportProgress('media', chat.entry, skippedMediaCount);

    let mediaResult: MessengerExportMediaRemovalResult;
    if (mediaDirectoryError && mediaToDelete.length > 0) {
      mediaResult = {
        completed: [],
        removed: [],
        failures: mediaToDelete.map(file => ({ path: file.path, error: mediaDirectoryError })),
      };
      reportProgress('media', chat.entry, mediaToDelete.length);
    } else {
      mediaResult = await removeMediaFiles(mediaHandle, mediaToDelete, 4, () => {
        reportProgress('media', chat.entry);
      });
    }

    if (mediaResult.failures.length > 0) {
      const partial = mediaResult.removed.length > 0;
      results.push({
        entry: chat.entry,
        deleted: false,
        partial,
        completedMedia: mediaResult.completed,
        error: new MessengerExportDeletionPartialError(
          'Some Messenger media files could not be removed. The chat was kept for retry.',
          partial,
          mediaResult.failures
        ),
      });
      reportProgress('chat', chat.entry);
      continue;
    }

    try {
      await rootHandle.removeEntry(chat.jsonFileName);
    } catch (error) {
      if (!isNotFoundError(error)) {
        const partial = mediaToDelete.length > 0;
        results.push({
          entry: chat.entry,
          deleted: false,
          partial,
          completedMedia: mediaResult.completed,
          error: new MessengerExportDeletionPartialError(
            'Messenger media was removed, but the chat JSON could not be removed.',
            partial,
            [],
            error
          ),
        });
        reportProgress('chat', chat.entry);
        continue;
      }
    }

    removeConversationFromIndex(index, chat.jsonFileName);
    results.push({
      entry: chat.entry,
      deleted: true,
      partial: false,
      completedMedia: mediaResult.completed,
    });
    reportProgress('chat', chat.entry);
  }

  return { plan, chats: results };
}

export async function deleteMessengerExportChat(
  rootHandle: WritableDirectoryHandle,
  entry: ChatListEntry,
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  onProgress?: (progress: MessengerExportDeletionProgress) => void
): Promise<void> {
  const plan = buildMessengerExportDeletionPlan([entry], index);
  const result = await executeMessengerExportDeletionPlan(rootHandle, plan, index, onProgress);
  const chatResult = result.chats[0];
  if (!chatResult?.deleted) throw chatResult?.error || new Error('Messenger chat deletion failed.');
}

export async function deleteMessengerExportJsonOnly(
  rootHandle: WritableDirectoryHandle,
  entries: readonly ChatListEntry[],
  index?: MessengerExportChatIndex | MessengerExportReferenceIndex,
  onProgress?: (completed: number, total: number, entry: ChatListEntry) => void
): Promise<MessengerExportChatDeletionResult[]> {
  const results: MessengerExportChatDeletionResult[] = [];
  for (const entry of entries) {
    const jsonFileName = getJsonFileName(entry);
    try {
      await rootHandle.removeEntry(jsonFileName);
      if (index) removeConversationFromIndex(index, jsonFileName);
      results.push({ entry, deleted: true, partial: false, completedMedia: [] });
    } catch (error) {
      if (isNotFoundError(error)) {
        if (index) removeConversationFromIndex(index, jsonFileName);
        results.push({ entry, deleted: true, partial: false, completedMedia: [] });
      } else {
        results.push({ entry, deleted: false, partial: false, completedMedia: [], error });
      }
    }
    onProgress?.(results.length, entries.length, entry);
  }
  return results;
}
