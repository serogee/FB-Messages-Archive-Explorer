interface ScopedValue<K, V> {
  key: K;
  generation: number;
  value: V;
}

interface ScopedPromise<K, V> {
  key: K;
  generation: number;
  promise: Promise<V>;
}

export class GenerationScopedAsyncCache<K, V> {
  private resolved: ScopedValue<K, V> | null = null;
  private pending: ScopedPromise<K, V> | null = null;

  get(key: K, generation: number): V | undefined {
    const cached = this.resolved;
    return cached && cached.key === key && cached.generation === generation
      ? cached.value
      : undefined;
  }

  set(key: K, generation: number, value: V): void {
    this.resolved = { key, generation, value };
  }

  getOrCreate(
    key: K,
    generation: number,
    build: () => Promise<V>,
    isCurrent: () => boolean
  ): Promise<V> {
    const cached = this.get(key, generation);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = this.pending;
    if (pending && pending.key === key && pending.generation === generation) {
      return pending.promise;
    }

    const promise = build().then(value => {
      if (isCurrent()) this.set(key, generation, value);
      return value;
    });
    const record = { key, generation, promise };
    this.pending = record;
    void promise.finally(() => {
      if (this.pending === record) this.pending = null;
    }).catch(() => {});
    return promise;
  }

  clear(): void {
    this.resolved = null;
    this.pending = null;
  }
}
