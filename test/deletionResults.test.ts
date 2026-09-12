import { describe, expect, it } from 'vitest';
import { formatBatchDeleteResult } from '../src/services/deletionResults';
import type { BatchDeleteResult } from '../src/types/deletion';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function entry(name: string): ChatListEntry {
  return {
    folderName: name,
    title: name,
    participants: [],
    messageCount: 0,
    folderSize: 0,
    dirHandle: createMockDirectoryHandle(name, {}),
    jsonFileCount: 1,
    source: 'inbox',
  };
}

describe('deletion result messages', () => {
  it('reports actual successful and failed chat counts', () => {
    const result: BatchDeleteResult = {
      requested: 12,
      deleted: Array.from({ length: 9 }, (_, index) => entry(`deleted-${index}`)),
      failed: Array.from({ length: 3 }, (_, index) => ({
        entry: entry(`failed-${index}`),
        error: new Error('failed'),
        partial: false,
      })),
    };
    expect(formatBatchDeleteResult(result, false)).toBe('9 of 12 chats deleted; 3 failed');
  });

  it('states that JSON-only deletion retains media', () => {
    const result: BatchDeleteResult = {
      requested: 1,
      deleted: [entry('alice')],
      failed: [],
    };
    expect(formatBatchDeleteResult(result, true)).toBe('Chat JSON deleted; media retained');
  });
});
