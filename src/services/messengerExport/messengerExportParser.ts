import type { MediaItem, MessengerMessage, MessengerThread, Reaction, SharedLink } from '../../types/messenger';
import { fixEncoding, getMessageTimestamp, normalizeMessengerData, sanitizeFileName } from '../parser';

interface RawMessengerExportMessage {
  senderName?: string;
  sender_name?: string;
  text?: string;
  content?: string;
  timestamp?: number;
  timestamp_ms?: number;
  isUnsent?: boolean;
  is_unsent?: boolean;
  media?: MediaItem[];
  share?: SharedLink;
  reactions?: Reaction[];
  type?: string;
}

interface RawMessengerExportThread {
  participants?: unknown[];
  threadName?: string;
  messages?: RawMessengerExportMessage[];
}

function isRawMessengerExportThread(raw: unknown): raw is RawMessengerExportThread {
  return (
    !!raw &&
    typeof raw === 'object' &&
    typeof (raw as RawMessengerExportThread).threadName === 'string' &&
    Array.isArray((raw as RawMessengerExportThread).participants) &&
    (raw as RawMessengerExportThread).participants!.some(participant => typeof participant === 'string') &&
    Array.isArray((raw as RawMessengerExportThread).messages)
  );
}

function isUsableMediaUri(uri: string): boolean {
  return /^\.?\/?media\//i.test(uri) || /^[^/\\]+\.[a-z0-9]{2,5}$/i.test(uri);
}

function categorizeMediaItem(item: MediaItem): 'photos' | 'videos' | 'audio' | 'gifs' | 'files' | null {
  const path = String(item?.uri || item?.filename || item?.path || item?.name || '');
  if (!path || !isUsableMediaUri(path)) return null;

  const ext = path.split(/[?#]/)[0].split('.').pop()?.toLowerCase() || '';
  if (ext === 'gif') return 'gifs';
  if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'heif'].includes(ext)) return 'photos';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'videos';
  if (['mp3', 'wav', 'aac', 'ogg', 'm4a', 'opus'].includes(ext)) return 'audio';
  return 'files';
}

function normalizeMediaItems(items: MediaItem[] | undefined): MediaItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    const path = String(item?.uri || item?.filename || item?.path || item?.name || '');
    return !!path && isUsableMediaUri(path);
  });
}

function normalizeMessage(raw: RawMessengerExportMessage): MessengerMessage {
  const sender = fixEncoding(String(raw.senderName || raw.sender_name || ''));
  const text = fixEncoding(String(raw.text ?? raw.content ?? ''));
  const timestamp = Number(raw.timestamp_ms ?? raw.timestamp ?? 0);
  const media = normalizeMediaItems(raw.media);

  const message: MessengerMessage = {
    sender_name: sender,
    senderName: sender,
    timestamp_ms: Number.isFinite(timestamp) ? timestamp : 0,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    content: text,
    text,
    media,
    share: raw.share ? {
      link: raw.share.link,
      href: raw.share.href,
      share_text: raw.share.share_text ? fixEncoding(raw.share.share_text) : undefined,
    } : undefined,
    reactions: Array.isArray(raw.reactions)
      ? raw.reactions.map(reaction => ({
          actor: fixEncoding(String(reaction.actor || '')),
          reaction: fixEncoding(String(reaction.reaction || '')),
          timestamp: reaction.timestamp,
          timestamp_ms: reaction.timestamp_ms,
        }))
      : [],
    is_unsent: Boolean(raw.is_unsent ?? raw.isUnsent),
  };

  for (const item of media) {
    const category = categorizeMediaItem(item);
    if (!category) continue;
    if (!message[category]) message[category] = [];
    message[category]?.push(item);
  }

  return message;
}

function parseMessengerExportRaw(raw: RawMessengerExportThread): MessengerThread {
  const title = fixEncoding(raw.threadName || 'conversation');
  const participants = (raw.participants || [])
    .filter((participant): participant is string => typeof participant === 'string')
    .map(name => ({ name: fixEncoding(name) }));

  const thread: MessengerThread = {
    participants,
    messages: Array.isArray(raw.messages) ? raw.messages.map(normalizeMessage) : [],
    title,
    thread_path: sanitizeFileName(title),
    is_still_participant: true,
  };

  return normalizeMessengerData(thread);
}

export function parseMessengerExportJson(content: string): MessengerThread {
  const raw = JSON.parse(content) as RawMessengerExportThread;
  return parseMessengerExportRaw(raw);
}

export function tryParseMessengerExportJson(content: string): MessengerThread | null {
  try {
    const raw = JSON.parse(content);
    if (!isRawMessengerExportThread(raw)) return null;
    return parseMessengerExportRaw(raw);
  } catch {
    return null;
  }
}

export function getMessengerExportLastMessage(thread: MessengerThread): MessengerMessage | null {
  const messages = thread.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (getMessageTimestamp(messages[i]) != null) return messages[i];
  }
  return messages[messages.length - 1] || null;
}
