// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HOME_LOCATION, MobileNavigationController, getNavigationItemKey, getParentLocation, type NavigationLocation } from '../src/services/mobileNavigation';
import type { SelectableItem } from '../src/types/messenger';

function harness() {
  const events = new EventTarget();
  const stack: unknown[] = [null];
  let cursor = 0;
  const history = {
    get state() { return stack[cursor]; },
    pushState: vi.fn((state: unknown) => { stack.splice(cursor + 1); stack.push(state); cursor++; }),
    replaceState: vi.fn((state: unknown) => { stack[cursor] = state; }),
    back: () => { if (cursor > 0) { cursor--; events.dispatchEvent(new Event('popstate')); } },
    forward: () => { if (cursor < stack.length - 1) { cursor++; events.dispatchEvent(new Event('popstate')); } },
  };
  const controller = new MobileNavigationController({ history: history as unknown as History,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } as Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>);
  controller.connect();
  return { controller, history, stack, pop: () => events.dispatchEvent(new Event('popstate')) };
}

const chat: NavigationLocation = { ...HOME_LOCATION, screen: 'chat', chatId: 'alice' };
const image = (messageIndex: number) => ({ category: 'photos', mediaPath: './photos/image.jpg', messageIndex } as SelectableItem);

describe('mobile navigation', () => {
  it('uses fixed parents even when an attachment was reached directly from chat', () => {
    const { controller, history } = harness();
    controller.setMobile(true);
    controller.navigate(chat);
    controller.navigate({ ...chat, screen: 'gallery', attachmentTarget: getNavigationItemKey(image(7)) });
    controller.parent();
    expect(controller.getState().location.screen).toBe('info');
    history.back();
    expect(controller.getState().location.screen).toBe('gallery');
    expect(getParentLocation({ ...chat, screen: 'selected' }).screen).toBe('gallery');
    expect(getParentLocation({ ...chat, sidebarView: 'settings', chatListView: 'requests' }).sidebarView).toBe('chats');
    expect(getParentLocation({ ...chat, sidebarView: 'requests', chatListView: 'requests' }).sidebarView).toBe('requests');
  });

  it('restores previews, actual viewer items, and underlying message positions after jumps', () => {
    const { controller, history } = harness();
    controller.setMobile(true);
    controller.navigate(chat);
    controller.capture = () => ({ message: { index: 2, offset: 35, scrollTop: 800, atBottom: false } });
    controller.openPreview({ items: [image(2), image(9)], index: 0, source: 'chat' });
    controller.updatePreview(image(9));
    const pushes = history.pushState.mock.calls.length;
    controller.navigate({ ...chat, screen: 'gallery', attachmentTarget: getNavigationItemKey(image(9)) });
    history.back();
    expect(controller.getState().restoring).toBe(true);
    expect(controller.getState().location.preview?.currentKey).toBe(getNavigationItemKey(image(9)));
    expect(controller.getState().snapshot?.message?.offset).toBe(35);
    expect(history.pushState).toHaveBeenCalledTimes(pushes + 1);
    controller.closePreview();
    expect(controller.getState().location.preview).toBeUndefined();
    history.forward();
    expect(controller.getState().location.preview?.currentKey).toBe(getNavigationItemKey(image(9)));
  });

  it('records same-chat jumps and drops the forward branch after a new action', () => {
    const { controller, history, stack } = harness();
    controller.setMobile(true);
    controller.navigate(chat);
    controller.navigate({ ...chat, messageTarget: 3 });
    controller.navigate({ ...chat, messageTarget: 8 });
    history.back();
    expect(controller.getState().location.messageTarget).toBe(3);
    controller.navigate({ ...chat, messageTarget: 12 });
    history.forward();
    expect(controller.getState().location.messageTarget).toBe(12);
    expect(stack).toHaveLength(4);
  });

  it('does not push duplicate visits or desktop actions, and restores mobile entries after resizing', () => {
    const { controller, history } = harness();
    controller.navigate(chat);
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    controller.setMobile(true);
    controller.navigate({ ...chat, screen: 'info' });
    controller.navigate({ ...chat, screen: 'info' });
    expect(history.pushState).toHaveBeenCalledTimes(1);
    controller.setMobile(false);
    controller.navigate({ ...chat, screen: 'gallery' });
    expect(history.pushState).toHaveBeenCalledTimes(1);
    history.back();
    expect(controller.getState().location.screen).toBe('chat');
  });

  it('invalidates old archive entries and ignores the browser entry outside its session', () => {
    const { controller, history, pop } = harness();
    controller.setMobile(true);
    controller.navigate(chat);
    controller.navigate({ ...chat, screen: 'gallery' });
    controller.reset();
    history.back();
    expect(controller.getState().location.screen).toBe('home');
    expect(controller.getState().location.chatId).toBeUndefined();
    const before = controller.getState();
    history.replaceState(null);
    pop();
    expect(controller.getState()).toBe(before);
  });

  it('keeps repeated file occurrences and link messages distinct', () => {
    expect(getNavigationItemKey(image(2))).not.toBe(getNavigationItemKey(image(9)));
    expect(getNavigationItemKey({ category: 'photos', mediaPath: 'PHOTOS\\image.jpg', messageIndex: 2 } as SelectableItem)).toBe(getNavigationItemKey(image(2)));
  });
});
