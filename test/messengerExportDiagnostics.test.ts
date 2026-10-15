import { describe, expect, it, vi } from 'vitest';
import { createMediaState } from '../src/services/media';
import { checkMessengerAttachmentFiles } from '../src/services/messengerExport/messengerExportDiagnostics';
import { processMessengerExportMedia } from '../src/services/messengerExport/messengerExportMedia';
import { parseMessengerExportJson } from '../src/services/messengerExport/messengerExportParser';
import { resolveMessengerExportRoot } from '../src/services/messengerExport/messengerExportDetector';
import { createVirtualFileSystem } from '../src/services/polyfill';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

const content = (uri = 'media/photo.jpg') => JSON.stringify({ threadName: 'Chat', participants: ['Alice'],
  messages: [{ senderName: 'Alice', timestamp: 1, media: [{ uri }] }] });
const thread = () => parseMessengerExportJson(content());
const makeRoot = () => createMockDirectoryHandle('export', { 'chat.json': content(), media: { 'photo.jpg': 'image bytes' } });

describe('Messenger attachment file diagnostics', () => {
  it('checks image bytes from a nested read-only upload without including names or contents', async () => {
    const files = [new File([content()], 'chat.json'), new File(['image bytes'], 'photo.jpg')];
    for (const [index, path] of ['Download/export/chat.json', 'Download/export/media/photo.jpg'].entries()) {
      Object.defineProperty(files[index], 'webkitRelativePath', { value: path });
    }
    const root = (await resolveMessengerExportRoot(createVirtualFileSystem(files)))!;
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    const report = await checkMessengerAttachmentFiles(root, thread(), state);
    expect(report).toContain('Indexed files: 1\nMatched references: 1');
    expect(report).toContain('Media listing: OK (1 files)');
    expect(report).toContain('Sample getFile(): OK\nSample file bytes: OK');
    expect(report).not.toMatch(/photo\.jpg|image bytes|Alice/);
  });

  it.each([false, true])('distinguishes a missing media folder from different capitalization=%s', async capitalized => {
    const root = createMockDirectoryHandle('export', capitalized ? { Media: { 'photo.jpg': 'image bytes' } } : {});
    const report = await checkMessengerAttachmentFiles(root, thread(), createMediaState());
    expect(report).toContain('Attachment references: 1\nIndexed files: 0\nMatched references: 0');
    expect(report).toContain(`Different capitalization of media folder: ${capitalized ? 'yes' : 'no'}`);
    expect(report).toContain('Media folder lookup: NotFoundError');
    expect(report).toContain('Sample getFile(): not checked (no matched file)');
  });

  it('identifies URL-encoded filename mismatches', async () => {
    const root = createMockDirectoryHandle('export', { media: { 'photo name.jpg': 'image bytes' } });
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    const report = await checkMessengerAttachmentFiles(root, parseMessengerExportJson(content('media/photo%20name.jpg')), state);
    expect(report).toContain('Indexed files: 1\nMatched references: 0\nAdditional matches after URL decoding: 1');
    expect(report).toContain('Media folder lookup: OK');
  });

  it('identifies a matched handle whose file cannot be opened', async () => {
    const root = makeRoot();
    const handle = await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg');
    vi.spyOn(handle, 'getFile').mockRejectedValue(new DOMException('Document unavailable', 'NotFoundError'));
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    const report = await checkMessengerAttachmentFiles(root, thread(), state);
    expect(report).toContain('Matched references: 1');
    expect(report).toContain('Sample getFile(): NotFoundError\nSample file bytes: not checked');
  });

  it('identifies an unreadable file snapshot and probes only its first byte', async () => {
    const root = makeRoot();
    const handle = await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg');
    const file = await handle.getFile();
    vi.spyOn(handle, 'getFile').mockResolvedValue(file);
    const slice = vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: async () => {
      throw new DOMException('Snapshot unavailable', 'NotReadableError');
    } } as Blob);
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    const report = await checkMessengerAttachmentFiles(root, thread(), state);
    expect(report).toContain('Sample getFile(): OK\nSample file bytes: NotReadableError');
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 1);
  });

  it('discards a check cancelled during file access', async () => {
    const root = makeRoot();
    const controller = new AbortController();
    const handle = await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg');
    const getFile = handle.getFile.bind(handle);
    vi.spyOn(handle, 'getFile').mockImplementation(async () => { controller.abort(); return getFile(); });
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    await expect(checkMessengerAttachmentFiles(root, thread(), state, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
