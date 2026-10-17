// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNavigationSync } from '../src/hooks/useNavigationSync';
import { HOME_LOCATION, MobileNavigationController, getNavigationItemKey, type NavigationSnapshot } from '../src/services/mobileNavigation';
import { getBookmarkChatId } from '../src/services/bookmarks';
import type { ChatViewHandle } from '../src/components/Chat/ChatView';
import type { ChatListEntry, MessengerThread, SelectableItem } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

type Inputs = Omit<Parameters<typeof useNavigationSync>[0], 'navigation' | 'navigationState'>;
const disconnects: (() => void)[] = [];

afterEach(() => {
  cleanup();
  disconnects.splice(0).forEach(disconnect => disconnect());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function controller() {
  const events = new EventTarget();
  let state: unknown = null;
  const history = {
    scrollRestoration: 'auto',
    get state() { return state; },
    pushState: vi.fn((next: unknown) => { state = next; }),
    replaceState: vi.fn((next: unknown) => { state = next; }),
    back: vi.fn(),
  };
  const navigation = new MobileNavigationController({ history: history as unknown as History,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  disconnects.push(navigation.connect());
  return navigation;
}

function entry(folderName: string): ChatListEntry {
  return { folderName, title: folderName, participants: [], messageCount: 1, folderSize: 0,
    dirHandle: createMockDirectoryHandle(folderName, {}), jsonFileCount: 1, source: 'inbox' };
}

function thread(): MessengerThread {
  return { title: 'Chat', participants: [], messages: [], thread_path: 'inbox/alice', is_still_participant: true };
}

const snapshot: NavigationSnapshot = {
  message: { index: 7, offset: 35, scrollTop: 800, atBottom: false },
  gallery: {
    tab: 'audio', positions: { all: 123, audio: 456 }, anchor: { key: 'audio:9:voice.mp4', offset: 23 },
    filters: { include: ['Alice'], exclude: ['Bob'], bookmark: 'bookmarked', query: 'voice' },
    expanded: true, senderSearch: '+Alice', highlightedKey: 'audio:9:voice.mp4',
  },
  sidebarScroll: 12, infoScroll: 34, selectedScroll: 56,
};

function harness(navigation: MobileNavigationController, overrides: Partial<Inputs> = {}) {
  const alice = entry('alice');
  let inputs: Inputs = { isMobile: false, archiveList: [alice], activeEntry: alice,
    chatData: thread(), chatLoading: false, loadChatEntry: vi.fn().mockResolvedValue(undefined), viewerLookup: new Map(),
    ...overrides };
  const handle = {
    getChatContainer: vi.fn((): HTMLDivElement | null => null), cancelJump: vi.fn(), scrollToBottom: vi.fn(),
    jumpToMessage: vi.fn<(index: number) => Promise<void>>().mockResolvedValue(undefined), jumpToAttachment: vi.fn(),
    captureSnapshot: vi.fn((): NavigationSnapshot => snapshot),
    restoreSnapshot: vi.fn<(value: NavigationSnapshot) => Promise<void>>().mockResolvedValue(undefined),
  } satisfies ChatViewHandle;
  const renders: { sidebar: string; gallery: boolean; tab: string }[] = [];
  const view = renderHook((props: Inputs) => {
    const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getState);
    const sync = useNavigationSync({ ...props, navigation, navigationState });
    sync.chatViewRef.current = handle;
    renders.push({ sidebar: sync.sidebarView, gallery: sync.galleryOpen, tab: sync.galleryDefaultTab });
    return sync;
  }, { initialProps: inputs });
  return { ...view, handle, renders, inputs, rerenderInputs(next: Partial<Inputs> = {}) {
    inputs = { ...inputs, ...next };
    view.rerender(inputs);
  } };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('navigation synchronization lifecycle', () => {
  it('commits destination panels before restoring all snapshots and moving mobile focus', () => {
    document.body.innerHTML = '<div id="sidebar"><div class="sidebar-scroll-region"></div></div>'
      + '<div id="chatInfoPanel"><div class="info-panel-content"></div></div>'
      + '<div class="selection-panel-content"></div><div inert><input></div>'
      + '<div class="chat-container"><div class="chat-view-layer active"><h3>Attachments</h3></div></div>';
    const navigation = controller();
    const alice = entry('alice');
    const chatLocation = { ...HOME_LOCATION, screen: 'chat' as const, chatId: getBookmarkChatId(alice) };
    navigation.navigate({ ...chatLocation, screen: 'gallery', sidebarView: 'settings', galleryTab: 'audio' });
    navigation.capture = () => snapshot;
    navigation.navigate(chatLocation, 'attachment');
    const view = harness(navigation, { archiveList: [alice], activeEntry: alice, isMobile: true });
    view.handle.cancelJump.mockClear();
    const restoredPanels: unknown[] = [];
    view.handle.restoreSnapshot.mockImplementation(async () => { restoredPanels.push(view.renders.at(-1)); });
    const input = document.querySelector('input')!;
    input.focus();
    act(() => navigation.returnFromJump());

    expect(restoredPanels).toEqual([{ sidebar: 'settings', gallery: true, tab: 'audio' }]);
    expect(view.handle.restoreSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(view.handle.cancelJump).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.sidebar-scroll-region')!.scrollTop).toBe(12);
    expect(document.querySelector('.info-panel-content')!.scrollTop).toBe(34);
    expect(document.querySelector('.selection-panel-content')!.scrollTop).toBe(56);
    expect(document.activeElement).toBe(document.querySelector('h3'));
    expect(document.querySelector('h3')!.tabIndex).toBe(-1);
    view.rerenderInputs({ viewerLookup: new Map() });
    expect(view.handle.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('gives a deferred date browse precedence over restored message position only for its own thread', () => {
    const navigation = controller();
    const view = harness(navigation);
    const captured = navigation.capture();
    const chatLocation = { ...HOME_LOCATION, screen: 'chat' as const, chatId: getBookmarkChatId(view.inputs.activeEntry!) };
    act(() => navigation.navigate(chatLocation));
    act(() => navigation.navigate({ ...chatLocation, screen: 'info' }, 'message'));
    act(() => view.result.current.handleBrowseToMessage(42));
    act(() => navigation.returnFromJump());
    expect(view.handle.restoreSnapshot).toHaveBeenCalledExactlyOnceWith({ ...captured, message: undefined });
    expect(view.handle.jumpToMessage).toHaveBeenCalledExactlyOnceWith(42);

    view.handle.restoreSnapshot.mockClear();
    view.handle.jumpToMessage.mockClear();
    act(() => navigation.navigate({ ...chatLocation, screen: 'info' }, 'message'));
    act(() => view.result.current.handleBrowseToMessage(88));
    view.rerenderInputs({ chatData: thread() });
    act(() => navigation.returnFromJump());
    expect(view.handle.restoreSnapshot).toHaveBeenCalledExactlyOnceWith(captured);
    expect(view.handle.jumpToMessage).not.toHaveBeenCalled();
  });

  it('settles superseded and canceled jumps without letting late completion settle a newer request', async () => {
    const navigation = controller();
    const view = harness(navigation);
    const first = deferred(), second = deferred(), canceled = deferred();
    view.handle.jumpToMessage.mockImplementation(index => index === 10 ? first.promise : index === 20 ? second.promise : canceled.promise);
    const firstOptions = { minimumOffset: () => 150 }, secondOptions = { minimumOffset: () => 180 };
    let firstRequest!: Promise<void>, secondRequest!: Promise<void>, canceledRequest!: Promise<void>;
    act(() => { firstRequest = view.result.current.handleChatMessageJump(10, firstOptions); });
    act(() => { secondRequest = view.result.current.handleChatMessageJump(20, secondOptions); });
    await expect(firstRequest).resolves.toBeUndefined();
    expect(view.handle.jumpToMessage).toHaveBeenNthCalledWith(1, 10, firstOptions);
    expect(view.handle.jumpToMessage).toHaveBeenNthCalledWith(2, 20, secondOptions);
    let settled = false;
    void secondRequest.then(() => { settled = true; });
    await act(async () => { first.resolve(); });
    expect(settled).toBe(false);
    await act(async () => { second.reject(new Error('jump canceled')); });
    await expect(secondRequest).resolves.toBeUndefined();

    const revision = navigation.getState().revision;
    view.handle.jumpToMessage.mockResolvedValueOnce(undefined);
    await act(async () => { await view.result.current.handleChatMessageJump(20, firstOptions); });
    expect(navigation.getState().revision).toBe(revision);
    expect(view.handle.jumpToMessage).toHaveBeenLastCalledWith(20, firstOptions);

    act(() => { canceledRequest = view.result.current.handleChatMessageJump(30); });
    act(() => navigation.reset());
    await expect(canceledRequest).resolves.toBeUndefined();
    expect(navigation.getState().location.screen).toBe('home');
    await act(async () => { canceled.resolve(); });
    expect(navigation.getState().location.screen).toBe('home');
  });

  it('loads a restored chat once per revision and waits for its matching loaded data', () => {
    const navigation = controller();
    const alice = entry('alice'), bob = entry('bob');
    const aliceLocation = { ...HOME_LOCATION, screen: 'chat' as const, chatId: getBookmarkChatId(alice) };
    const bobLocation = { ...aliceLocation, screen: 'gallery' as const, chatId: getBookmarkChatId(bob) };
    navigation.navigate(bobLocation);
    navigation.capture = () => snapshot;
    navigation.navigate(aliceLocation, 'attachment');
    const load = vi.fn().mockResolvedValue(undefined);
    const view = harness(navigation, { archiveList: [alice, bob], activeEntry: alice, loadChatEntry: load });
    act(() => navigation.returnFromJump());
    expect(load).toHaveBeenCalledExactlyOnceWith(bob);
    view.rerenderInputs({ viewerLookup: new Map() });
    view.rerenderInputs({ activeEntry: bob, chatData: null, chatLoading: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(view.handle.restoreSnapshot).not.toHaveBeenCalled();
    view.rerenderInputs({ chatData: thread(), chatLoading: false });
    expect(view.handle.restoreSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    act(() => navigation.navigate(aliceLocation));
    expect(load).toHaveBeenCalledTimes(1); // Ordinary selection/jump owns its own load.
  });

  it('keeps the desktop gallery during same-revision sidebar changes and targets the requested occurrence', () => {
    const navigation = controller();
    const first: SelectableItem = { category: 'photos', mediaPath: 'photos/shared.jpg', messageIndex: 2,
      sender: 'Alice', timestamp: 2, mediaEntry: null };
    const repeat = { ...first, messageIndex: 9, sender: 'Bob', timestamp: 9 };
    const lookup = new Map([first, repeat].map(item => [getNavigationItemKey(item), item]));
    const view = harness(navigation, { viewerLookup: lookup });
    act(() => navigation.navigate({ ...HOME_LOCATION, screen: 'chat', chatId: getBookmarkChatId(view.inputs.activeEntry!) }));
    act(() => view.result.current.handleOpenGallery('photos'));
    const revision = navigation.getState().revision;
    act(() => {
      view.result.current.setActiveTab('settings');
      view.result.current.handleSidebarViewChange('settings');
    });
    expect(navigation.getState().location.screen).toBe('home');
    expect(navigation.getState().revision).toBe(revision);
    expect(view.result.current.galleryOpen).toBe(true);
    expect(view.result.current.sidebarView).toBe('settings');
    expect(view.result.current.activeTab).toBe('settings');
    act(() => view.result.current.handleGalleryTabChange('audio'));
    expect(navigation.getState().revision).toBe(revision);
    expect(view.result.current.galleryDefaultTab).toBe('audio');
    act(() => view.result.current.handleJumpToAttachment(repeat));
    expect(navigation.getState().location.attachmentTarget).toBe(getNavigationItemKey(repeat));
    expect(view.result.current.attachmentJumpTarget?.messageIndex).toBe(9);
    expect(view.result.current.attachmentJumpTarget?.sender).toBe('Bob');
    expect(view.result.current.galleryDefaultTab).toBe('all');
  });

  it('falls back to chat after a failed load and resets a destination missing from the archive', () => {
    const navigation = controller();
    const view = harness(navigation, { chatData: null });
    act(() => navigation.navigate({ ...HOME_LOCATION, screen: 'selected', chatId: getBookmarkChatId(view.inputs.activeEntry!) }));
    expect(navigation.getState().location.screen).toBe('chat');
    expect(view.handle.restoreSnapshot).not.toHaveBeenCalled();
    act(() => navigation.navigate({ ...HOME_LOCATION, screen: 'gallery', chatId: 'missing-chat' }));
    expect(navigation.getState().location).toEqual(HOME_LOCATION);
    expect(view.inputs.loadChatEntry).not.toHaveBeenCalled();
  });
});
