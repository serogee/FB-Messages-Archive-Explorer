import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

const HOLD_MS = 500;
const MOVE_TOLERANCE = 10;

export function useLongPress(enabled: boolean, onLongPress: (element: HTMLElement) => void) {
  const cancelRef = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  useEffect(() => () => cancelRef.current(), [enabled]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    cancelRef.current();
    suppressClick.current = false;
    if (!enabled || !event.isPrimary || event.button !== 0 || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    const row = event.currentTarget;
    if (!(event.target instanceof Node) || !row.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
    const { pointerId, clientX, clientY } = event;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cancel = () => {
      clearTimeout(timer);
      row.removeAttribute('data-long-press');
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', cancelPointer, true);
      document.removeEventListener('pointerdown', additionalPointer, true);
      window.removeEventListener('scroll', interrupt, true);
      window.removeEventListener('blur', interrupt);
      cancelRef.current = () => {};
    };
    const move = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId === pointerId && Math.hypot(pointer.clientX - clientX, pointer.clientY - clientY) > MOVE_TOLERANCE) {
        suppressClick.current = true;
        cancel();
      }
    };
    const release = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId === pointerId) cancel();
    };
    const cancelPointer = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId === pointerId) {
        suppressClick.current = true;
        cancel();
      }
    };
    const additionalPointer = () => {
      suppressClick.current = true;
      cancel();
    };
    const interrupt = () => {
      suppressClick.current = true;
      cancel();
    };
    cancelRef.current = cancel;
    row.setAttribute('data-long-press', 'true');
    timer = setTimeout(() => {
      timer = undefined;
      if (!row.isConnected || row.closest('[inert]')) { cancel(); return; }
      suppressClick.current = true;
      callbackRef.current(row);
    }, HOLD_MS);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', cancelPointer, true);
    document.addEventListener('pointerdown', additionalPointer, true);
    window.addEventListener('scroll', interrupt, true);
    window.addEventListener('blur', interrupt);
  };

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (!enabled || !suppressClick.current || event.detail === 0) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!enabled || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.preventDefault();
    cancelRef.current();
    if (!suppressClick.current) callbackRef.current(event.currentTarget);
    suppressClick.current = true;
  };

  return { onPointerDown, onClickCapture, onContextMenu };
}
