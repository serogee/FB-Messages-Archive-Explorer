import { useState, useRef, useEffect } from 'react';
import type { ResolvedAttachment, ResolvedLink, SelectableItem, MediaState, MessengerThread, ChatListEntry } from '../../types/messenger';
import { MoreHorizontal, X, Check, Image as ImageIcon, Film, Music, FileText, Play, FolderOutput, Archive, Bookmark, BookmarkX, Link as LinkIcon, UserRound } from 'lucide-react';
import { formatFileSize, formatInfoNumber } from '../../services/storage';
import { saveToFolder, downloadAsZip } from '../../services/saveAttachments';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';
import { blobCache } from '../../services/blobCache';
import { getAudioMetadata, type AudioMetadata } from '../../services/audioMetadata';
import type { Settings } from '../../hooks/useSettings';
import type { AttachmentBookmarksController } from '../../hooks/useAttachmentBookmarks';
import { MediaFileSize } from '../MediaFileSize';

interface SelectionPanelProps {
  activeEntry: ChatListEntry | null;
  chatData: MessengerThread;
  mediaState: MediaState;
  selectedItems: SelectableItem[];
  onDeselect: (item: SelectableItem) => void;
  onClearSelection: () => void;
  useDateFilenames: Settings['dateAttachmentFilenames'];
  filenameTemplate: Settings['attachmentFilenameTemplate'];
  allowLongFilenames: Settings['longAttachmentFilenames'];
  attachmentBookmarkingEnabled: boolean;
  bookmarks: AttachmentBookmarksController;
}

interface SelectionHeaderProps {
  activeEntry: ChatListEntry | null;
  chatData: MessengerThread;
  mediaState: MediaState;
  selectedItems: SelectableItem[];
  onClearSelection: () => void;
  onSaveStateChange?: (state: SelectionSaveState) => void;
  useDateFilenames: Settings['dateAttachmentFilenames'];
  filenameTemplate: Settings['attachmentFilenameTemplate'];
  allowLongFilenames: Settings['longAttachmentFilenames'];
  attachmentBookmarkingEnabled: boolean;
  bookmarks: AttachmentBookmarksController;
}

interface SelectionSaveState {
  saving: boolean;
  progress: { done: number; total: number };
}

const IDLE_SAVE_STATE: SelectionSaveState = {
  saving: false,
  progress: { done: 0, total: 0 },
};

function isAttachment(item: SelectableItem): item is ResolvedAttachment {
  return item.category !== 'links';
}

function getLinkHostname(link: ResolvedLink): string {
  try {
    return new URL(link.url).hostname.replace(/^www\./i, '') || link.url;
  } catch {
    return link.url;
  }
}

function formatAudioDuration(seconds: number | null): string {
  if (seconds === null) return 'Unknown duration';
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function SelectedAudioMetadata({ attachment, mediaState }: { attachment: ResolvedAttachment; mediaState: MediaState }) {
  const [metadata, setMetadata] = useState<AudioMetadata | null>(null);

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setMetadata({ duration: null, size: null });
      return;
    }

    let mounted = true;
    setMetadata(null);
    void getAudioMetadata(entry).then(result => {
      if (mounted) setMetadata(result);
    });
    return () => { mounted = false; };
  }, [attachment, mediaState]);

  return (
    <div className="gallery-file-meta gallery-author-size-meta gallery-even-metadata-spacing">
      <span className="gallery-audio-details">
        {metadata
          ? `${formatAudioDuration(metadata.duration)} · ${metadata.size === null ? 'Unknown size' : formatFileSize(metadata.size)}`
          : 'Loading…'}
      </span>
      <span className="gallery-link-sender" title={`Sent by ${attachment.sender}`}>
        <UserRound size={12} />
        <span>{attachment.sender}</span>
      </span>
    </div>
  );
}

function SelectionVisualThumbnail({
  attachment,
  mediaState,
  basename,
}: {
  attachment: ResolvedAttachment;
  mediaState: MediaState;
  basename: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const isVideo = attachment.category === 'videos';
  const isSticker = attachment.category === 'stickers';

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setUrl(null);
      return;
    }

    const cached = isVideo
      ? videoPosterCache.get(entry)
      : isSticker
        ? blobCache.get(entry) || entry.url || null
        : imageThumbnailCache.get(entry);
    setUrl(cached);
    if (cached) return;

    let mounted = true;
    const thumbnailRequest = isVideo
      ? videoPosterCache.getOrCreate(entry)
      : isSticker
        ? blobCache.getOrCreate(entry)
        : imageThumbnailCache.getOrCreate(entry);
    void thumbnailRequest.then(thumbnailUrl => {
      if (mounted) setUrl(thumbnailUrl);
    });

    return () => { mounted = false; };
  }, [attachment, isSticker, isVideo, mediaState]);

  return (
    <>
      {url ? (
        <img src={url} alt={basename} className="gallery-thumb-img" />
      ) : (
        <div className="gallery-thumb-placeholder">
          {isVideo ? <Film size={24} /> : <ImageIcon size={24} />}
        </div>
      )}
      {isVideo && <div className="gallery-thumb-play"><Play fill="currentColor" size={24} /></div>}
    </>
  );
}

export function SelectionHeader({
  activeEntry,
  chatData,
  mediaState,
  selectedItems,
  onClearSelection,
  onSaveStateChange,
  useDateFilenames,
  filenameTemplate,
  allowLongFilenames,
  attachmentBookmarkingEnabled,
  bookmarks,
}: SelectionHeaderProps) {
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedAttachments = selectedItems.filter(isAttachment);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const updateSaveState = (nextSaving: boolean, done: number, total: number) => {
    setSaving(nextSaving);
    onSaveStateChange?.({ saving: nextSaving, progress: { done, total } });
  };

  const handleSave = async (mode: 'folder' | 'zip') => {
    setMenuOpen(false);
    updateSaveState(true, 0, selectedAttachments.length);

    try {
      const updateProgress = (done: number, total: number) => updateSaveState(true, done, total);
      if (mode === 'folder') {
        await saveToFolder(
          selectedAttachments,
          mediaState,
          updateProgress,
          useDateFilenames,
          chatData.title,
          filenameTemplate,
          allowLongFilenames
        );
      } else {
        await downloadAsZip(
          selectedAttachments,
          mediaState,
          chatData.title,
          updateProgress,
          useDateFilenames,
          filenameTemplate,
          allowLongFilenames
        );
      }
    } catch (error) {
      console.error('Failed to save attachments:', error);
    } finally {
      updateSaveState(false, 0, 0);
    }
  };

  const allBookmarked = !!activeEntry
    && selectedItems.length > 0
    && selectedItems.every(item => bookmarks.isBookmarked(activeEntry, item));

  const handleBookmarks = async () => {
    if (!activeEntry || selectedItems.length === 0) return;
    setMenuOpen(false);
    updateSaveState(true, 0, selectedItems.length);
    try {
      await bookmarks.setMany(activeEntry, selectedItems, !allBookmarked);
      updateSaveState(true, selectedItems.length, selectedItems.length);
    } catch (error) {
      console.error('Failed to update attachment bookmarks:', error);
    } finally {
      updateSaveState(false, 0, 0);
    }
  };

  const chromiumSupported = isFileSystemAccessSupported();

  return (
    <div className="selection-panel-header">
      <strong>{formatInfoNumber(selectedItems.length)} Selected</strong>
      <div className="selection-header-actions">
        {!saving && (
          <div className="selection-menu-wrap" ref={menuRef}>
            <button
              className="selection-menu-btn"
              onClick={() => setMenuOpen(!menuOpen)}
              title="Selected item actions"
              aria-label="Actions for selected items"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={20} />
            </button>
            {menuOpen && (
              <div className="selection-menu-dropdown">
                {chromiumSupported && (
                  <button className="selection-menu-item" onClick={() => handleSave('folder')} disabled={selectedAttachments.length === 0}>
                    <FolderOutput size={16} className="selection-menu-icon" />
                    Save to Folder
                  </button>
                )}
                <button className="selection-menu-item" onClick={() => handleSave('zip')} disabled={selectedAttachments.length === 0}>
                  <Archive size={16} className="selection-menu-icon" />
                  Save as ZIP
                </button>
                {attachmentBookmarkingEnabled && activeEntry && (
                  <>
                    <div className="selection-menu-divider" />
                    <button className="selection-menu-item" onClick={() => void handleBookmarks()}>
                      {allBookmarked
                        ? <BookmarkX size={16} className="selection-menu-icon" />
                        : <Bookmark size={16} className="selection-menu-icon" />}
                      {allBookmarked ? 'Remove bookmarks' : 'Bookmark selected'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {!saving && (
          <button className="selection-clear-btn" onClick={onClearSelection} title="Clear selection">
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export function SelectionPanel({
  activeEntry,
  chatData,
  mediaState,
  selectedItems,
  onDeselect,
  onClearSelection,
  useDateFilenames,
  filenameTemplate,
  allowLongFilenames,
  attachmentBookmarkingEnabled,
  bookmarks,
}: SelectionPanelProps) {
  const [saveState, setSaveState] = useState<SelectionSaveState>(IDLE_SAVE_STATE);

  return (
    <div className="chat-info-panel selection-panel">
      <SelectionHeader
        activeEntry={activeEntry}
        chatData={chatData}
        mediaState={mediaState}
        selectedItems={selectedItems}
        onClearSelection={onClearSelection}
        onSaveStateChange={setSaveState}
        useDateFilenames={useDateFilenames}
        filenameTemplate={filenameTemplate}
        allowLongFilenames={allowLongFilenames}
        attachmentBookmarkingEnabled={attachmentBookmarkingEnabled}
        bookmarks={bookmarks}
      />

      {saveState.saving ? (
        <div className="selection-progress-section">
          <div className="selection-progress-wrap">
            <div className="selection-progress-text">
              Processing… {saveState.progress.done} / {saveState.progress.total}
            </div>
            <div className="selection-progress-track">
              <div
                className="selection-progress-fill"
                style={{ width: `${saveState.progress.total > 0 ? (saveState.progress.done / saveState.progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="selection-panel-content">
          <div className="selection-grid">
            {selectedItems.map(item => {
              if (item.category === 'links') {
                const hostname = getLinkHostname(item);
                return (
                  <button
                    key={`links:${item.messageIndex}:${item.url}`}
                    className="gallery-thumb gallery-link-card selection-link-card selected"
                    onClick={() => onDeselect(item)}
                    title={item.url}
                  >
                    <div className="select-checkbox"><Check size={14} /></div>
                    <LinkIcon size={24} className="gallery-link-icon" />
                    <strong className="gallery-link-host">{hostname}</strong>
                    <span className="gallery-link-url">{item.label || item.url}</span>
                    <span className="gallery-link-meta">
                      <span className="gallery-link-sender" title={`Sent by ${item.sender}`}>
                        <UserRound size={12} />
                        <span>{item.sender}</span>
                      </span>
                    </span>
                    {attachmentBookmarkingEnabled && activeEntry && bookmarks.isBookmarked(activeEntry, item) && (
                      <span className="gallery-bookmark-indicator" title="Bookmarked" aria-label="Bookmarked link">
                        <Bookmark size={15} fill="currentColor" />
                      </span>
                    )}
                  </button>
                );
              }

              const att = item;
              const key = `${att.category}:${att.mediaPath}`;
              const basename = att.mediaPath.split('/').pop() || 'file';
              const cat = att.category;

              return (
                <button
                  key={key}
                  className={`gallery-thumb ${cat === 'audio' || cat === 'files' ? 'gallery-thumb-file' : ''} ${cat === 'stickers' ? 'gallery-thumb-sticker' : ''} selected`}
                  onClick={() => onDeselect(att)}
                  title={basename}
                >
                  <div className="select-checkbox"><Check size={14} /></div>

                  {attachmentBookmarkingEnabled && activeEntry && bookmarks.isBookmarked(activeEntry, att) && (
                    <span className="gallery-bookmark-indicator" title="Bookmarked" aria-label="Bookmarked attachment">
                      <Bookmark size={15} fill="currentColor" />
                    </span>
                  )}

                  {(cat === 'photos' || cat === 'gifs' || cat === 'videos' || cat === 'stickers') ? (
                    <SelectionVisualThumbnail
                      attachment={att}
                      mediaState={mediaState}
                      basename={basename}
                    />
                  ) : cat === 'audio' ? (
                    <>
                      <div className="gallery-thumb-icon"><Music size={24} /></div>
                      <div className="gallery-thumb-name">{basename}</div>
                      <SelectedAudioMetadata attachment={att} mediaState={mediaState} />
                    </>
                  ) : (
                    <>
                      <div className="gallery-thumb-icon"><FileText size={24} /></div>
                      <div className="gallery-thumb-name">{basename}</div>
                      <div className="gallery-file-meta gallery-author-size-meta gallery-even-metadata-spacing">
                        <MediaFileSize
                          entry={att.mediaEntry || findMediaFile(mediaState, att.mediaPath)}
                          className="gallery-thumb-file-size"
                        />
                        <span className="gallery-link-sender" title={`Sent by ${att.sender}`}>
                          <UserRound size={12} />
                          <span>{att.sender}</span>
                        </span>
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
