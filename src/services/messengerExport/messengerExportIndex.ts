import type { MessengerThread } from '../../types/messenger';
import { getMessageAttachmentReferences } from '../media';
import { addAttachmentOwner, createAttachmentReferenceIndex, removeChatAttachmentReferences, type AttachmentReferenceIndex } from '../attachmentReferenceIndex';

export type MessengerExportIndexWarningReason =
  | 'unreadable'
  | 'malformed-conversation'
  | 'ambiguous-media-path';

export interface MessengerExportIndexWarning {
  jsonFileName: string;
  reason: MessengerExportIndexWarningReason;
}

export interface MessengerExportReferenceIndex extends AttachmentReferenceIndex {
  warnings: MessengerExportIndexWarning[];
}

export interface MessengerExportSizeMetadata {
  chatMediaPaths: Map<string, Set<string>>;
  jsonSizes: Map<string, number>;
}

export interface MessengerExportChatIndex extends MessengerExportSizeMetadata {
  referenceIndex: MessengerExportReferenceIndex;
  complete: boolean;
  warnings: MessengerExportIndexWarning[];
}

function cleanMediaPath(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .split(/[?#]/, 1)[0]
    .replace(/^\.?\/+/, '')
    .replace(/\/{2,}/g, '/');
}

export function getMessengerMediaFilePath(path: string): string | null {
  const cleanPath = cleanMediaPath(path);
  const relativePath = /^media\//i.test(cleanPath) ? cleanPath.slice('media/'.length) : cleanPath;
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return null;
  const fileName = parts[parts.length - 1];
  if (!/\.[a-z0-9]{2,5}$/i.test(fileName)) return null;
  return parts.join('/');
}

export function getMessengerMediaIdentity(path: string): string | null {
  const relativePath = getMessengerMediaFilePath(path);
  return relativePath ? `media/${relativePath}`.toLowerCase() : null;
}

export function getMessengerMediaBasename(path: string): string {
  return getMessengerMediaFilePath(path)?.split('/').pop()?.toLowerCase() || '';
}

export function createMessengerExportReferenceIndex(): MessengerExportReferenceIndex {
  return {
    ...createAttachmentReferenceIndex(),
    warnings: [],
  };
}

export function createMessengerExportSizeMetadata(): MessengerExportSizeMetadata {
  return { chatMediaPaths: new Map(), jsonSizes: new Map() };
}

export function createMessengerExportChatIndex(metadata = createMessengerExportSizeMetadata()): MessengerExportChatIndex {
  const referenceIndex = createMessengerExportReferenceIndex();
  return {
    referenceIndex,
    ...metadata,
    complete: true,
    warnings: referenceIndex.warnings,
  };
}

export function markMessengerExportIndexIncomplete(
  index: MessengerExportChatIndex | MessengerExportReferenceIndex,
  warning: MessengerExportIndexWarning
): void {
  const referenceIndex = 'referenceIndex' in index ? index.referenceIndex : index;
  referenceIndex.complete = false;
  if (!referenceIndex.warnings.some(existing =>
    existing.jsonFileName === warning.jsonFileName && existing.reason === warning.reason
  )) {
    referenceIndex.warnings.push(warning);
  }
  if ('referenceIndex' in index) {
    index.complete = false;
  }
}

export function addConversationToChatIndex(
  index: MessengerExportChatIndex,
  jsonFileName: string,
  fileSize: number,
  thread: MessengerThread
): void {
  removeConversationFromChatIndex(index, jsonFileName);
  addConversationToSizeMetadata(index, jsonFileName, fileSize, thread, (identity, filePath) => {
    const existingPath = index.referenceIndex.mediaFiles.get(identity);
    if (existingPath && existingPath !== filePath) {
      markMessengerExportIndexIncomplete(index, { jsonFileName, reason: 'ambiguous-media-path' });
    } else if (!existingPath) index.referenceIndex.mediaFiles.set(identity, filePath);
  });
  const mediaIdentities = index.chatMediaPaths.get(jsonFileName)!;
  index.referenceIndex.chatMedia.set(jsonFileName, mediaIdentities);
  for (const identity of mediaIdentities) addAttachmentOwner(index.referenceIndex, identity, jsonFileName);
}

/** Size references are independent of cross-chat owners and safety warnings. */
export function addConversationToSizeMetadata(
  metadata: MessengerExportSizeMetadata, jsonFileName: string, fileSize: number, thread: MessengerThread,
  onReference?: (identity: string, filePath: string) => void,
): void {
  const identities = new Set<string>();
  for (const message of thread.messages || []) {
    for (const { path, shared } of getMessageAttachmentReferences(message)) {
      if (shared) continue;
      const identity = getMessengerMediaIdentity(path);
      const filePath = getMessengerMediaFilePath(path);
      if (!identity || !filePath) continue;
      identities.add(identity);
      onReference?.(identity, filePath);
    }
  }

  metadata.chatMediaPaths.set(jsonFileName, identities);
  metadata.jsonSizes.set(jsonFileName, fileSize);
}

export function removeConversationFromReferenceIndex(
  index: MessengerExportReferenceIndex,
  jsonFileName: string
): void {
  removeChatAttachmentReferences(index, jsonFileName);
}

export function removeConversationFromChatIndex(
  index: MessengerExportChatIndex,
  jsonFileName: string
): void {
  removeConversationFromReferenceIndex(index.referenceIndex, jsonFileName);
  index.chatMediaPaths.delete(jsonFileName);
  index.jsonSizes.delete(jsonFileName);
}

export function buildReferenceIndexFromChatMedia(
  chatMedia: Map<string, Set<string>>
): MessengerExportReferenceIndex {
  const index = createMessengerExportReferenceIndex();
  for (const [jsonFileName, paths] of chatMedia) {
    const identities = new Set<string>();
    for (const path of paths) {
      const identity = getMessengerMediaIdentity(path);
      const filePath = getMessengerMediaFilePath(path);
      if (!identity || !filePath) continue;
      identities.add(identity);
      const existingPath = index.mediaFiles.get(identity);
      if (existingPath && existingPath !== filePath) {
        markMessengerExportIndexIncomplete(index, {
          jsonFileName,
          reason: 'ambiguous-media-path',
        });
      } else if (!existingPath) {
        index.mediaFiles.set(identity, filePath);
      }
      addAttachmentOwner(index, identity, jsonFileName);
    }
    index.chatMedia.set(jsonFileName, identities);
  }
  return index;
}

export function isMessengerExportChatIndex(
  index: MessengerExportChatIndex | MessengerExportReferenceIndex
): index is MessengerExportChatIndex {
  return 'referenceIndex' in index;
}
