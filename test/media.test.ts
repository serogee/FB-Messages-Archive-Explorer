import { describe, expect, it } from 'vitest';
import {
  addMediaToIndex,
  createMediaState,
  findMediaFile,
  getMediaReferencePath,
  getMediaType,
  getFacebookStickerFileName,
  getMessageAttachmentReferences,
  getMessageMediaItems,
  isMediaReferenceFound,
  processFacebookStickerReferences,
  resolveMessageMediaItems,
} from '../src/services/media';
import type { MediaEntry, MessengerMessage } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

describe('media service', () => {
  it('maps common media extensions', () => {
    expect(getMediaType('photo.JPG')).toBe('image');
    expect(getMediaType('sticker.WEBP')).toBe('image');
    expect(getMediaType('clip.mp4')).toBe('video');
    expect(getMediaType('voice.m4a')).toBe('audio');
    expect(getMediaType('archive.zip')).toBe('unknown');
  });

  it('uses the expected media reference fallback order', () => {
    expect(getMediaReferencePath({ uri: 'uri', filename: 'filename', path: 'path', name: 'name' })).toBe('uri');
    expect(getMediaReferencePath({ filename: 'filename', path: 'path', name: 'name' })).toBe('filename');
    expect(getMediaReferencePath({ path: 'path', name: 'name' })).toBe('path');
    expect(getMediaReferencePath({ name: 'name' })).toBe('name');
  });

  it('deduplicates media items by path', () => {
    const msg = {
      sender_name: 'Alice',
      timestamp_ms: 1,
      photos: [{ uri: 'photos/a.jpg' }],
      media: [{ uri: 'photos/a.jpg' }, { uri: 'videos/b.mp4' }],
    } satisfies MessengerMessage;

    expect(getMessageMediaItems(msg).map(item => item.uri)).toEqual(['photos/a.jpg', 'videos/b.mp4']);
  });

  it('resolves rendering media with stable precedence, types, and sticker metadata', () => {
    const state = createMediaState();
    const photo: MediaEntry = { type: 'image' };
    const video: MediaEntry = { type: 'video' };
    const sticker: MediaEntry = { type: 'image' };
    addMediaToIndex(state, 'photos/a.jpg', photo);
    addMediaToIndex(state, 'videos/b.bin', video);
    addMediaToIndex(state, 'stickers/c.webp', sticker);

    const resolved = resolveMessageMediaItems({
      sender_name: 'Alice',
      timestamp_ms: 1,
      photos: [{ uri: 'photos/a.jpg' }],
      videos: [{ uri: 'videos/b.bin' }],
      media: [{ uri: 'photos/a.jpg' }],
      sticker: { uri: 'stickers/c.webp' },
    }, state);

    expect(resolved.map(item => ({
      path: item.mediaPath,
      type: item.mediaType,
      preferredType: item.preferredType,
      isSticker: item.isSticker,
      entry: item.mediaFile,
    }))).toEqual([
      { path: 'photos/a.jpg', type: 'image', preferredType: 'image', isSticker: false, entry: photo },
      { path: 'videos/b.bin', type: 'video', preferredType: 'video', isSticker: false, entry: video },
      { path: 'stickers/c.webp', type: 'image', preferredType: 'image', isSticker: true, entry: sticker },
    ]);
  });

  it('categorizes attachment references', () => {
    const refs = getMessageAttachmentReferences({
      sender_name: 'Alice',
      timestamp_ms: 1,
      photos: [{ uri: 'photos/a.jpg' }],
      videos: [{ uri: 'videos/b.mp4' }],
      audio_files: [{ uri: 'audio/c.m4a' }],
      media: [{ uri: 'media/d.gif' }, { uri: 'media/e.pdf' }],
    });

    expect(refs).toEqual([
      { path: 'photos/a.jpg', category: 'photos' },
      { path: 'videos/b.mp4', category: 'videos' },
      { path: 'audio/c.m4a', category: 'audio' },
      { path: 'media/d.gif', category: 'gifs' },
      { path: 'media/e.pdf', category: 'files' },
    ]);
  });

  it('categorizes Facebook stickers as shared attachments', () => {
    const sticker = {
      uri: 'your_facebook_activity/messages/stickers_used/827898137002625.webp',
      ai_stickers: [],
    };
    const message = {
      sender_name: 'Alice',
      timestamp_ms: 1,
      sticker,
    } satisfies MessengerMessage;

    expect(getMessageAttachmentReferences(message)).toEqual([{
      path: sticker.uri,
      category: 'stickers',
      shared: true,
    }]);
    expect(getMessageMediaItems(message)).toEqual([sticker]);
  });

  it('accepts supported Facebook sticker path variants only', () => {
    expect(getFacebookStickerFileName('your_facebook_activity/messages/stickers_used/1.webp')).toBe('1.webp');
    expect(getFacebookStickerFileName('messages/stickers_used/2.PNG')).toBe('2.PNG');
    expect(getFacebookStickerFileName('./stickers_used/3.jpg')).toBe('3.jpg');
    expect(getFacebookStickerFileName('media/3.webp')).toBeNull();
    expect(getFacebookStickerFileName('stickers_used/nested/3.webp')).toBeNull();
    expect(getFacebookStickerFileName('stickers_used/clip.mp4')).toBeNull();
  });

  it('indexes referenced Facebook stickers without increasing chat media totals', async () => {
    const root = createMockDirectoryHandle('messages', {
      stickers_used: {
        '1.png': new Uint8Array([1, 2, 3]),
      },
    });
    const state = createMediaState();
    const messages: MessengerMessage[] = [{
      sender_name: 'Alice',
      timestamp_ms: 1,
      sticker: { uri: 'your_facebook_activity/messages/stickers_used/1.png' },
    }, {
      sender_name: 'Bob',
      timestamp_ms: 2,
      sticker: { uri: 'your_facebook_activity/messages/stickers_used/missing.webp' },
    }];

    await processFacebookStickerReferences(root, messages, state);

    expect(findMediaFile(state, messages[0].sticker!.uri!)?.type).toBe('image');
    expect(findMediaFile(state, messages[1].sticker!.uri!)).toBeNull();
    expect(state.mediaFileCount).toBe(0);
  });

  it('finds indexed media by full path and basename', () => {
    const state = createMediaState();
    const entry: MediaEntry = { type: 'image' };

    addMediaToIndex(state, 'photos/Photo.JPG', entry);

    expect(isMediaReferenceFound(state, 'photos/photo.jpg')).toBe(true);
    expect(isMediaReferenceFound(state, 'other/photo.jpg')).toBe(true);
    expect(findMediaFile(state, 'photos/photo.jpg')).toBe(entry);
    expect(findMediaFile(state, 'photo.jpg')).toBe(entry);
  });
});
