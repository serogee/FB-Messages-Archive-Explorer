import { useState, useRef, useEffect } from 'react';
import type { ResolvedAttachment, MediaState, MessengerThread } from '../../types/messenger';
import { MoreHorizontal, X, Check, Image as ImageIcon, Film, Music, FileText, Play, FolderOutput, Archive } from 'lucide-react';
import { formatInfoNumber } from '../../services/storage';
import { saveToFolder, downloadAsZip } from '../../services/saveAttachments';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import { findMediaFile } from '../../services/media';
import { blobCache } from '../../services/blobCache';

interface SelectionPanelProps {
  chatData: MessengerThread;
  mediaState: MediaState;
  selectedAttachments: ResolvedAttachment[];
  onDeselect: (attachment: ResolvedAttachment) => void;
  onClearSelection: () => void;
}

export function SelectionPanel({
  chatData,
  mediaState,
  selectedAttachments,
  onDeselect,
  onClearSelection,
}: SelectionPanelProps) {
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleSave = async (mode: 'folder' | 'zip') => {
    setMenuOpen(false);
    setSaving(true);
    setProgress({ done: 0, total: selectedAttachments.length });
    
    try {
      if (mode === 'folder') {
        await saveToFolder(selectedAttachments, mediaState, (done, total) => setProgress({ done, total }));
      } else {
        await downloadAsZip(selectedAttachments, mediaState, chatData.title, (done, total) => setProgress({ done, total }));
      }
      onClearSelection();
    } catch (e) {
      console.error('Failed to save attachments:', e);
    } finally {
      setSaving(false);
    }
  };

  const chromiumSupported = isFileSystemAccessSupported();

  return (
    <div className="chat-info-panel selection-panel">
      <div className="selection-panel-header">
        <strong>{formatInfoNumber(selectedAttachments.length)} Selected</strong>
        <div className="selection-header-actions">
          {!saving && (
            <div className="selection-menu-wrap" ref={menuRef}>
              <button
                className="selection-menu-btn"
                onClick={() => setMenuOpen(!menuOpen)}
                title="Save options"
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

      {saving ? (
        <div className="selection-progress-section">
          <div className="selection-progress-wrap">
            <div className="selection-progress-text">
              Processing… {progress.done} / {progress.total}
            </div>
            <div className="selection-progress-track">
              <div 
                className="selection-progress-fill" 
                style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
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
              const isVisual = att.category === 'photos' || att.category === 'gifs' || att.category === 'videos';
              const cat = att.category;
              
              let url: string | undefined;
              if (isVisual) {
                const entry = att.mediaEntry || findMediaFile(mediaState, att.mediaPath);
                if (entry) {
                  const cached = blobCache.get(entry);
                  if (cached) url = cached;
                  else if (entry.url) url = entry.url;
                }
              }

              return (
                <button
                  key={key}
                  className={`gallery-thumb ${cat === 'audio' || cat === 'files' ? 'gallery-thumb-file' : ''} selected`}
                  onClick={() => onDeselect(att)}
                  title={basename}
                >
                  <div className="select-checkbox"><Check size={14} /></div>
                  
                  {(cat === 'photos' || cat === 'gifs') ? (
                    url ? (
                      <img src={url} alt={basename} className="gallery-thumb-img" />
                    ) : (
                      <div className="gallery-thumb-placeholder"><ImageIcon size={24} /></div>
                    )
                  ) : cat === 'videos' ? (
                    url ? (
                      <>
                        <video src={url} className="gallery-thumb-img" preload="metadata" muted />
                        <div className="gallery-thumb-play"><Play fill="currentColor" size={24} /></div>
                      </>
                    ) : (
                      <div className="gallery-thumb-placeholder"><Film size={24} /></div>
                    )
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
