import { describe, expect, it } from 'vitest';
import {
  addMediaToIndex,
  createMediaState,
  findMediaFile,
  getMediaReferencePath,
  getMediaType,
  getMessageAttachmentReferences,
  getMessageMediaItems,
  isMediaReferenceFound,
} from '../src/services/media';
import type { MediaEntry, MessengerMessage } from '../src/types/messenger';

describe('media service', () => {
  it('maps common media extensions', () => {
    expect(getMediaType('photo.JPG')).toBe('image');
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
