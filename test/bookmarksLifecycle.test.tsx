// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBookmarks } from '../src/hooks/useBookmarks';
import { createPinnedChatBookmark } from '../src/services/bookmarks';
import type { ChatListEntry, ResolvedAttachment } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

if (!File.prototype.text) {
  File.prototype.text = function text() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

function chat(root: FileSystemDirectoryHandle, name = 'alice'): ChatListEntry {
  return {
    folderName: name, title: name, participants: [], messageCount: 1, folderSize: 0,
    dirHandle: root, jsonFileCount: 1, source: 'inbox',
  };
}

const item: ResolvedAttachment = {
  mediaPath: 'photos/photo.jpg', category: 'photos', messageIndex: 1,
  timestamp: 1, sender: 'Alice', mediaEntry: null,
};

afterEach(() => vi.restoreAllMocks());

describe('bookmark hook lifecycle', () => {
  it('rolls back an optimistic bookmark when directory preparation fails and succeeds after retry', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const original = root.getDirectoryHandle.bind(root);
    let denyCreate = true;
    vi.spyOn(root, 'getDirectoryHandle').mockImplementation(async (name, options) => {
      if (denyCreate && options?.create) throw new DOMException('denied', 'NotAllowedError');
      return original(name, options);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useBookmarks(root));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      await expect(result.current.toggleItemBookmark(chat(root), item)).rejects.toMatchObject({ name: 'NotAllowedError' });
    });
    expect(result.current.attachmentBookmarks).toEqual([]);
    expect(result.current.preparationFailed).toBe(true);
    expect(result.current.error).toContain('Could not save bookmarks');

    denyCreate = false;
    await act(async () => { await result.current.retryPreparation(); });
    await act(async () => { await result.current.toggleItemBookmark(chat(root), item); });
    expect(result.current.attachmentBookmarks).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('discards loaded pins and late state when the archive root changes', async () => {
    const pinRoot = createMockDirectoryHandle('pin-chat', {});
    const pin = createPinnedChatBookmark(chat(pinRoot));
    const first = createMockDirectoryHandle('first', {
      'fb-mae': { 'bookmarks.json': JSON.stringify({
        version: 2, bookmarks: [], pinnedChats: [pin],
      }) },
    });
    const second = createMockDirectoryHandle('second', {});
    const { result, rerender } = renderHook(
      ({ root }) => useBookmarks(root),
      { initialProps: { root: first as FileSystemDirectoryHandle } },
    );
    await waitFor(() => expect(result.current.pinnedChats).toHaveLength(1));

    rerender({ root: second });
    await waitFor(() => expect(result.current.pinnedChats).toEqual([]));
    expect(result.current.error).toBeNull();
  });
});
