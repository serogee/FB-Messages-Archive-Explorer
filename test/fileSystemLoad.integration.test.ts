import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadChatMessages } from '../src/services/fileSystem';
import type { MessengerThread } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

const thread: MessengerThread = {
  title: 'Loaded',
  participants: [{ name: 'Alice' }],
  messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: 'loaded' }],
};

class WorkerStub {
  static instances: WorkerStub[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_message: unknown) => {});

  constructor() { WorkerStub.instances.push(this); }
}

afterEach(() => {
  WorkerStub.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Facebook chat worker loading', () => {
  it('continues with readable parts when another message file cannot be opened', async () => {
    const root = createMockDirectoryHandle('chat', {
      'message_1.json': JSON.stringify(thread),
      'message_2.json': JSON.stringify(thread),
    });
    const unreadable = await root.getFileHandle('message_2.json');
    vi.spyOn(unreadable, 'getFile').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    class SuccessWorker extends WorkerStub {
      override postMessage = vi.fn((message: { files: File[] }) => {
        expect(message.files.map(file => file.name)).toEqual(['message_1.json']);
        queueMicrotask(() => this.onmessage?.({ data: { type: 'success', data: thread } } as MessageEvent));
      });
    }
    vi.stubGlobal('Worker', SuccessWorker);

    await expect(loadChatMessages(root)).resolves.toBe(thread);
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('reports worker errors and terminates the failed worker', async () => {
    const root = createMockDirectoryHandle('chat', { 'message_1.json': JSON.stringify(thread) });
    class ErrorWorker extends WorkerStub {
      override postMessage = vi.fn(() => {
        queueMicrotask(() => this.onerror?.({ message: 'worker crashed' } as ErrorEvent));
      });
    }
    vi.stubGlobal('Worker', ErrorWorker);

    await expect(loadChatMessages(root)).rejects.toThrow('Worker error: worker crashed');
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('terminates an active worker when loading is aborted', async () => {
    const root = createMockDirectoryHandle('chat', { 'message_1.json': JSON.stringify(thread) });
    vi.stubGlobal('Worker', WorkerStub);
    const controller = new AbortController();
    const request = loadChatMessages(root, undefined, controller.signal);
    await vi.waitFor(() => expect(WorkerStub.instances).toHaveLength(1));

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(WorkerStub.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('reports empty and fully unreadable chat folders with useful progress', async () => {
    const progress: Array<[number, string]> = [];
    await expect(loadChatMessages(
      createMockDirectoryHandle('empty', {}),
      (value, text) => progress.push([value, text]),
    )).rejects.toThrow('No readable message files found');
    expect(progress).toEqual([[0, 'Scanning files...']]);

    const unreadableRoot = createMockDirectoryHandle('unreadable', { 'message_1.json': '{}' });
    const unreadable = await unreadableRoot.getFileHandle('message_1.json');
    vi.spyOn(unreadable, 'getFile').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const unreadableProgress: Array<[number, string]> = [];
    await expect(loadChatMessages(
      unreadableRoot,
      (value, text) => unreadableProgress.push([value, text]),
    )).rejects.toThrow('No readable message files found');
    expect(unreadableProgress).toEqual([
      [0, 'Scanning files...'],
      [0.05, 'Preparing files...'],
    ]);
  });
});
