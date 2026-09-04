import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateChatPreviewDimensions,
  ChatImagePreviewCache,
  getChatPreviewPixelSize,
  type ChatImagePreview,
} from '../src/services/chatImagePreviewCache';
import type { MediaEntry } from '../src/types/messenger';

const entry = (): MediaEntry => ({ type: 'image' });
const preview = (url: string): ChatImagePreview => ({ url, sourceWidth: 4000, sourceHeight: 3000 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat image preview sizing', () => {
  it('accounts for high-density displays and rounds into reusable size buckets', () => {
    expect(getChatPreviewPixelSize(169, 2)).toBe(384);
    expect(getChatPreviewPixelSize(340, 2)).toBe(768);
    expect(getChatPreviewPixelSize(900, 3)).toBe(2048);
  });

  it('preserves the source aspect ratio for single-image previews', () => {
    expect(calculateChatPreviewDimensions(4000, 3000, { width: 1024, height: 768, fit: 'contain' }))
      .toEqual({ width: 1024, height: 768, sourceX: 0, sourceY: 0, sourceWidth: 4000, sourceHeight: 3000 });
    expect(calculateChatPreviewDimensions(3000, 4000, { width: 1024, height: 768, fit: 'contain' }))
      .toEqual({ width: 576, height: 768, sourceX: 0, sourceY: 0, sourceWidth: 3000, sourceHeight: 4000 });
  });

  it('only square-crops previews requested for the existing media grid', () => {
    expect(calculateChatPreviewDimensions(4000, 3000, { width: 384, height: 384, fit: 'cover' }))
      .toEqual({ width: 384, height: 384, sourceX: 500, sourceY: 0, sourceWidth: 3000, sourceHeight: 3000 });
  });
});

describe('chat image preview cache', () => {
  it('shares work for the same entry and size while keeping different sizes separate', async () => {
    const create = vi.fn(async ({ options }: { options: { width: number } }) => preview(`blob:${options.width}`));
    const cache = new ChatImagePreviewCache(10, 2, create);
    const media = entry();
    const received: string[] = [];

    const first = new Promise<void>(resolve => cache.subscribe(media, { width: 384, height: 384, fit: 'cover' }, result => {
      if (result) received.push(result.url);
      resolve();
    }));
    const second = new Promise<void>(resolve => cache.subscribe(media, { width: 384, height: 384, fit: 'cover' }, result => {
      if (result) received.push(result.url);
      resolve();
    }));
    const third = new Promise<void>(resolve => cache.subscribe(media, { width: 768, height: 768, fit: 'cover' }, result => {
      if (result) received.push(result.url);
      resolve();
    }));

    await Promise.all([first, second, third]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(received).toEqual(['blob:384', 'blob:384', 'blob:768']);
  });

  it('revokes least-recently-used preview URLs', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let count = 0;
    const cache = new ChatImagePreviewCache(1, 1, async () => preview(`blob:${++count}`));

    const subscribe = (media: MediaEntry) => new Promise<void>(resolve => {
      cache.subscribe(media, { width: 384, height: 384, fit: 'cover' }, () => resolve());
    });
    await subscribe(entry());
    await subscribe(entry());

    expect(cache.size).toBe(1);
    expect(revoke).toHaveBeenCalledWith('blob:1');
  });
});
