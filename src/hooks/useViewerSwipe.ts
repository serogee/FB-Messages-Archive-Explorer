import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

const MOVE_TOLERANCE = 10;
const SWIPE_DISTANCE = 48;
const HORIZONTAL_DOMINANCE = 1.3;
const INTERACTIVE_CONTROLS = 'button, a, input, select, textarea, video, audio, [contenteditable="true"], [role="button"]:not(.media-viewer-image), .media-viewer-menu-dropdown';

interface SwipeGesture {
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
  vertical: boolean;
  image: Element | null;
}

export function useViewerSwipe({ enabled, item, onPrevious, onNext, onImageTap }: {
  enabled: boolean;
  item: unknown;
  onPrevious: () => void;
  onNext: () => void;
  onImageTap: () => void;
}) {
  const gesture = useRef<SwipeGesture | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => { gesture.current = null; }, [enabled, item]);

  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (!enabled) return;
    if (!event.isPrimary) {
      gesture.current = null;
      suppressClick.current = true;
      return;
    }
    suppressClick.current = false;
    gesture.current = null;
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_CONTROLS)) return;
    gesture.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, vertical: false,
      image: event.target instanceof Element ? event.target.closest('.media-viewer-image') : null,
    };
  };

  const onPointerMoveCapture = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!enabled || !current || event.pointerId !== current.pointerId) return;
    const dx = Math.abs(event.clientX - current.x);
    const dy = Math.abs(event.clientY - current.y);
    if (Math.max(dx, dy) > MOVE_TOLERANCE) {
      current.moved = true;
      if (dy > dx * HORIZONTAL_DOMINANCE) current.vertical = true;
    }
  };

  const onPointerUpCapture = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!enabled || !current || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    suppressClick.current = current.moved || Math.max(Math.abs(dx), Math.abs(dy)) > MOVE_TOLERANCE;
    if (!current.vertical && Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_DOMINANCE) {
      if (dx < 0) onNext();
      else onPrevious();
    } else if (!suppressClick.current && current.image && event.target === current.image) {
      // Touch browsers can omit the click after a recent swipe. Handle the tap
      // on release, then swallow its compatibility click to avoid toggling twice.
      suppressClick.current = true;
      onImageTap();
    }
  };

  const onPointerCancelCapture = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerId !== gesture.current?.pointerId) return;
    gesture.current = null;
    suppressClick.current = true;
  };

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    // A drag must neither enlarge an image nor close the viewer on release.
    // A new pointer press resets this flag; keyboard activation remains available.
    if (!enabled || !suppressClick.current || event.detail === 0) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return { onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture, onPointerCancelCapture, onClickCapture };
}
