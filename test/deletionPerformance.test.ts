import { describe, expect, it } from 'vitest';
import { computeFacebookDeleteInfo } from '../src/hooks/useArchive';
import type { ReadableDirectoryHandle } from '../src/types/fileSystem';
import type { ChatListEntry } from '../src/types/messenger';

describe('deletion preparation concurrency', () => {
  it('limits Facebook folder scans to four active files', async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    const releases = Array.from({ length: 10 }, () => {
      let release = () => {};
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });
    const entries = Array.from({ length: 10 }, (_, index) => {
      const fileHandle = {
        kind: 'file' as const,
        name: 'message_1.json',
        async getFile() {
          started++;
          active++;
          peak = Math.max(peak, active);
          await releases[index].promise;
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

    const work = computeFacebookDeleteInfo(entries);
    for (let turn = 0; turn < 10 && started < 4; turn++) await Promise.resolve();

    expect(started).toBe(4);
    expect(active).toBe(4);
    releases[0].release();
    for (let turn = 0; turn < 10 && started < 5; turn++) await Promise.resolve();
    expect(started).toBe(5);

    releases.forEach(gate => gate.release());
    const info = await work;

    expect(peak).toBe(4);
    expect(started).toBe(10);
    expect(info.chatFileCount).toBe(10);
  });
});
