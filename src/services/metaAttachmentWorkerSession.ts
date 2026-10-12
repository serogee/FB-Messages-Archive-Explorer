import { createMetaAttachmentAccumulator, type MetaAttachmentReferenceIndex } from './metaAttachmentAccumulator';
import type { MetaArchivePlatform } from './metaAttachmentPaths';

export type MetaAttachmentWorkerRequest =
  | { id: number; type: 'init'; platform: MetaArchivePlatform | boolean }
  | { id: number; type: 'file'; file: File; chatId: string; name: string }
  | { id: number; type: 'finish' };
export type MetaAttachmentWorkerResponse =
  | { id: number; type: 'success'; value: boolean | MetaAttachmentReferenceIndex }
  | { id: number; type: 'error'; error: string };

/** One worker per scan, with at most four directory/file requests in flight. */
export class MetaAttachmentWorkerSession {
  private worker: Worker | null = null;
  private fallback: ReturnType<typeof createMetaAttachmentAccumulator> | null = null;
  private pending = new Map<number, { resolve: (value: boolean | MetaAttachmentReferenceIndex) => void; reject: (error: unknown) => void }>();
  private nextId = 0;
  private failure: unknown;
  private readonly signal?: AbortSignal;
  private readonly abort = () => this.fail(new DOMException('Aborted', 'AbortError'));

  constructor(platform: MetaArchivePlatform | boolean, signal?: AbortSignal) {
    this.signal = signal;
    if (signal?.aborted) { this.abort(); return; }
    // Non-browser tooling uses exactly the same accumulator and safety rules.
    if (typeof Worker === 'undefined') this.fallback = createMetaAttachmentAccumulator(platform);
    else {
      this.worker = new Worker(new URL('./metaAttachmentWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<MetaAttachmentWorkerResponse>) => {
        const response = event.data;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.type === 'error') pending.reject(new Error(response.error));
        else pending.resolve(response.value);
      };
      this.worker.onerror = () => this.fail(new Error('Attachment ownership worker failed.'));
      this.worker.onmessageerror = () => this.fail(new Error('Attachment ownership results could not be read.'));
      // Messages on a worker port remain ordered; the worker also serializes
      // asynchronous File reads before processing subsequent requests.
      this.worker.postMessage({ id: 0, type: 'init', platform } satisfies MetaAttachmentWorkerRequest);
    }
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  async process(file: File, chatId: string, name: string, yieldIfNeeded: () => Promise<void>): Promise<boolean> {
    this.throwIfFailed();
    if (this.fallback) {
      const raw: unknown = JSON.parse(await file.text());
      this.throwIfFailed();
      return this.fallback.process(raw, chatId, name, yieldIfNeeded);
    }
    return await this.request({ id: ++this.nextId, type: 'file', file, chatId, name }) as boolean;
  }

  async finish(): Promise<MetaAttachmentReferenceIndex> {
    this.throwIfFailed();
    if (this.fallback) return this.fallback.index;
    return await this.request({ id: ++this.nextId, type: 'finish' }) as MetaAttachmentReferenceIndex;
  }

  dispose(): void {
    this.fail(new DOMException('Aborted', 'AbortError'));
    this.signal?.removeEventListener('abort', this.abort);
  }

  private request(message: MetaAttachmentWorkerRequest): Promise<boolean | MetaAttachmentReferenceIndex> {
    this.throwIfFailed();
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      try { this.worker!.postMessage(message); }
      catch (error) { this.fail(error); }
    });
  }

  private throwIfFailed(): void { if (this.failure) throw this.failure; }
  private fail(error: unknown): void {
    this.failure ||= error;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
}
