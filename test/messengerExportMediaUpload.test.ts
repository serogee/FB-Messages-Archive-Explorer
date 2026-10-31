import { describe, expect, it, vi } from 'vitest';
import { createVirtualFileSystem } from '../src/services/polyfill';
import { createMediaState, findMediaFile } from '../src/services/media';
import { resolveMessengerExportRoot } from '../src/services/messengerExport/messengerExportDetector';
import { processMessengerExportMedia } from '../src/services/messengerExport/messengerExportMedia';
import { buildMessengerExportMediaSizeIndex, computeMessengerExportChatSize } from '../src/services/messengerExport/messengerExportSize';
import { checkMessengerAttachmentFiles } from '../src/services/messengerExport/messengerExportDiagnostics';
import { parseMessengerExportJson } from '../src/services/messengerExport/messengerExportParser';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

const conversation = JSON.stringify({ threadName: 'Chat', participants: ['Alice'], messages: [
  { senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/photo.jpg' }, { uri: 'media/documents/report.pdf' }] },
] });

function uploadFile(path: string, content = 'media bytes', relativePath = path): File {
  const file = new File([content], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

describe('Messenger attachments in flat folder uploads', () => {
  it.each(['tree/', 'content://com.android.externalstorage.documents/tree/'])('restores Android document paths from %s uploads', async prefix => {
    const selectedDirectory = 'primary:Download/Messenger export';
    const androidPath = (path: string) => `${prefix}${encodeURIComponent(selectedDirectory)}/document/${encodeURIComponent(`${selectedDirectory}/${path}`)}`;
    const photo = uploadFile('photo.jpg', 'image bytes', androidPath('media/photo.jpg'));
    const document = uploadFile('report.pdf', 'document bytes', androidPath('media/documents/report.pdf'));
    const root = createVirtualFileSystem([
      uploadFile('chat.json', conversation, androidPath('chat.json')), photo, document,
      uploadFile('photo.jpg', 'unrelated image', androidPath('media/other/photo.jpg')),
    ]);
    expect(await resolveMessengerExportRoot(root)).toBe(root);
    const state = createMediaState();
    await processMessengerExportMedia(root, state);

    expect(state.mediaFileCount).toBe(3);
    expect(await findMediaFile(state, 'media/photo.jpg')?.handle?.getFile()).toBe(photo);
    expect(await findMediaFile(state, 'media/documents/report.pdf')?.handle?.getFile()).toBe(document);
    const sizes = await buildMessengerExportMediaSizeIndex(root);
    expect(await computeMessengerExportChatSize(root, 'chat.json', sizes)).toBe(
      new Blob([conversation]).size + photo.size + document.size,
    );
    const report = await checkMessengerAttachmentFiles(root, parseMessengerExportJson(conversation), state);
    expect(report).toContain('Indexed files: 3\nMatched references: 2');
    expect(report).toContain('Attachment lookup: media folder');
    expect(report).toContain('Sample getFile(): OK\nSample file bytes: OK');
  });

  it.each(['', 'export/', 'Download/export/', 'storage/Download/export/'])('loads flat uploaded files with prefix "%s"', async prefix => {
    const photo = uploadFile(`${prefix}photo.jpg`);
    const document = uploadFile(`${prefix}report.pdf`);
    const root = (await resolveMessengerExportRoot(createVirtualFileSystem([
      uploadFile(`${prefix}chat.json`, conversation), uploadFile(`${prefix}settings.json`, '{"settings":true}'),
      photo, document,
    ])))!;
    const state = createMediaState();
    await processMessengerExportMedia(root, state);

    expect(state.mediaFileCount).toBe(2);
    expect(findMediaFile(state, 'media/photo.jpg')?.type).toBe('image');
    expect(await findMediaFile(state, 'media/photo.jpg')?.handle?.getFile()).toBe(photo);
    expect(await findMediaFile(state, 'media/documents/report.pdf')?.handle?.getFile()).toBe(document);
    expect(findMediaFile(state, 'chat.json')).toBeNull();
    expect(findMediaFile(state, 'settings.json')).toBeNull();
    const sizes = await buildMessengerExportMediaSizeIndex(root);
    expect(await computeMessengerExportChatSize(root, 'chat.json', sizes)).toBe(
      new Blob([conversation]).size + photo.size + document.size,
    );
    const report = await checkMessengerAttachmentFiles(root, parseMessengerExportJson(conversation), state);
    expect(report).toContain('Indexed files: 2\nMatched references: 2');
    expect(report).toContain('Attachment lookup: uploaded root files');
    expect(report).toContain('Root listing: OK (4 files, 0 folders)');
    expect(report).toContain('Sample getFile(): OK\nSample file bytes: OK');
  });

  it('keeps using media paths when the uploaded folder structure is present', async () => {
    const photo = uploadFile('export/media/photo.jpg', 'correct image');
    const root = createVirtualFileSystem([
      uploadFile('export/chat.json', conversation), photo, uploadFile('export/photo.jpg', 'unrelated image'),
      uploadFile('export/media/documents/report.pdf'),
    ]);
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    expect(state.mediaFileCount).toBe(2);
    expect(await findMediaFile(state, 'media/photo.jpg')?.handle?.getFile()).toBe(photo);
  });

  it('does not scan root files in native folders or uploads containing subfolders', async () => {
    const roots = [
      createMockDirectoryHandle('export', { 'chat.json': conversation, 'photo.jpg': 'image bytes' }),
      createVirtualFileSystem([
        uploadFile('export/chat.json', conversation), uploadFile('export/photo.jpg'), uploadFile('export/other/unrelated.jpg'),
      ]),
    ];
    for (const root of roots) {
      const state = createMediaState();
      await processMessengerExportMedia(root, state);
      expect(state.mediaFileCount).toBe(0);
      expect(findMediaFile(state, 'media/photo.jpg')).toBeNull();
      expect((await buildMessengerExportMediaSizeIndex(root)).size).toBe(0);
    }
  });

  it('does not pick between flattened filenames that differ only by case', async () => {
    const root = createVirtualFileSystem([
      uploadFile('export/chat.json', conversation), uploadFile('export/Photo.jpg'), uploadFile('export/photo.jpg'),
      uploadFile('export/PHOTO.jpg'),
    ]);
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    expect(findMediaFile(state, 'media/photo.jpg')).toBeNull();
    expect(findMediaFile(state, 'photo.jpg')).toBeNull();
    expect((await buildMessengerExportMediaSizeIndex(root)).size).toBe(0);
  });

  it('does not replace a permission error with the flat-upload fallback', async () => {
    const root = createVirtualFileSystem([uploadFile('export/photo.jpg')]);
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    expect(state.mediaFileCount).toBe(0);
    await expect(buildMessengerExportMediaSizeIndex(root)).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('discards flat files when indexing is cancelled', async () => {
    const root = createVirtualFileSystem([uploadFile('export/photo.jpg')]);
    const controller = new AbortController();
    const entries = root.entries.bind(root);
    vi.spyOn(root, 'entries').mockImplementation(async function* () {
      controller.abort();
      yield* entries();
    });
    const state = createMediaState();
    await processMessengerExportMedia(root, state, undefined, controller.signal);
    expect(state.mediaFileCount).toBe(0);
    await expect(buildMessengerExportMediaSizeIndex(root, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
