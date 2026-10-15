import { describe, expect, it, vi } from 'vitest';
import { SubscribableTaskQueue, type TaskCompletion } from '../src/services/subscribableTaskQueue';
import { LiveConcurrencyLimit } from '../src/services/concurrency';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('subscribable task queue', () => {
  it('resizes pending preview work live while retaining visible-first priority', async () => {
    const source = new LiveConcurrencyLimit(1);
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const queue = new SubscribableTaskQueue<string, string>(source, async key => {
      started.push(key);
      await new Promise<void>(resolve => releases.set(key, resolve));
      return key;
    });
    queue.subscribe('first', () => {});
    queue.subscribe('background', () => {}, 2);
    queue.subscribe('visible', () => {}, 0);
    queue.subscribe('nearby', () => {}, 1);
    source.set(3);
    expect(started).toEqual(['first', 'visible', 'nearby']);
    source.set(1);
    releases.get('first')!(); releases.get('visible')!();
    await flush();
    expect(started).toEqual(['first', 'visible', 'nearby']);
    releases.get('nearby')!();
    await vi.waitFor(() => expect(started).toEqual(['first', 'visible', 'nearby', 'background']));
    releases.get('background')!();
    await flush();
    queue.clear();
  });
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

  it('starts visible work before preload and retention work', async () => {
    let releaseBlocker = () => {};
    const started: string[] = [];
    const queue = new SubscribableTaskQueue<string, string>(1, async key => {
      started.push(key);
      if (key === 'blocker') await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return key;
    });

    queue.subscribe('blocker', () => {});
    queue.subscribe('retention', () => {}, 2);
    queue.subscribe('preload', () => {}, 1);
    queue.subscribe('visible', () => {}, 0);
    releaseBlocker();
    await flush();
    await flush();

    expect(started).toEqual(['blocker', 'visible', 'preload', 'retention']);
  });

  it('moves unfinished retention work behind nearby work without restarting it', async () => {
    let releaseBlocker = () => {};
    const started: string[] = [];
    const queue = new SubscribableTaskQueue<string, string>(1, async key => {
      started.push(key);
      if (key === 'blocker') await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return key;
    });

    queue.subscribe('blocker', () => {});
    const retained = queue.subscribe('retained', () => {}, 1);
    queue.subscribe('nearby', () => {}, 1);
    retained.setPriority(2);
    releaseBlocker();
    await flush();
    await flush();

    expect(started).toEqual(['blocker', 'nearby', 'retained']);
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
