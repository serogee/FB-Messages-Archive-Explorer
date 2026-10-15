import { afterEach, describe, expect, it, vi } from 'vitest';
import { listChatFolders, loadChatMessages } from '../src/services/fileSystem';
import type { MessengerThread } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import { configurePerformance, defaultPerformancePreferences } from '../src/services/performanceSettings';

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
  configurePerformance(defaultPerformancePreferences());
});

describe('Facebook chat worker loading', () => {
  it('updates an active worker and stops forwarding changes after the chat finishes', async () => {
    const root = createMockDirectoryHandle('chat', { 'message_1.json': JSON.stringify(thread) });
    vi.stubGlobal('Worker', WorkerStub);
    const pending = loadChatMessages(root);
    await vi.waitFor(() => expect(WorkerStub.instances).toHaveLength(1));
    const worker = WorkerStub.instances[0];
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ concurrency: 4 });
    const preferences = defaultPerformancePreferences();
    preferences.archiveReads = 2;
    configurePerformance(preferences);
    expect(worker.postMessage.mock.calls[1][0]).toEqual({ type: 'concurrency', concurrency: 2 });
    worker.onmessage?.({ data: { type: 'success', data: thread } } as MessageEvent);
    expect(await pending).toBe(thread);
    preferences.archiveReads = 3;
    configurePerformance(preferences);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });
  it('does not publish empty section progress after cancellation during enumeration', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: {} });
    const inbox = await root.getDirectoryHandle('inbox');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(inbox, 'entries').mockImplementation(async function* () { await gate; yield* []; });
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = listChatFolders(root, 'inbox', 'inbox', progress, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(inbox.entries).toHaveBeenCalledOnce());
    controller.abort();
    release();
    await rejected;
    expect(progress).not.toHaveBeenCalled();
  });

  it('reads four snapshots at a time and sends them to the worker in part order', async () => {
    const names = Array.from({ length: 6 }, (_, index) => `message_${index + 1}.json`);
    const root = createMockDirectoryHandle('chat', Object.fromEntries(names.map(name => [name, JSON.stringify(thread)])));
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    let active = 0, peak = 0;
    for (const name of names) {
      const handle = await root.getFileHandle(name);
      const getFile = handle.getFile.bind(handle);
      const gate = new Promise<void>(resolve => { releases.set(name, resolve); });
      vi.spyOn(handle, 'getFile').mockImplementation(async () => {
        started.push(name);
        active++;
        peak = Math.max(peak, active);
        try { await gate; return await getFile(); } finally { active--; }
      });
    }
    class SuccessWorker extends WorkerStub {
      override postMessage = vi.fn((message: { files: File[] }) => {
        expect(message.files.map(file => file.name)).toEqual([...names].reverse());
        queueMicrotask(() => this.onmessage?.({ data: { type: 'success', data: thread } } as MessageEvent));
      });
    }
    vi.stubGlobal('Worker', SuccessWorker);
    const progress = vi.fn();
    const pending = loadChatMessages(root, progress);
    await vi.waitFor(() => expect(started).toEqual([...names].reverse().slice(0, 4)));
    releases.get('message_3.json')!();
    await vi.waitFor(() => expect(started).toContain('message_2.json'));
    releases.get('message_2.json')!();
    await vi.waitFor(() => expect(started).toContain('message_1.json'));
    expect(WorkerStub.instances).toHaveLength(0);
    for (const release of releases.values()) release();
    await expect(pending).resolves.toBe(thread);
    expect(peak).toBe(4);
    expect(progress.mock.calls.filter(([, label]) => label === 'Preparing files...').map(([value]) => value))
      .toEqual(names.map((_, index) => 0.05 * (index + 1) / names.length));
  });

  it('does not start queued snapshots or publish progress after cancellation', async () => {
    const root = createMockDirectoryHandle('chat', Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`message_${index + 1}.json`, '{}']),
    ));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async () => { await gate; return new File(['{}'], 'part.json'); });
    for await (const [, handle] of root.entries()) if (handle.kind === 'file') vi.spyOn(handle, 'getFile').mockImplementation(read);
    vi.stubGlobal('Worker', WorkerStub);
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = loadChatMessages(root, progress, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    const progressCount = progress.mock.calls.length;
    controller.abort();
    release();
    await rejected;
    expect(read).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenCalledTimes(progressCount);
    expect(WorkerStub.instances).toHaveLength(0);
  });

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
