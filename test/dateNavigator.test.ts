import { describe, expect, it } from 'vitest';
import {
  estimateMessageIndexInChunk,
  shouldAcceptBucketChange,
} from '../src/components/Chat/dateNavigatorScroll';

describe('date navigator scroll synchronization', () => {
  it('estimates the active message within an unrendered virtual chunk', () => {
    expect(estimateMessageIndexInChunk(150, 299, 100, 1_100, 100)).toBe(150);
    expect(estimateMessageIndexInChunk(150, 299, 100, 1_100, 600)).toBe(225);
    expect(estimateMessageIndexInChunk(150, 299, 100, 1_100, 1_100)).toBe(299);
  });

  it('does not move to an earlier bucket while scrolling down', () => {
    expect(shouldAcceptBucketChange(6, 5, 'down')).toBe(false);
    expect(shouldAcceptBucketChange(6, 7, 'down')).toBe(true);
    expect(shouldAcceptBucketChange(6, 7, 'up')).toBe(false);
    expect(shouldAcceptBucketChange(6, 5, 'up')).toBe(true);
  });
});
