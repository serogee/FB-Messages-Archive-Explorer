// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { useReactionFeature } from '../src/hooks/useReactionFeature';
import type { MessengerThread, ChatListEntry } from '../src/types/messenger';
import type { ReadableDirectoryHandle } from '../src/types/fileSystem';
const deps = vi.hoisted(() => ({ discover: vi.fn(), files: vi.fn() }));
vi.mock('../src/services/reactionAuditInventory', () => ({
  discoverReactionConversations: deps.discover,
  iterateReactionConversations: async function* () { yield* await deps.discover(); },
  checkReactionAbort: (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); },
  reactionConversationId: (source: string, folder: string) => `${source}:${folder}`,
}));
vi.mock('../src/services/fileSystem', () => ({ getLoadedReactionFiles: deps.files }));
class AuditWorker {
  static instances: AuditWorker[] = [];
  static verificationSnapshot = 'snapshot';
  static resultSnapshot = 'snapshot';
  static failStartup = false;
  static holdFinish = false;
  static holdThreads = false;
  static holdReport = false;
  static report = { status: 'consistent', reason: '24/24 supported notices match reactions.', owner: 'Owner', notices: 24, candidates: 24, inconsistentChats: [] };
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  stopped = false;
  broken = false;
  pendingFinishes: (() => void)[] = [];
  pendingThreads: (() => void)[] = [];
  pendingReports: (() => void)[] = [];
  ownerReads = 0;
  inputs: { type: string; mode?: string; id?: string }[] = [];
  constructor() {
    AuditWorker.instances.push(this);
    if (AuditWorker.failStartup) {
      this.broken = true;
      queueMicrotask(() => this.onerror?.({ message: 'Worker module failed to load' }));
    }
  }
  terminate() { this.stopped = true; }
  postMessage(input: { type: string; mode?: string; id?: string }) {
    this.inputs.push(input);
    if (this.broken) return;
    if (input.type === 'owner') this.ownerReads++;
    const data = input.type === 'thread' || input.type === 'owner' ? { type: 'ready', snapshot: AuditWorker.resultSnapshot, owner: this.ownerReads >= 2 ? 'Owner' : null } : input.type === 'verify' ? { type: 'verified', snapshot: AuditWorker.verificationSnapshot } : input.type === 'report' ? { type: 'report', report: AuditWorker.report } : {
      type: 'complete', results: [{ id: input.id, owner: 'Owner', snapshot: AuditWorker.resultSnapshot, estimates: [{ messageIndex: 0, reactionIndex: 1, noticeIndex: 2, timestamp: 9000, method: 'local' }, ...(input.mode === 'aggressive' ? [{ messageIndex: 0, reactionIndex: 2, noticeIndex: 3, timestamp: 10000, method: 'cross' }] : [])] }],
    };
    const reply = () => queueMicrotask(() => { if (!this.stopped) this.onmessage?.({ data }); });
    if (input.type === 'thread' && AuditWorker.holdThreads) this.pendingThreads.push(reply);
    else if (input.type === 'finish' && AuditWorker.holdFinish) this.pendingFinishes.push(reply);
    else if (input.type === 'report' && AuditWorker.holdReport) this.pendingReports.push(reply);
    else reply();
  }
}
const root = { name: 'root', kind: 'directory' } as ReadableDirectoryHandle;
const file = new File(['{}'], 'message_1.json');
const handle = { ...root, getFileHandle: async () => ({ getFile: async () => file }) } as ReadableDirectoryHandle;
const data: MessengerThread = { title: 'chat', thread_path: 'inbox/chat', participants: [], is_still_participant: true, _reactionInputComplete: true, messages: [{ sender_name: 'Owner', timestamp_ms: 1, reactions: [{ actor: 'A', reaction: 'x', timestamp: 2 }, { actor: 'A', reaction: 'y' }, { actor: 'A', reaction: 'z' }] }] };
const entry = { folderName: 'chat', source: 'inbox', dirHandle: handle } as ChatListEntry;
const defaults = { root, revision: 1, standalone: false, archiveLoading: false, chatLoading: false, chatData: data, entry, mode: 'off' as const, hide: true, showAll: vi.fn() };
beforeEach(() => {
  AuditWorker.instances = [];
  AuditWorker.verificationSnapshot = 'snapshot';
  AuditWorker.resultSnapshot = 'snapshot';
  AuditWorker.failStartup = false;
  AuditWorker.holdFinish = false;
  AuditWorker.holdThreads = false;
  AuditWorker.holdReport = false;
  AuditWorker.report = { status: 'consistent', reason: '24/24 supported notices match reactions.', owner: 'Owner', notices: 24, candidates: 24, inconsistentChats: [] };
  vi.stubGlobal('Worker', AuditWorker);
  deps.discover.mockResolvedValue(['chat', 'other', 'third', 'unopened'].map(id => ({ id: `inbox:${id}`, handle, files: ['message_1.json'] })));
  deps.files.mockReturnValue([file]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('reaction feature lifecycle', () => {
  it.each(['near', 'aggressive'] as const)('shows cold-scan progress and can restart %s with the chat already open in development', async mode => {
    AuditWorker.holdThreads = true;
    AuditWorker.holdFinish = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), {
      initialProps: { ...defaults, mode: 'off' as 'off' | 'near' | 'aggressive' },
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    rerender({ ...defaults, mode });
    const first = AuditWorker.instances.at(-1)!;
    await waitFor(() => expect(first.pendingThreads).toHaveLength(1));
    expect(result.current.status).toBe('checking');
    expect(result.current.reason).toBe('Checking reaction notices…');
    act(() => result.current.retry());
    await waitFor(() => expect(AuditWorker.instances.at(-1)!.pendingThreads).toHaveLength(1));
    const restarted = AuditWorker.instances.at(-1)!;
    expect(restarted).not.toBe(first);
    expect(first.stopped).toBe(true);
    await act(async () => first.pendingThreads.shift()!());
    expect(result.current.status).toBe('checking');
    await act(async () => restarted.pendingThreads.shift()!());
    await waitFor(() => expect(restarted.pendingFinishes).toHaveLength(1));
    expect(result.current.reason).toBe('Checking reaction notices…');
    await act(async () => restarted.pendingFinishes.shift()!());
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    expect(result.current.status).toBe('ready');
    expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(mode === 'aggressive' ? 10000 : 0);
  });
  it('matches the latest enabled mode without restarting an unfinished archive scan', async () => {
    AuditWorker.holdThreads = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'off' as 'off' | 'near' | 'aggressive' } });
    rerender({ ...defaults, mode: 'near' });
    const worker = AuditWorker.instances[0];
    await waitFor(() => expect(worker.pendingThreads).toHaveLength(1));
    rerender({ ...defaults, mode: 'aggressive' });
    expect(AuditWorker.instances).toHaveLength(1);
    expect(result.current.status).toBe('checking');
    await act(async () => worker.pendingThreads.shift()!());
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(10000));
    expect(worker.inputs.filter(input => input.type === 'finish')).toEqual([{ type: 'finish', id: 'inbox:chat', mode: 'aggressive' }]);
  });
  it.each(['off', 'near', 'aggressive'] as const)('publishes Nearby after leaving %s for Off and enabling Nearby directly', async initialMode => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: initialMode as 'off' | 'near' | 'aggressive' } });
    if (initialMode !== 'off') await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ ...defaults, mode: 'off' });
    expect(result.current.status).toBe('off');
    rerender({ ...defaults, mode: 'near' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(0);
  });
  it('verifies an already-open chat against a fresh audit after clearing while off', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    rerender(defaults);
    act(() => result.current.clear());
    expect(result.current.hasCache).toBe(false);
    expect(AuditWorker.instances).toHaveLength(1);
    expect(AuditWorker.instances[0].stopped).toBe(true);
    AuditWorker.resultSnapshot = 'new-snapshot';
    AuditWorker.verificationSnapshot = 'new-snapshot';
    rerender({ ...defaults, mode: 'near' });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    const inputs = AuditWorker.instances.at(-1)!.inputs.map(input => input.type);
    expect(inputs[0]).toBe('thread');
    expect(inputs).not.toContain('verify');
  });
  it('reports a worker startup failure instead of remaining in Checking', async () => {
    AuditWorker.failStartup = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'off' as 'off' | 'near' | 'aggressive' } });
    rerender({ ...defaults, mode: 'near' });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.reason).toContain('Worker module failed to load');
  });
  it('publishes the selected mode when it changes during the first matching request', async () => {
    AuditWorker.holdFinish = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'off' as 'off' | 'near' | 'aggressive' } });
    rerender({ ...defaults, mode: 'near' });
    const worker = AuditWorker.instances[0];
    await waitFor(() => expect(worker.pendingFinishes).toHaveLength(1));
    rerender({ ...defaults, mode: 'aggressive' });
    await act(async () => worker.pendingFinishes.shift()!());
    await waitFor(() => expect(worker.pendingFinishes).toHaveLength(1));
    await act(async () => worker.pendingFinishes.shift()!());
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(10000));
    expect(worker.inputs.filter(input => input.type === 'finish')).toHaveLength(2);
  });
  it('schedules no inference work while off, on off-mode revisions, or for standalone', () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: defaults });
    rerender({ ...defaults, revision: 2 });
    expect(deps.discover).not.toHaveBeenCalled();
    expect(AuditWorker.instances).toHaveLength(0);
    expect(result.current.time(data.messages[0].reactions![0], 0, 0).timestamp).toBe(2000);
    rerender({ ...defaults, standalone: true });
    expect(result.current.applicable).toBe(false);
    expect(result.current.hide).toBe(false);
  });
  it('publishes subscribed estimates, preserves indices, retains the cache and hides cross/off times immediately', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    expect(result.current.time(data.messages[0].reactions![1], 0, 0).timestamp).toBe(0);
    rerender({ ...defaults, mode: 'aggressive' });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(10000));
    expect(AuditWorker.instances).toHaveLength(1);
    rerender({ ...defaults, mode: 'near' });
    expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(0);
    rerender(defaults);
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    expect(result.current.time(data.messages[0].reactions![0], 0, 0).timestamp).toBe(2000);
    expect(result.current.hasCache).toBe(true);
    expect(AuditWorker.instances[0].stopped).toBe(false);
  });
  it.each(['near', 'aggressive'] as const)('reuses completed %s guesses after Off without rescanning or rematching', async mode => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: mode as 'off' | 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    const worker = AuditWorker.instances[0], requests = worker.inputs.length;
    rerender(defaults);
    expect(result.current.status).toBe('off');
    expect(result.current.hasCache).toBe(true);
    expect(result.current.canClear).toBe(true);
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    expect(result.current.time(data.messages[0].reactions![0], 0, 0).timestamp).toBe(2000);
    rerender({ ...defaults, mode });
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000);
    expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(mode === 'aggressive' ? 10000 : 0);
    expect(worker.inputs).toHaveLength(requests);
    expect(deps.discover).toHaveBeenCalledOnce();
    expect(AuditWorker.instances).toHaveLength(1);
  });
  it('pauses an unfinished scan while Off and resumes the same inputs without rediscovery', async () => {
    AuditWorker.holdThreads = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    const worker = AuditWorker.instances[0];
    await waitFor(() => expect(worker.pendingThreads).toHaveLength(1));
    rerender(defaults);
    await act(async () => worker.pendingThreads.shift()!());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(worker.inputs.filter(input => input.type === 'thread')).toHaveLength(1);
    expect(worker.inputs.filter(input => input.type === 'finish')).toHaveLength(0);
    expect(worker.stopped).toBe(false);
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    rerender({ ...defaults, mode: 'near' });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    expect(worker.inputs.filter(input => input.type === 'thread')).toHaveLength(1);
    expect(deps.discover).toHaveBeenCalledOnce();
    expect(AuditWorker.instances).toHaveLength(1);
  });
  it('clears a paused scan, rejects late replies and performs no work while Off', async () => {
    AuditWorker.holdThreads = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    const worker = AuditWorker.instances[0];
    await waitFor(() => expect(worker.pendingThreads).toHaveLength(1));
    rerender(defaults);
    act(() => result.current.clear());
    await act(async () => worker.pendingThreads.shift()!());
    expect(worker.stopped).toBe(true);
    expect(result.current.status).toBe('off');
    expect(result.current.hasCache).toBe(false);
    expect(result.current.canClear).toBe(false);
    expect(AuditWorker.instances).toHaveLength(1);
    expect(deps.discover).not.toHaveBeenCalled();
    expect(result.current.time(data.messages[0].reactions![0], 0, 0).timestamp).toBe(2000);
  });
  it('cancels queued matching when Off is selected before its request can start', async () => {
    AuditWorker.holdFinish = true;
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    const worker = AuditWorker.instances[0];
    await waitFor(() => expect(worker.pendingFinishes).toHaveLength(1));
    rerender({ ...defaults, mode: 'aggressive' });
    rerender(defaults);
    await act(async () => worker.pendingFinishes.shift()!());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(worker.inputs.filter(input => input.type === 'finish')).toEqual([{ type: 'finish', id: 'inbox:chat', mode: 'near' }]);
    expect(result.current.status).toBe('off');
    rerender({ ...defaults, mode: 'aggressive' });
    await waitFor(() => expect(worker.pendingFinishes).toHaveLength(1));
    await act(async () => worker.pendingFinishes.shift()!());
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![2], 0, 2).timestamp).toBe(10000));
    expect(deps.discover).toHaveBeenCalledOnce();
  });
  it('does not hash a queued chat verification after switching Off', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    const worker = AuditWorker.instances[0], reloaded = { ...data };
    AuditWorker.holdFinish = true;
    rerender({ ...defaults, mode: 'aggressive' });
    await waitFor(() => expect(worker.pendingFinishes).toHaveLength(1));
    rerender({ ...defaults, mode: 'aggressive', chatData: reloaded });
    rerender({ ...defaults, chatData: reloaded });
    await act(async () => worker.pendingFinishes.shift()!());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(worker.inputs.filter(input => input.type === 'verify')).toHaveLength(0);
    expect(result.current.time(reloaded.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    rerender({ ...defaults, mode: 'near', chatData: reloaded });
    await waitFor(() => expect(result.current.time(reloaded.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    expect(worker.inputs.filter(input => input.type === 'verify')).toHaveLength(1);
    expect(deps.discover).toHaveBeenCalledOnce();
  });
  it('discards cached guesses on archive changes while Off without starting another scan', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.hasCache).toBe(true));
    rerender(defaults);
    rerender({ ...defaults, revision: 2 });
    expect(result.current.hasCache).toBe(false);
    expect(AuditWorker.instances[0].stopped).toBe(true);
    expect(AuditWorker.instances).toHaveLength(1);
    expect(deps.discover).toHaveBeenCalledOnce();
    rerender({ ...defaults, revision: 2, mode: 'near' });
    await waitFor(() => expect(result.current.hasCache).toBe(true));
    expect(AuditWorker.instances).toHaveLength(2);
    expect(deps.discover).toHaveBeenCalledTimes(2);
  });
  it('verifies newly loaded chats before restoring cached timestamps after Off', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'off' | 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    rerender(defaults);
    const reloaded = { ...data };
    AuditWorker.verificationSnapshot = 'changed-bytes';
    rerender({ ...defaults, chatData: reloaded });
    expect(result.current.hasCache).toBe(true);
    expect(AuditWorker.instances[0].inputs.filter(input => input.type === 'verify')).toHaveLength(0);
    rerender({ ...defaults, mode: 'near', chatData: reloaded });
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.hasCache).toBe(false);
    expect(deps.discover).toHaveBeenCalledOnce();
  });
  it('withdraws completed authority on source revision changes and keeps viewing data immutable', async () => {
    const before = JSON.stringify(data);
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as const } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    await act(async () => { rerender({ ...defaults, mode: 'near', revision: 2, archiveLoading: true }); });
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    expect(JSON.stringify(data)).toBe(before);
  });
  it('keeps current-chat guesses usable while an explicit full consistency check uses a separate worker', async () => {
    const { result } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as const } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    const quick = AuditWorker.instances[0];
    act(() => result.current.checkArchive());
    await waitFor(() => expect(AuditWorker.instances).toHaveLength(2));
    await waitFor(() => expect(result.current.consistency.status).toBe('consistent'));
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000);
    expect(quick.inputs.filter(input => input.type === 'thread')).toHaveLength(1);
    expect(AuditWorker.instances[1].inputs.filter(input => input.type === 'thread')).toHaveLength(4);
    expect(AuditWorker.instances[1].inputs.filter(input => input.type === 'report')).toHaveLength(1);
  });
  it('retains the individual chats reported by a failed full consistency check', async () => {
    AuditWorker.report = {
      status: 'inconsistent', reason: '1 chat has inconsistent matches.', owner: 'Owner', notices: 30, candidates: 28,
      inconsistentChats: [{ id: 'inbox:other', notices: 20, candidates: 18 }],
    };
    const { result } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as const } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.checkArchive());
    await waitFor(() => expect(result.current.consistency.status).toBe('inconsistent'));
    expect(result.current.consistency.inconsistentChats).toEqual([{ id: 'inbox:other', notices: 20, candidates: 18 }]);
    expect(result.current.consistency).toMatchObject({ notices: 30, candidates: 28 });
  });
  it('withdraws archive authority after a late partial chat load and cannot restore it by switching modes', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    rerender({ ...defaults, mode: 'near', chatData: { ...data, _reactionInputComplete: false } });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    rerender({ ...defaults, mode: 'aggressive' });
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    expect(result.current.time(data.messages[0].reactions![0], 0, 0).timestamp).toBe(2000);
    expect(result.current.reason).toContain('unreadable or invalid');
  });
  it('invalidates the entire session when newly loaded bytes differ, including on subsequent mode changes', async () => {
    const { result, rerender } = renderHook(props => useReactionFeature(props), { initialProps: { ...defaults, mode: 'near' as 'near' | 'aggressive' } });
    await waitFor(() => expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(9000));
    AuditWorker.verificationSnapshot = 'changed-bytes';
    rerender({ ...defaults, mode: 'near', chatData: { ...data } });
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    rerender({ ...defaults, mode: 'aggressive' });
    expect(result.current.time(data.messages[0].reactions![1], 0, 1).timestamp).toBe(0);
    expect(result.current.reason).toContain('Archive changed');
  });
});
