// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchive } from '../src/hooks/useArchive';
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

function facebookRoot(title: string) {
  return createMockDirectoryHandle(title, {
    messages: {
      inbox: {
        chat: {
          'message_1.json': JSON.stringify({
            title,
            thread_path: 'inbox/chat',
            participants: [{ name: 'Alice' }],
            messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: title }],
          }),
        },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('archive lifecycle integration', () => {
  it('aborts an older folder load and prevents its late result from replacing the new archive', async () => {
    const firstRoot = facebookRoot('First archive');
    const secondRoot = facebookRoot('Second archive');
    const firstMessages = await firstRoot.getDirectoryHandle('messages');
    const firstInbox = await firstMessages.getDirectoryHandle('inbox');
    const firstChat = await firstInbox.getDirectoryHandle('chat');
    const firstFile = await firstChat.getFileHandle('message_1.json');
    const originalGetFile = firstFile.getFile.bind(firstFile);
    let releaseFirst = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstGetFile = vi.spyOn(firstFile, 'getFile').mockImplementation(async () => {
      await firstGate;
      return originalGetFile();
    });
    const picker = vi.fn()
      .mockResolvedValueOnce(firstRoot)
      .mockResolvedValueOnce(secondRoot);
    Object.defineProperty(window, 'showDirectoryPicker', { value: picker, configurable: true });
    const { result, unmount } = renderHook(() => useArchive());

    let firstLoad!: Promise<boolean>;
    act(() => { firstLoad = result.current.openFolder(); });
    await waitFor(() => expect(firstGetFile).toHaveBeenCalledOnce());

    let secondResult = false;
    await act(async () => { secondResult = await result.current.openFolder(); });
    expect(secondResult).toBe(true);
    await waitFor(() => expect(result.current.inboxList.map(entry => entry.title)).toEqual(['Second archive']));

    releaseFirst();
    let firstResult = true;
    await act(async () => { firstResult = await firstLoad; });

    expect(firstResult).toBe(false);
    expect(result.current.originalRootHandle).toBe(secondRoot);
    expect(result.current.inboxList.map(entry => entry.title)).toEqual(['Second archive']);
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('reports invalid folders without retaining stale archive state', async () => {
    const validRoot = facebookRoot('Valid archive');
    const invalidRoot = createMockDirectoryHandle('invalid', { notes: { 'readme.txt': 'no messages' } });
    const picker = vi.fn().mockResolvedValueOnce(validRoot).mockResolvedValueOnce(invalidRoot);
    Object.defineProperty(window, 'showDirectoryPicker', { value: picker, configurable: true });
    const { result } = renderHook(() => useArchive());

    await act(async () => { await result.current.openFolder(); });
    expect(result.current.inboxList).toHaveLength(1);
    await act(async () => { await result.current.openFolder(); });

    expect(result.current.rootHandle).toBeNull();
    expect(result.current.inboxList).toEqual([]);
    expect(result.current.error).toContain('Could not find messages');
  });
});
