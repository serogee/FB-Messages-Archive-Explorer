// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
