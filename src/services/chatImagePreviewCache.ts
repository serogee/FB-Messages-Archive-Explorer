import type { MediaEntry } from '../types/messenger';
import { createNoopTaskSubscription, SubscribableTaskQueue, type TaskSubscription } from './subscribableTaskQueue';

export type ChatImagePreviewFit = 'contain' | 'cover';

export interface ChatImagePreviewOptions {
  width: number;
  height: number;
  fit: ChatImagePreviewFit;
}

export interface ChatImagePreview {
  url: string;
  sourceWidth: number;
  sourceHeight: number;
}

interface PreviewRequest {
  entry: MediaEntry;
  options: ChatImagePreviewOptions;
}

type PreviewCreator = (request: PreviewRequest, signal: AbortSignal) => Promise<ChatImagePreview | null>;
type PreviewSubscriber = (preview: ChatImagePreview | null) => void;

const DEFAULT_MAX_PREVIEWS = 300;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const SIZE_BUCKETS = [256, 384, 512, 768, 1024, 1536, 2048] as const;

export function getChatPreviewPixelSize(cssPixels: number, devicePixelRatio = 1): number {
  const required = Math.max(1, Math.ceil(cssPixels * Math.max(1, devicePixelRatio)));
  return SIZE_BUCKETS.find(size => size >= required) || SIZE_BUCKETS[SIZE_BUCKETS.length - 1];
}

export function calculateChatPreviewDimensions(
  sourceWidth: number,
  sourceHeight: number,
  options: ChatImagePreviewOptions,
): { width: number; height: number; sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number } {
  const safeSourceWidth = Math.max(1, sourceWidth);
  const safeSourceHeight = Math.max(1, sourceHeight);
  const targetWidth = Math.max(1, Math.round(options.width));
  const targetHeight = Math.max(1, Math.round(options.height));

  if (options.fit === 'cover') {
    const sourceRatio = safeSourceWidth / safeSourceHeight;
    const targetRatio = targetWidth / targetHeight;
    if (sourceRatio > targetRatio) {
      const croppedWidth = safeSourceHeight * targetRatio;
      return {
        width: targetWidth,
        height: targetHeight,
        sourceX: (safeSourceWidth - croppedWidth) / 2,
        sourceY: 0,
        sourceWidth: croppedWidth,
        sourceHeight: safeSourceHeight,
      };
    }

    const croppedHeight = safeSourceWidth / targetRatio;
    return {
      width: targetWidth,
      height: targetHeight,
      sourceX: 0,
      sourceY: (safeSourceHeight - croppedHeight) / 2,
      sourceWidth: safeSourceWidth,
      sourceHeight: croppedHeight,
    };
  }

  const scale = Math.min(targetWidth / safeSourceWidth, targetHeight / safeSourceHeight, 1);
  return {
    width: Math.max(1, Math.round(safeSourceWidth * scale)),
    height: Math.max(1, Math.round(safeSourceHeight * scale)),
    sourceX: 0,
    sourceY: 0,
    sourceWidth: safeSourceWidth,
    sourceHeight: safeSourceHeight,
  };
}

/** Keeps chat-sized previews separate from both gallery thumbnails and original-file URLs. */
export class ChatImagePreviewCache {
  private readonly cache = new Map<PreviewRequest, ChatImagePreview>();
  private readonly requestKeys = new Map<MediaEntry, Map<string, PreviewRequest>>();
  private readonly scheduler: SubscribableTaskQueue<PreviewRequest, ChatImagePreview | null>;
  private readonly maxSize: number;
  private generation = 0;

  constructor(
    maxSize = DEFAULT_MAX_PREVIEWS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
    creator: PreviewCreator = createChatImagePreview,
  ) {
    this.maxSize = maxSize;
    this.scheduler = new SubscribableTaskQueue(maxConcurrentJobs, creator);
  }

  subscribe(
    entry: MediaEntry,
    options: ChatImagePreviewOptions,
    subscriber: PreviewSubscriber,
    priority = 0,
  ): TaskSubscription {
    const request = this.getRequest(entry, options);
    const cached = this.get(request);
    if (cached) {
      subscriber(cached);
      return createNoopTaskSubscription();
    }

    const requestGeneration = this.generation;
    return this.scheduler.subscribe(request, completion => {
      if (completion.status !== 'completed' || !completion.value) {
        subscriber(null);
        return;
      }

      const preview = completion.value;
      if (requestGeneration !== this.generation) {
        URL.revokeObjectURL(preview.url);
        subscriber(null);
        return;
      }

      this.put(request, preview);
      subscriber(preview);
    }, priority);
  }

  clear(): void {
    this.generation++;
    this.scheduler.clear();
    for (const preview of this.cache.values()) URL.revokeObjectURL(preview.url);
    this.cache.clear();
    this.requestKeys.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private getRequest(entry: MediaEntry, options: ChatImagePreviewOptions): PreviewRequest {
    const normalized = {
      width: Math.max(1, Math.round(options.width)),
      height: Math.max(1, Math.round(options.height)),
      fit: options.fit,
    };
    const variant = `${normalized.width}x${normalized.height}:${normalized.fit}`;
    let variants = this.requestKeys.get(entry);
    if (!variants) {
      variants = new Map();
      this.requestKeys.set(entry, variants);
    }
    let request = variants.get(variant);
    if (!request) {
      request = { entry, options: normalized };
      variants.set(variant, request);
    }
    return request;
  }

  private get(request: PreviewRequest): ChatImagePreview | null {
    const cached = this.cache.get(request);
    if (!cached) return null;
    this.cache.delete(request);
    this.cache.set(request, cached);
    return cached;
  }

  private put(request: PreviewRequest, preview: ChatImagePreview): void {
    const previous = this.cache.get(request);
    if (previous && previous.url !== preview.url) URL.revokeObjectURL(previous.url);
    if (previous) this.cache.delete(request);

    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      URL.revokeObjectURL(oldest[1].url);
    }
    this.cache.set(request, preview);
  }
}

async function createChatImagePreview(request: PreviewRequest, signal: AbortSignal): Promise<ChatImagePreview | null> {
  let temporaryUrl: string | null = null;
  let bitmap: ImageBitmap | null = null;

  try {
    let blob: Blob | null = request.entry.handle ? await request.entry.handle.getFile() : null;
    if (signal.aborted) return null;
    if (!blob && request.entry.url) {
      try {
        blob = await fetch(request.entry.url, { signal }).then(response => response.blob());
      } catch { /* Fall back to the URL-backed image below. */ }
    }
    if (signal.aborted) return null;

    let source: CanvasImageSource;
    let sourceWidth: number;
    let sourceHeight: number;
    if (blob && typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } else {
      const sourceUrl = request.entry.url || (blob ? URL.createObjectURL(blob) : null);
      if (!sourceUrl) return null;
      if (!request.entry.url) temporaryUrl = sourceUrl;
      const image = await loadImage(sourceUrl, signal);
      source = image;
      sourceWidth = image.naturalWidth;
      sourceHeight = image.naturalHeight;
    }
    if (signal.aborted || !sourceWidth || !sourceHeight) return null;

    const dimensions = calculateChatPreviewDimensions(sourceWidth, sourceHeight, request.options);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      source,
      dimensions.sourceX,
      dimensions.sourceY,
      dimensions.sourceWidth,
      dimensions.sourceHeight,
      0,
      0,
      dimensions.width,
      dimensions.height,
    );

    const previewBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (signal.aborted || !previewBlob) return null;
    return {
      url: URL.createObjectURL(previewBlob),
      sourceWidth,
      sourceHeight,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
  }
}

function loadImage(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      image.src = '';
      reject(new DOMException('Chat preview generation cancelled', 'AbortError'));
    };
    image.decoding = 'async';
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('Image decode failed')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else image.src = source;
  });
}

export const chatImagePreviewCache = new ChatImagePreviewCache();
