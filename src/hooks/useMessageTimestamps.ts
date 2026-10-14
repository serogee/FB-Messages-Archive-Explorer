import { useEffect, type RefObject } from 'react';
import { resetChatScrollAnchor } from '../components/Chat/chatScrollAnchoring';
import { MOBILE_QUERY } from './useMobileNavigation';

const MAX_TAP_MS = 500;
const MOVE_TOLERANCE = 10;
const INTERACTIVE_CONTROLS = 'a, button, input, select, textarea, [role="button"], [contenteditable="true"], .reaction-bubble';

function alignedDateHeight(height: number, margins: number, ratio: number): number {
  const minimum = Math.ceil(height + margins);
  let aligned = minimum;
  let error = Infinity;
  // Prefer the smallest whole-CSS-pixel block that also ends on a device pixel.
  // Bound the search so unusual ratios cannot introduce a large blank date row.
  for (let outer = minimum; outer < minimum + 16; outer++) {
    const pixels = outer * ratio;
    const distance = Math.abs(pixels - Math.round(pixels));
    if (distance < error - 0.000001) {
      aligned = outer;
      error = distance;
    }
    if (distance < 0.000001) break;
  }
  return aligned - margins;
}

/** Delegate taps to the chat and keep the tapped bubble in place as its date row changes. */
export function useMessageTimestamps(containerRef: RefObject<HTMLElement | null>, thread: unknown) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const query = window.matchMedia?.(MOBILE_QUERY);
    const mobile = () => query?.matches ?? window.innerWidth <= 768;
    let pressed: HTMLElement | null = null;
    let visible: HTMLElement | null = null;
    let handledClick: HTMLElement | null = null;
    let blockedClick: HTMLElement | null = null;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let startedAt = 0;

    const dateRow = (message: HTMLElement) => message.closest('.message-wrapper')?.querySelector<HTMLElement>('.mobile-msg-timestamp');
    const messageFor = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest(INTERACTIVE_CONTROLS)) return null;
      const message = target.closest<HTMLElement>('.message');
      return message && container.contains(message) && message.querySelector('.msg-timestamp')?.textContent?.trim() ? message : null;
    };
    const cancelPress = () => {
      pressed = null;
      pointerId = -1;
    };
    const reserveDateHeight = (row: HTMLElement) => {
      row.style.removeProperty('min-height');
      const height = row.getBoundingClientRect().height;
      if (height > 0) {
        const style = getComputedStyle(row);
        const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        // Include margins: the entire inserted block moves the scroll content.
        // CSS-pixel alignment alone still changes painted edges at fractional DPR.
        row.style.minHeight = `${alignedDateHeight(height, margins, window.devicePixelRatio || 1)}px`;
      }
    };
    const restoreBubbleTop = (anchor: HTMLElement | null, top: number | undefined) => {
      if (top !== undefined && anchor?.isConnected) {
        const delta = anchor.getBoundingClientRect().top - top;
        const destination = Math.max(0, container.scrollTop + delta);
        const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
        if (mobile() && destination > maximum + 0.5) {
          // Replacing a date below the tapped bubble can reduce the scroll limit.
          // Reserve space at the bottom so that limit cannot move the bubble.
          const content = container.lastElementChild;
          const contentBottom = content ? content.getBoundingClientRect().bottom - container.getBoundingClientRect().top
            + container.scrollTop + (parseFloat(getComputedStyle(container).paddingBottom) || 0) : 0;
          const unusedSpace = maximum === 0 ? Math.max(0, container.clientHeight - contentBottom) : 0;
          container.style.setProperty('--timestamp-bottom-space', `${destination - maximum + unusedSpace}px`);
        }
        if (Math.abs(destination - container.scrollTop) > 0.5) {
          container.scrollTop = destination;
        }
        resetChatScrollAnchor(container);
      }
    };
    const setVisible = (message: HTMLElement | null, anchor = message ?? visible) => {
      const top = anchor?.isConnected ? anchor.getBoundingClientRect().top : undefined;
      container.style.removeProperty('--timestamp-bottom-space');
      visible?.removeAttribute('data-timestamp-visible');
      if (visible) {
        const row = dateRow(visible);
        if (row) {
          row.style.removeProperty('min-height');
          row.textContent = '';
          row.setAttribute('aria-hidden', 'true');
        }
      }
      visible = message;
      visible?.setAttribute('data-timestamp-visible', 'true');
      if (visible) {
        const row = dateRow(visible);
        if (row) {
          row.textContent = visible.querySelector('.msg-timestamp')?.textContent ?? '';
          row.setAttribute('aria-hidden', 'false');
          reserveDateHeight(row);
        }
      }
      restoreBubbleTop(anchor, top);
    };
    const dismiss = () => {
      cancelPress();
      if (visible) setVisible(null);
    };
    const toggle = (message: HTMLElement) => {
      setVisible(visible === message ? null : message, message);
    };
    const down = (event: PointerEvent) => {
      if (event.isPrimary === false) {
        blockedClick = pressed;
        cancelPress();
        return;
      }
      cancelPress();
      handledClick = blockedClick = null;
      const message = mobile() && event.button === 0 ? messageFor(event.target) : null;
      if (!message) return;
      pressed = message;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startedAt = Date.now();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId && Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE) {
        blockedClick = pressed;
        cancelPress();
      }
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || !pressed) return;
      const message = pressed;
      cancelPress();
      if (!mobile() || messageFor(event.target) !== message || Date.now() - startedAt >= MAX_TAP_MS
        || Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE) {
        blockedClick = message;
        return;
      }
      toggle(message);
      handledClick = message;
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      blockedClick = pressed;
      cancelPress();
    };
    const click = (event: MouseEvent) => {
      if (!mobile()) return;
      const message = messageFor(event.target);
      if (!message) return;
      if (message === handledClick || message === blockedClick) {
        handledClick = blockedClick = null;
        return;
      }
      toggle(message);
    };
    const contextMenu = () => { blockedClick = pressed; cancelPress(); };
    const layoutChange = () => { dismiss(); container.style.removeProperty('--timestamp-bottom-space'); };
    let viewportWidth = container.clientWidth;
    let viewportHeight = container.clientHeight;
    let viewportRatio = window.devicePixelRatio || 1;
    const refreshDateHeight = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      if (width === viewportWidth && height === viewportHeight && ratio === viewportRatio) return;
      viewportWidth = width;
      viewportHeight = height;
      viewportRatio = ratio;
      if (!mobile() || !visible?.isConnected) return;
      const row = dateRow(visible);
      if (!row) return;
      const top = visible.getBoundingClientRect().top;
      reserveDateHeight(row);
      restoreBubbleTop(visible, top);
    };
    const viewportObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refreshDateHeight);
    // Observe the viewport, not the row whose height we adjust in the callback.
    viewportObserver?.observe(container, { box: 'border-box' });
    window.addEventListener('resize', refreshDateHeight);

    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', cancel, true);
    container.addEventListener('click', click, true);
    container.addEventListener('contextmenu', contextMenu);
    query?.addEventListener('change', layoutChange);
    return () => {
      viewportObserver?.disconnect();
      window.removeEventListener('resize', refreshDateHeight);
      dismiss();
      container.style.removeProperty('--timestamp-bottom-space');
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', cancel, true);
      container.removeEventListener('click', click, true);
      container.removeEventListener('contextmenu', contextMenu);
      query?.removeEventListener('change', layoutChange);
    };
  }, [containerRef, thread]);
}
