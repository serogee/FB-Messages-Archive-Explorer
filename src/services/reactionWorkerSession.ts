import { checkReactionAbort } from './reactionAuditInventory';
import type { ReactionWorkerInput, ReactionWorkerReply } from './reactionAuditProtocol';

export interface ReactionWorkerSession {
  signal: AbortSignal;
  check: () => void;
  idle: (isCurrent?: () => boolean) => Promise<void>;
  request: (input: ReactionWorkerInput, isCurrent?: () => boolean) => Promise<ReactionWorkerReply>;
  dispose: () => void;
}
export function createReactionWorkerSession(paused: () => boolean): ReactionWorkerSession {
  const controller = new AbortController();
  const worker = new Worker(new URL('./reactionAuditWorker.ts', import.meta.url), { type: 'module' });
  let queue: Promise<unknown> = Promise.resolve();
  let failure: Error | null = null;
  let pending: { resolve: (reply: ReactionWorkerReply) => void; reject: (error: Error) => void } | null = null;
  const fail = (error: Error) => { failure = error; pending?.reject(error); };
  // Register before any filesystem work; an early module failure must not leave
  // a later request waiting forever for a worker that never loaded.
  worker.onerror = event => fail(new Error(event.message || 'Reaction worker unavailable.'));
  worker.onmessageerror = () => fail(new Error('Reaction worker response could not be read.'));
  worker.onmessage = event => pending?.resolve(event.data as ReactionWorkerReply);
  const check = () => { checkReactionAbort(controller.signal); if (failure) throw failure; };
  const idle = async (isCurrent?: () => boolean) => {
    const current = () => { check(); if (isCurrent && !isCurrent()) throw new DOMException('Aborted', 'AbortError'); };
    current();
    while (paused()) { await new Promise(r => setTimeout(r, 50)); current(); }
  };
  const request = (input: ReactionWorkerInput, isCurrent?: () => boolean): Promise<ReactionWorkerReply> => {
    const task = queue.then(async () => {
      // Recheck canceled mode/chat work immediately before queued dispatch.
      await idle(isCurrent);
      return new Promise<ReactionWorkerReply>((resolve, reject) => {
        const finish = () => { controller.signal.removeEventListener('abort', abort); pending = null; };
        const abort = () => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
        pending = {
          resolve: reply => { finish(); if (reply.type === 'error') reject(new Error(reply.reason)); else resolve(reply); },
          reject: error => { finish(); reject(error); },
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        try { worker.postMessage(input); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    queue = task.catch(() => {});
    return task;
  };
  return { signal: controller.signal, check, idle, request, dispose: () => { controller.abort(); worker.terminate(); } };
}
