export type ChatOpeningDirection = 'up' | 'down';
export type ChatAnchorCandidateKind = 'message' | 'media';

type ChatAnchorEdge = 'top' | 'bottom';

interface ChatAnchor {
  element: HTMLElement;
  kind: ChatAnchorCandidateKind;
  edge: ChatAnchorEdge;
  offset: number;
}

interface ChatAnchorState {
  candidates: Map<HTMLElement, ChatAnchorCandidateKind>;
  visibleCandidates: Set<HTMLElement>;
  observer: IntersectionObserver;
  anchor: ChatAnchor | null;
  separatelyObservedAnchor: HTMLElement | null;
  anchorGeneration: number;
  direction: ChatOpeningDirection;
  lastScrollTop: number | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const chatAnchorStates = new WeakMap<HTMLElement, ChatAnchorState>();
const ANCHOR_RELEASE_DELAY_MS = 100;

function intersectsViewport(rect: DOMRect, viewport: DOMRect): boolean {
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

function edgePosition(rect: DOMRect, edge: ChatAnchorEdge): number {
  return edge === 'top' ? rect.top : rect.bottom;
}

function anchorEdgeForRect(
  rect: DOMRect,
  viewport: DOMRect,
  direction: ChatOpeningDirection,
): ChatAnchorEdge {
  if (rect.bottom <= viewport.top) return 'bottom';
  if (rect.top >= viewport.bottom) return 'top';
  return direction === 'up' ? 'bottom' : 'top';
}

function createAnchor(
  element: HTMLElement,
  kind: ChatAnchorCandidateKind,
  edge: ChatAnchorEdge,
  viewport: DOMRect,
): ChatAnchor {
  return {
    element,
    kind,
    edge,
    offset: edgePosition(element.getBoundingClientRect(), edge) - viewport.top,
  };
}

function isInside(element: HTMLElement, possibleAncestor?: HTMLElement | null): boolean {
  return !!possibleAncestor && (
    element === possibleAncestor
    || (typeof possibleAncestor.contains === 'function' && possibleAncestor.contains(element))
  );
}

function setChatAnchor(state: ChatAnchorState, anchor: ChatAnchor | null): void {
  const separatelyObserved = state.separatelyObservedAnchor;
  if (separatelyObserved && !state.candidates.has(separatelyObserved)) {
    state.observer.unobserve(separatelyObserved);
  }

  state.anchor = anchor;
  state.separatelyObservedAnchor = null;
  state.anchorGeneration++;

  if (anchor && !state.candidates.has(anchor.element)) {
    state.observer.observe(anchor.element);
    state.separatelyObservedAnchor = anchor.element;
  }
}

function createChatAnchorState(container: HTMLElement): ChatAnchorState {
  const state = {} as ChatAnchorState;
  state.candidates = new Map();
  state.visibleCandidates = new Set();
  state.anchor = null;
  state.separatelyObservedAnchor = null;
  state.anchorGeneration = 0;
  state.direction = container.dataset.scrollDir === 'up' ? 'up' : 'down';
  state.lastScrollTop = Number.isFinite(Number(container.dataset.lastScrollTop))
    ? Number(container.dataset.lastScrollTop)
    : null;
  state.releaseTimer = null;
  state.observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      if (state.candidates.has(element)) {
        if (entry.isIntersecting) state.visibleCandidates.add(element);
        else state.visibleCandidates.delete(element);
      }

      if (
        !entry.isIntersecting
        && state.anchor?.element === element
        && container.dataset.jumpInProgress !== 'true'
      ) {
        setChatAnchor(state, selectLayoutAnchor(container, state, element));
      }
    }
    if (
      container.dataset.jumpInProgress !== 'true'
      && !state.anchor
      && state.candidates.size > 0
    ) {
      setChatAnchor(state, selectLayoutAnchor(container, state));
    }
  }, { root: container, threshold: 0 });
  return state;
}

function getChatAnchorState(container: HTMLElement): ChatAnchorState {
  let state = chatAnchorStates.get(container);
  if (!state) {
    state = createChatAnchorState(container);
    chatAnchorStates.set(container, state);
  }
  return state;
}

function selectChatAnchor(
  container: HTMLElement,
  state: ChatAnchorState,
  excludedElement?: HTMLElement | null,
): ChatAnchor | null {
  const viewport = container.getBoundingClientRect();
  const visible = [...state.visibleCandidates]
    .filter(element => (
      element.isConnected
      && state.candidates.has(element)
      && !isInside(element, excludedElement)
    ))
    .map(element => ({
      element,
      kind: state.candidates.get(element)!,
      rect: element.getBoundingClientRect(),
    }))
    .filter(candidate => intersectsViewport(candidate.rect, viewport));
  if (visible.length === 0) return null;

  // Selection only happens when the first geometry-unknown item is encountered.
  // Once selected, the anchor is not replaced merely because another item appears.
  visible.sort((left, right) => state.direction === 'up'
    ? right.rect.bottom - left.rect.bottom
    : left.rect.top - right.rect.top);
  const selected = visible[0];
  const edge = anchorEdgeForRect(selected.rect, viewport, state.direction);
  return createAnchor(selected.element, selected.kind, edge, viewport);
}

function getHitMessage(container: HTMLElement, x: number, y: number): HTMLElement | null {
  const hit = container.ownerDocument?.elementFromPoint?.(x, y) as HTMLElement | null;
  if (!hit || (typeof container.contains === 'function' && !container.contains(hit))) return null;

  const directMessage = hit.closest?.('.message[data-msg-index]') as HTMLElement | null;
  if (directMessage) return directMessage;

  const wrapper = hit.closest?.('.message-wrapper') as HTMLElement | null;
  return wrapper?.querySelector?.('.message[data-msg-index]') as HTMLElement | null;
}

function selectStableMessageAnchor(
  container: HTMLElement,
  state: ChatAnchorState,
  excludedElement?: HTMLElement | null,
): ChatAnchor | null {
  const viewport = container.getBoundingClientRect();
  const width = viewport.right - viewport.left;
  const height = viewport.bottom - viewport.top;
  if (width <= 0 || height <= 0 || !container.ownerDocument?.elementFromPoint) return null;

  const xPositions = [0.12, 0.5, 0.88].map(ratio => viewport.left + width * ratio);
  const stepCount = 12;
  for (let step = 0; step <= stepCount; step++) {
    const progress = step / stepCount;
    const y = state.direction === 'up'
      ? viewport.bottom - 1 - progress * Math.max(0, height - 2)
      : viewport.top + 1 + progress * Math.max(0, height - 2);

    for (const x of xPositions) {
      const message = getHitMessage(container, x, y);
      if (!message?.isConnected || isInside(message, excludedElement)) continue;
      if (message.querySelector?.('.lazy-media-wrapper[data-media-geometry-pending="true"]')) continue;

      const rect = message.getBoundingClientRect();
      if (!intersectsViewport(rect, viewport)) continue;
      const edge = anchorEdgeForRect(rect, viewport, state.direction);
      return createAnchor(message, 'message', edge, viewport);
    }
  }

  return null;
}

function selectLayoutAnchor(
  container: HTMLElement,
  state: ChatAnchorState,
  excludedElement?: HTMLElement | null,
): ChatAnchor | null {
  return selectChatAnchor(container, state, excludedElement)
    || selectStableMessageAnchor(container, state, excludedElement);
}

function isUsableAnchor(
  anchor: ChatAnchor,
  viewport: DOMRect,
  changingElement?: HTMLElement | null,
): boolean {
  return anchor.element.isConnected
    && !isInside(anchor.element, changingElement)
    && intersectsViewport(anchor.element.getBoundingClientRect(), viewport);
}

function cancelAnchorRelease(state: ChatAnchorState): void {
  if (!state.releaseTimer) return;
  clearTimeout(state.releaseTimer);
  state.releaseTimer = null;
}

function scheduleAnchorRelease(state: ChatAnchorState): void {
  cancelAnchorRelease(state);
  const scheduledGeneration = state.anchorGeneration;
  state.releaseTimer = setTimeout(() => {
    state.releaseTimer = null;
    if (state.candidates.size === 0 && state.anchorGeneration === scheduledGeneration) {
      setChatAnchor(state, null);
    }
  }, ANCHOR_RELEASE_DELAY_MS);
}

export function registerChatAnchorCandidate(
  container: HTMLElement,
  element: HTMLElement,
  kind: ChatAnchorCandidateKind,
): () => void {
  const state = getChatAnchorState(container);
  cancelAnchorRelease(state);
  state.candidates.set(element, kind);
  const viewport = container.getBoundingClientRect();
  if (intersectsViewport(element.getBoundingClientRect(), viewport)) {
    state.visibleCandidates.add(element);
  }
  state.observer.observe(element);
  if (!state.anchor && container.dataset.jumpInProgress !== 'true') {
    setChatAnchor(state, selectLayoutAnchor(container, state));
  }

  return () => {
    state.observer.unobserve(element);
    state.candidates.delete(element);
    state.visibleCandidates.delete(element);
    if (state.anchor?.element === element) {
      if (!element.isConnected) {
        setChatAnchor(state, null);
      } else {
        state.observer.observe(element);
        state.separatelyObservedAnchor = element;
      }
    }
    if (state.candidates.size === 0) scheduleAnchorRelease(state);
  };
}

/** Capture a stable viewport anchor immediately before an element changes size. */
export function captureChatScrollAnchor(
  container: HTMLElement,
  forceNew = false,
  changingElement?: HTMLElement | null,
): void {
  if (container.dataset.jumpInProgress === 'true') return;
  const state = getChatAnchorState(container);
  cancelAnchorRelease(state);
  state.lastScrollTop = container.scrollTop;
  container.dataset.lastScrollTop = String(container.scrollTop);
  const viewport = container.getBoundingClientRect();
  const current = state.anchor;
  if (!forceNew && current && isUsableAnchor(current, viewport, changingElement)) {
    current.offset = edgePosition(current.element.getBoundingClientRect(), current.edge) - viewport.top;
    state.anchorGeneration++;
    return;
  }

  setChatAnchor(state, selectLayoutAnchor(container, state, changingElement));
}

export function recordChatScroll(container: HTMLElement): void {
  const state = getChatAnchorState(container);
  const scrollTop = container.scrollTop;
  const previous = state.lastScrollTop;
  if (previous !== null) {
    const delta = scrollTop - previous;
    if (delta > 0.5) state.direction = 'down';
    else if (delta < -0.5) state.direction = 'up';
    // Scrolling moves an existing anchor by the inverse amount. Updating the
    // stored offset arithmetically avoids synchronous layout reads per event.
    if (state.anchor?.element.isConnected) state.anchor.offset -= delta;
  }
  state.lastScrollTop = scrollTop;
  container.dataset.scrollDir = state.direction;
  container.dataset.lastScrollTop = String(scrollTop);

  const isAtBottom = Math.abs(container.scrollHeight - scrollTop - container.clientHeight) < 20;
  if (!isAtBottom && !state.anchor && state.candidates.size > 0) {
    setChatAnchor(state, selectLayoutAnchor(container, state));
  }
}

export function stabilizeChatScrollAnchor(container: HTMLElement): boolean {
  if (container.dataset.jumpInProgress === 'true') return stabilizeJumpTarget(container);

  const state = getChatAnchorState(container);
  if (container.dataset.isAtBottom === 'true') {
    container.scrollTop = container.scrollHeight;
    state.lastScrollTop = container.scrollTop;
    container.dataset.lastScrollTop = String(container.scrollTop);
    setChatAnchor(state, null);
    return true;
  }

  let anchor = state.anchor;
  if (!anchor?.element.isConnected) {
    setChatAnchor(state, state.candidates.size > 0 ? selectLayoutAnchor(container, state) : null);
    anchor = state.anchor;
    if (!anchor) return false;
  }

  const viewportTop = container.getBoundingClientRect().top;
  const currentOffset = edgePosition(anchor.element.getBoundingClientRect(), anchor.edge) - viewportTop;
  const unobservedScrollDelta = state.lastScrollTop === null
    ? 0
    : container.scrollTop - state.lastScrollTop;
  const expectedOffset = anchor.offset - unobservedScrollDelta;
  const correction = currentOffset - expectedOffset;
  if (Math.abs(correction) < 0.5) {
    anchor.offset = currentOffset;
    state.lastScrollTop = container.scrollTop;
    container.dataset.lastScrollTop = String(container.scrollTop);
    if (state.candidates.size === 0) setChatAnchor(state, null);
    return false;
  }

  const previousScrollTop = container.scrollTop;
  container.scrollTop += correction;
  const appliedCorrection = container.scrollTop - previousScrollTop;
  anchor.offset = currentOffset - appliedCorrection;
  state.lastScrollTop = container.scrollTop;
  container.dataset.lastScrollTop = String(container.scrollTop);
  if (state.candidates.size === 0) setChatAnchor(state, null);
  return appliedCorrection !== 0;
}

export function resetChatScrollAnchor(container: HTMLElement): void {
  const state = getChatAnchorState(container);
  cancelAnchorRelease(state);
  state.lastScrollTop = container.scrollTop;
  container.dataset.lastScrollTop = String(container.scrollTop);
  setChatAnchor(
    state,
    container.dataset.jumpInProgress === 'true' || state.candidates.size === 0
      ? null
      : selectLayoutAnchor(container, state),
  );
}

export function prepareChatScrollAnchorForJump(container: HTMLElement): void {
  const state = getChatAnchorState(container);
  cancelAnchorRelease(state);
  state.direction = 'down';
  setChatAnchor(state, null);
  state.lastScrollTop = container.scrollTop;
  container.dataset.scrollDir = 'down';
  container.dataset.lastScrollTop = String(container.scrollTop);
}

export function stabilizeJumpTarget(container: HTMLElement): boolean {
  if (container.dataset.jumpInProgress !== 'true') return false;
  const targetIndex = container.dataset.jumpTargetIndex;
  const anchorOffset = Number(container.dataset.jumpAnchorOffset);
  if (!targetIndex || !Number.isFinite(anchorOffset)) return false;

  const target = container.querySelector(
    `.message[data-msg-index="${targetIndex}"]`,
  ) as HTMLElement | null;
  if (!target) return false;

  const containerTop = container.getBoundingClientRect().top;
  const targetOffset = target.getBoundingClientRect().top - containerTop;
  const correction = targetOffset - anchorOffset;
  if (Math.abs(correction) >= 0.5) {
    container.scrollTop += correction;
    const state = chatAnchorStates.get(container);
    if (state) state.lastScrollTop = container.scrollTop;
    container.dataset.lastScrollTop = String(container.scrollTop);
  }
  return true;
}

export function hasPendingMediaBeforeJumpTarget(container: HTMLElement): boolean {
  const targetIndex = container.dataset.jumpTargetIndex;
  if (!targetIndex) return false;
  const target = container.querySelector(
    `.message[data-msg-index="${targetIndex}"]`,
  ) as HTMLElement | null;
  if (!target) return false;

  const targetTop = target.getBoundingClientRect().top;
  return [...container.querySelectorAll('.lazy-media-wrapper[data-media-geometry-pending="true"]')]
    .some(element => element.getBoundingClientRect().top < targetTop);
}
