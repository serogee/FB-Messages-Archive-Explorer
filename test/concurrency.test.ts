import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/services/concurrency';

describe('mapWithConcurrency', () => {
  it('caps active work and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([3, 1, 2, 0, 4, 5], 3, async value => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, value));
      active--;
      return value * 2;
    });

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
