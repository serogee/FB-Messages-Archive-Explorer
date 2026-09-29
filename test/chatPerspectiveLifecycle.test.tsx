// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../src/hooks/useChat';
import { loadChatMessages } from '../src/services/fileSystem';
import { storageRemove } from '../src/services/storage';
import type { ChatListEntry, MessengerThread } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

vi.mock('../src/services/fileSystem', () => ({ loadChatMessages: vi.fn() }));
vi.mock('../src/services/media', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/media')>(),
  processMediaFromDirectory: vi.fn(async () => {}),
  processFacebookStickerReferences: vi.fn(async () => {}),
}));

const entry: ChatListEntry = {
  folderName: 'chat', title: 'chat', participants: ['Bob', 'Alice'],
  source: 'inbox', messageCount: 0, folderSize: 0, jsonFileCount: 1,
  dirHandle: createMockDirectoryHandle('chat', {}),
};
function thread(names = ['Bob', 'Alice']): MessengerThread {
  return {
    participants: names.map(name => ({ name })), messages: [], title: 'chat',
    thread_path: 'inbox/chat', is_still_participant: true, _reactionsEnriched: true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  storageRemove('archivePerspectivesV1');
  storageRemove('selectedPerspective');
  vi.mocked(loadChatMessages).mockResolvedValue(thread());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('chat perspective lifecycle', () => {
  it('uses the detected name and keeps a manual override on later chat opens', async () => {
    const { result } = renderHook(() => useChat());
    await act(async () => {
      const pending = result.current.loadChat(entry, null, 'archive-a', 'Alice');
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    expect(result.current.selectedPerspective).toBe('Alice');
    act(() => result.current.setSelectedPerspective('Bob'));
    await act(async () => {
      const pending = result.current.loadChat(entry, null, 'archive-a', 'Alice');
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    expect(result.current.selectedPerspective).toBe('Bob');
  });

  it('does not transfer a manual preference to another archive', async () => {
    const { result } = renderHook(() => useChat());
    await act(async () => {
      const pending = result.current.loadChat(entry, null, 'archive-a', 'Alice');
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    act(() => result.current.setSelectedPerspective('Bob'));
    act(() => result.current.clearChat());
    await act(async () => {
      const pending = result.current.loadChat(entry, null, 'archive-b', 'Alice');
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    expect(result.current.selectedPerspective).toBe('Alice');
  });

  it('does not restore an old chat or perspective after clearing during its final loading delay', async () => {
    const { result } = renderHook(() => useChat());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.loadChat(entry, null, 'archive-a', 'Alice');
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.msgStatusText).toBe('Loading messages...');
    act(() => result.current.clearChat());
    const clearedPerspective = result.current.selectedPerspective;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await pending;
    });
    expect(result.current.chatData).toBeNull();
    expect(result.current.selectedPerspective).toBe(clearedPerspective);
  });

  it('preserves a manual choice made while a chat is loading', async () => {
    const { result } = renderHook(() => useChat());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.loadChat(entry, null, 'archive-a', 'Alice');
      await vi.advanceTimersByTimeAsync(10);
    });
    act(() => result.current.setSelectedPerspective('Bob'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await pending;
    });
    expect(result.current.selectedPerspective).toBe('Bob');
  });

  it('does not begin file loading if cleared during the initial delay', async () => {
    const { result } = renderHook(() => useChat());
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadChat(entry, null, 'archive-a', 'Alice'); });
    act(() => result.current.clearChat());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
      await pending;
    });
    expect(loadChatMessages).not.toHaveBeenCalled();
    expect(result.current.chatData).toBeNull();
  });
});
