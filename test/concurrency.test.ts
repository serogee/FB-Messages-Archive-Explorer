import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/services/concurrency';

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
