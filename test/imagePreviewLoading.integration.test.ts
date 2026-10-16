import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatImagePreviewCache } from '../src/services/chatImagePreviewCache';
import { ImageThumbnailCache } from '../src/services/imageThumbnailCache';
import type { TaskSubscription } from '../src/services/subscribableTaskQueue';
import type { MediaEntry } from '../src/types/messenger';

let images: FakeImage[];
let onImageCreate: () => void;

class FakeImage {
  decoding = '';
  src = '';
  naturalWidth = 400;
  naturalHeight = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    images.push(this);
    onImageCreate();
  }
}

beforeEach(() => {
  images = [];
  onImageCreate = () => {};
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('createImageBitmap', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['gallery', 'chat'] as const)('%s image-element fallback', kind => {
  let clear: () => void;
  let subscribe: (entry: MediaEntry, subscriber: (url: string | null) => void) => TaskSubscription;
  let revoke: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    if (kind === 'gallery') {
      const cache = new ImageThumbnailCache(2, 1);
      clear = () => cache.clear();
      subscribe = (entry, subscriber) => cache.subscribe(entry, subscriber);
    } else {
      const cache = new ChatImagePreviewCache(2, 1);
      clear = () => cache.clear();
      subscribe = (entry, subscriber) => cache.subscribe(entry, { width: 384, height: 384, fit: 'contain' }, preview => subscriber(preview?.url ?? null));
    }
    let nextUrl = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++nextUrl}`);
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => clear());

  const fileEntry = (): MediaEntry => ({
    type: 'image',
    handle: { kind: 'file', name: 'photo.jpg', getFile: async () => new File(['synthetic image'], 'photo.jpg') },
  });

  it('retains encoding, geometry, and separate temporary/output URL ownership', async () => {
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, _type: string, _quality: number) => callback(new Blob(['synthetic preview'])));
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob };
    vi.stubGlobal('document', { createElement: () => canvas });
    const received = vi.fn();
    subscribe(fileEntry(), received);
    await vi.waitFor(() => expect(images).toHaveLength(1));
    const image = images[0];
    expect(image.decoding).toBe('async');
    expect(image.src).toBe('blob:image-1');

    image.onload?.();
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith('blob:image-2'));
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
    if (kind === 'gallery') {
      expect(drawImage).toHaveBeenCalledWith(image, 100, 0, 200, 200, 0, 0, 150, 150);
      expect(canvas).toMatchObject({ width: 150, height: 150 });
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.76);
    } else {
      expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 400, 200, 0, 0, 384, 192);
      expect(canvas).toMatchObject({ width: 384, height: 192 });
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.9);
    }
    expect(revoke.mock.calls).toEqual([['blob:image-1']]);
    clear();
    expect(image.src).toBe('blob:image-1');
    expect(revoke.mock.calls).toEqual([['blob:image-1'], ['blob:image-2']]);
  });

  it('returns null on decode error without taking ownership of an external URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic fetch failure')));
    const received = vi.fn();
    const source = 'https://fixture.invalid/photo.jpg';
    subscribe({ type: 'image', url: source }, received);
    await vi.waitFor(() => expect(images).toHaveLength(1));

    images[0].onerror?.();
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(null));
    clear();
    expect(images[0]).toMatchObject({ src: source, onload: null, onerror: null });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['unsubscribe', 'clear', 'clear during image construction'] as const)('releases a borrowed temporary source after %s', async action => {
    if (action === 'clear during image construction') onImageCreate = clear;
    const received = vi.fn();
    const unsubscribe = subscribe(fileEntry(), received);
    await vi.waitFor(() => expect(images).toHaveLength(1));

    if (action === 'unsubscribe') unsubscribe();
    else if (action === 'clear') clear();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:image-1'));
    expect(images[0]).toMatchObject({ src: '', onload: null, onerror: null });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    if (action === 'unsubscribe') expect(received).not.toHaveBeenCalled();
    else expect(received.mock.calls).toEqual([[null]]);
  });
});
