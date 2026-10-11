// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAttachments, useSharedLinks } from '../src/hooks/useAttachments';
import { addMediaToIndex, createMediaState } from '../src/services/media';
import type { MediaState, MessengerThread } from '../src/types/messenger';
import { parseMessengerExportJson } from '../src/services/messengerExport/messengerExportParser';

afterEach(cleanup);

function makeThread(): MessengerThread {
  return {
    title: 'Chat', thread_path: 'inbox/chat', is_still_participant: true, participants: [],
    messages: [
      { sender_name: 'Alice', timestamp_ms: 1, content: 'ordinary' },
      { sender_name: 'Alice', timestamp_ms: 2, content: 'https://example.com', photos: [{ uri: 'photos/a.jpg' }] },
    ],
  };
}

describe('shared attachment scans', () => {
  it('opens repeated Messenger paths at their own message while keeping the gallery deduplicated', () => {
    const path = './media/52c20a89-be1a-4dd2-bf46-83c8f260ec80.jpeg';
    const data = parseMessengerExportJson(JSON.stringify({
      threadName: 'Chat', participants: ['Alice', 'Geevoi Plaza'], messages: [
        { senderName: 'Alice', timestamp: 1791261704038, media: [{ uri: path }] },
        { senderName: 'Geevoi Plaza', timestamp: 1791547299971, media: [{ uri: path }] },
      ],
    }));
    const media = createMediaState();
    const { result, rerender } = renderHook(({ media }: { media: MediaState }) => ({
      chat: useAttachments(data, media, { includeRepeated: true }),
      gallery: useAttachments(data, media),
    }), { initialProps: { media } });
    expect(result.current.gallery.all).toHaveLength(1);
    expect(result.current.chat.all).toHaveLength(2);
    for (const index of [0, 1]) {
      const attachmentIndex = result.current.chat.findIndex(path, index);
      expect(attachmentIndex).toBe(index);
      expect(result.current.chat.all[attachmentIndex].messageIndex).toBe(index);
      expect(result.current.chat.all[attachmentIndex].mediaEntry).toBeNull();
    }
    expect(result.current.chat.all[1].sender).toBe('Geevoi Plaza');
    expect(result.current.chat.all[1].timestamp).toBe(1791547299971);
    expect(result.current.chat.findIndex(path, 2)).toBe(-1);

    const loadedMedia = createMediaState();
    const entry = { type: 'image', url: 'blob:photo' };
    addMediaToIndex(loadedMedia, path, entry);
    rerender({ media: loadedMedia });
    expect(result.current.gallery.all).toHaveLength(1);
    expect(result.current.chat.all.map(item => item.mediaEntry)).toEqual([entry, entry]);
    expect(result.current.chat.findIndex(path, 1)).toBe(1);
  });

  it('resolves newly indexed media after a missing-file scan', () => {
    const data = makeThread();
    const initialMedia = createMediaState();
    const { result, rerender } = renderHook(({ media }: { media: MediaState }) => useAttachments(data, media), { initialProps: { media: initialMedia } });
    expect(result.current.all[0].mediaEntry).toBeNull();
    const indexedMedia = createMediaState();
    const entry = { type: 'image', url: 'blob:resolved' };
    addMediaToIndex(indexedMedia, 'photos/a.jpg', entry);
    rerender({ media: indexedMedia });
    expect(result.current.all[0].mediaEntry).toBe(entry);
    expect(result.current.findIndex('photos/a.jpg', 1)).toBe(0);
  });

  it('uses new message indices after a refreshed thread loses earlier messages', () => {
    const data = makeThread();
    const media = createMediaState();
    const { result, rerender } = renderHook(({ thread }: { thread: MessengerThread }) => ({
      attachments: useAttachments(thread, media), links: useSharedLinks(thread),
    }), { initialProps: { thread: data } });
    expect(result.current.links[0].messageIndex).toBe(1);
    rerender({ thread: { ...data, messages: data.messages.slice(1) } });
    expect(result.current.links[0].messageIndex).toBe(0);
    expect(result.current.attachments.all[0].messageIndex).toBe(0);
    expect(result.current.attachments.findIndex('photos/a.jpg', 1)).toBe(-1);
  });
});
