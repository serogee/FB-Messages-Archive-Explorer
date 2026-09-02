import { useMemo } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment, ResolvedLink } from '../types/messenger';
import { getMessageAttachmentReferences, findMediaFile } from '../services/media';
import { getMessageTimestamp } from '../services/parser';
import { isReactionNoticeMessage } from '../services/reactions';
import { getMessageLinks } from '../services/messageLinks';

export type AttachmentCategory = 'all' | 'photos' | 'videos' | 'audio' | 'gifs' | 'files' | 'stickers';
export type GalleryCategory = AttachmentCategory | 'links';

export function useSharedLinks(chatData: MessengerThread | null): ResolvedLink[] {
  return useMemo(() => {
    if (!chatData) return [];

    const links: ResolvedLink[] = [];
    for (let i = 0; i < chatData.messages.length; i++) {
      const msg = chatData.messages[i];
      if (isReactionNoticeMessage(msg)) continue;

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
    return links;
  }, [chatData]);
}

export function useAttachments(
  chatData: MessengerThread | null,
  mediaState: MediaState
): {
  all: ResolvedAttachment[];
  byCategory: Record<Exclude<AttachmentCategory, 'all'>, ResolvedAttachment[]>;
  getFiltered: (category: AttachmentCategory) => ResolvedAttachment[];
  findIndex: (mediaPath: string, messageIndex: number) => number;
} {
  const all = useMemo<ResolvedAttachment[]>(() => {
    if (!chatData) return [];

    const result: ResolvedAttachment[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < chatData.messages.length; i++) {
      const msg = chatData.messages[i];
      if (isReactionNoticeMessage(msg)) continue;

      const ts = getMessageTimestamp(msg) || 0;
      const refs = getMessageAttachmentReferences(msg);

      for (const { path, category, shared } of refs) {
        const key = `${category}:${path.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        result.push({
          mediaPath: path,
          category: category as ResolvedAttachment['category'],
          messageIndex: i,
          timestamp: ts,
          sender: msg.senderName || msg.sender_name || 'Unknown',
          mediaEntry: findMediaFile(mediaState, path),
          shared,
        });
      }
    }

    return result;
  }, [chatData, mediaState]);

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

  const getFiltered = (category: AttachmentCategory): ResolvedAttachment[] => {
    return category === 'all' ? all : byCategory[category];
  };

  const findIndex = (mediaPath: string, messageIndex: number): number => {
    const pathLower = mediaPath.toLowerCase();
    return all.findIndex(
      a => a.mediaPath.toLowerCase() === pathLower && a.messageIndex === messageIndex
    );
  };

  return { all, byCategory, getFiltered, findIndex };
}
