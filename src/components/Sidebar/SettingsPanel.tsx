import { useState, useRef, useEffect } from 'react';
import type { Settings } from '../../hooks/useSettings';
import type { MessengerThread } from '../../types/messenger';
import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import { getParticipantNames } from '../../services/parser';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import { EnableDeletionModal } from '../Modals/EnableDeletionModal';
import { ShortcutsModal } from '../Modals/ShortcutsModal';
import { FilenamePlaceholdersModal } from '../Modals/FilenamePlaceholdersModal';
import { Braces, ChevronUp, ChevronDown, ChevronRight, Keyboard } from 'lucide-react';
import { DEFAULT_ATTACHMENT_FILENAME_TEMPLATE } from '../../services/saveAttachments';

interface SettingsPanelProps {
  settings: Settings;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  chatData: MessengerThread | null;
  selectedPerspective: string;
  setSelectedPerspective: (name: string) => void;
  onOpenFolder: () => Promise<void>;
  rootHandle: ReadableDirectoryHandle | null;
}

function ToggleRow({ id, label, checked, onChange, disabled }: {
  id: string; label: string; checked: boolean; onChange: (val: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="settings-row">
      <label htmlFor={id}>{label}</label>
      <label className="switch">
        <input
          type="checkbox"
          id={id}
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span className="slider" />
      </label>
    </div>
  );
}

function PerspectiveDropdown({
  participants,
  selectedPerspective,
  setSelectedPerspective,
}: {
  participants: string[];
  selectedPerspective: string;
  setSelectedPerspective: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = filter.trim()
    ? participants.filter(p => p.toLowerCase().includes(filter.toLowerCase()))
    : participants;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = (name: string) => {
    setSelectedPerspective(name);
    setOpen(false);
    setFilter('');
  };

  return (
    <div className="perspective-dropdown-wrap" ref={wrapRef}>
      <button
        className="perspective-dropdown-btn"
        onClick={() => { setOpen(v => !v); setTimeout(() => inputRef.current?.focus(), 30); }}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="perspective-dropdown-value">
          {selectedPerspective || 'Select...'}
        </span>
        <span className="perspective-dropdown-arrow">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      {open && (
        <div className="perspective-dropdown-list" role="listbox">
          <input
            ref={inputRef}
            className="perspective-dropdown-search"
            type="text"
            placeholder="Search..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setOpen(false); setFilter(''); }
              if (e.key === 'Enter' && filtered.length === 1) select(filtered[0]);
            }}
          />
          {filtered.length === 0 && (
            <div className="perspective-dropdown-empty">No match</div>
          )}
          {filtered.map(name => (
            <button
              key={name}
              className={`perspective-dropdown-item${name === selectedPerspective ? ' active' : ''}`}
              onClick={() => select(name)}
              role="option"
              aria-selected={name === selectedPerspective}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({
  settings, setSetting,
  chatData, selectedPerspective, setSelectedPerspective,
  onOpenFolder, rootHandle,
}: SettingsPanelProps) {
  const participants = getParticipantNames(chatData);
  const fsSupported = isFileSystemAccessSupported();
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showFilenamePlaceholdersModal, setShowFilenamePlaceholdersModal] = useState(false);

  const handleDeletionToggle = (val: boolean) => {
    if (val) {
      // Always require explicit confirmation before enabling
      setShowEnableModal(true);
    } else {
      setSetting('deletionEnabled', false as Settings['deletionEnabled']);
    }
  };

  return (
    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <div className="settings-section">
        <strong>Messages Folder</strong>
        {rootHandle ? (
          <div className="folder-display-container">
            <div className="folder-path-display" title={rootHandle.name}>
              <span className="folder-path-prefix">…/</span>
              <span className="folder-path-name">{rootHandle.name}</span>
            </div>
            <button className="btn btn-secondary" onClick={onOpenFolder} style={{ flexShrink: 0, padding: '4px 8px', fontSize: '13px' }}>
              Change
            </button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onOpenFolder} style={{ marginTop: 4 }}>
            Select messages folder
          </button>
        )}
      </div>

      {chatData && participants.length > 0 && (
        <div className="settings-section">
          <strong>View perspective</strong>
          <PerspectiveDropdown
            participants={participants}
            selectedPerspective={selectedPerspective}
            setSelectedPerspective={setSelectedPerspective}
          />
          <span id="tips" className="footer">Messages from the selected participant appear on the right side as "me".</span>
        </div>
      )}

      <div className="settings-section">
        <strong>Customization</strong>
        <ToggleRow id="darkModeToggle" label="Dark mode" checked={settings.darkMode} onChange={v => setSetting('darkMode', v as Settings['darkMode'])} />
        <ToggleRow id="showMyNameToggle" label="Show my name" checked={settings.showMyName} onChange={v => setSetting('showMyName', v as Settings['showMyName'])} />
        <ToggleRow id="showTheirNameToggle" label="Show their names" checked={settings.showTheirName} onChange={v => setSetting('showTheirName', v as Settings['showTheirName'])} />
        <ToggleRow id="showReactionsToggle" label="Show reactions" checked={settings.showReactions} onChange={v => setSetting('showReactions', v as Settings['showReactions'])} />
        <ToggleRow id="autoCollapseDateNavToggle" label="Auto-collapse date navigator" checked={settings.autoCollapseDateNav} onChange={v => setSetting('autoCollapseDateNav', v as Settings['autoCollapseDateNav'])} />
      </div>

      <div className="settings-section">
        <strong>Downloads</strong>
        <ToggleRow
          id="dateAttachmentFilenamesToggle"
          label="Name attachments by message date and time"
          checked={settings.dateAttachmentFilenames}
          onChange={v => setSetting('dateAttachmentFilenames', v as Settings['dateAttachmentFilenames'])}
        />
        {settings.dateAttachmentFilenames && (
          <>
            <label className="filename-template-label" htmlFor="attachmentFilenameTemplate">Filename template</label>
            <div className="filename-template-row">
              <input
                id="attachmentFilenameTemplate"
                className="filename-template-input"
                type="text"
                maxLength={200}
                value={settings.attachmentFilenameTemplate}
                placeholder={DEFAULT_ATTACHMENT_FILENAME_TEMPLATE}
                onChange={event => setSetting(
                  'attachmentFilenameTemplate',
                  event.target.value
                    .replace(/\.?\{ext\}/g, '')
                    .replace(/[^\p{L}\p{N}\s{}_-]/gu, '') as Settings['attachmentFilenameTemplate']
                )}
                spellCheck={false}
              />
              <span className="filename-template-extension">.{'{ext}'}</span>
              <button
                type="button"
                className="btn btn-secondary filename-template-reset"
                onClick={() => setSetting('attachmentFilenameTemplate', DEFAULT_ATTACHMENT_FILENAME_TEMPLATE as Settings['attachmentFilenameTemplate'])}
                disabled={settings.attachmentFilenameTemplate === DEFAULT_ATTACHMENT_FILENAME_TEMPLATE}
              >
                Reset
              </button>
            </div>
            <button className="settings-shortcuts-btn filename-placeholders-btn" onClick={() => setShowFilenamePlaceholdersModal(true)}>
              <Braces size={17} />
              <span>Filename placeholders</span>
              <ChevronRight size={16} />
            </button>
            <ToggleRow
              id="longAttachmentFilenamesToggle"
              label="Enable long filenames"
              checked={settings.longAttachmentFilenames}
              onChange={v => setSetting('longAttachmentFilenames', v as Settings['longAttachmentFilenames'])}
            />
            <p className="browser-notice">
              Names are normalized and stripped of unsupported symbols. The maximum is {settings.longAttachmentFilenames ? '180' : '100'} characters including the extension.
            </p>
          </>
        )}
      </div>

      <div className="settings-section">
        <strong>Help</strong>
        <button className="settings-shortcuts-btn" onClick={() => setShowShortcutsModal(true)}>
          <Keyboard size={17} />
          <span>Keyboard shortcuts</span>
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="settings-section">
        <strong>Chat Deletion</strong>
        {!fsSupported ? (
          <>
            <ToggleRow id="deletionEnabledToggle" label="Enable chat deletion" checked={false} onChange={() => {}} disabled={true} />
            <p className="browser-notice">Only available in Chromium-based browsers (Chrome, Edge, Brave).</p>
          </>
        ) : (
          <>
            <ToggleRow id="deletionEnabledToggle" label="Enable chat deletion" checked={settings.deletionEnabled} onChange={handleDeletionToggle} />
            <p className="deletion-info">
              When enabled, a <em>Delete chat</em> option appears on each conversation.
              This removes the chat folder — including all messages, photos, videos, and audio —
              permanently from your device storage. <strong>Once deleted, the files cannot be recovered.</strong>
              {!rootHandle && settings.deletionEnabled && ' Write access will be requested when you open a folder.'}
            </p>
          </>
        )}
      </div>

      {showEnableModal && (
        <EnableDeletionModal
          onConfirm={() => {
            setSetting('deletionEnabled', true as Settings['deletionEnabled']);
            setShowEnableModal(false);
          }}
          onCancel={() => setShowEnableModal(false)}
        />
      )}

      {showShortcutsModal && (
        <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />
      )}

      {showFilenamePlaceholdersModal && (
        <FilenamePlaceholdersModal onClose={() => setShowFilenamePlaceholdersModal(false)} />
      )}

      <div className="settings-section download-info">
        <strong>How to get your Facebook data</strong>
        <a href="https://www.facebook.com/dyi" target="_blank" rel="noreferrer">
          Facebook Download Your Information
        </a>
        <a href="https://www.messenger.com/dyi" target="_blank" rel="noreferrer">
          Messenger Download Your Information
        </a>
        <p className="footer">
          Select <strong style={{fontSize: '0.85em'}}>JSON</strong> format and download the <em>Messages</em> category.
          Extract the zip and open the <code>messages</code> folder here.
        </p>
      </div>
    </div>
  );
}
