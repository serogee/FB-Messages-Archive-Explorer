import { describe, expect, it } from 'vitest';
import { resolveFacebookMessagesRoot } from '../src/services/fileSystem';
import { isMessengerExport } from '../src/services/messengerExport/messengerExportDetector';
import { createVirtualFileSystem } from '../src/services/polyfill';
import { isWritableDirectoryHandle } from '../src/types/fileSystem';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

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
});
