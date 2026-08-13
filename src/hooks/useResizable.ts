import { useRef, useEffect, useCallback } from 'react';
import { storageSet, storageGet } from '../services/storage';

interface UseResizableOptions {
  minWidth: number;
  maxWidthFraction: number;
  maxWidthAbsolute: number;
  storageKey: string;
  initialWidth: number;
  onWidthChange: (width: number) => void;
  /** 'left' for sidebar (width grows from left), 'right' for info panel (width grows from right) */
  side?: 'left' | 'right';
}

function clampWidth(width: number, min: number, maxAbsolute: number, fraction: number): number {
  const viewportWidth = window.innerWidth || 1200;
  const max = Math.min(maxAbsolute, Math.max(min, viewportWidth * fraction));
  return Math.min(max, Math.max(min, width));
}

function getOrCreateGhostLine(): HTMLDivElement {
  let line = document.getElementById('resizeGhostLine') as HTMLDivElement | null;
  if (!line) {
    line = document.createElement('div');
    line.id = 'resizeGhostLine';
    line.className = 'resize-ghost-line';
    document.body.appendChild(line);
  }
  return line;
}

export function useResizable(options: UseResizableOptions): {
  handleRef: React.RefObject<HTMLDivElement | null>;
} {
  const { minWidth, maxWidthFraction, maxWidthAbsolute, storageKey, initialWidth, onWidthChange, side = 'left' } = options;
  const handleRef = useRef<HTMLDivElement | null>(null);

  // Track current width in a ref so event listeners always see current value
  const storedWidth = Number(storageGet(storageKey));
  const initialClamped = clampWidth(
    Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : initialWidth,
    minWidth, maxWidthAbsolute, maxWidthFraction
  );
  const currentWidthRef = useRef<number>(initialClamped);

  const applyWidth = useCallback((width: number, persist = false) => {
    const clamped = clampWidth(width, minWidth, maxWidthAbsolute, maxWidthFraction);
    currentWidthRef.current = clamped;
    onWidthChange(clamped);
    if (persist) storageSet(storageKey, String(Math.round(clamped)));
  }, [minWidth, maxWidthAbsolute, maxWidthFraction, storageKey, onWidthChange]);

  useEffect(() => {
    // Apply initial width
    applyWidth(currentWidthRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    let resizing = false;
    let dragOffset = 0;
    let pendingWidth = currentWidthRef.current;

    const container = handle.closest('.container') as HTMLElement | null;

    const stopResize = () => {
      if (!resizing) return;
      resizing = false;
      container?.classList.remove('resizing');
      const ghost = getOrCreateGhostLine();
      ghost.classList.remove('active');
      applyWidth(pendingWidth, true);
    };

    const onPointerDown = (e: PointerEvent) => {
      resizing = true;
      const handleRect = handle.getBoundingClientRect();
      dragOffset = e.clientX - (handleRect.left + handleRect.width / 2);
      pendingWidth = currentWidthRef.current;
      const ghost = getOrCreateGhostLine();
      ghost.style.left = `${Math.round(handleRect.left + handleRect.width / 2)}px`;
      ghost.classList.add('active');
      container?.classList.add('resizing');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!resizing || !container) return;
      const containerRect = container.getBoundingClientRect();
      const handleCenter = e.clientX - dragOffset;

      if (side === 'left') {
        pendingWidth = clampWidth(
          handleCenter - containerRect.left - handle.offsetWidth / 2,
          minWidth, maxWidthAbsolute, maxWidthFraction
        );
        const ghost = getOrCreateGhostLine();
        ghost.style.left = `${Math.round(containerRect.left + pendingWidth + handle.offsetWidth / 2)}px`;
      } else {
        pendingWidth = clampWidth(
          containerRect.right - handleCenter - handle.offsetWidth / 2,
          minWidth, maxWidthAbsolute, maxWidthFraction
        );
        const ghost = getOrCreateGhostLine();
        ghost.style.left = `${Math.round(containerRect.right - pendingWidth - handle.offsetWidth / 2)}px`;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = side === 'left'
        ? (e.key === 'ArrowRight' ? 20 : -20)
        : (e.key === 'ArrowLeft' ? 20 : -20);
      applyWidth(currentWidthRef.current + delta, true);
    };

    const onWindowResize = () => {
      applyWidth(currentWidthRef.current);
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', stopResize);
    handle.addEventListener('pointercancel', stopResize);
    handle.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onWindowResize);

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', stopResize);
      handle.removeEventListener('pointercancel', stopResize);
      handle.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
    };
  }, [applyWidth, minWidth, maxWidthAbsolute, maxWidthFraction, side]);

  return { handleRef };
}
