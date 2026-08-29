import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

interface UseResizableOptions {
  minWidth: number;
  maxWidthFraction: number;
  maxWidthAbsolute: number;
  initialWidth: number;
  onWidthChange: (width: number) => void;
  cssVariable: `--${string}`;
  minMainWidth?: number;
  layoutDependency?: unknown;
  side?: 'left' | 'right';
}

interface ResizeBounds {
  minWidth: number;
  maxWidthFraction: number;
  maxWidthAbsolute: number;
  viewportWidth: number;
  layoutMaximum?: number;
}

export function clampResizableWidth(width: number, bounds: ResizeBounds): number {
  const fractionalMaximum = bounds.viewportWidth * bounds.maxWidthFraction;
  const layoutMaximum = bounds.layoutMaximum ?? Number.POSITIVE_INFINITY;
  const maximum = Math.max(
    bounds.minWidth,
    Math.min(bounds.maxWidthAbsolute, fractionalMaximum, layoutMaximum),
  );
  return Math.round(Math.min(maximum, Math.max(bounds.minWidth, width)));
}

function getOrCreateHandlePreview(): HTMLDivElement {
  let preview = document.getElementById('resizeHandlePreview') as HTMLDivElement | null;
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'resizeHandlePreview';
    preview.className = 'resize-handle-preview';
    document.body.appendChild(preview);
  }
  return preview;
}

function getLayoutMaximum(
  container: HTMLElement,
  handle: HTMLElement,
  side: 'left' | 'right',
  currentWidth: number,
  minMainWidth: number,
): number {
  const containerRect = container.getBoundingClientRect();
  const handleRect = handle.getBoundingClientRect();
  let currentMainWidth: number;

  if (side === 'left') {
    const infoHandle = container.querySelector<HTMLElement>('.info-resize-handle');
    const infoHandleRect = infoHandle?.getBoundingClientRect();
    const mainRight = infoHandleRect && infoHandleRect.width > 0
      ? infoHandleRect.left
      : containerRect.right;
    currentMainWidth = mainRight - handleRect.right;
  } else {
    const sidebarHandle = container.querySelector<HTMLElement>('.sidebar-resize-handle');
    const sidebarHandleRect = sidebarHandle?.getBoundingClientRect();
    const mainLeft = sidebarHandleRect && sidebarHandleRect.width > 0
      ? sidebarHandleRect.right
      : containerRect.left;
    currentMainWidth = handleRect.left - mainLeft;
  }

  return currentWidth + currentMainWidth - minMainWidth;
}

export function useResizable(options: UseResizableOptions): {
  handleRef: React.RefObject<HTMLDivElement | null>;
} {
  const {
    minWidth,
    maxWidthFraction,
    maxWidthAbsolute,
    initialWidth,
    onWidthChange,
    cssVariable,
    minMainWidth = 320,
    layoutDependency,
    side = 'left',
  } = options;
  const handleRef = useRef<HTMLDivElement | null>(null);
  const onWidthChangeRef = useRef(onWidthChange);
  const currentWidthRef = useRef(initialWidth);
  const lastReportedWidthRef = useRef(initialWidth);

  onWidthChangeRef.current = onWidthChange;

  const clampWidth = useCallback((width: number, layoutMaximum?: number) => clampResizableWidth(width, {
    minWidth,
    maxWidthFraction,
    maxWidthAbsolute,
    viewportWidth: window.innerWidth || 1200,
    layoutMaximum,
  }), [maxWidthAbsolute, maxWidthFraction, minWidth]);

  const setLiveWidth = useCallback((width: number) => {
    currentWidthRef.current = width;
    document.documentElement.style.setProperty(cssVariable, `${width}px`);
    handleRef.current?.setAttribute('aria-valuenow', String(width));
  }, [cssVariable]);

  const commitWidth = useCallback((width: number, layoutMaximum?: number) => {
    const clamped = clampWidth(width, layoutMaximum);
    setLiveWidth(clamped);
    if (lastReportedWidthRef.current !== clamped) {
      lastReportedWidthRef.current = clamped;
      onWidthChangeRef.current(clamped);
    }
  }, [clampWidth, setLiveWidth]);

  useLayoutEffect(() => {
    const handle = handleRef.current;
    const container = handle?.closest('.container') as HTMLElement | null;
    const hasVisibleHandle = (handle?.getBoundingClientRect().width ?? 0) > 0;
    const layoutMaximum = handle && container && hasVisibleHandle
      ? getLayoutMaximum(container, handle, side, initialWidth, minMainWidth)
      : undefined;
    const clamped = clampWidth(initialWidth, layoutMaximum);
    currentWidthRef.current = clamped;
    lastReportedWidthRef.current = clamped;
    document.documentElement.style.setProperty(cssVariable, `${clamped}px`);
    handle?.setAttribute('aria-valuemin', String(minWidth));
    handle?.setAttribute('aria-valuemax', String(clampWidth(Number.POSITIVE_INFINITY, layoutMaximum)));
    handle?.setAttribute('aria-valuenow', String(clamped));
    if (clamped !== initialWidth) onWidthChangeRef.current(clamped);
  }, [clampWidth, cssVariable, initialWidth, layoutDependency, minMainWidth, minWidth, side]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const container = handle.closest('.container') as HTMLElement | null;
    if (!container) return;

    let resizing = false;
    let activePointerId: number | null = null;
    let dragOffset = 0;
    let dragStartWidth = currentWidthRef.current;
    let layoutMaximum = Number.POSITIVE_INFINITY;
    let pendingWidth = currentWidthRef.current;
    let pendingPreviewX = 0;
    let animationFrame: number | null = null;
    let containerLeft = 0;
    let containerRight = 0;
    let halfHandleWidth = 0;

    const applyPendingFrame = () => {
      animationFrame = null;
      const preview = getOrCreateHandlePreview();
      preview.style.transform = `translate3d(${pendingPreviewX}px, 0, 0) translateX(-50%)`;
    };

    const schedulePendingFrame = () => {
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(applyPendingFrame);
      }
    };

    const removeDragListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onDragKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    };

    const clearResizeUi = () => {
      container.classList.remove('resizing', 'resizing-left', 'resizing-right');
      const preview = getOrCreateHandlePreview();
      if (preview.dataset.resizeOwner === cssVariable) {
        preview.classList.remove('active');
        delete preview.dataset.resizeOwner;
      }
    };

    const finishResize = (shouldCommit: boolean) => {
      if (!resizing) return;
      resizing = false;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }

      const finalWidth = shouldCommit ? pendingWidth : dragStartWidth;
      removeDragListeners();

      if (activePointerId !== null && handle.hasPointerCapture(activePointerId)) {
        handle.releasePointerCapture(activePointerId);
      }
      activePointerId = null;

      if (shouldCommit) {
        container.classList.add('resize-settling');
        commitWidth(finalWidth, layoutMaximum);
        window.requestAnimationFrame(() => container.classList.remove('resize-settling'));
      }
      clearResizeUi();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!resizing || event.pointerId !== activePointerId) return;
      const handleCenter = event.clientX - dragOffset;

      if (side === 'left') {
        pendingWidth = clampWidth(
          handleCenter - containerLeft - halfHandleWidth,
          layoutMaximum,
        );
        pendingPreviewX = containerLeft + pendingWidth + halfHandleWidth;
      } else {
        pendingWidth = clampWidth(
          containerRight - handleCenter - halfHandleWidth,
          layoutMaximum,
        );
        pendingPreviewX = containerRight - pendingWidth - halfHandleWidth;
      }
      schedulePendingFrame();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === activePointerId) finishResize(true);
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === activePointerId) finishResize(false);
    };

    const onLostPointerCapture = (event: PointerEvent) => {
      if (resizing && event.pointerId === activePointerId) finishResize(false);
    };

    const onDragKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finishResize(false);
    };

    const onWindowBlur = () => finishResize(false);

    const onPointerDown = (event: PointerEvent) => {
      if (resizing || !event.isPrimary || event.button !== 0) return;
      resizing = true;
      activePointerId = event.pointerId;
      dragStartWidth = currentWidthRef.current;
      pendingWidth = dragStartWidth;
      layoutMaximum = getLayoutMaximum(container, handle, side, dragStartWidth, minMainWidth);

      const handleRect = handle.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const handleCenter = handleRect.left + handleRect.width / 2;
      containerLeft = containerRect.left;
      containerRight = containerRect.right;
      halfHandleWidth = handleRect.width / 2;
      dragOffset = event.clientX - handleCenter;
      pendingPreviewX = handleCenter;

      container.classList.add('resizing', `resizing-${side}`);
      const preview = getOrCreateHandlePreview();
      preview.dataset.resizeOwner = cssVariable;
      preview.style.transform = `translate3d(${handleCenter}px, 0, 0) translateX(-50%)`;
      preview.classList.add('active');
      handle.setAttribute('aria-valuemax', String(clampWidth(Number.POSITIVE_INFINITY, layoutMaximum)));

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onDragKeyDown);
      window.addEventListener('blur', onWindowBlur);
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        finishResize(false);
        return;
      }
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const maximum = getLayoutMaximum(container, handle, side, currentWidthRef.current, minMainWidth);
      const delta = side === 'left'
        ? (event.key === 'ArrowRight' ? 20 : -20)
        : (event.key === 'ArrowLeft' ? 20 : -20);
      commitWidth(currentWidthRef.current + delta, maximum);
    };

    const onWindowResize = () => {
      const maximum = getLayoutMaximum(container, handle, side, currentWidthRef.current, minMainWidth);
      commitWidth(currentWidthRef.current, maximum);
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('lostpointercapture', onLostPointerCapture);
    handle.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onWindowResize);
    document.getElementById('resizeGhostLine')?.remove();
    document.getElementById('resizeHandlePreview')?.remove();

    return () => {
      if (resizing) finishResize(false);
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('lostpointercapture', onLostPointerCapture);
      handle.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      removeDragListeners();
    };
  }, [clampWidth, commitWidth, cssVariable, minMainWidth, setLiveWidth, side]);

  return { handleRef };
}
