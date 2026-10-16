function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function waitForPromiseWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

export const FILE_READ_CONCURRENCY = 4;

export interface ConcurrencySource {
  get(): number;
  subscribe(listener: () => void): () => void;
}

export class LiveConcurrencyLimit implements ConcurrencySource {
  private listeners = new Set<() => void>();
  private value: number;
  constructor(value: number) { validateConcurrency(value); this.value = value; }
  get = (): number => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set(value: number): void {
    validateConcurrency(value);
    if (value === this.value) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
}

export type Concurrency = number | ConcurrencySource;
export const concurrencyValue = (limit: Concurrency): number => typeof limit === 'number' ? limit : limit.get();
function validateConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('Concurrency must be a positive integer.');
}

export type ConcurrencyLimiter = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** Share a limit across independently enumerated lists without starting queued work. */
export function createConcurrencyLimiter(concurrency: Concurrency): ConcurrencyLimiter {
  validateConcurrency(concurrencyValue(concurrency));
  let active = 0;
  let unsubscribe: (() => void) | undefined;
  const queue: Array<() => void> = [];
  const drain = () => {
    if (queue.length && !unsubscribe && typeof concurrency !== 'number') unsubscribe = concurrency.subscribe(drain);
    while (active < concurrencyValue(concurrency) && queue.length) queue.shift()!();
    if (!queue.length) { unsubscribe?.(); unsubscribe = undefined; }
  };

  return async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', abort);
        active++;
        resolve();
      };
      const abort = () => {
        const index = queue.indexOf(start);
        if (index !== -1) queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('Aborted', 'AbortError'));
        drain();
      };
      queue.push(start);
      signal?.addEventListener('abort', abort, { once: true });
      drain();
    });
    try {
      throwIfAborted(signal);
      return await task();
    } finally {
      active--;
      drain();
    }
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: Concurrency,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  validateConcurrency(concurrencyValue(concurrency));
  if (typeof concurrency !== 'number') return mapWithLiveConcurrency(items, concurrency, mapper, signal);

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex++;
      results[index] = await mapper(items[index], index);
      throwIfAborted(signal);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  const outcomes = await Promise.allSettled(workers);
  throwIfAborted(signal);
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (failure) throw failure.reason;
  return results;
}

/** Resize pending work immediately; never interrupt active I/O or publish late results. */
function mapWithLiveConcurrency<T, R>(
  items: readonly T[], source: ConcurrencySource,
  mapper: (item: T, index: number) => Promise<R>, signal?: AbortSignal,
): Promise<R[]> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const results: R[] = [];
    let next = 0, active = 0;
    let failed = false, failure: unknown;
    let draining = false, finished = false;
    const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', drain); };
    const drain = () => {
      if (draining || finished) return;
      draining = true;
      while (!failed && !signal?.aborted && next < items.length && active < source.get()) {
        const index = next++;
        active++;
        let operation: Promise<R>;
        try { operation = mapper(items[index], index); } catch (error) { operation = Promise.reject(error); }
        void Promise.resolve(operation).then(value => { results[index] = value; }, error => {
          failed = true; failure = error;
        }).finally(() => { active--; drain(); });
      }
      draining = false;
      if (active === 0 && (next >= items.length || failed || signal?.aborted)) {
        finished = true;
        cleanup();
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else if (failed) reject(failure);
        else resolve(results);
      }
    };
    const unsubscribe = source.subscribe(drain);
    signal?.addEventListener('abort', drain, { once: true });
    drain();
  });
}
