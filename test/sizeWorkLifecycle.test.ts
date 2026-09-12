import { describe, expect, it } from 'vitest';
import { SizeWorkLifecycle } from '../src/services/sizeWorkLifecycle';

describe('SizeWorkLifecycle', () => {
  it('aborts active work and waits for it to settle', async () => {
    const lifecycle = new SizeWorkLifecycle();
    const originalSignal = lifecycle.signal;
    let release: (() => void) | undefined;
    const activeWork = new Promise<void>(resolve => {
      release = resolve;
    });
    lifecycle.track(activeWork);

    let suspensionSettled = false;
    const suspension = lifecycle.suspend().then(() => {
      suspensionSettled = true;
    });
    await Promise.resolve();

    expect(originalSignal.aborted).toBe(true);
    expect(suspensionSettled).toBe(false);
    release?.();
    await suspension;
    expect(suspensionSettled).toBe(true);
  });

  it('resumes only after all callers release their suspension', async () => {
    const lifecycle = new SizeWorkLifecycle();
    const originalSignal = lifecycle.signal;

    await lifecycle.suspend();
    await lifecycle.suspend();

    expect(lifecycle.resume()).toBe(false);
    expect(lifecycle.suspended).toBe(true);
    expect(lifecycle.signal).toBe(originalSignal);
    expect(lifecycle.resume()).toBe(true);
    expect(lifecycle.suspended).toBe(false);
    expect(lifecycle.signal).not.toBe(originalSignal);
    expect(lifecycle.signal.aborted).toBe(false);
  });
});
