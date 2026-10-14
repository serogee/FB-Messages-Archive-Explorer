// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageTimestamps } from '../src/hooks/useMessageTimestamps';

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useMessageTimestamps(ref, 'thread');
  return <div ref={ref} data-testid="chat">
    <div className="message-wrapper">
      <div className="time-separator mobile-msg-timestamp" data-testid="date-message" aria-hidden="true" />
      <div className="message" data-testid="message">Message<span className="msg-timestamp">January 14, 2026, 8:00 AM</span></div>
    </div>
    <div className="message-wrapper">
      <div className="time-separator mobile-msg-timestamp" data-testid="date-other" aria-hidden="true" />
      <div className="message" data-testid="other">Another message<span className="msg-timestamp">January 15, 2026, 8:00 AM</span><button>Open attachment</button></div>
    </div>
  </div>;
}

function pointer(target: HTMLElement, type: string, x = 20, y = 20, primary = true) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: primary ? 1 : 2 }, isPrimary: { value: primary }, button: { value: 0 }, clientX: { value: x }, clientY: { value: y } });
  target.dispatchEvent(event);
}

function click(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
}

function tap(target: HTMLElement) {
  pointer(target, 'pointerdown');
  pointer(target, 'pointerup');
  click(target);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390, writable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('mobile message timestamps', () => {
  it('reveals on a tap without toggling twice, toggles off, and dismisses after a delay', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    tap(message);
    expect(message.getAttribute('data-timestamp-visible')).toBe('true');
    expect(view.getByTestId('date-message').getAttribute('aria-hidden')).toBe('false');
    tap(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    tap(message);
    vi.advanceTimersByTime(3000);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    expect(view.getByTestId('date-message').getAttribute('aria-hidden')).toBe('true');
  });

  it('ignores holds, swipes, pointer cancellation, and multiple touches', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    pointer(message, 'pointerdown');
    vi.advanceTimersByTime(700);
    pointer(message, 'pointerup');
    click(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    pointer(message, 'pointermove', 20, 45);
    pointer(message, 'pointerup', 20, 45);
    click(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    pointer(message, 'pointercancel');
    click(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    pointer(message, 'pointerdown');
    pointer(message, 'pointerdown', 20, 20, false);
    pointer(message, 'pointerup');
    click(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('dismisses for user scrolling and interactions outside the message', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    tap(message);
    view.getByTestId('chat').dispatchEvent(new Event('scroll'));
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    tap(message);
    pointer(document.body, 'pointerdown');
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('keeps the tapped bubble stationary when revealing, changing, or hiding dates', () => {
    const view = render(<Harness />);
    const chat = view.getByTestId('chat');
    const first = view.getByTestId('message');
    const second = view.getByTestId('other');
    chat.scrollTop = 100;
    const messages = [first, second];
    for (const [index, message] of messages.entries()) {
      vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => ({
        top: 200 + index * 200 + messages.slice(0, index + 1).filter(element => element.hasAttribute('data-timestamp-visible')).length * 32 - chat.scrollTop,
      } as DOMRect));
    }
    const secondTop = second.getBoundingClientRect().top;
    const firstTop = first.getBoundingClientRect().top;
    tap(second);
    expect(second.getBoundingClientRect().top).toBe(secondTop);
    expect(first.getBoundingClientRect().top).toBe(firstTop - 32);
    expect(chat.scrollTop).toBe(132);
    chat.dispatchEvent(new Event('scroll'));
    expect(second.hasAttribute('data-timestamp-visible')).toBe(true);
    tap(second);
    expect(second.getBoundingClientRect().top).toBe(secondTop);
    expect(chat.scrollTop).toBe(100);
    tap(first);
    tap(second);
    expect(first.hasAttribute('data-timestamp-visible')).toBe(false);
    expect(second.getBoundingClientRect().top).toBe(secondTop);
    vi.advanceTimersByTime(3000);
    expect(second.getBoundingClientRect().top).toBe(secondTop);
    expect(chat.scrollTop).toBe(100);
  });

  it('preserves interactive controls and desktop behavior', () => {
    const view = render(<Harness />);
    tap(view.getByRole('button'));
    expect(view.getByTestId('other').hasAttribute('data-timestamp-visible')).toBe(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    tap(view.getByTestId('message'));
    expect(view.getByTestId('message').hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('preserves native context menus and cleans up a revealed date on unmount', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    pointer(message, 'pointerdown');
    expect(message.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true);
    pointer(message, 'pointerup');
    click(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    tap(message);
    view.unmount();
    vi.advanceTimersByTime(3000);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
  });
});
