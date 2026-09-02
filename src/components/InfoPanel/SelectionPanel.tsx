import { useState, useRef, useEffect } from 'react';
import type { ResolvedAttachment, MediaState, MessengerThread } from '../../types/messenger';
import { MoreHorizontal, X, Check, Image as ImageIcon, Film, Music, FileText, Play, FolderOutput, Archive } from 'lucide-react';
import { formatInfoNumber } from '../../services/storage';
import { saveToFolder, downloadAsZip } from '../../services/saveAttachments';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';

interface SelectionPanelProps {
  chatData: MessengerThread;
  mediaState: MediaState;
  selectedAttachments: ResolvedAttachment[];
  onDeselect: (attachment: ResolvedAttachment) => void;
  onClearSelection: () => void;
}

interface SelectionHeaderProps {
  chatData: MessengerThread;
  mediaState: MediaState;
  selectedAttachments: ResolvedAttachment[];
  onClearSelection: () => void;
  onSaveStateChange?: (state: SelectionSaveState) => void;
}

interface SelectionSaveState {
  saving: boolean;
  progress: { done: number; total: number };
}

const IDLE_SAVE_STATE: SelectionSaveState = {
  saving: false,
  progress: { done: 0, total: 0 },
};

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

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setUrl(null);
      return;
    }

    const cached = isVideo
      ? videoPosterCache.get(entry)
      : imageThumbnailCache.get(entry);
    setUrl(cached);
    if (cached) return;

    let mounted = true;
    const thumbnailRequest = isVideo
      ? videoPosterCache.getOrCreate(entry)
      : imageThumbnailCache.getOrCreate(entry);
    void thumbnailRequest.then(thumbnailUrl => {
      if (mounted) setUrl(thumbnailUrl);
    });

    return () => { mounted = false; };
  }, [attachment, isVideo, mediaState]);

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
  chatData,
  mediaState,
  selectedAttachments,
  onClearSelection,
  onSaveStateChange,
}: SelectionHeaderProps) {
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
        await saveToFolder(selectedAttachments, mediaState, updateProgress);
      } else {
        await downloadAsZip(selectedAttachments, mediaState, chatData.title, updateProgress);
      }
      onClearSelection();
    } catch (error) {
      console.error('Failed to save attachments:', error);
    } finally {
      updateSaveState(false, 0, 0);
    }
  };

  const chromiumSupported = isFileSystemAccessSupported();

  return (
    <div className="selection-panel-header">
      <strong>{formatInfoNumber(selectedAttachments.length)} Selected</strong>
      <div className="selection-header-actions">
        {!saving && (
          <div className="selection-menu-wrap" ref={menuRef}>
            <button
              className="selection-menu-btn"
              onClick={() => setMenuOpen(!menuOpen)}
              title="Save options"
              aria-label="Save selected attachments"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={20} />
            </button>
            {menuOpen && (
              <div className="selection-menu-dropdown">
                {chromiumSupported && (
                  <button className="selection-menu-item" onClick={() => handleSave('folder')}>
                    <FolderOutput size={16} className="selection-menu-icon" />
                    Save to Folder
                  </button>
                )}
                <button className="selection-menu-item" onClick={() => handleSave('zip')}>
                  <Archive size={16} className="selection-menu-icon" />
                  Save as ZIP
                </button>
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
  chatData,
  mediaState,
  selectedAttachments,
  onDeselect,
  onClearSelection,
}: SelectionPanelProps) {
  const [saveState, setSaveState] = useState<SelectionSaveState>(IDLE_SAVE_STATE);

  return (
    <div className="chat-info-panel selection-panel">
      <SelectionHeader
        chatData={chatData}
        mediaState={mediaState}
        selectedAttachments={selectedAttachments}
        onClearSelection={onClearSelection}
        onSaveStateChange={setSaveState}
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
            {selectedAttachments.map(att => {
              const key = `${att.category}:${att.mediaPath}`;
              const basename = att.mediaPath.split('/').pop() || 'file';
              const cat = att.category;

              return (
                <button
                  key={key}
                  className={`gallery-thumb ${cat === 'audio' || cat === 'files' ? 'gallery-thumb-file' : ''} selected`}
                  onClick={() => onDeselect(att)}
                  title={basename}
                >
                  <div className="select-checkbox"><Check size={14} /></div>

                  {(cat === 'photos' || cat === 'gifs' || cat === 'videos') ? (
                    <SelectionVisualThumbnail
                      attachment={att}
                      mediaState={mediaState}
                      basename={basename}
                    />
                  ) : cat === 'audio' ? (
                    <>
                      <div className="gallery-thumb-icon"><Music size={24} /></div>
                      <div className="gallery-thumb-name">{basename}</div>
                    </>
                  ) : (
                    <>
                      <div className="gallery-thumb-icon"><FileText size={24} /></div>
                      <div className="gallery-thumb-name">{basename}</div>
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
