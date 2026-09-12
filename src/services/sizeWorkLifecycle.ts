export class SizeWorkLifecycle {
  private controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private suspensionCount = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get suspended(): boolean {
    return this.suspensionCount > 0;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.finally(() => {
      this.active.delete(promise);
    }).catch(() => {});
    return promise;
  }

  async suspend(): Promise<void> {
    this.suspensionCount++;
    if (this.suspensionCount === 1) this.controller.abort();

    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }

  resume(): boolean {
    if (this.suspensionCount === 0) return false;
    this.suspensionCount--;
    if (this.suspensionCount > 0) return false;

    this.controller = new AbortController();
    return true;
  }

  reset(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.suspensionCount = 0;
  }
}
