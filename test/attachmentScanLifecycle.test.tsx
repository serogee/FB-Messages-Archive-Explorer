// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAttachments, useSharedLinks } from '../src/hooks/useAttachments';
import { addMediaToIndex, createMediaState } from '../src/services/media';
import type { MediaState, MessengerThread } from '../src/types/messenger';

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
