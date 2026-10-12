import { describe, expect, it, vi } from 'vitest';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import { createMediaState, findMediaFile, isMediaReferenceFound, processMediaFromDirectory, processMetaAttachmentReferences, resolveMessageMediaItems } from '../src/services/media';
import type { MessengerMessage } from '../src/types/messenger';

const message = (fields: Partial<MessengerMessage>): MessengerMessage => ({ sender_name: 'A', timestamp_ms: 1, ...fields });

describe('exact Meta archive media resolution', () => {
  it.each([false, true])('keeps duplicate bare filenames unresolved after registering references (reverse order: %s)', async reverse => {
    const root = createMockDirectoryHandle('messages', { inbox: { a: {
      photos: { 'same.png': 'photo bytes' }, files: { 'same.png': 'document bytes' },
    } } });
    const chat = await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a');
    const photo = await (await chat.getDirectoryHandle('photos')).getFileHandle('same.png');
    const document = await (await chat.getDirectoryHandle('files')).getFileHandle('same.png');
    const messages = [message({ photos: [{ uri: 'same.png' }] }), message({ files: [{ uri: 'same.png' }] })];
    const media = createMediaState();
    await processMediaFromDirectory(chat, media);
    await processMetaAttachmentReferences(root, 'inbox/a', reverse ? [...messages].reverse() : messages, media);
    for (const item of messages) expect(resolveMessageMediaItems(item, media)[0].mediaFile).toBeNull();
    expect(isMediaReferenceFound(media, 'same.png')).toBe(false);
    expect(findMediaFile(media, 'photos/same.png')?.handle).toBe(photo);
    expect(findMediaFile(media, 'messages/inbox/a/files/same.png')?.handle).toBe(document);
    expect(media.lookup.has('same.png')).toBe(false);
    expect(media.mediaFileCount).toBe(2);
  });

  it('resolves a unique bare filename without registering a direct alias', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: { a: { photos: { 'unique.png': 'photo' } } } });
    const photo = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a')).getDirectoryHandle('photos');
    const media = createMediaState();
    const item = message({ photos: [{ uri: 'unique.png' }] });
    await processMetaAttachmentReferences(root, 'inbox/a', [item, item], media);
    expect(resolveMessageMediaItems(item, media)[0].mediaFile?.handle).toBe(await photo.getFileHandle('unique.png'));
    expect(findMediaFile(media, 'photos/unique.png')).toBe(findMediaFile(media, 'unique.png'));
    expect(media.lookup.has('unique.png')).toBe(false);
    expect(media.mediaFileCount).toBe(1);
  });

  it('loads foreign images, videos, audio and documents while keeping identical local names separate', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {
      a: { photos: { 'shared.png': 'foreign image' }, videos: { 'shared.mp4': 'foreign video' },
        audio: { 'shared.ogg': 'foreign audio' }, files: { 'shared.pdf': 'foreign file' } },
      b: { photos: { 'shared.png': 'local image' }, videos: { 'shared.mp4': 'local video' } },
    } });
    const inbox = await root.getDirectoryHandle('inbox');
    const media = createMediaState();
    await processMediaFromDirectory(await inbox.getDirectoryHandle('b'), media);
    const foreignImage = 'your_facebook_activity\\messages\\inbox\\a\\photos\\shared.png';
    const foreignVideo = 'your_instagram_activity/messages/inbox/a/videos/shared.mp4';
    await processMetaAttachmentReferences(root, 'inbox/b', [message({
      photos: [{ uri: foreignImage }, { uri: 'photos/shared.png' }, { uri: foreignImage }],
      videos: [{ uri: foreignVideo }], audio_files: [{ uri: 'messages/inbox/a/audio/shared.ogg' }],
      files: [{ uri: 'inbox/a/files/shared.pdf' }],
    })], media);
    const foreign = await (await inbox.getDirectoryHandle('a')).getDirectoryHandle('photos');
    expect(findMediaFile(media, foreignImage)?.handle).toBe(await foreign.getFileHandle('shared.png'));
    expect(findMediaFile(media, 'photos/shared.png')?.handle).not.toBe(findMediaFile(media, foreignImage)?.handle);
    expect(findMediaFile(media, 'messages/inbox/b/photos/shared.png')).toBe(findMediaFile(media, 'photos/shared.png'));
    expect(findMediaFile(media, foreignVideo)?.type).toBe('video');
    expect(findMediaFile(media, 'messages/inbox/a/audio/shared.ogg')?.type).toBe('audio');
    expect(isMediaReferenceFound(media, 'inbox/a/files/shared.pdf')).toBe(true);
    expect(media.mediaFileCount).toBe(6); // Two local files plus four foreign files, without duplicate aliases.
  });

  it('never replaces a missing foreign, remote or unsafe path with a same-named local file', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: { b: { photos: { 'shared.png': 'local' } } } });
    const media = createMediaState();
    await processMediaFromDirectory(await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('b'), media);
    const paths = ['messages/inbox/missing/photos/shared.png', 'https://example.com/shared.png',
      '../inbox/b/photos/shared.png', '/inbox/b/photos/shared.png', 'messages/inbox/b/photos/%73hared.png'];
    await processMetaAttachmentReferences(root, 'inbox/b', [message({ photos: paths.map(uri => ({ uri })) })], media);
    for (const path of paths) {
      expect(findMediaFile(media, path)).toBeNull();
      expect(isMediaReferenceFound(media, path)).toBe(false);
    }
    expect(findMediaFile(media, 'photos/shared.png')).not.toBeNull();
  });

  it('loads global stickers and deduplicates aliases without reading original media bytes', async () => {
    const root = createMockDirectoryHandle('messages', { stickers_used: { 'shared.webp': 'sticker' }, inbox: { b: {} } });
    const file = await (await root.getDirectoryHandle('stickers_used')).getFileHandle('shared.webp');
    const read = vi.spyOn(file, 'getFile');
    const media = createMediaState();
    await processMetaAttachmentReferences(root, 'inbox/b', [
      message({ sticker: { uri: 'messages/stickers_used/shared.webp' } }),
      message({ sticker: { uri: './your_facebook_activity/messages/stickers_used/shared.webp' } }),
    ], media);
    expect(findMediaFile(media, 'stickers_used/shared.webp')?.handle).toBe(file);
    expect(findMediaFile(media, 'messages/stickers_used/shared.webp')?.type).toBe('image');
    expect(media.mediaFileCount).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not publish foreign media from a canceled pending lookup', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: { a: { photos: { 'shared.png': 'foreign' } } } });
    const photos = await (await (await root.getDirectoryHandle('inbox')).getDirectoryHandle('a')).getDirectoryHandle('photos');
    const getFile = photos.getFileHandle.bind(photos);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lookup = vi.spyOn(photos, 'getFileHandle').mockImplementation(async name => { await gate; return getFile(name); });
    const controller = new AbortController();
    const media = createMediaState();
    const work = processMetaAttachmentReferences(root, 'inbox/b', [message({ photos: [{ uri: 'messages/inbox/a/photos/shared.png' }] })], media, controller.signal);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    controller.abort(); release();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(media.lookup.size).toBe(0);
  });
});
