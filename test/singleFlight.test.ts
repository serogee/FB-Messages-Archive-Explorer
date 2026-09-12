import { describe, expect, it } from 'vitest';
import { SingleFlightGuard } from '../src/services/singleFlight';

describe('SingleFlightGuard', () => {
  it('rejects a second synchronous start until the first token finishes', () => {
    const guard = new SingleFlightGuard();
    const first = guard.tryBegin();

    expect(first).toBeTypeOf('symbol');
    expect(guard.busy).toBe(true);
    expect(guard.tryBegin()).toBeNull();

    guard.finish(Symbol('not-the-owner'));
    expect(guard.tryBegin()).toBeNull();
    guard.finish(first!);
    expect(guard.tryBegin()).toBeTypeOf('symbol');
  });
});
