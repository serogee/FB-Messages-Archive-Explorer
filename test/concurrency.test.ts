import { describe, expect, it, vi } from 'vitest';
import { createConcurrencyLimiter, LiveConcurrencyLimit, mapWithConcurrency } from '../src/services/concurrency';

describe('live concurrency', () => {
  it('starts more pending jobs immediately and drains active work before reducing the limit', async () => {
    const source = new LiveConcurrencyLimit(1);
    const releases: Array<() => void> = [];
    const gates = Array.from({ length: 6 }, () => new Promise<void>(resolve => { releases.push(resolve); }));
    const started: number[] = [];
    let active = 0, peak = 0;
    const pending = mapWithConcurrency(gates, source, async (gate, index) => {
      started.push(index); active++; peak = Math.max(peak, active);
      await gate; active--; return index;
    });
    expect(started).toEqual([0]);
    source.set(3);
    expect(started).toEqual([0, 1, 2]);
    source.set(1);
    releases[0](); releases[1]();
    await vi.waitFor(() => expect(active).toBe(1));
    expect(started).toEqual([0, 1, 2]);
    releases[2]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    source.set(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    releases.forEach(release => release());
    expect(await pending).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(3);
  });

  it('updates a shared limiter across queued lists and releases its setting subscription', async () => {
    const source = new LiveConcurrencyLimit(1);
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const originalSubscribe = source.subscribe;
    vi.spyOn(source, 'subscribe').mockImplementation(listener => {
      const stop = vi.fn(originalSubscribe(listener)); unsubscribes.push(stop); return stop;
    });
    const limit = createConcurrencyLimiter(source);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: number[] = [];
    const pending = Promise.all([0, 1, 2, 3].map(index => limit(async () => { started.push(index); await gate; return index; })));
    await vi.waitFor(() => expect(started).toEqual([0]));
    source.set(3);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    source.set(1);
    release();
    expect(await pending).toEqual([0, 1, 2, 3]);
    expect(unsubscribes.every(stop => stop.mock.calls.length === 1)).toBe(true);
  });

  it('cancels pending jobs after resizing and waits for active work before rejecting', async () => {
    const source = new LiveConcurrencyLimit(1);
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: number[] = [];
    const pending = mapWithConcurrency([0, 1, 2, 3], source, async index => { started.push(index); await gate; return index; }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    source.set(2);
    controller.abort();
    source.set(4);
    expect(started).toEqual([0, 1]);
    release();
    await rejected;
  });
});

describe('shared concurrency limit', () => {
  it('caps independent lists together and releases slots after failures', async () => {
    const limit = createConcurrencyLimiter(4);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, peak = 0, started = 0;
    const lists = Array.from({ length: 4 }, (_, section) => mapWithConcurrency([0, 1, 2, 3], 4, index => limit(async () => {
      active++;
      peak = Math.max(peak, active);
      started++;
      try { await gate; if (section === 0 && index === 0) throw new Error('unreadable'); return index; }
      finally { active--; }
    }).catch(() => -1)));
    await vi.waitFor(() => expect(started).toBe(4));
    expect(peak).toBe(4);
    release();
    expect(await Promise.all(lists)).toEqual([[-1, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it('removes cancelled queued reads without consuming or leaking a slot', async () => {
    const limit = createConcurrencyLimiter(1);
    let release!: () => void;
    const first = limit(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const controller = new AbortController();
    const read = vi.fn(async () => 'cancelled');
    const cancelled = limit(read, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const next = limit(async () => 'next');
    controller.abort();
    await rejected;
    release();
    await first;
    expect(await next).toBe('next');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN])('rejects an invalid shared limit %s', concurrency => {
    expect(() => createConcurrencyLimiter(concurrency)).toThrow(RangeError);
  });
});

describe('mapWithConcurrency', () => {
  it('caps active work and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases = Array.from({ length: 6 }, () => {
      let release = () => {};
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });
    const work = mapWithConcurrency([3, 1, 2, 0, 4, 5], 3, async (value, index) => {
      active++;
      peak = Math.max(peak, active);
      started.push(value);
      await releases[index].promise;
      active--;
      return value * 2;
    });

    expect(started).toEqual([3, 1, 2]);
    expect(active).toBe(3);
    releases[2].release();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([3, 1, 2, 0]);

    releases.forEach(gate => gate.release());
    const results = await work;
    expect(peak).toBe(3);
    expect(results).toEqual([6, 2, 4, 0, 8, 10]);
  });

  it('stops scheduling after abort and waits for active work', async () => {
    const abortController = new AbortController();
    let started = 0;
    let active = 0;
    const work = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async () => {
      started++;
      active++;
      abortController.abort();
      await Promise.resolve();
      active--;
      return started;
    }, abortController.signal);

    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toBe(1);
    expect(active).toBe(0);
  });
});
