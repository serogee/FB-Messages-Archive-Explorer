import { describe, expect, it, vi } from 'vitest';
import { readMp4MediaType } from '../src/services/mp4MediaType';
import { addMediaToIndex, classifyChatMp4Attachments, createMediaState, getMessageAttachmentReferences, resolveMessageMediaItems } from '../src/services/media';
import type { MediaEntry, MessengerMessage, MessengerThread } from '../src/types/messenger';
import { mp4Box, mp4Track } from './helpers/mp4Fixtures';

describe('MP4 media types', () => {
  it.each([
    { handlers: ['soun'], type: 'audio' },
    { handlers: ['soun', 'vide'], type: 'video' },
    { handlers: ['vide', 'soun'], type: 'video' },
    { handlers: ['vide'], type: 'video' },
    { handlers: ['text'], type: null },
  ])('classifies $handlers as $type', async ({ handlers, type }) => {
    const file = new Blob([mp4Box('moov', ...handlers.map(mp4Track))]);
    await expect(readMp4MediaType(file)).resolves.toBe(type);
  });

  it('finds metadata after a large media payload without loading the payload', async () => {
    const file = new Blob([mp4Box('mdat', new Uint8Array(2 * 1024 * 1024)), mp4Box('moov', mp4Track('soun'))]);
    const slice = vi.spyOn(file, 'slice');
    await expect(readMp4MediaType(file)).resolves.toBe('audio');
    const bytesRequested = slice.mock.calls.reduce((size, [start = 0, end = file.size]) => size + end - start, 0);
    expect(bytesRequested).toBeLessThan(200);
  });

  it('handles a 64-bit box header', async () => {
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1);
    header.set(new TextEncoder().encode('free'), 4);
    view.setBigUint64(8, 16n);
    await expect(readMp4MediaType(new Blob([header, mp4Box('moov', mp4Track('soun'))]))).resolves.toBe('audio');
  });

  it('keeps unknown or malformed containers unclassified', async () => {
    await expect(readMp4MediaType(new Blob(['not an mp4']))).resolves.toBeNull();
    await expect(readMp4MediaType(new Blob([mp4Box('moov', mp4Box('trak'))]))).resolves.toBeNull();
    const malformed = mp4Box('moov', mp4Track('soun'));
    new DataView(malformed.buffer).setUint32(8, malformed.length + 1);
    await expect(readMp4MediaType(new Blob([malformed]))).resolves.toBeNull();
    await expect(readMp4MediaType(new Blob([mp4Box('moov', new Uint8Array(9 * 1024 * 1024))]))).resolves.toBeNull();
  });

  it('stops before reading an abandoned file', async () => {
    const file = new Blob([mp4Box('moov', mp4Track('soun'))]);
    const slice = vi.spyOn(file, 'slice');
    await expect(readMp4MediaType(file, AbortSignal.abort())).resolves.toBeNull();
    expect(slice).not.toHaveBeenCalled();
  });

  it('classifies only referenced MP4 files and uses audio consistently in chat and gallery references', async () => {
    const path = './media/voice.mp4';
    const file = new File([mp4Box('moov', mp4Track('soun'))], 'voice.mp4');
    const getFile = vi.fn(async () => file);
    const entry: MediaEntry = { type: 'video', handle: { kind: 'file', name: file.name, getFile } };
    const unrelated = { type: 'video', handle: { kind: 'file', name: 'unused.mp4', getFile: vi.fn() } };
    const state = createMediaState();
    addMediaToIndex(state, 'media/voice.mp4', entry);
    addMediaToIndex(state, 'media/unused.mp4', unrelated);
    const message: MessengerMessage = { sender_name: 'Alice', timestamp_ms: 1, videos: [{ uri: path }], media: [{ uri: path }] };
    const thread: MessengerThread = { title: 'Chat', participants: [], messages: [message, { ...message, timestamp_ms: 2 }], thread_path: 'chat', is_still_participant: true };
    await classifyChatMp4Attachments(thread, state);
    expect(entry.type).toBe('audio');
    expect(state.types['media/voice.mp4']).toBe('audio');
    expect(getFile).toHaveBeenCalledOnce();
    expect(unrelated.handle.getFile).not.toHaveBeenCalled();
    expect(getMessageAttachmentReferences(message, state)).toEqual([{ path, category: 'audio' }]);
    expect(resolveMessageMediaItems(message, state)).toMatchObject([{ mediaType: 'audio', preferredType: 'audio' }]);
    await classifyChatMp4Attachments(thread, state);
    expect(getFile).toHaveBeenCalledOnce();
  });
});
