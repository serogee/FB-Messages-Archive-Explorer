import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  captureChatScrollAnchor,
  prepareChatScrollAnchorForJump,
  recordChatScroll,
  registerChatAnchorCandidate,
  resetChatScrollAnchor,
  stabilizeChatScrollAnchor,
  hasPendingMediaBeforeJumpTarget,
  stabilizeJumpTarget,
} from '../src/components/Chat/chatScrollAnchoring';

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect;
}

function anchorContainer(direction: 'up' | 'down' = 'down') {
  return {
    dataset: { scrollDir: direction, lastScrollTop: '100', isAtBottom: 'false' },
    scrollTop: 100,
    scrollHeight: 2_000,
    clientHeight: 600,
    getBoundingClientRect: () => rect(0, 600),
  } as unknown as HTMLElement;
}

function anchorCandidate(getRect: () => DOMRect): HTMLElement {
  return {
    isConnected: true,
    getBoundingClientRect: getRect,
  } as HTMLElement;
}

describe('chat scroll anchoring', () => {
  it('keeps an encountered media bottom fixed so it opens upward', () => {
    const container = anchorContainer('up');
    let mediaRect = rect(100, 300);
    const media = anchorCandidate(() => mediaRect);
    registerChatAnchorCandidate(container, media, 'media');

    mediaRect = rect(100, 360);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    expect(container.scrollTop).toBe(160);
  });

  it('keeps an encountered media top fixed so it opens downward', () => {
    const container = anchorContainer('down');
    let mediaRect = rect(100, 300);
    const media = anchorCandidate(() => mediaRect);
    registerChatAnchorCandidate(container, media, 'media');

    mediaRect = rect(100, 360);
    expect(stabilizeChatScrollAnchor(container)).toBe(false);
    expect(container.scrollTop).toBe(100);
  });

  it('keeps the viewport anchor fixed when media above it changes size', () => {
    const container = anchorContainer('down');
    let anchorRect = rect(280, 330);
    const anchor = anchorCandidate(() => anchorRect);
    registerChatAnchorCandidate(container, anchor, 'media');

    // Growth above the anchor pushes its document position downward. Restoring
    // the anchor makes that media appear to grow upward instead.
    anchorRect = rect(340, 390);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    expect(container.scrollTop).toBe(160);
  });

  it('does not move the viewport when media below the anchor grows downward', () => {
    const container = anchorContainer('down');
    const anchor = anchorCandidate(() => rect(280, 330));
    registerChatAnchorCandidate(container, anchor, 'media');

    // Content below does not move the retained anchor, so no correction is made.
    expect(stabilizeChatScrollAnchor(container)).toBe(false);
    expect(container.scrollTop).toBe(100);
  });

  it('does not replace a valid anchor when another unknown media item appears', () => {
    const container = anchorContainer('down');
    let firstRect = rect(100, 200);
    let secondRect = rect(300, 400);
    const first = anchorCandidate(() => firstRect);
    const second = anchorCandidate(() => secondRect);
    registerChatAnchorCandidate(container, first, 'media');
    registerChatAnchorCandidate(container, second, 'media');

    firstRect = rect(130, 230);
    secondRect = rect(360, 460);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    expect(container.scrollTop).toBe(130);
  });

  it('records continuous scrolling without synchronous geometry reads', () => {
    const container = anchorContainer('down');
    let mediaRect = rect(100, 300);
    const getRect = vi.fn(() => mediaRect);
    const media = anchorCandidate(getRect);
    registerChatAnchorCandidate(container, media, 'media');
    const readsBeforeScroll = getRect.mock.calls.length;

    container.scrollTop = 120;
    mediaRect = rect(80, 280);
    recordChatScroll(container);

    expect(getRect).toHaveBeenCalledTimes(readsBeforeScroll);
    expect(stabilizeChatScrollAnchor(container)).toBe(false);
    expect(container.scrollTop).toBe(120);
  });

  it('does not cancel user movement that arrives before its scroll event', () => {
    const container = anchorContainer('down');
    let mediaRect = rect(180, 230);
    const media = anchorCandidate(() => mediaRect);
    registerChatAnchorCandidate(container, media, 'media');

    container.scrollTop = 110;
    mediaRect = rect(210, 260);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    expect(container.scrollTop).toBe(150);
  });

  it('retains a settled candidate for its final resize correction', () => {
    const container = anchorContainer('down');
    let mediaRect = rect(180, 230);
    const media = anchorCandidate(() => mediaRect);
    const unregister = registerChatAnchorCandidate(container, media, 'media');
    unregister();

    mediaRect = rect(220, 270);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    expect(container.scrollTop).toBe(140);
  });

  it('uses an explicit chunk as a one-shot anchor without observing messages', () => {
    const container = anchorContainer('up');
    let chunkRect = rect(100, 500);
    const chunk = anchorCandidate(() => chunkRect);
    captureChatScrollAnchor(container, false, chunk);

    chunkRect = rect(100, 560);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    expect(container.scrollTop).toBe(160);

    chunkRect = rect(100, 590);
    expect(stabilizeChatScrollAnchor(container)).toBe(false);
    expect(container.scrollTop).toBe(160);
  });

  it('replaces an upward anchor with downward semantics before a jump', () => {
    const container = anchorContainer('up');
    let mediaRect = rect(100, 300);
    const media = anchorCandidate(() => mediaRect);
    registerChatAnchorCandidate(container, media, 'media');

    prepareChatScrollAnchorForJump(container);
    captureChatScrollAnchor(container, false, media);
    mediaRect = rect(100, 360);

    expect(container.dataset.scrollDir).toBe('down');
    expect(stabilizeChatScrollAnchor(container)).toBe(false);
    expect(container.scrollTop).toBe(100);
  });

  it('reset stays dormant unless geometry-unknown media is present', () => {
    const container = anchorContainer('down');
    let mediaRect = rect(100, 300);
    const media = anchorCandidate(() => mediaRect);
    registerChatAnchorCandidate(container, media, 'media');
    resetChatScrollAnchor(container);

    mediaRect = rect(150, 350);
    expect(stabilizeChatScrollAnchor(container)).toBe(true);
    // A pending candidate can be selected again when stabilization is needed.
    expect(container.scrollTop).toBe(150);
  });

  it('keeps the actual jump target at its saved viewport offset', () => {
    const target = {
      getBoundingClientRect: () => ({ top: 170 } as DOMRect),
    } as HTMLElement;
    const container = {
      dataset: {
        jumpInProgress: 'true',
        jumpTargetIndex: '42',
        jumpAnchorOffset: '120',
      },
      scrollTop: 500,
      getBoundingClientRect: () => ({ top: 20 } as DOMRect),
      querySelector: () => target,
    } as unknown as HTMLElement;

    expect(stabilizeJumpTarget(container)).toBe(true);
    expect(container.scrollTop).toBe(530);
    expect(container.dataset.lastScrollTop).toBe('530');
  });

  it('detects geometry-unknown media that can move a jump target', () => {
    const before = {
      getBoundingClientRect: () => ({ top: 100 } as DOMRect),
    } as HTMLElement;
    const after = {
      getBoundingClientRect: () => ({ top: 300 } as DOMRect),
    } as HTMLElement;
    const target = {
      getBoundingClientRect: () => ({ top: 200 } as DOMRect),
    } as HTMLElement;
    let pending = [before, after];
    const container = {
      dataset: { jumpTargetIndex: '8' },
      querySelector: () => target,
      querySelectorAll: (selector: string) => {
        expect(selector).toContain('data-media-geometry-pending');
        return pending;
      },
    } as unknown as HTMLElement;

    expect(hasPendingMediaBeforeJumpTarget(container)).toBe(true);
    pending = [after];
    expect(hasPendingMediaBeforeJumpTarget(container)).toBe(false);
  });
});
