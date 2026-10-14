// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaViewer } from '../src/components/MediaViewer/MediaViewer';
import { createMediaState } from '../src/services/media';
import type { ResolvedAttachment } from '../src/types/messenger';

beforeEach(() => {
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'touch';
      this.isPrimary = init.isPrimary ?? true;
    }
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  fireEvent.pointerDown(document);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const items: ResolvedAttachment[] = Array.from({ length: 3 }, (_, index) => ({
  category: 'photos', mediaPath: `swipe-${index}.jpg`, messageIndex: index, timestamp: index + 1, sender: 'Alice',
  mediaEntry: { type: 'image', url: `blob:swipe-${index}` },
}));

function openViewer(mobile = true, reverseNavigation = false) {
  const onClose = vi.fn();
  const onCurrentItemChange = vi.fn();
  render(<MediaViewer mobile={mobile} reverseNavigation={reverseNavigation} items={items} initialIndex={1}
    mediaState={createMediaState()} onClose={onClose} onCurrentItemChange={onCurrentItemChange} onJumpToMessage={() => {}} />);
  return { onClose, onCurrentItemChange };
}

function gesture(target: Element, dx: number, dy = 0, cancel = false) {
  const pointer = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 };
  fireEvent.pointerDown(target, { ...pointer, clientX: 200, clientY: 300 });
  fireEvent.pointerMove(target, { ...pointer, clientX: 200 + dx, clientY: 300 + dy });
  if (cancel) fireEvent.pointerCancel(target, pointer);
  else fireEvent.pointerUp(target, { ...pointer, clientX: 200 + dx, clientY: 300 + dy });
}

describe('mobile viewer gestures', () => {
  it.each([true, false])('never commits a previous file URL under the next attachment, mobile=%s', async mobile => {
    const mediaState = createMediaState();
    const sources: (string | null)[] = [];
    const first: ResolvedAttachment = { ...items[0], mediaEntry: { type: 'image', url: 'blob:first-frame' } };
    const next: ResolvedAttachment = { ...items[1], mediaEntry: { type: 'image', url: 'blob:next-frame' } };
    function Preview({ attachment }: { attachment: ResolvedAttachment }) {
      useLayoutEffect(() => {
        sources.push(document.querySelector<HTMLImageElement>('.media-viewer-image')?.getAttribute('src') ?? null);
      }, [attachment]);
      return <MediaViewer mobile={mobile} items={[attachment]} initialIndex={0} mediaState={mediaState}
        onClose={() => {}} onJumpToMessage={() => {}} />;
    }
    const { rerender } = render(<Preview attachment={first} />);
    await waitFor(() => expect(document.querySelector('.media-viewer-image')?.getAttribute('src')).toBe('blob:first-frame'));
    rerender(<Preview attachment={next} />);
    expect(sources.at(-1)).toBeNull();
    await waitFor(() => expect(document.querySelector('.media-viewer-image')?.getAttribute('src')).toBe('blob:next-frame'));
  });

  it('activates short toolbar taps without a browser click and ignores the compatibility click', async () => {
    const { onClose } = openViewer();
    const image = await screen.findByRole('button', { name: 'Expand image' });
    const menu = screen.getByRole('button', { name: 'More options' });
    gesture(menu.querySelector('svg')!, 0);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(menu, { detail: 1 });
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(image.getAttribute('aria-pressed')).toBe('false');
    const close = screen.getByRole('button', { name: 'Close' });
    gesture(close.querySelector('svg')!, 0);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(close, { detail: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks the released Close tap from activating the page after the viewer unmounts', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<MediaViewer mobile items={items} initialIndex={1}
      mediaState={createMediaState()} onClose={onClose} onJumpToMessage={() => {}} />);
    gesture(screen.getByRole('button', { name: 'Close' }), 0);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    const pageButton = document.createElement('button');
    const onPageClick = vi.fn();
    pageButton.addEventListener('click', onPageClick);
    document.body.append(pageButton);
    try {
      fireEvent.click(pageButton, { detail: 1 });
      expect(onPageClick).not.toHaveBeenCalled();
      fireEvent.pointerDown(pageButton);
      fireEvent.click(pageButton, { detail: 1 });
      expect(onPageClick).toHaveBeenCalledTimes(1);
    } finally { pageButton.remove(); }
  });

  it('leaves canceled control taps inactive and allows keyboard activation after a touch', async () => {
    openViewer();
    const menu = screen.getByRole('button', { name: 'More options' });
    gesture(menu, 0, 0, true);
    fireEvent.click(menu, { detail: 1 });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menu, { detail: 0 });
    expect(menu.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([false, true])('swipes across the backdrop in both directions with reverse=%s and clamps at the ends', async reverse => {
    const { onClose, onCurrentItemChange } = openViewer(true, reverse);
    const viewer = screen.getByRole('dialog');
    await waitFor(() => expect(document.querySelector('.media-viewer-image')).toBeTruthy());
    expect(document.querySelector('.media-viewer-nav')).toBeNull();
    gesture(viewer, -100);
    await waitFor(() => expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[reverse ? 0 : 2]));
    gesture(viewer, -100);
    fireEvent.click(viewer, { detail: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[reverse ? 0 : 2]);
    gesture(document.querySelector('.media-viewer-date')!, 100);
    await waitFor(() => expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[1]));
  });

  it('keeps expanded images expanded on swipes without activating the release click', async () => {
    const { onCurrentItemChange } = openViewer();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand image' }));
    const image = screen.getByRole('button', { name: 'Restore image controls' });
    gesture(image, -100);
    await waitFor(() => expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[2]));
    fireEvent.click(screen.getByRole('button', { name: 'Restore image controls' }), { detail: 1 });
    expect(screen.getByRole('button', { name: 'Restore image controls' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Restore image controls' }), { isPrimary: true, pointerType: 'touch', pointerId: 8 });
    fireEvent.click(screen.getByRole('button', { name: 'Restore image controls' }), { detail: 1 });
    expect(screen.getByRole('button', { name: 'Expand image' })).toBeTruthy();
  });

  it('handles a fresh image tap after a swipe even when the browser omits its click', async () => {
    openViewer();
    gesture(await screen.findByRole('button', { name: 'Expand image' }), -100);
    const image = await screen.findByRole('button', { name: 'Expand image' });
    const pointer = { pointerId: 8, pointerType: 'touch', isPrimary: true, clientX: 200, clientY: 300 };
    fireEvent.pointerDown(image, pointer);
    fireEvent.pointerUp(image, pointer);
    expect(screen.getByRole('button', { name: 'Restore image controls' })).toBeTruthy();
    fireEvent.click(image, { detail: 1 });
    expect(screen.getByRole('button', { name: 'Restore image controls' })).toBeTruthy();
    fireEvent.pointerDown(image, pointer);
    fireEvent.pointerUp(image, pointer);
    expect(screen.getByRole('button', { name: 'Expand image' })).toBeTruthy();
  });

  it.each([[20, 0, false], [80, 100, false], [100, 0, true]])('rejects short, vertical, and canceled gestures (%s, %s, canceled=%s)', async (dx, dy, cancel) => {
    const { onCurrentItemChange, onClose } = openViewer();
    const image = await screen.findByRole('button', { name: 'Expand image' });
    gesture(image, dx as number, dy as number, cancel as boolean);
    fireEvent.click(image, { detail: 1 });
    expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[1]);
    expect(screen.getByRole('button', { name: 'Expand image' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores multiple touches and leaves toolbar buttons in control of their own actions', async () => {
    const { onCurrentItemChange } = openViewer();
    const image = await screen.findByRole('button', { name: 'Expand image' });
    fireEvent.pointerDown(image, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 200, clientY: 300 });
    fireEvent.pointerDown(image, { pointerId: 8, pointerType: 'touch', isPrimary: false });
    fireEvent.pointerMove(image, { pointerId: 7, clientX: 50, clientY: 300 });
    fireEvent.pointerUp(image, { pointerId: 7, clientX: 50, clientY: 300 });
    fireEvent.click(image, { detail: 1 });
    expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[1]);
    const menu = screen.getByRole('button', { name: 'More options' });
    gesture(menu, -100);
    fireEvent.click(menu, { detail: 1 });
    expect(screen.getByRole('button', { name: 'Jump to message' })).toBeTruthy();
    expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[1]);
    expect(screen.getByRole('button', { name: 'Expand image' })).toBeTruthy();
  });

  it('keeps desktop arrows active and does not turn desktop drags into navigation', async () => {
    const { onCurrentItemChange } = openViewer(false);
    const image = await screen.findByRole('img', { name: 'swipe-1.jpg' });
    gesture(image, -100);
    expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    await waitFor(() => expect(onCurrentItemChange).toHaveBeenLastCalledWith(items[2]));
  });
});
