import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from '../src/services/progressThrottle';

describe('createProgressThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces updates while emitting stage changes and final values immediately', () => {
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

    throttle.report({ stage: 'chat', done: 4 });
    expect(emitted.at(-1)).toEqual({ stage: 'chat', done: 4 });

    throttle.report({ stage: 'chat', done: 5 });
    throttle.report({ stage: 'chat', done: 6 }, true);
    expect(emitted.at(-1)).toEqual({ stage: 'chat', done: 6 });
    expect(emitted).toHaveLength(3);
  });
});
