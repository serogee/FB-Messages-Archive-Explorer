import { describe, expect, it } from 'vitest';
import { computeFacebookDeleteInfo } from '../src/hooks/useArchive';
import type { ReadableDirectoryHandle } from '../src/types/fileSystem';
import type { ChatListEntry } from '../src/types/messenger';

describe('deletion preparation concurrency', () => {
  it('limits Facebook folder scans to four active files', async () => {
    let active = 0;
    let peak = 0;
    const entries = Array.from({ length: 10 }, (_, index) => {
      const fileHandle = {
        kind: 'file' as const,
        name: 'message_1.json',
        async getFile() {
          active++;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 2));
          active--;
          return new File([String(index)], 'message_1.json');
        },
      };
      const dirHandle = {
        kind: 'directory' as const,
        name: `chat-${index}`,
        async *entries() {
          yield ['message_1.json', fileHandle] as const;
        },
      } as ReadableDirectoryHandle;
      return {
        folderName: `chat-${index}`,
        title: `Chat ${index}`,
        participants: [],
        messageCount: 0,
        folderSize: 0,
        dirHandle,
        jsonFileCount: 1,
        source: 'inbox' as const,
      };
    }) satisfies ChatListEntry[];

    const info = await computeFacebookDeleteInfo(entries);

    expect(peak).toBe(4);
    expect(info.chatFileCount).toBe(10);
  });
});
