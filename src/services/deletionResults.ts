import type { BatchDeleteResult } from '../types/deletion';

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
  if (failureCount > 0) return `${deletedCount} of ${result.requested} chats deleted; ${failureCount} failed`;
  return `${deletedCount} ${deletedCount === 1 ? 'chat' : 'chats'} deleted`;
}
