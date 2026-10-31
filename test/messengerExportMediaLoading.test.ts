import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaState, findMediaFile } from '../src/services/media';
import { readListedFile } from '../src/services/listedFileAccess';
import { processMessengerExportMedia } from '../src/services/messengerExport/messengerExportMedia';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

afterEach(() => vi.restoreAllMocks());

describe('native Messenger media loading', () => {
  it('indexes all attachments without reopening files after the root needs filename recovery', async () => {
    const root = createMockDirectoryHandle('export', {
      'chat.json': '{}', media: { 'photo.jpg': 'image bytes', 'document.pdf': 'document bytes' },
    });
    await readListedFile(root, 'chat.json', {
      kind: 'file', name: 'chat.json',
      getFile: async () => { throw new DOMException('Listed document not found', 'NotFoundError'); },
    });
    const media = await root.getDirectoryHandle('media');
    const photo = await media.getFileHandle('photo.jpg');
    const read = vi.spyOn(photo, 'getFile');
    const lookup = vi.spyOn(media, 'getFileHandle');
    const state = createMediaState();

    await processMessengerExportMedia(root, state);

    expect(state.mediaFileCount).toBe(2);
    expect(lookup).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await findMediaFile(state, 'media/photo.jpg')!.handle!.getFile()).toHaveProperty('size', 11);
  });

  it('recovers unreadable listed media only when requested and remembers recovery within that directory', async () => {
    const root = createMockDirectoryHandle('export', { media: { 'one.jpg': 'one', 'two.jpg': 'two' } });
    const media = await root.getDirectoryHandle('media');
    const entries = media.entries.bind(media);
    const listedRead = vi.fn(async () => { throw new DOMException('Listed document not found', 'NotFoundError'); });
    vi.spyOn(media, 'entries').mockImplementation(async function* () {
      for await (const [name] of entries()) yield [name, { kind: 'file', name, getFile: listedRead }];
    });
    const lookup = vi.spyOn(media, 'getFileHandle');
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    expect(lookup).not.toHaveBeenCalled();
    expect(listedRead).not.toHaveBeenCalled();

    expect(await (await findMediaFile(state, 'media/one.jpg')!.handle!.getFile()).text()).toBe('one');
    expect(await (await findMediaFile(state, 'media/two.jpg')!.handle!.getFile()).text()).toBe('two');
    expect(listedRead).toHaveBeenCalledOnce();
    expect(lookup.mock.calls).toEqual([['one.jpg', { create: false }], ['two.jpg', { create: false }]]);
  });

  it('does not retry permission errors or hide other indexed attachments', async () => {
    const root = createMockDirectoryHandle('export', { media: { 'denied.jpg': 'one', 'readable.jpg': 'two' } });
    const media = await root.getDirectoryHandle('media');
    const denied = await media.getFileHandle('denied.jpg');
    vi.spyOn(denied, 'getFile').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    const lookup = vi.spyOn(media, 'getFileHandle');
    const state = createMediaState();
    await processMessengerExportMedia(root, state);

    await expect(findMediaFile(state, 'media/denied.jpg')!.handle!.getFile()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(await (await findMediaFile(state, 'media/readable.jpg')!.handle!.getFile()).text()).toBe('two');
    expect(lookup).not.toHaveBeenCalled();
    expect(state.mediaFileCount).toBe(2);
  });

  it('shares one file snapshot across concurrent preview, dimension, and download reads', async () => {
    const root = createMockDirectoryHandle('export', { media: { 'photo.jpg': 'image bytes' } });
    const photo = await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg');
    const read = vi.spyOn(photo, 'getFile');
    const state = createMediaState();
    await processMessengerExportMedia(root, state);
    const handle = findMediaFile(state, 'media/photo.jpg')!.handle!;
    const files = await Promise.all([handle.getFile(), handle.getFile(), handle.getFile()]);
    expect(read).toHaveBeenCalledOnce();
    expect(files.every(file => file === files[0])).toBe(true);
    expect(await handle.getFile()).toBe(files[0]);
    expect(read).toHaveBeenCalledOnce();
  });

  it('retries a failed snapshot read and starts fresh when the chat is indexed again', async () => {
    const root = createMockDirectoryHandle('export', { media: { 'photo.jpg': 'image bytes' } });
    const photo = await (await root.getDirectoryHandle('media')).getFileHandle('photo.jpg');
    const read = vi.spyOn(photo, 'getFile').mockRejectedValueOnce(new DOMException('Temporarily denied', 'NotAllowedError'));
    const first = createMediaState();
    await processMessengerExportMedia(root, first);
    const handle = findMediaFile(first, 'media/photo.jpg')!.handle!;
    await expect(handle.getFile()).rejects.toMatchObject({ name: 'NotAllowedError' });
    const file = await handle.getFile();
    expect(read).toHaveBeenCalledTimes(2);
    const second = createMediaState();
    await processMessengerExportMedia(root, second);
    expect(await findMediaFile(second, 'media/photo.jpg')!.handle!.getFile()).not.toBe(file);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
