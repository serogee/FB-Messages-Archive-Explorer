function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer.');
  }

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
