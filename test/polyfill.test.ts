// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFileSystemAccessSupported, pickMessagesFolder, pickFolderWithWriteAccess, resolveFacebookMessagesRoot } from '../src/services/fileSystem';
import { isMessengerExport } from '../src/services/messengerExport/messengerExportDetector';
import { createVirtualFileSystem, openFolderPolyfill } from '../src/services/polyfill';
import { isWritableDirectoryHandle } from '../src/types/fileSystem';
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

function folderUploadFile(path: string, content = '{}'): File {
  const fileName = path.split('/').pop() || 'file';
  const file = new File([content], fileName);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('folder-upload filesystem fallback', () => {
  it('reports preparation before reading paths and yields during a large upload', async () => {
    let pathsRead = 0;
    let pathsReadDuringYield: number | undefined;
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 16);
    const files = Array.from({ length: 1024 }, (_, index) => {
      const file = new File(['{}'], `${index}.json`);
      Object.defineProperty(file, 'webkitRelativePath', { get: () => {
        pathsRead++;
        return `messages/inbox/alice/${index}.json`;
      } });
      return file;
    });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: files });
      this.dispatchEvent(new Event('change'));
    });
    const onProgress = vi.fn((done: number) => {
      if (done === 0) expect(pathsRead).toBe(0);
      if (done > 0 && done < files.length && pathsReadDuringYield === undefined) {
        setTimeout(() => { pathsReadDuringYield = pathsRead; }, 0);
      }
    });

    const root = await openFolderPolyfill(onProgress);
    expect(onProgress.mock.calls[0]).toEqual([0, files.length]);
    expect(onProgress.mock.calls.at(-1)).toEqual([files.length, files.length]);
    expect(pathsReadDuringYield).toBeGreaterThan(0);
    expect(pathsReadDuringYield).toBeLessThan(files.length);
    expect(pathsRead).toBe(files.length);
    const alice = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('alice');
    await expect((await alice.getFileHandle('1023.json')).getFile()).resolves.toBe(files[1023]);
    expect(isWritableDirectoryHandle(root)).toBe(false);
  });

  it.each([pickMessagesFolder, pickFolderWithWriteAccess])('loads an explicitly selected mobile upload even when a native picker is available (%s)', async pick => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14) Chrome/132.0.0.0 Mobile Safari/537.36');
    const nativePicker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', nativePicker);
    expect(isFileSystemAccessSupported()).toBe(true);
    const input = document.createElement('input');
    const files = [folderUploadFile('messages/inbox/alice/message_1.json')];
    Object.defineProperty(input, 'files', { value: files });
    vi.spyOn(input, 'click').mockImplementation(() => { input.dispatchEvent(new Event('change')); });
    vi.spyOn(document, 'createElement').mockReturnValue(input);

    const root = await pick('upload');
    expect(input.webkitdirectory).toBe(true);
    expect(nativePicker).not.toHaveBeenCalled();
    await expect(resolveFacebookMessagesRoot(root)).resolves.toBe(root);
    const alice = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('alice');
    await expect((await alice.getFileHandle('message_1.json')).getFile()).resolves.toBe(files[0]);
  });
  it.each([
    { pick: pickMessagesFolder, mode: 'read' },
    { pick: pickFolderWithWriteAccess, mode: 'readwrite' },
  ] as const)('keeps native mobile access with $mode permission', async ({ pick, mode }) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14) Chrome/132.0.0.0 Mobile Safari/537.36');
    const root = createMockDirectoryHandle('messages', { inbox: {} });
    const nativePicker = vi.fn().mockResolvedValue(root);
    vi.stubGlobal('showDirectoryPicker', nativePicker);

    await expect(pick()).resolves.toBe(root);
    expect(nativePicker).toHaveBeenCalledExactlyOnceWith({ id: 'messages-folder', mode });
    expect(isWritableDirectoryHandle(root)).toBe(true);
  });
  it.each([pickMessagesFolder, pickFolderWithWriteAccess])('falls back to read-only access when the native API is unavailable (%s)', async pick => {
    vi.stubGlobal('showDirectoryPicker', undefined);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: [folderUploadFile('messages/inbox/alice/message_1.json')] });
      this.dispatchEvent(new Event('change'));
    });

    const root = await pick();
    expect(isWritableDirectoryHandle(root)).toBe(false);
    await expect(resolveFacebookMessagesRoot(root)).resolves.toBe(root);
  });
  it('models the selected export directory as the virtual root', async () => {
    const root = createVirtualFileSystem([
      folderUploadFile('facebook-export/messages/inbox/alice/message_1.json'),
    ]);

    const messagesRoot = await resolveFacebookMessagesRoot(root);
    expect(messagesRoot?.name).toBe('messages');
    await expect(messagesRoot?.getDirectoryHandle('inbox')).resolves.toMatchObject({ kind: 'directory' });
  });

  it('models a directly selected messages directory as the virtual root', async () => {
    const root = createVirtualFileSystem([
      folderUploadFile('messages/archived_threads/alice/message_1.json'),
    ]);

    await expect(resolveFacebookMessagesRoot(root)).resolves.toBe(root);
  });

  it.each([
    'instagram-export/your_instagram_activity/messages/message_requests/alice/message_1.json',
    'your_instagram_activity/messages/message_requests/alice/message_1.json',
    'messages/message_requests/alice/message_1.json',
  ])('recognizes an Instagram folder upload from %s', async path => {
    const root = createVirtualFileSystem([folderUploadFile(path)]);
    const messagesRoot = await resolveFacebookMessagesRoot(root);

    expect(messagesRoot).not.toBeNull();
    await expect(messagesRoot?.getDirectoryHandle('message_requests')).resolves.toMatchObject({ kind: 'directory' });
  });

  it('exposes standalone Messenger JSON files at the virtual root', async () => {
    const root = createVirtualFileSystem([
      folderUploadFile('messenger-export/alice.json', JSON.stringify({
        threadName: 'Alice',
        participants: ['Alice', 'Bob'],
        messages: [],
      })),
    ]);

    await expect(isMessengerExport(root)).resolves.toBe(true);
  });

  it('keeps fallback handles read-only while native handles remain writable', () => {
    const fallbackRoot = createVirtualFileSystem([
      folderUploadFile('messages/inbox/alice/message_1.json'),
    ]);
    const nativeRoot = createMockDirectoryHandle('messages', { inbox: {} });

    expect(isWritableDirectoryHandle(fallbackRoot)).toBe(false);
    expect(isWritableDirectoryHandle(nativeRoot)).toBe(true);
  });

  it('rejects duplicate, colliding, and malformed uploaded paths', () => {
    expect(() => createVirtualFileSystem([
      folderUploadFile('export/messages/item.json'),
      folderUploadFile('export/messages/item.json'),
    ])).toThrow(/collision/i);
    expect(() => createVirtualFileSystem([
      folderUploadFile('export/messages'),
      folderUploadFile('export/messages/item.json'),
    ])).toThrow(/collision/i);
    expect(() => createVirtualFileSystem([
      folderUploadFile('export/../item.json'),
    ])).toThrow(/invalid uploaded file path/i);
  });

  it.each([
    ['primary:Download/export', 'primary:Download/export-other/media/photo.jpg'],
    ['primary:Download/export', 'primary:Download/export/../photo.jpg'],
    ['primary:Download/export', 'primary:Download/export/media//photo.jpg'],
    ['primary:Download/export', 'primary:Download/export/media/./photo.jpg'],
    ['primary:Download/export', 'primary:Download/export/media/other.jpg'],
    ['primary:Download/export', '%invalid'],
  ])('rejects Android document paths outside the selected folder or with invalid segments (%s, %s)', (tree, document) => {
    const file = new File(['image'], 'photo.jpg');
    Object.defineProperty(file, 'webkitRelativePath', { value: `tree/${encodeURIComponent(tree)}/document/${encodeURIComponent(document)}` });
    expect(() => createVirtualFileSystem([file])).toThrow(/invalid uploaded file path/i);
  });

  it('decodes Android document identifiers once and preserves literal encoded filenames in ordinary uploads', async () => {
    const name = 'photo%20name.jpg';
    const android = new File(['android image'], name);
    Object.defineProperty(android, 'webkitRelativePath', { value: `tree/primary%3Aexport/document/${encodeURIComponent(`primary:export/media/${name}`)}` });
    const ordinary = new File(['ordinary image'], name);
    Object.defineProperty(ordinary, 'webkitRelativePath', { value: `export/media/${name}` });
    for (const file of [android, ordinary]) {
      const root = createVirtualFileSystem([file]);
      const media = await root.getDirectoryHandle('media');
      expect(await (await media.getFileHandle(name)).getFile()).toBe(file);
      await expect(media.getFileHandle('photo name.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });

  it('preserves ordinary folders named tree and document', async () => {
    const file = folderUploadFile('tree/albums/document/photo.jpg');
    const root = createVirtualFileSystem([file]);
    const directory = await (await root.getDirectoryHandle('albums')).getDirectoryHandle('document');
    expect(await (await directory.getFileHandle('photo.jpg')).getFile()).toBe(file);
  });

  it('reports cancellation without preparing uploaded files', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      this.dispatchEvent(new Event('cancel'));
    });
    const onProgress = vi.fn();
    await expect(openFolderPolyfill(onProgress)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects a picker change that has no files', async () => {
    const input = {
      type: '',
      multiple: false,
      webkitdirectory: false,
      onchange: null as ((event: Event) => void) | null,
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      click() {
        this.onchange?.({ target: { files: null } } as unknown as Event);
      },
    };
    vi.spyOn(document, 'createElement').mockReturnValue(input as unknown as HTMLInputElement);

    await expect(openFolderPolyfill()).rejects.toThrow('No files selected');
  });
});
