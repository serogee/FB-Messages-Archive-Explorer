import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from '../src/services/progressThrottle';

describe('createProgressThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces delayed updates and supports stage changes, final values, flush, and cancel', () => {
    vi.useFakeTimers();
    const emitted: Array<{ stage: string; done: number }> = [];
    const throttle = createProgressThrottle(
      value => emitted.push(value),
      100,
      value => value.stage
    );

    throttle.report({ stage: 'media', done: 1 });
    throttle.report({ stage: 'media', done: 2 });
    throttle.report({ stage: 'media', done: 3 });
    expect(emitted).toEqual([{ stage: 'media', done: 1 }]);
    vi.advanceTimersByTime(99);
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(emitted.at(-1)).toEqual({ stage: 'media', done: 3 });

    throttle.report({ stage: 'chat', done: 4 });
    expect(emitted.at(-1)).toEqual({ stage: 'chat', done: 4 });

    throttle.report({ stage: 'chat', done: 5 });
    throttle.flush();
    expect(emitted.at(-1)).toEqual({ stage: 'chat', done: 5 });

    throttle.report({ stage: 'chat', done: 6 });
    throttle.cancel();
    vi.advanceTimersByTime(100);
    expect(emitted.at(-1)).toEqual({ stage: 'chat', done: 5 });

    throttle.report({ stage: 'chat', done: 7 }, true);
    expect(emitted.at(-1)).toEqual({ stage: 'chat', done: 7 });
    expect(emitted).toHaveLength(5);
  });
});
