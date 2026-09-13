// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResizable } from '../src/hooks/useResizable';

function rect(left: number, width: number, right = left + width): DOMRect {
  return { left, right, width, top: 0, bottom: 600, height: 600, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

function pointerEvent(type: string, clientX: number, pointerId = 1): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: pointerId },
    isPrimary: { value: true },
    button: { value: 0 },
  });
  return event;
}

function Harness({ side = 'left', initialWidth = 300, onWidthChange }: {
  side?: 'left' | 'right';
  initialWidth?: number;
  onWidthChange: (width: number) => void;
}) {
  const { handleRef } = useResizable({
    minWidth: 240,
    maxWidthFraction: 0.5,
    maxWidthAbsolute: 600,
    initialWidth,
    onWidthChange,
    cssVariable: '--test-panel-width',
    minMainWidth: 320,
    side,
  });
  return (
    <div className="container">
      <div
        ref={handleRef}
        className={side === 'left' ? 'sidebar-resize-handle' : 'info-resize-handle'}
        role="separator"
        tabIndex={0}
      />
    </div>
  );
}

function installGeometry(container: HTMLElement, handle: HTMLElement, side: 'left' | 'right') {
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0, 1000, 1000));
  vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue(
    side === 'left' ? rect(300, 10, 310) : rect(690, 10, 700),
  );
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--test-panel-width');
  document.getElementById('resizeHandlePreview')?.remove();
  vi.restoreAllMocks();
});

describe('resizable hook lifecycle', () => {
  it('commits pointer movement and updates ARIA state', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const onWidthChange = vi.fn();
    const view = render(<Harness onWidthChange={onWidthChange} />);
    const container = view.container.querySelector<HTMLElement>('.container')!;
    const handle = view.getByRole('separator');
    installGeometry(container, handle, 'left');

    handle.dispatchEvent(pointerEvent('pointerdown', 305));
    window.dispatchEvent(pointerEvent('pointermove', 405));
    window.dispatchEvent(pointerEvent('pointerup', 405));

    expect(onWidthChange).toHaveBeenLastCalledWith(400);
    expect(document.documentElement.style.getPropertyValue('--test-panel-width')).toBe('400px');
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    expect(container.classList.contains('resizing')).toBe(false);
  });

  it('rolls back pointer cancellation and Escape and cleans resize UI on unmount', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const onWidthChange = vi.fn();
    const view = render(<Harness onWidthChange={onWidthChange} />);
    const container = view.container.querySelector<HTMLElement>('.container')!;
    const handle = view.getByRole('separator');
    installGeometry(container, handle, 'left');

    handle.dispatchEvent(pointerEvent('pointerdown', 305));
    window.dispatchEvent(pointerEvent('pointermove', 405));
    window.dispatchEvent(pointerEvent('pointercancel', 405));
    expect(onWidthChange).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--test-panel-width')).toBe('300px');

    handle.dispatchEvent(pointerEvent('pointerdown', 305, 2));
    window.dispatchEvent(pointerEvent('pointermove', 405, 2));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onWidthChange).not.toHaveBeenCalled();
    expect(document.getElementById('resizeHandlePreview')?.classList.contains('active')).toBe(false);

    handle.dispatchEvent(pointerEvent('pointerdown', 305, 3));
    view.unmount();
    expect(document.getElementById('resizeHandlePreview')?.classList.contains('active')).toBe(false);
  });

  it('uses side-aware keyboard direction and reclamps after viewport changes', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    const leftChange = vi.fn();
    const leftView = render(<Harness initialWidth={400} onWidthChange={leftChange} />);
    const leftContainer = leftView.container.querySelector<HTMLElement>('.container')!;
    const leftHandle = leftView.getByRole('separator');
    installGeometry(leftContainer, leftHandle, 'left');
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(leftChange).toHaveBeenLastCalledWith(420);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600, writable: true });
    window.dispatchEvent(new Event('resize'));
    expect(leftChange).toHaveBeenLastCalledWith(300);
    expect(leftHandle.getAttribute('aria-valuenow')).toBe('300');
    leftView.unmount();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    const rightChange = vi.fn();
    const rightView = render(<Harness side="right" onWidthChange={rightChange} />);
    const rightContainer = rightView.container.querySelector<HTMLElement>('.container')!;
    const rightHandle = rightView.getByRole('separator');
    installGeometry(rightContainer, rightHandle, 'right');
    rightHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(rightChange).toHaveBeenLastCalledWith(320);
  });
});
