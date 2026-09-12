// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatListEntry, MessengerThread } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

const serviceMocks = vi.hoisted(() => ({
  loadChatMessages: vi.fn(),
  loadMessengerExportChat: vi.fn(),
}));

vi.mock('../src/services/fileSystem', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/fileSystem')>()),
  loadChatMessages: serviceMocks.loadChatMessages,
}));
vi.mock('../src/services/messengerExport', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/messengerExport')>()),
  loadMessengerExportChat: serviceMocks.loadMessengerExportChat,
}));

import { useSearch } from '../src/hooks/useSearch';

function entry(name: string): ChatListEntry {
  return {
    folderName: name,
    title: `${name} title`,
    participants: [],
    messageCount: 1,
    folderSize: 0,
    dirHandle: createMockDirectoryHandle(name, {}),
    jsonFileCount: 1,
    source: 'inbox',
  };
}

function thread(content: string, count = 1): MessengerThread {
  return {
    title: 'Thread', participants: [{ name: 'Alice' }],
    messages: Array.from({ length: count }, (_, index) => ({
      sender_name: 'Alice', timestamp_ms: index + 1, content,
    })),
  };
}

afterEach(() => {
  serviceMocks.loadChatMessages.mockReset();
  serviceMocks.loadMessengerExportChat.mockReset();
});

describe('search hook lifecycle', () => {
  it('publishes complete current-chat results and clears all observable search state', async () => {
    const { result } = renderHook(() => useSearch(thread('needle', 60), []));

    await act(async () => { await result.current.startSearch('needle'); });
    expect(result.current.results).toHaveLength(60);
    expect(result.current.progress).toBe(100);
    expect(result.current.activeQuery).toBe('needle');

    act(() => result.current.clearSearch());
    expect(result.current).toMatchObject({ activeQuery: '', results: [], progress: 0, isSearching: false });
  });

  it('attributes wide results to their chats and continues past an unreadable chat', async () => {
    const unreadable = entry('unreadable');
    const readable = entry('readable');
    serviceMocks.loadChatMessages
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(thread('needle'));
    const { result } = renderHook(() => useSearch(null, [unreadable, readable]));
    act(() => result.current.setIsWideSearch(true));

    await act(async () => { await result.current.startSearch('needle'); });

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].item).toMatchObject({
      chatTitle: 'readable title', chatFolderName: 'readable',
    });
    expect(result.current.progress).toBe(100);
  });

  it('does not publish a wide-search result that resolves after cancellation', async () => {
    const chat = entry('slow');
    let release!: (value: MessengerThread) => void;
    serviceMocks.loadChatMessages.mockImplementation((_handle, _progress, signal: AbortSignal) => (
      new Promise<MessengerThread>((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      })
    ));
    const { result } = renderHook(() => useSearch(null, [chat]));
    act(() => result.current.setIsWideSearch(true));
    let searching!: Promise<void>;
    act(() => { searching = result.current.startSearch('needle'); });
    await waitFor(() => expect(serviceMocks.loadChatMessages).toHaveBeenCalledOnce());

    act(() => result.current.clearSearch());
    release(thread('needle'));
    await act(async () => { await searching; });

    expect(result.current).toMatchObject({ activeQuery: '', results: [], progress: 0, isSearching: false });
  });
});
