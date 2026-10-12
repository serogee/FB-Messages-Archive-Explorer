import type { BatchDeleteResult } from '../types/deletion';
import type { ChatListEntry } from '../types/messenger';

export function getDeleteRetryEntries(result: BatchDeleteResult): ChatListEntry[] {
  return result.failed.map(failure => failure.entry);
}

export function getBookmarkCleanupEntries(result: BatchDeleteResult): ChatListEntry[] {
  return result.deleted;
}

export function formatBatchDeleteResult(result: BatchDeleteResult, jsonOnly: boolean): string {
  const deletedCount = result.deleted.length;
  const failureCount = result.failed.length;
  if (jsonOnly) {
    return failureCount > 0
      ? `${deletedCount} of ${result.requested} chat JSON files deleted; media retained; ${failureCount} failed`
      : deletedCount === 1
        ? 'Chat JSON deleted; media retained'
        : `${deletedCount} chat JSON files deleted; media retained`;
  }
  const cleanupWarning = result.sharedMediaCleanupFailures?.length
    ? `; ${result.sharedMediaCleanupFailures.length} shared stickers could not be removed` : '';
  const protectedCount = result.failed.filter(failure => failure.blocked).length;
  if (protectedCount > 0) {
    const actualFailures = failureCount - protectedCount;
    return `${deletedCount} of ${result.requested} chats deleted; ${protectedCount} protected${actualFailures ? `; ${actualFailures} failed` : ''}${cleanupWarning}`;
  }
  if (failureCount > 0) return `${deletedCount} of ${result.requested} chats deleted; ${failureCount} failed${cleanupWarning}`;
  return `${deletedCount} ${deletedCount === 1 ? 'chat' : 'chats'} deleted${cleanupWarning}`;
}
