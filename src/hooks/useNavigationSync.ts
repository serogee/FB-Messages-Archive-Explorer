import { useState, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import type { ChatViewHandle } from '../components/Chat/ChatView';
import type { MessageJumpOptions } from '../components/Chat/MessageList';
import type { AttachmentJumpTarget } from '../components/AttachmentGallery/AttachmentGallery';
import { getAttachmentJumpTab } from '../components/AttachmentGallery/attachmentJump';
import { ENABLE_CONTEXTUAL_BACK_NAVIGATION } from '../config/uiFeatures';
import type { GalleryCategory } from './useAttachments';
import type { ChatListEntry, MessengerThread, SelectableItem } from '../types/messenger';
import { getBookmarkChatId } from '../services/bookmarks';
import { getNavigationItemKey, type MobileNavigationController, type NavigationState, type NavigationSnapshot, type SidebarView } from '../services/mobileNavigation';

interface NavigationSyncOptions {
  navigation: MobileNavigationController;
  navigationState: NavigationState;
  isMobile: boolean;
  archiveList: readonly ChatListEntry[];
  activeEntry: ChatListEntry | null;
  chatData: MessengerThread | null;
  chatLoading: boolean;
  loadChatEntry: (entry: ChatListEntry) => Promise<void>;
  viewerLookup: ReadonlyMap<string, SelectableItem>;
}

/** Applies navigation destinations to the mounted UI without owning history. */
export function useNavigationSync({
  navigation,
  navigationState,
  isMobile,
  archiveList,
  activeEntry,
  chatData,
  chatLoading,
  loadChatEntry,
  viewerLookup,
}: NavigationSyncOptions) {
  const [sidebarView, setSidebarView] = useState<'chats' | 'settings' | 'archived' | 'requests'>('chats');
  const [activeTab, setActiveTab] = useState<'chats' | 'settings'>('chats');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryDefaultTab, setGalleryDefaultTab] = useState<GalleryCategory>('all');
  const chatViewRef = useRef<ChatViewHandle>(null);
  const chatScrollContainerRef = useMemo(() => ({ get current() { return chatViewRef.current?.getChatContainer() ?? null; } }), []);
  const pendingJumpCompletion = useRef<{ revision: number; resolve: () => void; options?: MessageJumpOptions } | null>(null);
  const pendingDateBrowse = useRef<{ data: typeof chatData; index: number } | null>(null);

  const handleBrowseToMessage = useCallback((index: number) => {
    pendingDateBrowse.current = { data: chatData, index };
  }, [chatData]);

  const handleJumpToMessage = useCallback(async (index: number, folderName?: string, options?: MessageJumpOptions) => {
    const entry = folderName ? archiveList.find(entry => entry.folderName === folderName) : activeEntry;
    if (!entry) return;
    pendingDateBrowse.current = null;
    const previousRevision = navigation.getState().revision;
    const source = navigation.getState().location;
    const fromAttachment = source.screen === 'gallery' || source.screen === 'selected' || !!source.preview;
    navigation.navigate({ ...source, screen: 'chat', chatId: getBookmarkChatId(entry),
      preview: undefined, messageTarget: index, attachmentTarget: undefined },
      ENABLE_CONTEXTUAL_BACK_NAVIGATION && fromAttachment ? 'attachment' : undefined);
    const revision = navigation.getState().revision;
    if (revision === previousRevision) {
      await chatViewRef.current?.jumpToMessage(index, options);
      return;
    }
    pendingJumpCompletion.current?.resolve();
    const completion = new Promise<void>(resolve => { pendingJumpCompletion.current = { revision, resolve, options }; });
    setGalleryOpen(false);
    if (getBookmarkChatId(entry) !== (activeEntry ? getBookmarkChatId(activeEntry) : undefined)) {
      await loadChatEntry(entry);
    }
    await completion;
  }, [archiveList, activeEntry, loadChatEntry, navigation]);

  const handleChatMessageJump = useCallback((index: number, options?: MessageJumpOptions) => (
    handleJumpToMessage(index, undefined, options)
  ), [handleJumpToMessage]);

  const handleOpenGallery = useCallback((tab?: string) => {
    const nextTab = (tab as GalleryCategory | undefined) ?? galleryDefaultTab;
    navigation.navigate({ ...navigation.getState().location, screen: 'gallery', galleryTab: nextTab,
      preview: undefined, messageTarget: undefined, attachmentTarget: undefined });
    setGalleryDefaultTab(nextTab);
    setGalleryOpen(true);
  }, [galleryDefaultTab, navigation]);

  const handleJumpToAttachment = useCallback((item: SelectableItem) => {
    const tab = getAttachmentJumpTab(galleryDefaultTab, item.category);
    const source = navigation.getState().location;
    navigation.navigate({ ...source, screen: 'gallery', galleryTab: tab,
      preview: undefined, messageTarget: undefined, attachmentTarget: getNavigationItemKey(item) },
      ENABLE_CONTEXTUAL_BACK_NAVIGATION && (source.screen === 'chat' || source.preview?.source === 'chat') ? 'message' : undefined);
    setGalleryDefaultTab(tab);
    setGalleryOpen(true);
  }, [galleryDefaultTab, navigation]);

  const handleSidebarViewChange = useCallback((view: SidebarView) => {
    const destination = { ...navigation.getState().location, screen: 'home' as const, sidebarView: view,
      chatListView: view === 'settings' ? navigation.getState().location.chatListView : view,
      preview: undefined, messageTarget: undefined, attachmentTarget: undefined };
    if (isMobile) navigation.navigate(destination);
    else navigation.update(destination);
    setSidebarView(view);
  }, [isMobile, navigation]);

  const sidebarScrollElement = () => document.querySelector<HTMLElement>('#sidebar .sidebar-scroll-region')
    ?? document.querySelector<HTMLElement>('#sidebar .settings');
  navigation.capture = (): NavigationSnapshot => ({
    ...chatViewRef.current?.captureSnapshot(),
    sidebarScroll: sidebarScrollElement()?.scrollTop,
    infoScroll: document.querySelector<HTMLElement>('#chatInfoPanel .info-panel-content')?.scrollTop,
    selectedScroll: document.querySelector<HTMLElement>('.selection-panel-content')?.scrollTop,
  });

  const appliedRevisionRef = useRef(-1);
  const startedRevisionRef = useRef(-1);
  const loadedRestorationRef = useRef(-1);
  const [attachmentJumpTarget, setAttachmentJumpTarget] = useState<AttachmentJumpTarget | null>(null);
  useLayoutEffect(() => {
    const { location: destination, snapshot, revision, restoring } = navigationState;
    if (pendingDateBrowse.current?.data !== chatData) pendingDateBrowse.current = null;
    if (appliedRevisionRef.current === revision) return;
    if (startedRevisionRef.current !== revision) {
      if (pendingJumpCompletion.current && pendingJumpCompletion.current.revision !== revision) {
        pendingJumpCompletion.current.resolve();
        pendingJumpCompletion.current = null;
      }
      startedRevisionRef.current = revision;
      chatViewRef.current?.cancelJump();
      setAttachmentJumpTarget(null);
    }
    if (sidebarView !== destination.sidebarView) {
      setSidebarView(destination.sidebarView);
      setActiveTab(destination.sidebarView === 'settings' ? 'settings' : 'chats');
      return;
    }
    setSidebarView(destination.sidebarView);
    setActiveTab(destination.sidebarView === 'settings' ? 'settings' : 'chats');
    const wantsGallery = destination.screen === 'gallery' || destination.screen === 'selected';
    if (galleryOpen !== wantsGallery) { setGalleryOpen(wantsGallery); return; }
    if (galleryDefaultTab !== destination.galleryTab) { setGalleryDefaultTab(destination.galleryTab); return; }
    if (destination.chatId) {
      const entry = archiveList.find(entry => getBookmarkChatId(entry) === destination.chatId);
      if (!entry) { navigation.reset(); return; }
      if (!activeEntry || getBookmarkChatId(activeEntry) !== destination.chatId) {
        if (restoring && loadedRestorationRef.current !== revision) {
          loadedRestorationRef.current = revision;
          void loadChatEntry(entry);
        }
        return;
      }
      if (chatLoading) return;
      if (!chatData && destination.screen !== 'home' && destination.screen !== 'chat') {
        navigation.navigate({ ...destination, screen: 'chat', preview: undefined });
        return;
      }
    }
    appliedRevisionRef.current = revision;
    const dateBrowse = destination.screen === 'chat' && !destination.preview ? pendingDateBrowse.current : null;
    if (dateBrowse) pendingDateBrowse.current = null;
    if (restoring && snapshot) {
      // A date selected in Info takes precedence over the chat position saved on entry.
      void chatViewRef.current?.restoreSnapshot(dateBrowse ? { ...snapshot, message: undefined } : snapshot);
      const sidebar = sidebarScrollElement();
      if (sidebar && snapshot.sidebarScroll !== undefined) sidebar.scrollTop = snapshot.sidebarScroll;
      const info = document.querySelector<HTMLElement>('#chatInfoPanel .info-panel-content');
      if (info && snapshot.infoScroll !== undefined) info.scrollTop = snapshot.infoScroll;
      const selected = document.querySelector<HTMLElement>('.selection-panel-content');
      if (selected && snapshot.selectedScroll !== undefined) selected.scrollTop = snapshot.selectedScroll;
    } else if (!destination.preview) {
      if (destination.messageTarget !== undefined && !dateBrowse) {
        const finish = () => {
          if (pendingJumpCompletion.current?.revision === revision) {
            pendingJumpCompletion.current.resolve();
            pendingJumpCompletion.current = null;
          }
        };
        const options = pendingJumpCompletion.current?.revision === revision ? pendingJumpCompletion.current.options : undefined;
        void chatViewRef.current?.jumpToMessage(destination.messageTarget, options).then(finish, finish);
      }
      if (destination.attachmentTarget) {
        const item = viewerLookup.get(destination.attachmentTarget);
        if (item) setAttachmentJumpTarget({ ...item, tab: destination.galleryTab });
      } else setAttachmentJumpTarget(null);
    }
    if (dateBrowse) void chatViewRef.current?.jumpToMessage(dateBrowse.index);
    if (isMobile) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('[inert]')) focused.blur();
      const activePanel = destination.screen === 'home' ? '#sidebar' : destination.screen === 'info' ? '#chatInfoPanel'
        : destination.screen === 'selected' ? '.selection-panel' : '.chat-container .chat-view-layer.active';
      const heading = document.querySelector<HTMLElement>(`${activePanel} h3, ${activePanel} .title-text`);
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }, [navigationState, archiveList, activeEntry, chatData, chatLoading, galleryOpen, galleryDefaultTab, sidebarView, isMobile, loadChatEntry, navigation, viewerLookup]);

  const hideGallery = useCallback(() => setGalleryOpen(false), []);
  const resetSidebar = useCallback(() => {
    setActiveTab('chats');
    setSidebarView('chats');
  }, []);
  const clearAttachmentJumpTarget = useCallback(() => setAttachmentJumpTarget(null), []);
  // Keep the existing per-render tab callback while navigation.update leaves the
  // current revision applied. The local default still needs its own publication.
  const handleGalleryTabChange = (tab: GalleryCategory) => {
    setGalleryDefaultTab(tab);
    navigation.update({ ...navigation.getState().location, galleryTab: tab });
  };

  return {
    sidebarView, activeTab, setActiveTab, galleryOpen, galleryDefaultTab,
    chatViewRef, chatScrollContainerRef, attachmentJumpTarget,
    hideGallery, resetSidebar, clearAttachmentJumpTarget,
    handleBrowseToMessage, handleJumpToMessage, handleChatMessageJump,
    handleOpenGallery, handleJumpToAttachment, handleSidebarViewChange,
    handleGalleryTabChange,
  };
}
