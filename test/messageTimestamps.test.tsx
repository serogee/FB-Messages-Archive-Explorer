// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageTimestamps } from '../src/hooks/useMessageTimestamps';

function Harness({ separator }: { separator?: string } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  useMessageTimestamps(ref, 'thread');
  return <div ref={ref} data-testid="chat">
    {separator && <div className="time-separator" data-testid="separator">{separator}</div>}
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
  vi.stubGlobal('devicePixelRatio', 1);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390, writable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('mobile message timestamps', () => {
  it('does not duplicate the matching separator immediately above a message', () => {
    const view = render(<Harness separator="January 14, 2026, 8:00 AM" />);
    const chat = view.getByTestId('chat');
    const message = view.getByTestId('message');
    chat.scrollTop = 100;
    tap(message);
    tap(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    expect(view.getByTestId('date-message').getAttribute('aria-hidden')).toBe('true');
    expect(view.getByTestId('date-message').textContent).toBe('');
    expect(view.getByTestId('date-message').style.minHeight).toBe('');
    expect(view.getByTestId('separator').textContent).toBe('January 14, 2026, 8:00 AM');
    expect(chat.scrollTop).toBe(100);
    expect(chat.style.getPropertyValue('--timestamp-bottom-space')).toBe('');
  });

  it('clears another revealed date when tapping a message with its own separator', () => {
    const view = render(<Harness separator="January 14, 2026, 8:00 AM" />);
    const other = view.getByTestId('other');
    tap(other);
    expect(other.hasAttribute('data-timestamp-visible')).toBe(true);
    tap(view.getByTestId('message'));
    expect(other.hasAttribute('data-timestamp-visible')).toBe(false);
    expect(view.getByTestId('date-other').textContent).toBe('');
    expect(view.getByTestId('date-message').textContent).toBe('');
    expect(view.getByTestId('separator').textContent).toBe('January 14, 2026, 8:00 AM');
  });

  it('still reveals a different exact time or a date belonging to a later message', () => {
    const view = render(<Harness separator="January 14, 2026, 7:00 AM" />);
    tap(view.getByTestId('message'));
    expect(view.getByTestId('date-message').textContent).toBe('January 14, 2026, 8:00 AM');
    view.getByTestId('other').querySelector('.msg-timestamp')!.textContent = 'January 14, 2026, 7:00 AM';
    tap(view.getByTestId('other'));
    expect(view.getByTestId('date-other').textContent).toBe('January 14, 2026, 7:00 AM');
  });

  it('reveals on a tap without toggling twice and hides only on a retap', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    tap(message);
    expect(message.getAttribute('data-timestamp-visible')).toBe('true');
    expect(view.getByTestId('date-message').getAttribute('aria-hidden')).toBe('false');
    tap(message);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(false);
    tap(message);
    vi.advanceTimersByTime(3000);
    expect(message.hasAttribute('data-timestamp-visible')).toBe(true);
    tap(message);
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

  it('keeps the date visible while scrolling and interacting outside the message', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    tap(message);
    view.getByTestId('chat').dispatchEvent(new Event('scroll'));
    expect(message.hasAttribute('data-timestamp-visible')).toBe(true);
    pointer(document.body, 'pointerdown');
    expect(message.hasAttribute('data-timestamp-visible')).toBe(true);
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
    expect(chat.scrollTop).toBe(132);
  });

  it('preserves interactive controls and desktop behavior', () => {
    const view = render(<Harness />);
    tap(view.getByRole('button'));
    expect(view.getByTestId('other').hasAttribute('data-timestamp-visible')).toBe(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    tap(view.getByTestId('message'));
    expect(view.getByTestId('message').hasAttribute('data-timestamp-visible')).toBe(false);
  });

  it('keeps fractional date rows aligned with rounded scroll offsets and clears their reservations', () => {
    const view = render(<Harness />);
    const chat = view.getByTestId('chat');
    const messages = [view.getByTestId('message'), view.getByTestId('other')];
    const rows = [view.getByTestId('date-message'), view.getByTestId('date-other')];
    const naturalHeights = [16.1875, 32.375];
    const height = (index: number) => Math.max(naturalHeights[index], parseFloat(rows[index].style.minHeight) || 0);
    let scrollTop = 100;
    Object.defineProperties(chat, {
      scrollTop: { get: () => scrollTop, set: (value: number) => { scrollTop = Math.round(value); } },
      scrollHeight: { get: () => 2000 },
      clientHeight: { get: () => 600 },
    });
    rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({ height: height(index) } as DOMRect)));
    messages.forEach((message, index) => vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => ({
      top: 200 + index * 200 + messages.slice(0, index + 1).reduce((total, message, rowIndex) => (
        total + (message.hasAttribute('data-timestamp-visible') ? height(rowIndex) + 20 : 0)
      ), 0) - scrollTop,
    } as DOMRect)));
    const firstTop = messages[0].getBoundingClientRect().top;
    tap(messages[0]);
    expect(messages[0].getBoundingClientRect().top).toBe(firstTop);
    expect(rows[0].style.minHeight).toBe('17px');
    const secondTop = messages[1].getBoundingClientRect().top;
    tap(messages[1]);
    expect(messages[1].getBoundingClientRect().top).toBe(secondTop);
    expect(rows[0].style.minHeight).toBe('');
    expect(rows[1].style.minHeight).toBe('33px');
    tap(messages[1]);
    expect(messages[1].getBoundingClientRect().top).toBe(secondTop);
    expect(rows[1].style.minHeight).toBe('');
    tap(messages[0]);
    view.unmount();
    expect(rows[0].style.minHeight).toBe('');
  });

  it.each([1, 1.25, 1.5, 2, 2.625, 3])('aligns the date including its margins with CSS and device pixels at DPR %s', ratio => {
    vi.stubGlobal('devicePixelRatio', ratio);
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    const row = view.getByTestId('date-message');
    row.style.marginTop = '12px';
    row.style.marginBottom = '8px';
    let naturalHeight = 16.1875;
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({
      height: Math.max(naturalHeight, parseFloat(row.style.minHeight) || 0),
    } as DOMRect));
    for (naturalHeight of [16.1875, 32.375]) {
      tap(message);
      const reserved = parseFloat(row.style.minHeight);
      const outer = reserved + 20;
      expect(reserved).toBeGreaterThanOrEqual(naturalHeight);
      expect(reserved - naturalHeight).toBeLessThan(16);
      expect(outer).toBe(Math.round(outer));
      expect(outer * ratio).toBeCloseTo(Math.round(outer * ratio), 5);
      tap(message);
      expect(row.style.minHeight).toBe('');
    }
  });

  it('bounds the date spacing at uncommon display ratios and reacts to ratio changes without a viewport size change', () => {
    const view = render(<Harness />);
    const message = view.getByTestId('message');
    const row = view.getByTestId('date-message');
    row.style.marginTop = '12px';
    row.style.marginBottom = '8px';
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({
      height: Math.max(16.1875, parseFloat(row.style.minHeight) || 0),
    } as DOMRect));
    tap(message);
    expect(row.style.minHeight).toBe('17px');
    vi.stubGlobal('devicePixelRatio', 1.25);
    window.dispatchEvent(new Event('resize'));
    expect(row.style.minHeight).toBe('20px');
    vi.stubGlobal('devicePixelRatio', 1.23456789);
    window.dispatchEvent(new Event('resize'));
    expect(parseFloat(row.style.minHeight)).toBeGreaterThanOrEqual(16.1875);
    expect(parseFloat(row.style.minHeight)).toBeLessThan(32.1875);
    view.unmount();
    window.dispatchEvent(new Event('resize'));
    expect(row.style.minHeight).toBe('');
  });

  it('refreshes a visible date reservation on viewport resize without observing its own row', () => {
    let resize: () => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const view = render(<Harness />);
    const chat = view.getByTestId('chat');
    const message = view.getByTestId('message');
    const row = view.getByTestId('date-message');
    let width = 390;
    let naturalHeight = 16.1875;
    Object.defineProperty(chat, 'clientWidth', { get: () => width });
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({
      height: Math.max(naturalHeight, parseFloat(row.style.minHeight) || 0),
    } as DOMRect));
    resize();
    tap(message);
    expect(row.style.minHeight).toBe('17px');
    width = 320;
    naturalHeight = 32.375;
    resize();
    expect(row.style.minHeight).toBe('33px');
    width = 640;
    naturalHeight = 16.1875;
    resize();
    expect(row.style.minHeight).toBe('17px');
    expect(observe).toHaveBeenCalledExactlyOnceWith(chat, { box: 'border-box' });
    expect(message.getAttribute('data-timestamp-visible')).toBe('true');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(row.style.minHeight).toBe('');
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
