// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { resolveFacebookMessagesRoot } from '../src/services/fileSystem';
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

describe('folder-upload filesystem fallback', () => {
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

  it('rejects a picker change that has no files', async () => {
    const input = {
      type: '',
      multiple: false,
      webkitdirectory: false,
      onchange: null as ((event: Event) => void) | null,
      setAttribute: vi.fn(),
      click() {
        this.onchange?.({ target: { files: null } } as unknown as Event);
      },
    };
    vi.spyOn(document, 'createElement').mockReturnValue(input as unknown as HTMLInputElement);

    await expect(openFolderPolyfill()).rejects.toThrow('No files selected');
  });
});
