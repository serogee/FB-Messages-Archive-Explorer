import { describe, expect, it, vi } from 'vitest';
import { SubscribableTaskQueue, type TaskCompletion } from '../src/services/subscribableTaskQueue';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('subscribable task queue', () => {
  it('drops abandoned queued work before it starts', async () => {
    let releaseBlocker = () => {};
    const started: string[] = [];
    const queue = new SubscribableTaskQueue<string, string>(1, async key => {
      started.push(key);
      if (key === 'blocker') await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return key;
    });

    queue.subscribe('blocker', () => {});
    const unsubscribe = queue.subscribe('abandoned', () => {});
    unsubscribe();
    releaseBlocker();
    await flush();

    expect(started).toEqual(['blocker']);
  });

  it('promotes a queued task when it is requested again', async () => {
    let releaseBlocker = () => {};
    const started: string[] = [];
    const queue = new SubscribableTaskQueue<string, string>(1, async key => {
      started.push(key);
      if (key === 'blocker') await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return key;
    });

    queue.subscribe('blocker', () => {});
    queue.subscribe('first', () => {});
    queue.subscribe('promoted', () => {});
    queue.subscribe('promoted', () => {});
    releaseBlocker();
    await flush();

    expect(started.slice(0, 2)).toEqual(['blocker', 'promoted']);
  });

  it('keeps shared work alive until the last subscriber leaves', async () => {
    let finish = (_value: string) => {};
    const worker = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const first = vi.fn();
    const second = vi.fn();
    const queue = new SubscribableTaskQueue<string, string>(1, worker);

    const unsubscribeFirst = queue.subscribe('shared', first);
    queue.subscribe('shared', second);
    unsubscribeFirst();
    finish('result');
    await flush();

    expect(worker).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ status: 'completed', value: 'result' });
  });

  it('allows a replacement request while an aborted task is settling', async () => {
    const started: AbortSignal[] = [];
    const queue = new SubscribableTaskQueue<string, number>(1, (_key, signal) => {
      started.push(signal);
      if (started.length === 2) return Promise.resolve(2);
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(1), { once: true }));
    });
    const result = vi.fn();

    const unsubscribe = queue.subscribe('same', () => {});
    unsubscribe();
    queue.subscribe('same', result);
    await flush();

    expect(started).toHaveLength(2);
    expect(started[0].aborted).toBe(true);
    expect(result).toHaveBeenCalledWith({ status: 'completed', value: 2 });
  });

  it('cancels pending subscribers and isolates callback errors on clear', () => {
    const completions: TaskCompletion<string>[] = [];
    const queue = new SubscribableTaskQueue<string, string>(1, () => new Promise(() => {}));
    queue.subscribe('running', () => { throw new Error('consumer failed'); });
    queue.subscribe('running', completion => completions.push(completion));

    queue.clear();

    expect(completions).toEqual([{ status: 'cancelled' }]);
  });

  it('does not accumulate rapid abandoned requests', async () => {
    let releaseBlocker = () => {};
    const worker = vi.fn(async (key: string) => {
      if (key === 'blocker') await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return key;
    });
    const queue = new SubscribableTaskQueue<string, string>(1, worker);
    queue.subscribe('blocker', () => {});

    for (let index = 0; index < 100; index++) {
      queue.subscribe(`item-${index}`, () => {})();
    }
    releaseBlocker();
    await flush();

    expect(worker).toHaveBeenCalledOnce();
  });
});
