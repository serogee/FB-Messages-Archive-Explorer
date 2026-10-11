import { useCallback, useMemo } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment, ResolvedLink } from '../types/messenger';
import { getMessageAttachmentReferences, findMediaFile } from '../services/media';
import { getMessageTimestamp } from '../services/parser';
import { getMessageLinks } from '../services/messageLinks';
import { getAttachmentIdentity, normalizeAttachmentPath } from '../services/attachmentIdentity';

export type AttachmentCategory = 'all' | 'photos' | 'videos' | 'audio' | 'gifs' | 'files' | 'stickers';
export type GalleryCategory = AttachmentCategory | 'links';

// Imported threads are immutable during browsing. Share scans between the app,
// chat header and gallery; weak keys release a closed thread naturally.
const linksCache = new WeakMap<MessengerThread, ResolvedLink[]>();
const attachmentsCache = new WeakMap<MessengerThread, {
  mediaState: MediaState;
  all: ResolvedAttachment[];
  occurrences: ResolvedAttachment[];
}>();

export function useSharedLinks(chatData: MessengerThread | null): ResolvedLink[] {
  return useMemo(() => {
    if (!chatData) return [];
    const cached = linksCache.get(chatData);
    if (cached) return cached;

    const links: ResolvedLink[] = [];
    for (let i = 0; i < chatData.messages.length; i++) {
      const msg = chatData.messages[i];

      for (const link of getMessageLinks(msg)) {
        links.push({
          category: 'links',
          url: link.url,
          label: link.label,
          messageIndex: i,
          timestamp: getMessageTimestamp(msg) || 0,
          sender: msg.senderName || msg.sender_name || 'Unknown',
        });
      }
    }
    linksCache.set(chatData, links);
    return links;
  }, [chatData]);
}

export function useAttachments(
  chatData: MessengerThread | null,
  mediaState: MediaState,
  { includeRepeated = false }: { includeRepeated?: boolean } = {},
): {
  all: ResolvedAttachment[];
  byCategory: Record<Exclude<AttachmentCategory, 'all'>, ResolvedAttachment[]>;
  getFiltered: (category: AttachmentCategory) => ResolvedAttachment[];
  findIndex: (mediaPath: string, messageIndex: number) => number;
} {
  const scan = useMemo(() => {
    if (!chatData) return { all: [], occurrences: [] };
    const cached = attachmentsCache.get(chatData);
    if (cached?.mediaState === mediaState) return cached;

    const result: ResolvedAttachment[] = [];
    const occurrences: ResolvedAttachment[] = [];
    const seen = new Set<string>();
    const usageCounts = new Map<string, number>();

    for (let i = 0; i < chatData.messages.length; i++) {
      const msg = chatData.messages[i];

      const refs = getMessageAttachmentReferences(msg, mediaState);
      if (refs.length === 0) continue;
      const ts = getMessageTimestamp(msg) || 0;

      for (const { path, category, shared } of refs) {
        const attachment: ResolvedAttachment = {
          mediaPath: path,
          category: category as ResolvedAttachment['category'],
          messageIndex: i,
          timestamp: ts,
          sender: msg.senderName || msg.sender_name || 'Unknown',
          mediaEntry: findMediaFile(mediaState, path),
          shared,
        };
        const key = getAttachmentIdentity(attachment);
        usageCounts.set(key, (usageCounts.get(key) ?? 0) + 1);
        occurrences.push(attachment);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(attachment);
        }
      }
    }

    for (const attachment of occurrences) {
      attachment.usageCount = usageCounts.get(getAttachmentIdentity(attachment));
    }

    const scanned = { mediaState, all: result, occurrences };
    attachmentsCache.set(chatData, scanned);
    return scanned;
  }, [chatData, mediaState]);
  // Chat actions need the sender, date, and jump target of every occurrence.
  // Counts and saved selections use one entry per file and category.
  const all = includeRepeated ? scan.occurrences : scan.all;

  const byCategory = useMemo(() => {
    const groups: Record<Exclude<AttachmentCategory, 'all'>, ResolvedAttachment[]> = {
      photos: [],
      videos: [],
      audio: [],
      gifs: [],
      files: [],
      stickers: [],
    };
    for (const att of all) {
      groups[att.category].push(att);
    }
    return groups;
  }, [all]);

  const getFiltered = useCallback((category: AttachmentCategory): ResolvedAttachment[] => {
    return category === 'all' ? all : byCategory[category];
  }, [all, byCategory]);

  const attachmentIndex = useMemo(() => {
    const index = new Map<string, number>();
    for (let itemIndex = 0; itemIndex < all.length; itemIndex++) {
      const attachment = all[itemIndex];
      index.set(`${attachment.messageIndex}:${normalizeAttachmentPath(attachment.mediaPath)}`, itemIndex);
    }
    return index;
  }, [all]);

  const findIndex = useCallback((mediaPath: string, messageIndex: number): number => (
    attachmentIndex.get(`${messageIndex}:${normalizeAttachmentPath(mediaPath)}`) ?? -1
  ), [attachmentIndex]);

  return useMemo(() => ({ all, byCategory, getFiltered, findIndex }), [all, byCategory, findIndex, getFiltered]);
}
