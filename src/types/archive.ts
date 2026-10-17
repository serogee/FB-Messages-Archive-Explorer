import type { ReadableDirectoryHandle } from './fileSystem';
import type { ChatListEntry } from './messenger';

export type ArchiveScope = Readonly<{
  rootHandle: ReadableDirectoryHandle;
  generation: number;
  signal: AbortSignal | undefined;
}>;

export type ArchiveListLane = 'inbox' | 'archived' | 'requests';

export type ArchiveLists = Readonly<Record<ArchiveListLane, readonly ChatListEntry[]>>;
