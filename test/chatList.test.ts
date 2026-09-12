import { describe, expect, it } from 'vitest';
import { filterAndOrderChats, type ChatSortOption } from '../src/services/chatList';
import { getBookmarkChatId } from '../src/services/bookmarks';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function entry(
  folderName: string,
  title: string,
  source: ChatListEntry['source'],
  lastTimestamp: number | undefined,
  messageCount: number,
  folderSize: number
): ChatListEntry {
  return {
    folderName,
    title,
    source,
    lastTimestamp,
    messageCount,
    folderSize,
    participants: [title],
    dirHandle: createMockDirectoryHandle(folderName, {}),
    jsonFileCount: 1,
  };
}

const alice = entry('alice', 'Alice', 'inbox', 100, 5, 500);
const bob = entry('bob', 'Bob', 'archived', 300, 1, 100);
const carol = entry('carol', 'Carol', 'requests', 200, 10, 300);
const noDate = entry('unknown', 'Unknown', 'inbox', undefined, 2, 200);

describe('chat-list ordering', () => {
  it('keeps persisted pin order at the very top for every selected sort', () => {
    const list = [alice, bob, carol, noDate];
    const pins = [getBookmarkChatId(carol), getBookmarkChatId(alice)];
    const sorts: ChatSortOption[] = [
      'recent',
      'oldest',
      'most_msgs',
      'least_msgs',
      'biggest_size',
      'smallest_size',
    ];

    for (const sort of sorts) {
      expect(filterAndOrderChats(list, '', sort, pins).slice(0, 2)).toEqual([carol, alice]);
    }
  });

  it('applies the selected sort only to unpinned chats and keeps null timestamps last', () => {
    const pins = [getBookmarkChatId(alice)];
    expect(filterAndOrderChats([alice, bob, carol, noDate], '', 'recent', pins))
      .toEqual([alice, bob, carol, noDate]);
    expect(filterAndOrderChats([alice, bob, carol, noDate], '', 'oldest', pins))
      .toEqual([alice, carol, bob, noDate]);
    expect(filterAndOrderChats([alice, bob, carol], '', 'most_msgs', pins))
      .toEqual([alice, carol, bob]);
  });

  it('filters without changing the relative order of matching pins', () => {
    const pins = [getBookmarkChatId(carol), getBookmarkChatId(alice)];
    expect(filterAndOrderChats([alice, bob, carol], 'a', 'recent', pins)).toEqual([carol, alice]);
    expect(filterAndOrderChats([alice, bob, carol], 'bob', 'recent', pins)).toEqual([bob]);
  });

  it('does not mutate its input and ignores stale pin IDs', () => {
    const list = [alice, bob, carol];
    const original = [...list];
    expect(filterAndOrderChats(list, '', 'recent', ['facebook:inbox:missing']))
      .toEqual([bob, carol, alice]);
    expect(list).toEqual(original);
  });

  it('deduplicates promoted source chats and keeps same-named source IDs independent', () => {
    const inboxSam = entry('sam', 'Sam Inbox', 'inbox', 100, 1, 1);
    const archivedSam = entry('sam', 'Sam Archived', 'archived', 200, 1, 1);
    const pins = [getBookmarkChatId(archivedSam)];
    const mainWithPromotedPin = [archivedSam, inboxSam, archivedSam];

    expect(filterAndOrderChats(mainWithPromotedPin, '', 'recent', pins))
      .toEqual([archivedSam, inboxSam]);
    expect(getBookmarkChatId(inboxSam)).not.toBe(getBookmarkChatId(archivedSam));
  });
});
