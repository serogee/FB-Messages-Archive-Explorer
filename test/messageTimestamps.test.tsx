// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageTimestamps } from '../src/hooks/useMessageTimestamps';

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useMessageTimestamps(ref, 'thread');
  return <div ref={ref} data-testid="chat">
    <div className="message" data-testid="message">Message<span className="msg-timestamp">January 14, 2026, 8:00 AM</span></div>
    <div className="message" data-testid="other">Another message<span className="msg-timestamp">January 15, 2026, 8:00 AM</span><button>Open attachment</button></div>
  </div>;
}

function pointer(target: HTMLElement, type: string, x = 20, y = 20) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, button: { value: 0 }, clientX: { value: x }, clientY: { value: y } });
  target.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390, writable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('mobile message timestamps', () => {
  it('ignores a tap, reveals after a hold, and dismisses after release', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    pointer(message, 'pointerdown');
    vi.advanceTimersByTime(200);
    pointer(message, 'pointerup');
    vi.advanceTimersByTime(500);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(message.getAttribute('data-timestamp-visible')).toBe('true');
    pointer(message, 'pointerup');
    expect(message.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('cancels a swipe, pointer cancellation, scrolling, and navigation outside the message', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    pointer(message, 'pointerdown');
    pointer(message, 'pointermove', 20, 45);
    vi.advanceTimersByTime(500);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    pointer(message, 'pointercancel');
    vi.advanceTimersByTime(500);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    vi.advanceTimersByTime(500);
    view.getByTestId('chat').dispatchEvent(new Event('scroll'));
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    vi.advanceTimersByTime(500);
    pointer(view.getByTestId('other'), 'pointerdown');
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('preserves interactive controls and desktop behavior', () => {
    const view = render(<Harness />);
    pointer(view.getByRole('button'), 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(view.getByTestId('other').hasAttribute('data-timestamp-visible')).toBe(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    pointer(view.getByTestId('message'), 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(view.getByTestId('message').hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('handles native long-press context menus and cleans up a held message on unmount', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    pointer(message, 'pointerdown');
    expect(message.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(true);
    view.unmount();
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    expect(message.hasAttribute('data-timestamp-press')).toBe(false);
  });
});
