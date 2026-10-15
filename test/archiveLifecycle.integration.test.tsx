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
  it.each(['native', 'upload'] as const)('shares four metadata jobs across sections with %s access and publishes only the finished list', async accessMode => {
    const sections = ['inbox', 'archived_threads', 'message_requests', 'e2ee_cutover'];
    const tree: Parameters<typeof createMockDirectoryHandle>[1] = {};
    const files: File[] = [];
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let active = 0, peak = 0;
    for (const section of sections) {
      tree[section] = Object.fromEntries(Array.from({ length: 3 }, (_, index) => {
        const json = JSON.stringify({ title: `${section} ${index}`, participants: [{ name: 'Alice' }],
          messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: 'preview' }] });
        const fileIndex = files.length;
        const file = new File([json], 'message_1.json');
        Object.defineProperty(file, 'webkitRelativePath', { value: `messages/${section}/chat_${index}/message_1.json` });
        const gate = new Promise<void>(resolve => { releases.push(resolve); });
        vi.spyOn(file, 'text').mockImplementation(async () => {
          started.push(fileIndex);
          active++;
          peak = Math.max(peak, active);
          try { await gate; return json; } finally { active--; }
        });
        files.push(file);
        return [`chat_${index}`, { 'message_1.json': json }];
      }));
    }
    const root = createMockDirectoryHandle('messages', tree);
    let fileIndex = 0;
    for (const section of sections) {
      for await (const [, chat] of (await root.getDirectoryHandle(section)).entries()) {
        if (chat.kind !== 'directory') continue;
        vi.spyOn(await chat.getFileHandle('message_1.json'), 'getFile').mockResolvedValue(files[fileIndex++]);
      }
    }
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: files });
      this.dispatchEvent(new Event('change'));
    });
    const { result, unmount } = renderHook(() => useArchive(false));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.openFolder(false, undefined, accessMode); });
    await waitFor(() => expect(started).toHaveLength(4));
    expect(peak).toBe(4);
    expect(result.current.inboxList).toEqual([]);
    expect(result.current.loading).toBe(true);
    act(() => releases[started[0]]());
    await waitFor(() => expect(started).toHaveLength(5));
    expect(result.current.inboxList).toEqual([]);
    expect(result.current.archivedList).toEqual([]);
    await act(async () => { releases.forEach(release => release()); await pending; });
    expect(peak).toBe(4);
    expect(started).toHaveLength(12);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.inboxList.map(entry => entry.title)).toEqual([
      'inbox 0', 'inbox 1', 'inbox 2', 'e2ee_cutover 0', 'e2ee_cutover 1', 'e2ee_cutover 2',
    ]);
    expect(result.current.archivedList.map(entry => entry.title)).toEqual(['archived_threads 0', 'archived_threads 1', 'archived_threads 2']);
    expect(result.current.requestsList.map(entry => entry.title)).toEqual(['message_requests 0', 'message_requests 1', 'message_requests 2']);
    unmount();
  });

  it.each([
    { path: 'export/private-chat.json', name: 'private-chat.json', content: '',
      folder: '1 top-level files, 0 subfolders, 1 JSON files (1 invalid, 0 unrecognized, 1 empty)',
      upload: '1 JSON filenames, 1 JSON paths, 1 top-level JSON files' },
    { path: 'export/private-chat.json', name: 'private-chat.json', content: '{"settings":true}',
      folder: '1 top-level files, 0 subfolders, 1 JSON files (0 invalid, 1 unrecognized, 0 empty)',
      upload: '1 JSON filenames, 1 JSON paths, 1 top-level JSON files' },
    { path: 'export/wrapper/private-chat.json', name: 'private-chat.json', content: '{}',
      folder: '0 top-level files, 1 subfolders, 0 JSON files (0 invalid, 0 unrecognized, 0 empty)',
      upload: '1 JSON filenames, 1 JSON paths, 0 top-level JSON files' },
    { path: 'export/document-123', name: 'private-chat.json', content: '{}',
      folder: '1 top-level files, 0 subfolders, 0 JSON files (0 invalid, 0 unrecognized, 0 empty)',
      upload: '1 JSON filenames, 0 JSON paths, 0 top-level JSON files' },
  ])('reports what a rejected upload exposed for $path', async ({ path, name, content, folder, upload }) => {
    const file = new File([content], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    const { result, unmount } = renderHook(() => useArchive(false, true));
    await act(async () => { await result.current.openFolder(false, undefined, 'upload'); });
    expect(result.current.error).toContain('Could not find messages');
    expect(result.current.error).toContain(folder);
    expect(result.current.error).toContain(upload);
    expect(result.current.error).not.toContain('Native folder details:');
    expect(result.current.error).not.toContain('private-chat');
    expect(result.current.error).not.toContain(content || '"settings"');
    expect(result.current.loading).toBe(false);
    expect(result.current.rootHandle).toBeNull();
    unmount();
  });

  it.each(['native', 'upload'] as const)('shows %s error details only while debugging is enabled', async accessMode => {
    const picker = vi.fn().mockRejectedValue(new DOMException('Requested document not found', 'NotFoundError'));
    vi.stubGlobal('showDirectoryPicker', picker);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      const file = new File(['{}'], 'metadata.json');
      Object.defineProperty(file, 'webkitRelativePath', { value: 'export/metadata.json' });
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    const { result, rerender, unmount } = renderHook(({ enabled }) => useArchive(false, enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => { await result.current.openFolder(false, undefined, accessMode); });
    const normalError = result.current.error;
    expect(normalError).toBeTruthy();
    expect(normalError).not.toMatch(/folder details:|Folder upload:/);
    rerender({ enabled: true });
    expect(result.current.error).toContain(normalError);
    expect(result.current.error).toContain(accessMode === 'native' ? 'Native folder details:' : 'Browser folder details:');
    rerender({ enabled: false });
    expect(result.current.error).toBe(normalError);
    expect(picker).toHaveBeenCalledTimes(accessMode === 'native' ? 1 : 0);
    unmount();
  });

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

  it.each(['Download', 'storage/Download'])('loads a read-only Messenger upload with %s parent paths', async prefix => {
    const json = JSON.stringify({ threadName: 'Uploaded Messenger chat', participants: ['Alice'],
      messages: [{ senderName: 'Alice', timestamp: 1, text: 'hello', media: [{ uri: 'media/photo.jpg' }] }] });
    const files = [new File([json], 'alice.json'), new File(['photo bytes'], 'photo.jpg')];
    Object.defineProperty(files[0], 'webkitRelativePath', { value: `${prefix}/messenger/alice.json` });
    Object.defineProperty(files[1], 'webkitRelativePath', { value: `${prefix}/messenger/media/photo.jpg` });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: files });
      this.dispatchEvent(new Event('change'));
    });
    const { result, unmount } = renderHook(() => useArchive(true));

    await act(async () => { await result.current.openFolder(true, undefined, 'upload'); });

    expect(result.current.error).toBeNull();
    expect(result.current.standaloneMessenger).toBe(true);
    expect(result.current.inboxList.map(entry => entry.title)).toEqual(['Uploaded Messenger chat']);
    const root = result.current.rootHandle!;
    expect(root.name).toBe('messenger');
    expect(result.current.inboxList[0].dirHandle).toBe(root);
    expect(result.current.originalRootHandle).not.toBe(root);
    expect(await (await root.getFileHandle('alice.json')).getFile()).toBe(files[0]);
    expect(await (await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg')).getFile()).toBe(files[1]);
    expect(isWritableDirectoryHandle(root)).toBe(false);
    expect(result.current.attachmentReferenceIndex).toBeNull();
    await expect(result.current.deleteChats(result.current.inboxList)).rejects.toMatchObject({ name: 'AbortError' });
    unmount();
  });

  it('uses the inner native Messenger root for attachment checks and deletion', async () => {
    const selected = createMockDirectoryHandle('Download', { messenger: {
      'alice.json': JSON.stringify({ threadName: 'Native Messenger chat', participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1, text: 'hello', media: [{ uri: 'media/photo.jpg' }] }] }),
      media: { 'photo.jpg': 'photo bytes' },
    } });
    const root = await selected.getDirectoryHandle('messenger');
    const removeParent = vi.spyOn(selected, 'removeEntry');
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(selected));
    const { result, unmount } = renderHook(() => useArchive(true));

    await act(async () => { await result.current.openFolder(true, undefined, 'native'); });

    expect(result.current.error).toBeNull();
    expect(result.current.originalRootHandle).toBe(selected);
    expect(result.current.rootHandle).toBe(root);
    expect(result.current.inboxList[0].dirHandle).toBe(root);
    expect(result.current.attachmentReferenceIndex?.chatMedia.get('alice.json')).toEqual(new Set(['media/photo.jpg']));
    await expect(result.current.getDeleteInfo(result.current.inboxList[0])).resolves.toMatchObject({
      exclusiveMediaFiles: ['photo.jpg'], mediaSize: 11,
    });
    await act(async () => {
      const deletion = await result.current.deleteChats(result.current.inboxList);
      expect(deletion.deleted).toHaveLength(1);
      expect(deletion.failed).toEqual([]);
    });
    await expect(root.getFileHandle('alice.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect((await root.getDirectoryHandle('media')).getFileHandle('photo.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(removeParent).not.toHaveBeenCalled();
    expect(result.current.inboxList).toEqual([]);
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

  it.each([false, true])('identifies a native picker failure with write request=%s', async requestWrite => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(new DOMException('Requested document not found', 'NotFoundError')));
    const { result, unmount } = renderHook(() => useArchive(false, true));
    const picked = vi.fn();

    await act(async () => { await result.current.openFolder(requestWrite, picked, 'native'); });

    expect(result.current.error).toContain('Requested document not found');
    expect(result.current.error).toContain('stage=folder picker; operation=showDirectoryPicker()');
    expect(result.current.error).toContain(`picker returned=no; requested permission=${requestWrite ? 'readwrite' : 'read'}; error=NotFoundError`);
    expect(picked).not.toHaveBeenCalled();
    expect(result.current.folderSelectionPending).toBe(false);
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('identifies a native folder lookup failure', async () => {
    const root = createMockDirectoryHandle('private-export', {});
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValue(new DOMException('Access denied', 'NotAllowedError'));
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false, true));

    await act(async () => { await result.current.openFolder(); });

    expect(result.current.error).toContain('stage=Facebook folder lookup; operation=getDirectoryHandle(); folder depth=0');
    expect(result.current.error).toContain('picker returned=yes; requested permission=read; error=NotAllowedError');
    expect(result.current.error).not.toContain('private-export');
    unmount();
  });

  it.each([0, 2])('identifies native enumeration failures at folder depth %i', async depth => {
    const root = createMockDirectoryHandle('private-export', depth ? { wrapper: { wrapper: { 'notes.txt': 'private content' } } } : {});
    let current = root;
    for (let index = 0; index < depth; index++) current = await current.getDirectoryHandle('wrapper');
    vi.spyOn(current, 'entries').mockImplementation(async function* () {
      yield ['private.json', { kind: 'file', name: 'private.json', getFile: async () => new File(['{}'], 'private.json') }];
      throw new DOMException('Requested directory not found', 'NotFoundError');
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false, true));

    await act(async () => { await result.current.openFolder(); });

    expect(result.current.error).toContain(`stage=Messenger detection; operation=entries(); folder depth=${depth}; entries read=1`);
    expect(result.current.error).toContain('picker returned=yes');
    expect(result.current.error).not.toContain('private');
    unmount();
  });

  it.each(['getFile()', 'File.text()', 'JSON.parse()'])('identifies a native %s failure after later reads succeed', async operation => {
    const root = createMockDirectoryHandle('private-export', {
      'private-conversation.json': '{}', 'metadata.json': '{"settings":true}',
    });
    const fileHandle = await root.getFileHandle('private-conversation.json');
    const error = operation === 'JSON.parse()' ? new RangeError('Cannot parse the document')
      : new DOMException('Requested document not found', 'NotFoundError');
    if (operation === 'getFile()') vi.spyOn(fileHandle, 'getFile').mockRejectedValue(error);
    if (operation === 'File.text()') {
      const file = new File(['{}'], 'private-conversation.json');
      vi.spyOn(file, 'text').mockRejectedValue(error);
      vi.spyOn(fileHandle, 'getFile').mockResolvedValue(file);
    }
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false, true));
    if (operation === 'JSON.parse()') {
      const parse = JSON.parse;
      vi.spyOn(JSON, 'parse').mockImplementation((content, ...args) => {
        if (content === '{}') throw error;
        return parse(content, ...args);
      });
    }

    await act(async () => { await result.current.openFolder(); });

    expect(result.current.error).toContain(error.message);
    expect(result.current.error).toContain(`stage=Messenger detection; operation=${operation}; folder depth=0`);
    expect(result.current.error).toContain(`error=${error.name}`);
    expect(result.current.error).not.toContain('private');
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('identifies native enumeration failures while listing Facebook conversations', async () => {
    const root = facebookRoot('private-export');
    const inbox = await (await root.getDirectoryHandle('messages')).getDirectoryHandle('inbox');
    vi.spyOn(inbox, 'entries').mockImplementation(() => { throw new DOMException('Requested directory not found', 'NotFoundError'); });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false, true));

    await act(async () => { await result.current.openFolder(); });

    expect(result.current.error).toContain('stage=Facebook conversation listing; operation=entries(); entries read=0');
    expect(result.current.error).toContain('error=NotFoundError');
    unmount();
  });

  it('identifies native enumeration failures after Messenger detection succeeded', async () => {
    const root = createMockDirectoryHandle('private-export', {
      'alice.json': JSON.stringify({ threadName: 'Alice', participants: ['Alice'], messages: [] }),
    });
    const entries = root.entries.bind(root);
    let calls = 0;
    vi.spyOn(root, 'entries').mockImplementation(() => {
      if (++calls > 1) throw new DOMException('Requested directory not found', 'NotFoundError');
      return entries();
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    const { result, unmount } = renderHook(() => useArchive(false, true));

    await act(async () => { await result.current.openFolder(); });

    expect(result.current.error).toContain('stage=Messenger conversation listing; operation=entries(); entries read=0');
    expect(result.current.error).toContain('error=NotFoundError');
    unmount();
  });

  it('does not blame expected missing layout markers when the selected folder is unsupported', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(createMockDirectoryHandle('empty', {})));
    const { result, unmount } = renderHook(() => useArchive(false, true));
    await act(async () => { await result.current.openFolder(); });

    expect(result.current.error).toContain('Could not find messages');
    expect(result.current.error).toContain('stage=Messenger detection; operation=archive validation');
    expect(result.current.error).not.toContain('operation=getDirectoryHandle()');
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
