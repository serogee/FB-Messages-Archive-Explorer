import type { ReadableDirectoryHandle, ReadableFileHandle } from './fileSystem';

export interface MediaItem {
  uri?: string;
  filename?: string;
  path?: string;
  name?: string;
}

export interface Reaction {
  actor: string;
  reaction: string;
  timestamp?: number;
  timestamp_ms?: number;
  /** Enriched from reaction-notice messages */
  __timestamp?: number;
}

export interface MessengerMessage {
  sender_name: string;
  senderName?: string;
  timestamp_ms: number;
  timestamp?: number;
  content?: string;
  text?: string;
  photos?: MediaItem[];
  videos?: MediaItem[];
  audio?: MediaItem[];
  audio_files?: MediaItem[];
  gifs?: MediaItem[];
  files?: MediaItem[];
  media?: MediaItem[];
  reactions?: Reaction[];
  is_unsent?: boolean;
  is_geoblocked_for_viewer?: boolean;
  is_unsent_image_by_messenger_kid_parent?: boolean;
  /** Runtime cache for repeated reaction-notice checks */
  _isReactionNotice?: boolean;
}

export interface MessengerThread {
  participants: { name: string }[];
  messages: MessengerMessage[];
  title: string;
  thread_path: string;
  is_still_participant: boolean;
  magic_words?: string[];
  joinable_mode?: { mode: number; link: string };

  /** Avoids repeating asynchronous reaction timestamp enrichment. */
  _reactionsEnriched?: boolean;
  /** Cached height estimates for virtualized message chunks. */
  _chunkHeights?: number[];
}

export interface ChatListEntry {
  folderName: string;
  title: string;
  participants: string[];
  lastMessage?: string;
  lastTimestamp?: number;
  messageCount: number;
  /** Total folder size in bytes (computed lazily) */
  folderSize: number;
  dirHandle: ReadableDirectoryHandle;
  jsonFileCount: number;
  source: 'inbox' | 'archived' | 'requests' | 'e2ee';
  _messengerExport?: boolean;
  _jsonFileName?: string;
  _sizeIncludesMedia?: boolean;
}

export interface AttachmentCounts {
  photos: number;
  videos: number;
  audio: number;
  gifs: number;
  files: number;
  total: number;
}

export interface ResolvedAttachment {
  mediaPath: string;
  category: 'photos' | 'videos' | 'audio' | 'gifs' | 'files';
  messageIndex: number;
  timestamp: number;
  sender: string;
  mediaEntry: MediaEntry | null;
}

export type DateScale = 'month' | 'week' | 'day';

export interface DateBucket {
  key: string;
  index: number;
  timestamp: number;
  count: number;
  label: string;
}

export interface DateNavState {
  bucketsByScale: Record<DateScale, DateBucket[]>;
  scale: DateScale;
  activeKey: string | null;
  scrollTimer: ReturnType<typeof setTimeout> | null;
  sliderTimer: ReturnType<typeof setTimeout> | null;
  headerHover: boolean;
  autoCollapse: boolean;
  collapsed: boolean;
  syncing: boolean;
}

export interface SearchIndexEntry {
  text: string;
  normalized: string;
  sender: string;
  timestamp: number;
  idx: number;
  /** Only present in wide-search results */
  chatTitle?: string;
  chatFolderName?: string;
}

export interface SearchResult {
  item: SearchIndexEntry;
}

export interface MediaEntry {
  url?: string;
  handle?: ReadableFileHandle;
  type: string;
}

export interface MediaState {
  files: Record<string, string>;
  types: Record<string, string>;
  lookup: Map<string, MediaEntry>;
  pathIndex: Set<string>;
  basenameIndex: Set<string>;
}
