import type { ChatListEntry } from '../types/messenger';
import { getBookmarkChatId } from './bookmarks';

export type ChatSortOption =
  | 'recent'
  | 'oldest'
  | 'most_msgs'
  | 'least_msgs'
  | 'biggest_size'
  | 'smallest_size';

function compareUnpinnedChats(a: ChatListEntry, b: ChatListEntry, sortBy: ChatSortOption): number {
  switch (sortBy) {
    case 'oldest':
      if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
      if (a.lastTimestamp == null) return 1;
      if (b.lastTimestamp == null) return -1;
      return a.lastTimestamp - b.lastTimestamp;
    case 'most_msgs':
      return (b.messageCount || b.jsonFileCount) - (a.messageCount || a.jsonFileCount);
    case 'least_msgs':
      return (a.messageCount || a.jsonFileCount) - (b.messageCount || b.jsonFileCount);
    case 'biggest_size':
      return b.folderSize - a.folderSize;
    case 'smallest_size':
      return a.folderSize - b.folderSize;
    case 'recent':
    default:
      if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
      if (a.lastTimestamp == null) return 1;
      if (b.lastTimestamp == null) return -1;
      return b.lastTimestamp - a.lastTimestamp;
  }
}

export function filterAndOrderChats(
  list: ChatListEntry[],
  filter: string,
  sortBy: ChatSortOption,
  pinnedChatIds: readonly string[] = []
): ChatListEntry[] {
  const normalizedFilter = filter.trim().toLowerCase();
  const seen = new Set<string>();
  const filtered = list.filter(entry => {
    const id = getBookmarkChatId(entry);
    if (seen.has(id)) return false;
    seen.add(id);
    return !normalizedFilter
      || entry.title.toLowerCase().includes(normalizedFilter)
      || entry.folderName.toLowerCase().includes(normalizedFilter);
  });
  const positions = new Map(pinnedChatIds.map((id, index) => [id, index]));

  return filtered.sort((a, b) => {
    const aPosition = positions.get(getBookmarkChatId(a));
    const bPosition = positions.get(getBookmarkChatId(b));
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
    if (aPosition !== undefined) return -1;
    if (bPosition !== undefined) return 1;
    return compareUnpinnedChats(a, b, sortBy);
  });
}
