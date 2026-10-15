// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchive } from '../src/hooks/useArchive';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import { isWritableDirectoryHandle } from '../src/types/fileSystem';

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
  vi.unstubAllGlobals();
});

describe('archive lifecycle integration', () => {
  it('loads the explicitly chosen read-only picker without enabling stored deletion preferences', async () => {
    const json = JSON.stringify({ title: 'Uploaded archive', participants: [{ name: 'Alice' }],
      messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: 'hello' }] });
    const file = new File([json], 'message_1.json');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'messages/inbox/alice/message_1.json' });
    const nativePicker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', nativePicker);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    const { result, unmount } = renderHook(() => useArchive(true));
    await act(async () => { await result.current.openFolder(true, undefined, 'upload'); });

    expect(nativePicker).not.toHaveBeenCalled();
    expect(result.current.inboxList).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(isWritableDirectoryHandle(result.current.rootHandle!)).toBe(false);
    expect(result.current.folderPreparationProgress).toBeNull();
    expect(result.current.attachmentReferenceIndex).toBeNull();
    expect(result.current.attachmentReferenceScan).toBeNull();
    await expect(result.current.deleteChats(result.current.inboxList)).rejects.toMatchObject({ name: 'AbortError' });
    unmount();
  });

  it('shows upload preparation immediately and discards it when a later picker wins', async () => {
    let paint!: FrameRequestCallback;
    let pathsRead = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { paint = callback; return 1; }));
    const file = new File(['{}'], 'message_1.json');
    Object.defineProperty(file, 'webkitRelativePath', { get: () => { pathsRead++; return 'messages/inbox/alice/message_1.json'; } });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(facebookRoot('Native archive')));
    const { result, unmount } = renderHook(() => useArchive(false));
    const uploadedFolderPicked = vi.fn();
    let upload!: Promise<boolean>;
    act(() => { upload = result.current.openFolder(false, uploadedFolderPicked, 'upload'); });
    expect(result.current.folderPreparationProgress).toEqual({ done: 0, total: 1 });
    expect(pathsRead).toBe(0);
    await act(async () => { await result.current.openFolder(false, undefined, 'native'); });
    const nativeRoot = result.current.rootHandle;
    await act(async () => { paint(0); await upload; });
    await expect(upload).resolves.toBe(false);
    expect(uploadedFolderPicked).not.toHaveBeenCalled();
    expect(result.current.rootHandle).toBe(nativeRoot);
    expect(result.current.inboxList.map(entry => entry.title)).toEqual(['Native archive']);
    expect(result.current.folderPreparationProgress).toBeNull();
    unmount();
  });

  it('shows the picker wait immediately and clears it when folder upload is cancelled', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useArchive(false));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.openFolder(false, undefined, 'upload'); });
    expect(result.current.folderSelectionPending).toBe(true);
    expect(result.current.folderPreparationProgress).toBeNull();
    await act(async () => {
      (click.mock.contexts[0] as HTMLInputElement).dispatchEvent(new Event('cancel'));
      await pending;
    });
    expect(result.current.folderSelectionPending).toBe(false);
    expect(result.current.error).toBeNull();
    await expect(pending).resolves.toBe(false);
    unmount();
  });

  it('shows native read failures with a fallback hint instead of treating the folder as invalid', async () => {
    const root = createMockDirectoryHandle('messenger', { 'alice.json': '{}' });
    const file = await root.getFileHandle('alice.json');
    vi.spyOn(file, 'getFile').mockRejectedValue(new DOMException('Cannot read the selected document', 'NotReadableError'));
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false));
    await act(async () => { await result.current.openFolder(); });

    expect(result.current.rootHandle).toBeNull();
    expect(result.current.error).toContain('Cannot read the selected document');
    expect(result.current.error).toContain('Read-only access');
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('rejects a detected Facebook layout when none of its conversations can be read', async () => {
    const root = facebookRoot('Unreadable archive');
    const chat = await (await (await root.getDirectoryHandle('messages')).getDirectoryHandle('inbox')).getDirectoryHandle('chat');
    vi.spyOn(await chat.getFileHandle('message_1.json'), 'getFile').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false));
    await act(async () => { await result.current.openFolder(); });

    expect(result.current.rootHandle).toBeNull();
    expect(result.current.originalRootHandle).toBeNull();
    expect(result.current.inboxList).toEqual([]);
    expect(result.current.error).toContain('No readable conversation files');
    expect(result.current.error).toContain('Read-only access');
    unmount();
  });

  it('keeps native picker cancellation silent and preserves the current archive', async () => {
    const picker = vi.fn().mockResolvedValueOnce(facebookRoot('Current archive'))
      .mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    vi.stubGlobal('showDirectoryPicker', picker);
    const { result, unmount } = renderHook(() => useArchive(false));
    await act(async () => { await result.current.openFolder(); });
    const root = result.current.rootHandle;
    let picked = true;
    await act(async () => { picked = await result.current.openFolder(); });

    expect(picked).toBe(false);
    expect(result.current.rootHandle).toBe(root);
    expect(result.current.inboxList.map(entry => entry.title)).toEqual(['Current archive']);
    expect(result.current.error).toBeNull();
    unmount();
  });

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
    const { result, unmount } = renderHook(() => useArchive(true));

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
    const { result } = renderHook(() => useArchive(true));

    await act(async () => { await result.current.openFolder(); });
    expect(result.current.inboxList).toHaveLength(1);
    await act(async () => { await result.current.openFolder(); });

    expect(result.current.rootHandle).toBeNull();
    expect(result.current.inboxList).toEqual([]);
    expect(result.current.error).toContain('Could not find messages');
  });
});
