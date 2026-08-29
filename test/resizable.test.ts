import { describe, expect, it } from 'vitest';
import { clampResizableWidth } from '../src/hooks/useResizable';

describe('clampResizableWidth', () => {
  const bounds = {
    minWidth: 240,
    maxWidthFraction: 0.45,
    maxWidthAbsolute: 520,
    viewportWidth: 1200,
  };

  it('allows the info panel to shrink to its new minimum', () => {
    expect(clampResizableWidth(100, bounds)).toBe(240);
  });

  it('uses the strictest viewport and absolute maximum', () => {
    expect(clampResizableWidth(800, bounds)).toBe(520);
    expect(clampResizableWidth(800, { ...bounds, viewportWidth: 1000 })).toBe(450);
  });

  it('preserves main-content space when the layout maximum is tighter', () => {
    expect(clampResizableWidth(500, { ...bounds, layoutMaximum: 375 })).toBe(375);
  });

  it('never makes an impossible layout maximum smaller than the panel minimum', () => {
    expect(clampResizableWidth(300, { ...bounds, layoutMaximum: 180 })).toBe(240);
  });
});
