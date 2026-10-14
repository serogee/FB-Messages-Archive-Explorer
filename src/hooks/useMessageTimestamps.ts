import { useEffect, type RefObject } from 'react';
import { MOBILE_QUERY } from './useMobileNavigation';

const HOLD_MS = 500;
const DISMISS_MS = 3000;
const MOVE_TOLERANCE = 10;

/** Delegate gestures to the chat, without adding listeners/state to every message. */
export function useMessageTimestamps(containerRef: RefObject<HTMLElement | null>, thread: unknown) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const query = window.matchMedia?.(MOBILE_QUERY);
    const mobile = () => query?.matches ?? window.innerWidth <= 768;
    let pressed: HTMLElement | null = null;
    let visible: HTMLElement | null = null;
    let suppressClick: HTMLElement | null = null;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let dismissTimer: ReturnType<typeof setTimeout> | undefined;

    const cancelPress = () => {
      clearTimeout(holdTimer);
      holdTimer = undefined;
      pressed?.removeAttribute('data-timestamp-press');
      pressed = null;
      pointerId = -1;
    };
    const dismiss = () => {
      cancelPress();
      clearTimeout(dismissTimer);
      visible?.removeAttribute('data-timestamp-visible');
      visible = null;
      suppressClick = null;
    };
    const show = () => {
      if (!pressed?.isConnected || !container.contains(pressed) || !mobile()) return;
      clearTimeout(holdTimer);
      holdTimer = undefined;
      visible = pressed;
      suppressClick = pressed;
      visible.setAttribute('data-timestamp-visible', 'true');
    };
    const down = (event: PointerEvent) => {
      dismiss();
      if (!mobile() || event.isPrimary === false || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      // Preserve native links and taps on attachment, audio, and reaction controls.
      if (target?.closest('a, button, input, select, textarea, [role="button"], [contenteditable="true"], .reaction-bubble')) return;
      const message = target?.closest<HTMLElement>('.message');
      if (!message || !container.contains(message) || !message.querySelector('.msg-timestamp')?.textContent?.trim()) return;
      pressed = message;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      pressed.setAttribute('data-timestamp-press', 'true');
      holdTimer = setTimeout(show, HOLD_MS);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId && Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE) dismiss();
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      cancelPress();
      if (visible) dismissTimer = setTimeout(dismiss, DISMISS_MS);
    };
    const click = (event: MouseEvent) => {
      if (suppressClick && event.target instanceof Node && suppressClick.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = null;
      }
    };
    const contextMenu = (event: MouseEvent) => {
      if (!mobile() || !(event.target instanceof Node)) return;
      if (pressed?.contains(event.target) || visible?.contains(event.target)) {
        event.preventDefault();
        show();
      }
    };
    // Dismiss on a new interaction anywhere, including navigation outside the chat.
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    container.addEventListener('click', click, true);
    container.addEventListener('contextmenu', contextMenu);
    container.addEventListener('scroll', dismiss, { passive: true });
    query?.addEventListener('change', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      dismiss();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      container.removeEventListener('click', click, true);
      container.removeEventListener('contextmenu', contextMenu);
      container.removeEventListener('scroll', dismiss);
      query?.removeEventListener('change', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [containerRef, thread]);
}
