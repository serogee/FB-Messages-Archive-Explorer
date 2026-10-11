// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBookmarks } from '../src/hooks/useBookmarks';
import { createAttachmentBookmark, createPinnedChatBookmark } from '../src/services/bookmarks';
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
  it('preserves and removes video bookmarks when an MP4 is recognized as audio', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const entry = chat(root);
    const video: ResolvedAttachment = { ...item, category: 'videos', mediaPath: 'media/voice.mp4' };
    const bookmark = createAttachmentBookmark(entry, video);
    const directory = await root.getDirectoryHandle('fb-mae', { create: true });
    const writable = await (await directory.getFileHandle('bookmarks.json', { create: true })).createWritable();
    await writable.write(JSON.stringify({ version: 2, bookmarks: [bookmark], pinnedChats: [] }));
    await writable.close();
    const audio = { ...video, category: 'audio' as const };
    const { result } = renderHook(() => useBookmarks(root));
    await waitFor(() => expect(result.current.attachmentBookmarks).toHaveLength(1));
    expect(result.current.isItemBookmarked(entry, audio)).toBe(true);
    await act(async () => { await result.current.setItemBookmarks(entry, [audio], true); });
    expect(result.current.attachmentBookmarks).toHaveLength(1);
    await act(async () => { await result.current.toggleItemBookmark(entry, audio); });
    expect(result.current.attachmentBookmarks).toHaveLength(0);
  });

  it('shares a single persisted bookmark across repeated uses and removes it from every use', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const entry = chat(root);
    const repeat = { ...item, mediaPath: './PHOTOS/photo.jpg', messageIndex: 7, sender: 'Bob' };
    const { result } = renderHook(() => useBookmarks(root));
    await act(async () => { await result.current.setItemBookmarks(entry, [item, repeat], true); });
    expect(result.current.attachmentBookmarks).toHaveLength(1);
    expect(result.current.isItemBookmarked(entry, item)).toBe(true);
    expect(result.current.isItemBookmarked(entry, repeat)).toBe(true);

    const reloaded = renderHook(() => useBookmarks(root));
    await waitFor(() => expect(reloaded.result.current.attachmentBookmarks).toHaveLength(1));
    expect(reloaded.result.current.isItemBookmarked(entry, repeat)).toBe(true);
    await act(async () => { await reloaded.result.current.toggleItemBookmark(entry, repeat); });
    expect(reloaded.result.current.isItemBookmarked(entry, item)).toBe(false);
    expect(reloaded.result.current.isItemBookmarked(entry, repeat)).toBe(false);
  });

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

  it('discards bookmark state that loads after the archive root changes', async () => {
    const firstPinRoot = createMockDirectoryHandle('first-pin', {});
    const secondPinRoot = createMockDirectoryHandle('second-pin', {});
    const firstPin = createPinnedChatBookmark(chat(firstPinRoot, 'first-chat'));
    const secondPin = createPinnedChatBookmark(chat(secondPinRoot, 'second-chat'));
    const first = createMockDirectoryHandle('first', {
      'fb-mae': { 'bookmarks.json': JSON.stringify({
        version: 2, bookmarks: [], pinnedChats: [firstPin],
      }) },
    });
    const second = createMockDirectoryHandle('second', {
      'fb-mae': { 'bookmarks.json': JSON.stringify({
        version: 2, bookmarks: [], pinnedChats: [secondPin],
      }) },
    });
    const firstFileHandle = await (await first.getDirectoryHandle('fb-mae')).getFileHandle('bookmarks.json');
    const firstFile = await firstFileHandle.getFile();
    let releaseFirstLoad!: (file: File) => void;
    const firstLoad = new Promise<File>(resolve => { releaseFirstLoad = resolve; });
    const getFirstFile = vi.spyOn(firstFileHandle, 'getFile').mockReturnValue(firstLoad);
    const { result, rerender } = renderHook(
      ({ root }) => useBookmarks(root),
      { initialProps: { root: first as FileSystemDirectoryHandle } },
    );
    await waitFor(() => expect(getFirstFile).toHaveBeenCalledOnce());

    rerender({ root: second });
    await waitFor(() => expect(result.current.pinnedChats.map(pin => pin.chat.folderName)).toEqual(['second-chat']));
    await act(async () => { releaseFirstLoad(firstFile); });

    expect(result.current.pinnedChats.map(pin => pin.chat.folderName)).toEqual(['second-chat']);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });
});
