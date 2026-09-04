import { describe, expect, it } from 'vitest';
import { shouldCompensateHeightChange } from '../src/components/Chat/chatScrollAnchoring';

const base = {
  viewportTop: 100,
  viewportBottom: 700,
};

describe('chat scroll anchoring', () => {
  it('preserves the existing downward-scroll viewport-top anchor', () => {
    expect(shouldCompensateHeightChange({ ...base, direction: 'down', elementTop: 99 })).toBe(true);
    expect(shouldCompensateHeightChange({ ...base, direction: 'down', elementTop: 100 })).toBe(false);
    expect(shouldCompensateHeightChange({ ...base, direction: 'down', elementTop: 400 })).toBe(false);
  });

  it('preserves the existing upward-scroll viewport-bottom anchor', () => {
    expect(shouldCompensateHeightChange({ ...base, direction: 'up', elementTop: 699 })).toBe(true);
    expect(shouldCompensateHeightChange({ ...base, direction: 'up', elementTop: 700 })).toBe(false);
    expect(shouldCompensateHeightChange({ ...base, direction: 'up', elementTop: 701 })).toBe(false);
  });

  it('uses a jump anchor instead of the normal direction anchor', () => {
    expect(shouldCompensateHeightChange({
      ...base,
      direction: 'down',
      elementTop: 180,
      jumpAnchorTop: 220,
    })).toBe(true);
    expect(shouldCompensateHeightChange({
      ...base,
      direction: 'up',
      elementTop: 220,
      jumpAnchorTop: 220,
    })).toBe(false);
    expect(shouldCompensateHeightChange({
      ...base,
      direction: 'up',
      elementTop: 221,
      jumpAnchorTop: 220,
    })).toBe(false);
  });
});
