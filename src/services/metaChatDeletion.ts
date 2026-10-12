import type { ChatListEntry } from '../types/messenger';
import { getMetaChatId } from './metaAttachmentPaths';
import type { MetaAttachmentReferenceIndex } from './metaAttachmentReferences';
import type { ChatDeletionBlockDetails, ChatDeletionDependency } from '../types/deletion';

export interface MetaChatDeletionBlock {
  entry: ChatListEntry;
  reason: string;
  kind: ChatDeletionBlockDetails['kind'];
  dependencies: ChatDeletionDependency[];
}

export class MetaChatDeletionBlockedError extends Error {
  readonly block: MetaChatDeletionBlock;
  constructor(block: MetaChatDeletionBlock) {
    super(block.reason);
    this.block = block;
    this.name = 'MetaChatDeletionBlockedError';
  }
}

function getFolderDependents(index: MetaAttachmentReferenceIndex, chatId: string): Set<string> {
  const dependents = new Set<string>();
  for (const identity of index.folderReferences.get(chatId.toLowerCase()) || []) {
    for (const owner of index.mediaOwners.get(identity) || []) if (owner.toLowerCase() !== chatId.toLowerCase()) dependents.add(owner);
  }
  return dependents;
}

export function getMetaFolderDeletionBlock(
  entry: ChatListEntry,
  index: MetaAttachmentReferenceIndex,
  deletingChatIds: ReadonlySet<string>,
): MetaChatDeletionBlock | null {
  if (!index.complete) return {
    entry, reason: `Cannot delete ${entry.title}: attachment ownership could not be verified for every conversation. The folder will be kept to protect shared files.`,
    kind: 'unverified', dependencies: [],
  };
  const chatId = getMetaChatId(entry);
  const retained = [...getFolderDependents(index, chatId)].filter(owner => !deletingChatIds.has(owner));
  if (retained.length === 0) return null;
  const titles = retained.map(owner => index.chatTitles.get(owner) || owner);
  return {
    entry,
    kind: 'shared-files',
    dependencies: retained.map(chatId => ({ chatId, title: index.chatTitles.get(chatId) || chatId })),
    reason: `Cannot delete ${entry.title}: files in this folder are still used by ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? ` and ${titles.length - 3} other chats` : ''}. Select those chats too, or keep this chat.`,
  };
}

/** Delete referencing chats first so a failed deletion can still protect its source folder. */
export function buildMetaChatDeletionPlan(
  entries: readonly ChatListEntry[],
  index: MetaAttachmentReferenceIndex,
): { chats: ChatListEntry[]; blocked: MetaChatDeletionBlock[] } {
  const selected = new Map(entries.map(entry => [getMetaChatId(entry), entry]));
  const eligible = new Set(selected.keys());
  const blocked: MetaChatDeletionBlock[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const chatId of eligible) {
      const block = getMetaFolderDeletionBlock(selected.get(chatId)!, index, eligible);
      if (block) { blocked.push(block); eligible.delete(chatId); changed = true; }
    }
  }
  const dependencies = new Map<string, Set<string>>();
  const sourceFolders = new Map<string, Set<string>>();
  for (const chatId of eligible) {
    const dependents = getFolderDependents(index, chatId);
    dependencies.set(chatId, dependents);
    for (const owner of dependents) {
      let folders = sourceFolders.get(owner);
      if (!folders) { folders = new Set(); sourceFolders.set(owner, folders); }
      folders.add(chatId);
    }
  }
  const ready = [...eligible].filter(chatId => dependencies.get(chatId)!.size === 0);
  const chats: ChatListEntry[] = [];
  for (let position = 0; position < ready.length; position++) {
    const chatId = ready[position];
    chats.push(selected.get(chatId)!);
    eligible.delete(chatId);
    for (const folder of sourceFolders.get(chatId) || []) {
      dependencies.get(folder)!.delete(chatId);
      if (dependencies.get(folder)!.size === 0) ready.push(folder);
    }
  }
  for (const chatId of eligible) blocked.push({
    entry: selected.get(chatId)!,
    kind: 'cycle',
    dependencies: [...getFolderDependents(index, chatId)].map(owner => ({ chatId: owner, title: index.chatTitles.get(owner) || owner })),
    reason: `Cannot delete ${selected.get(chatId)!.title}: these chats depend on files in each other's folders. Folder deletion was stopped to protect shared files.`,
  });
  return { chats, blocked };
}
