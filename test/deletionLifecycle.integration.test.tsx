// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchive } from '../src/hooks/useArchive';
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

afterEach(() => vi.restoreAllMocks());

describe('archive deletion lifecycle', () => {
  it('keeps a partially deleted Messenger chat retryable and removes it after retry', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'a.json': JSON.stringify({
        threadName: 'A', participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 2, media: [
          { uri: 'media/blocked.jpg' }, { uri: 'media/removed.jpg' },
        ] }],
      }),
      'b.json': JSON.stringify({
        threadName: 'B', participants: ['Bob'],
        messages: [{ senderName: 'Bob', timestamp: 1, text: 'keep' }],
      }),
      media: {
        'blocked.jpg': new Uint8Array([1]),
        'removed.jpg': new Uint8Array([2]),
      },
    });
    const media = await root.getDirectoryHandle('media');
    const removeMedia = media.removeEntry.bind(media);
    let failOnce = true;
    vi.spyOn(media, 'removeEntry').mockImplementation(async name => {
      if (name === 'blocked.jpg' && failOnce) {
        failOnce = false;
        throw new DOMException('denied', 'NotAllowedError');
      }
      return removeMedia(name);
    });
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => root) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useArchive());
    await act(async () => { await result.current.openFolder(); });
    const target = result.current.inboxList.find(entry => entry._jsonFileName === 'a.json')!;
    const progress: Array<{ stage: string; done: number; total: number }> = [];

    await act(async () => { await result.current.suspendSizeWork(); });
    let firstResult!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => {
      firstResult = await result.current.deleteChats([target], value => progress.push(value));
    });
    result.current.resumeSizeWork();

    expect(firstResult.deleted).toEqual([]);
    expect(firstResult.failed).toHaveLength(1);
    expect(firstResult.failed[0]).toMatchObject({ entry: target, partial: true, removedMediaCount: 1, jsonRetained: true });
    expect(result.current.inboxList.map(entry => entry._jsonFileName).sort()).toEqual(['a.json', 'b.json']);
    await expect(root.getFileHandle('a.json')).resolves.toMatchObject({ kind: 'file' });
    await expect(media.getFileHandle('removed.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('blocked.jpg')).resolves.toMatchObject({ kind: 'file' });
    expect(progress.some(value => value.stage === 'media')).toBe(true);

    let retryResult!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { retryResult = await result.current.deleteChats([firstResult.failed[0].entry]); });
    expect(retryResult.failed).toEqual([]);
    expect(retryResult.deleted).toHaveLength(1);
    await waitFor(() => expect(result.current.inboxList.map(entry => entry._jsonFileName)).toEqual(['b.json']));
    await expect(root.getFileHandle('a.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('blocked.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps an ordinary Facebook failure listed and removes it after retry', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        chat: { 'message_1.json': JSON.stringify({
          title: 'Chat', thread_path: 'inbox/chat', participants: [{ name: 'Alice' }],
          messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: 'hello' }],
        }) },
      },
    });
    const inbox = await root.getDirectoryHandle('inbox');
    const removeChat = inbox.removeEntry.bind(inbox);
    let failOnce = true;
    vi.spyOn(inbox, 'removeEntry').mockImplementation(async (name, options) => {
      if (failOnce) {
        failOnce = false;
        throw new DOMException('denied', 'NotAllowedError');
      }
      return removeChat(name, options);
    });
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => root) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useArchive());
    await act(async () => { await result.current.openFolder(); });
    const target = result.current.inboxList[0];

    let failed!: Awaited<ReturnType<typeof result.current.deleteChats>>;
    await act(async () => { failed = await result.current.deleteChats([target]); });
    expect(failed.failed[0]).toMatchObject({ entry: target, partial: false });
    expect(result.current.inboxList).toHaveLength(1);

    await act(async () => { await result.current.deleteChats([target]); });
    expect(result.current.inboxList).toEqual([]);
    await expect(inbox.getDirectoryHandle('chat')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
