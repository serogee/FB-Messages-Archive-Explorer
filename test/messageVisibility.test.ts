import { describe, expect, it } from 'vitest';
import { getVisibleMessageNeighbors } from '../src/services/messageVisibility';

describe('visible message neighbors', () => {
  it('retains original indices across hidden runs for clumps and separators', () => {
    const { previous, next } = getVisibleMessageNeighbors(Uint8Array.from([1, 0, 1, 1, 0, 1]));
    expect([...previous]).toEqual([-1, -1, 1, 1, 1, 4]);
    expect([...next]).toEqual([1, 4, 4, 4, -1, -1]);
  });

  it('handles empty and entirely hidden threads', () => {
    expect(getVisibleMessageNeighbors(new Uint8Array()).previous).toHaveLength(0);
    const { previous, next } = getVisibleMessageNeighbors(Uint8Array.from([1, 1, 1]));
    expect([...previous]).toEqual([-1, -1, -1]);
    expect([...next]).toEqual([-1, -1, -1]);
  });
});
