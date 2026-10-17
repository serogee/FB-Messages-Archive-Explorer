import { useCallback, useRef, useEffect, useMemo } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useSettings } from './hooks/useSettings';
import { useMobileLayout, useMobileNavigation } from './hooks/useMobileNavigation';
import { getNavigationItemKey, type PreviewRequest } from './services/mobileNavigation';
import { ReactionFeatureContext, useReactionFeature } from './hooks/useReactionFeature';
import { useArchive } from './hooks/useArchive';
import { useDeleteDialog } from './hooks/useDeleteDialog';
import { useNavigationSync } from './hooks/useNavigationSync';
import { useChat } from './hooks/useChat';
import { ThreadDataContext } from './hooks/useThreadData';
import { AttachmentReferencesContext } from './hooks/useAttachmentReferences';
import { getMetaChatId } from './services/metaAttachmentPaths';
import { useSearch } from './hooks/useSearch';
import { useResizable } from './hooks/useResizable';
import { sortSelectableItemsNewestFirst, useSelection } from './hooks/useSelection';
import { useAttachments, useSharedLinks } from './hooks/useAttachments';
import { useBookmarks } from './hooks/useBookmarks';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatView } from './components/Chat/ChatView';
import { DateNavigator } from './components/Chat/DateNavigator';
import { InfoPanel } from './components/InfoPanel/InfoPanel';
import { SelectionHeader, SelectionPanel } from './components/InfoPanel/SelectionPanel';
import { MediaViewer } from './components/MediaViewer/MediaViewer';
import { ParentBackButton } from './components/Navigation/ParentBackButton';
import { ENABLE_CONTEXTUAL_BACK_NAVIGATION } from './config/uiFeatures';
import { TrustModal } from './components/Modals/TrustModal';
import { ReloadPrompt } from './components/ReloadPrompt';
import { DeleteConfirmModal } from './components/Modals/DeleteConfirmModal';
import type { ChatListEntry, SelectableItem } from './types/messenger';
import { isFileSystemAccessSupported } from './services/fileSystem';
import { getBookmarkChatId } from './services/bookmarks';
import { isWritableDirectoryHandle, requestDirectoryWritePermission } from './types/fileSystem';

export default function App() {
  const { settings, setSetting } = useSettings();
  const isMobile = useMobileLayout();
  const { controller: navigation, state: navigationState } = useMobileNavigation(isMobile);
  const location = navigationState.location;
  const archive = useArchive(settings.deletionEnabled, settings.debuggingEnabled);
  const chat = useChat();
  const attachmentReferences = useMemo(() => ({
    index: archive.attachmentReferenceIndex,
    standaloneMessenger: archive.standaloneMessenger,
    indexing: archive.attachmentReferenceIndexLoading,
    chatId: chat.activeEntry && !chat.activeEntry._messengerExport ? getMetaChatId(chat.activeEntry) : undefined,
  }), [archive.attachmentReferenceIndex, archive.attachmentReferenceIndexLoading, archive.standaloneMessenger, chat.activeEntry]);
  const archiveList = useMemo(
    () => [...archive.inboxList, ...archive.archivedList, ...archive.requestsList],
    [archive.inboxList, archive.archivedList, archive.requestsList]
  );
  const navigatingChat = !!location.chatId && (!chat.activeEntry || getBookmarkChatId(chat.activeEntry) !== location.chatId);
  const viewEntry = navigatingChat ? archiveList.find(entry => getBookmarkChatId(entry) === location.chatId) ?? chat.activeEntry : chat.activeEntry;
  const showAllReactionNotices = useCallback(() => setSetting('hideLikelyReactionNotices', false), [setSetting]);
  const reactionFeature = useReactionFeature({
    root: archive.rootHandle, revision: archive.reactionSourceRevision, standalone: archive.standaloneMessenger,
    archiveLoading: archive.loading || archive.reactionMutationPending, chatLoading: chat.loading, chatData: chat.chatData, entry: chat.activeEntry,
    mode: settings.reactionTimestampGuessingMode, hide: settings.hideLikelyReactionNotices, showAll: showAllReactionNotices,
  });
  const search = useSearch(chat.chatData, archiveList, settings.hideLikelyReactionNotices, archive.standaloneMessenger);
  const { clearWideSearchCache, clearSearch } = search;
  useEffect(() => {
    clearWideSearchCache();
    clearSearch();
  }, [archive.reactionSourceRevision, clearWideSearchCache, clearSearch]);
  const selection = useSelection();
  const attachments = useAttachments(chat.chatData, chat.mediaState);
  const sharedLinks = useSharedLinks(chat.chatData);
  const bookmarkingEnabled = settings.attachmentBookmarkingEnabled && isFileSystemAccessSupported()
    && (!archive.rootHandle || isWritableDirectoryHandle(archive.rootHandle));
  const bookmarks = useBookmarks(archive.rootHandle, bookmarkingEnabled);

  const handleDeletedChats = useCallback((deletedEntries: readonly ChatListEntry[]) => {
    if (chat.activeEntry && deletedEntries.some(
      entry => getBookmarkChatId(entry) === getBookmarkChatId(chat.activeEntry!)
    )) {
      chat.clearChat();
      navigation.reset();
      selection.deselectAll();
    }
  }, [chat, navigation, selection]);

  const deleteDialog = useDeleteDialog({
    deletionEnabled: settings.deletionEnabled,
    permissionRoot: archive.originalRootHandle || archive.rootHandle,
    getDeleteInfo: archive.getDeleteInfo,
    updateFolderSize: archive.updateFolderSize,
    suspendSizeWork: archive.suspendSizeWork,
    resumeSizeWork: archive.resumeSizeWork,
    deleteChats: archive.deleteChats,
    deleteMessengerChatsJsonOnly: archive.deleteMessengerChatsJsonOnly,
    removeBookmarks: bookmarks.removeForChats,
    onDeleted: handleDeletedChats,
  });
  const { abortForPickedFolder, resetAfterHandledOpen } = deleteDialog;

  const repeatedAttachments = useAttachments(chat.chatData, chat.mediaState, { includeRepeated: true });
  const viewerLookup = useMemo(() => new Map([...repeatedAttachments.all, ...sharedLinks].map(item => [getNavigationItemKey(item), item])), [repeatedAttachments.all, sharedLinks]);
  const preview = location.preview;
  const viewerItems = useMemo(() => preview?.keys.map(key => viewerLookup.get(key)).filter((item): item is SelectableItem => !!item) ?? [], [preview?.keys, viewerLookup]);

  const { handleRef: sidebarHandleRef } = useResizable({
    enabled: !isMobile,
    minWidth: 260,
    maxWidthFraction: 0.55,
    maxWidthAbsolute: 640,
    initialWidth: settings.sidebarWidth,
    onWidthChange: (w) => setSetting('sidebarWidth', w as typeof settings.sidebarWidth),
    cssVariable: '--sidebar-width',
    minMainWidth: 320,
    layoutDependency: settings.infoPanelOpen,
    side: 'left',
  });

  const { handleRef: infoHandleRef } = useResizable({
    enabled: !isMobile,
    minWidth: 240,
    maxWidthFraction: 0.45,
    maxWidthAbsolute: 520,
    initialWidth: settings.infoPanelWidth,
    onWidthChange: (w) => setSetting('infoPanelWidth', w as typeof settings.infoPanelWidth),
    cssVariable: '--info-panel-width',
    minMainWidth: 320,
    layoutDependency: settings.infoPanelOpen,
    side: 'right',
  });

  const loadChatEntry = useCallback(async (entry: ChatListEntry) => {
    await archive.suspendSizeWork();
    try {
      await chat.loadChat(
        entry,
        archive.rootHandle,
        archive.archivePerspectiveKey,
        archive.archivePerspectiveName
      );
    } finally {
      archive.resumeSizeWork();
    }
  }, [archive, chat]);

  const {
    sidebarView, activeTab, setActiveTab, galleryOpen, galleryDefaultTab,
    chatViewRef, chatScrollContainerRef, attachmentJumpTarget,
    hideGallery, resetSidebar, clearAttachmentJumpTarget,
    handleBrowseToMessage, handleJumpToMessage, handleChatMessageJump,
    handleOpenGallery, handleJumpToAttachment, handleSidebarViewChange,
    handleGalleryTabChange,
  } = useNavigationSync({
    navigation, navigationState, isMobile, archiveList,
    activeEntry: chat.activeEntry, chatData: chat.chatData, chatLoading: chat.loading,
    loadChatEntry, viewerLookup,
  });

  const handleSelectChat = useCallback(async (entry: ChatListEntry) => {
    navigation.navigate({ ...navigation.getState().location, screen: 'chat', chatId: getBookmarkChatId(entry),
      preview: undefined, messageTarget: undefined, attachmentTarget: undefined });
    hideGallery();
    if (chat.activeEntry && getBookmarkChatId(chat.activeEntry) === getBookmarkChatId(entry) && chat.chatData) return;
    // Paint the loading view before pausing background work or reading chat files.
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    if (navigation.getState().location.chatId !== getBookmarkChatId(entry)) return;
    await loadChatEntry(entry);
  }, [navigation, loadChatEntry, chat.activeEntry, chat.chatData, hideGallery]);

  const handleOpenFolder = useCallback(async () => {
    const picked = await archive.openFolder(
      settings.deletionEnabled || settings.attachmentBookmarkingEnabled,
      () => {
        resetSidebar();
        abortForPickedFolder();
        chat.clearChat();
        search.clearSearch();
        search.clearWideSearchCache();
        selection.deselectAll();
        hideGallery();
        navigation.reset();
      },
      settings.folderAccessMode,
    );
    if (picked) {
      resetAfterHandledOpen();
    }
  }, [settings.deletionEnabled, settings.attachmentBookmarkingEnabled, settings.folderAccessMode, archive, chat, search, selection, navigation, abortForPickedFolder, resetAfterHandledOpen, resetSidebar, hideGallery]);

  const handleAttachmentBookmarkingChange = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (!enabled) {
      setSetting('attachmentBookmarkingEnabled', false);
      return true;
    }
    if (!isFileSystemAccessSupported()) return false;
    const handle = archive.originalRootHandle || archive.rootHandle;
    if (handle && !await requestDirectoryWritePermission(handle)) return false;
    setSetting('attachmentBookmarkingEnabled', true);
    return true;
  }, [archive.originalRootHandle, archive.rootHandle, setSetting]);

  const prevChatDataRef = useRef(chat.chatData);
  useEffect(() => {
    if (chat.chatData && chat.chatData !== prevChatDataRef.current) selection.deselectAll();
    prevChatDataRef.current = chat.chatData;
  }, [chat.chatData, selection]);

  const handleInfo = useCallback(() => {
    if (isMobile) navigation.navigate({ ...navigation.getState().location, screen: 'info', preview: undefined,
      messageTarget: undefined, attachmentTarget: undefined });
    else {
      setSetting('infoPanelOpen', !settings.infoPanelOpen);
      navigation.update({ ...navigation.getState().location, screen: settings.infoPanelOpen ? (galleryOpen ? 'gallery' : 'chat') : 'info' });
    }
  }, [isMobile, navigation, setSetting, settings.infoPanelOpen, galleryOpen]);

  const openViewer = useCallback((request: PreviewRequest) => {
    if (!isMobile) navigation.update({ ...navigation.getState().location, screen: request.source === 'selected' ? 'gallery' : request.source });
    navigation.openPreview(request);
  }, [isMobile, navigation]);
  const updateViewerItem = useCallback((item: SelectableItem) => navigation.updatePreview(item), [navigation]);
  const closeViewer = useCallback(() => navigation.closePreview(), [navigation]);
  const parent = useCallback(() => navigation.parent(), [navigation]);

  const selectableItemsNewestFirst = useMemo(
    () => sortSelectableItemsNewestFirst([...attachments.all, ...sharedLinks]),
    [attachments.all, sharedLinks]
  );
  const selectedItems = selection.getSelectedItems(selectableItemsNewestFirst);

  return (
    <ReactionFeatureContext.Provider value={reactionFeature}>
    <ThreadDataContext.Provider value={navigatingChat ? null : chat.chatData}>
    <AttachmentReferencesContext.Provider value={attachmentReferences}>
    <div className={`container ${settings.infoPanelOpen ? 'info-open' : ''}`} data-mobile-screen={location.screen} inert={!!preview || undefined}>
      <Sidebar
        hidden={isMobile && location.screen !== 'home'}
        settings={settings}
        setSetting={setSetting}
        inboxList={archive.inboxList}
        archivedList={archive.archivedList}
        requestsList={archive.requestsList}
        activeEntry={chat.activeEntry}
        rootHandle={archive.rootHandle}
        originalRootHandle={archive.originalRootHandle}
        loading={archive.loading}
        folderSelectionPending={archive.folderSelectionPending}
        folderPreparationProgress={archive.folderPreparationProgress}
        loadProgress={archive.loadProgress}
        sizeProgress={archive.sizeProgress}
        attachmentReferenceScan={archive.attachmentReferenceScan}
        error={archive.error}
        sidebarView={sidebarView}
        setSidebarView={handleSidebarViewChange}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onSelectChat={handleSelectChat}
        onOpenFolder={handleOpenFolder}
        onDeleteChat={deleteDialog.request}
        search={search}
        mediaState={chat.mediaState}
        selectedPerspective={chat.selectedPerspective}
        setSelectedPerspective={chat.setSelectedPerspective}
        onJumpToMessage={handleJumpToMessage}
        onAttachmentBookmarkingChange={handleAttachmentBookmarkingChange}
        bookmarkingEnabled={bookmarkingEnabled}
        pinnedChats={bookmarks.pinnedChats}
        bookmarkBusy={bookmarks.busy}
        isChatPinned={bookmarks.isChatPinned}
        onToggleChatPin={bookmarks.toggleChatPin}
        onSetChatsPinned={bookmarks.setChatsPinned}
      />

      <div
        className="sidebar-resize-handle"
        id="sidebarResizeHandle"
        ref={sidebarHandleRef}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        tabIndex={0}
      />

      <ChatView
        ref={chatViewRef}
        mobile={isMobile}
        hidden={isMobile && location.screen !== 'chat' && location.screen !== 'gallery'}
        viewerOpen={!!preview}
        onBack={parent}
        onOpenSelection={() => navigation.navigate({ ...location, screen: 'selected', preview: undefined })}
        onOpenViewer={openViewer}
        onNavigateToMessage={handleChatMessageJump}
        onNavigateToAttachment={handleJumpToAttachment}
        attachmentJumpTarget={attachmentJumpTarget}
        onAttachmentJumpHandled={() => clearAttachmentJumpTarget()}
        activeEntry={viewEntry}
        mediaState={chat.mediaState}
        msgProgress={navigatingChat ? 0 : chat.msgProgress}
        msgStatusText={navigatingChat ? 'Loading messages' : chat.msgStatusText}
        chatError={chat.error}
        selectedPerspective={chat.selectedPerspective}
        settings={settings}
        loading={chat.loading || navigatingChat}
        infoPanelOpen={settings.infoPanelOpen}
        onToggleInfoPanel={handleInfo}
        search={search}
        onSelectPerspective={chat.setSelectedPerspective}
        galleryOpen={galleryOpen}
        galleryDefaultTab={galleryDefaultTab}
        onGalleryTabChange={handleGalleryTabChange}
        onOpenGallery={handleOpenGallery}
        onCloseGallery={() => { if (isMobile) parent(); else { hideGallery(); navigation.navigate({ ...location, screen: 'chat', preview: undefined, messageTarget: undefined, attachmentTarget: undefined }); } }}
        selection={selection}
        attachmentBookmarkingEnabled={bookmarkingEnabled}
        bookmarks={bookmarks}
      />

      <div
        className="info-resize-handle"
        id="infoResizeHandle"
        ref={infoHandleRef}
        role="separator"
        aria-label="Resize info panel"
        aria-orientation="vertical"
        tabIndex={0}
      />

      {(isMobile || settings.infoPanelOpen) && (
        (!isMobile && galleryOpen && selection.selectedCount > 0 && chat.chatData && !navigatingChat) ? (
          <SelectionPanel
            activeEntry={viewEntry}
            chatData={chat.chatData}
            mediaState={chat.mediaState}
            selectedItems={selectedItems}
            onDeselect={selection.toggle}
            onOpenViewer={index => openViewer({ items: [...selectedItems], index, source: 'selected', selectionMode: true, selectedNavigation: true })}
            onClearSelection={selection.deselectAll}
            useDateFilenames={settings.dateAttachmentFilenames}
            filenameTemplate={settings.attachmentFilenameTemplate}
            allowLongFilenames={settings.longAttachmentFilenames}
            attachmentBookmarkingEnabled={bookmarkingEnabled}
            bookmarks={bookmarks}
          />
        ) : (
          <InfoPanel
            debuggingEnabled={settings.debuggingEnabled}
            dateNavigation={isMobile ? <DateNavigator settings={settings} onJumpToMessage={handleJumpToMessage} onBrowseToMessage={handleBrowseToMessage} chatContainerRef={chatScrollContainerRef} mobile embedded /> : undefined}
            onBack={isMobile ? parent : undefined}
            hidden={isMobile && location.screen !== 'info'}
            activeEntry={viewEntry}
            mediaState={chat.mediaState}
            selectedPerspective={chat.selectedPerspective}
            onSelectPerspective={chat.setSelectedPerspective}
            onOpenGallery={handleOpenGallery}
            header={!isMobile && !galleryOpen && selection.selectedCount > 0 && chat.chatData ? (
              <SelectionHeader
                activeEntry={chat.activeEntry}
                chatData={chat.chatData}
                mediaState={chat.mediaState}
                selectedItems={selectedItems}
                onClearSelection={selection.deselectAll}
                useDateFilenames={settings.dateAttachmentFilenames}
                filenameTemplate={settings.attachmentFilenameTemplate}
                allowLongFilenames={settings.longAttachmentFilenames}
                attachmentBookmarkingEnabled={bookmarkingEnabled}
                bookmarks={bookmarks}
              />
            ) : undefined}
          />
        )
      )}

      {isMobile && chat.chatData && !navigatingChat && (
        <SelectionPanel
          onBack={parent}
          hidden={location.screen !== 'selected'}
          activeEntry={chat.activeEntry}
          chatData={chat.chatData}
          mediaState={chat.mediaState}
          selectedItems={selectedItems}
          onDeselect={selection.toggle}
          onOpenViewer={index => openViewer({ items: [...selectedItems], index, source: 'selected', selectionMode: true, selectedNavigation: true })}
          onClearSelection={selection.deselectAll}
          useDateFilenames={settings.dateAttachmentFilenames}
          filenameTemplate={settings.attachmentFilenameTemplate}
          allowLongFilenames={settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={bookmarkingEnabled}
          bookmarks={bookmarks}
        />
      )}

      {isMobile && location.screen === 'selected' && (!chat.chatData || navigatingChat) && (
        <div className="chat-info-panel selection-panel">
          <div className="mobile-page-header">
            <ParentBackButton destination="attachments" ariaLabel="Back to attachments" onClick={parent} />
            <h3>Selected attachments</h3>
          </div>
          <p className="info-empty" role="status">Loading selected attachments...</p>
        </div>
      )}

      {deleteDialog.target && (
        <DeleteConfirmModal
          entry={deleteDialog.target}
          onConfirm={() => deleteDialog.confirm(deleteDialog.preparation.status === 'unchecked' || deleteDialog.preparation.attachmentCheckSkipped ? 'unchecked' : 'normal')}
          onDeleteAnyway={() => deleteDialog.confirm('override')}
          onDeleteJsonOnly={() => deleteDialog.confirm('json-only')}
          onRetryCalculation={deleteDialog.retry}
          onSkipCalculation={deleteDialog.skipSizes}
          onCheckAttachments={deleteDialog.checkAttachments}
          onSkipCheck={deleteDialog.skipCheck}
          onCancel={deleteDialog.cancel}
          progress={deleteDialog.progress}
          preparation={deleteDialog.preparation}
          resultNotice={deleteDialog.resultNotice}
          preparingDeletion={deleteDialog.preparing}
          deleting={deleteDialog.busy}
          verificationProgress={deleteDialog.verificationProgress}
        />
      )}
      {preview && viewerItems.length > 0 && !chat.loading && !navigatingChat && (
        <MediaViewer
          key={navigationState.revision}
          mobile={isMobile}
          navigationVisible={settings.viewerNavigation === 'auto' ? !isMobile : settings.viewerNavigation === 'show'}
          onToggleNavigation={() => setSetting('viewerNavigation', (settings.viewerNavigation === 'auto' ? !isMobile : settings.viewerNavigation === 'show') ? 'hide' : 'show')}
          items={viewerItems}
          initialIndex={Math.max(0, viewerItems.findIndex(item => getNavigationItemKey(item) === preview.currentKey))}
          mediaState={chat.mediaState}
          onClose={closeViewer}
          onCurrentItemChange={updateViewerItem}
          onJumpToMessage={handleJumpToMessage}
          onJumpToAttachment={handleJumpToAttachment}
          selection={selection}
          selectionMode={preview.source === 'chat' ? selection.selectedCount > 0 : preview.selectionMode}
          reverseNavigation={preview.reverseNavigation}
          selectedNavigation={preview.selectedNavigation}
          useDateFilename={settings.dateAttachmentFilenames}
          chatTitle={chat.chatData?.title}
          filenameTemplate={settings.attachmentFilenameTemplate}
          allowLongFilenames={settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={bookmarkingEnabled}
          isBookmarked={item => !!chat.activeEntry && bookmarks.isItemBookmarked(chat.activeEntry, item)}
          onToggleBookmark={item => chat.activeEntry ? bookmarks.toggleItemBookmark(chat.activeEntry, item) : Promise.resolve()}
          bookmarkBusy={bookmarks.busy}
        />
      )}
      <div className="app-toast-stack">
        {ENABLE_CONTEXTUAL_BACK_NAVIGATION && navigationState.returnTo && !preview && <div className="jump-return-banner">
          <button type="button" className="jump-return-action" onClick={() => navigation.returnFromJump()}>
            <ArrowLeft size={16} />Return to {navigationState.returnTo.label}
          </button>
          <button type="button" className="jump-return-dismiss" aria-label="Dismiss return action" onClick={() => navigation.dismissJumpReturn()}><X size={16} /></button>
        </div>}
        {settings.offlineSupportEnabled && (
          <ReloadPrompt canAutoReload={!archive.rootHandle && !archive.loading} />
        )}
        {deleteDialog.toast && (
          <div className="delete-toast" role="status" aria-live="polite">
            {deleteDialog.toast}
          </div>
        )}
        {!deleteDialog.toast && bookmarks.error && (
          <div className="delete-toast bookmark-error-toast" role="status">
            <span>{bookmarks.error}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={bookmarks.preparationFailed
                ? () => void bookmarks.retryPreparation().catch(() => {})
                : bookmarks.clearError}
            >
              {bookmarks.preparationFailed ? 'Retry' : 'Dismiss'}
            </button>
          </div>
        )}
      </div>
      <TrustModal settings={settings} setSetting={setSetting} />
    </div>
    </AttachmentReferencesContext.Provider>
    </ThreadDataContext.Provider>
    </ReactionFeatureContext.Provider>
  );
}
