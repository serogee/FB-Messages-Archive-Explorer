import type { CalculationProgressStore } from './calculationProgress';
/** Physical attachment identities are independent of their display category. */
export interface AttachmentReferenceIndex {
  mediaOwners: Map<string, Set<string>>;
  chatMedia: Map<string, Set<string>>;
  mediaFiles: Map<string, string>;
  complete: boolean;
}

export interface AttachmentReferenceScan {
  status: 'checking' | 'complete' | 'incomplete' | 'failed';
  progress?: CalculationProgressStore;
}

export function createAttachmentReferenceIndex(): AttachmentReferenceIndex {
  return { mediaOwners: new Map(), chatMedia: new Map(), mediaFiles: new Map(), complete: true };
}

export function addAttachmentOwner(index: AttachmentReferenceIndex, identity: string, chatId: string): void {
  let owners = index.mediaOwners.get(identity);
  if (!owners) {
    owners = new Set();
    index.mediaOwners.set(identity, owners);
  }
  owners.add(chatId);
}

export function removeChatAttachmentReferences(index: AttachmentReferenceIndex, chatId: string): void {
  for (const identity of index.chatMedia.get(chatId) || []) {
    const owners = index.mediaOwners.get(identity);
    owners?.delete(chatId);
    if (owners?.size === 0) {
      index.mediaOwners.delete(identity);
      index.mediaFiles.delete(identity);
    }
  }
  index.chatMedia.delete(chatId);
}

/** An incomplete scan can never authorize shared-file deletion. */
export function getDeletableAttachmentIdentities(
  index: AttachmentReferenceIndex,
  selectedChatIds: ReadonlySet<string>,
): string[] {
  if (!index.complete) return [];
  const candidates = new Set<string>();
  for (const chatId of selectedChatIds) {
    for (const identity of index.chatMedia.get(chatId) || []) candidates.add(identity);
  }
  return [...candidates].filter(identity => {
    const owners = index.mediaOwners.get(identity);
    return !!owners?.size && [...owners].every(owner => selectedChatIds.has(owner));
  });
}
