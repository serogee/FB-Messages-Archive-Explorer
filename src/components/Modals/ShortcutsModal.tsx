import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ShortcutsModalProps {
  onClose: () => void;
}

const SHORTCUT_GROUPS = [
  {
    title: 'Attachment viewer',
    shortcuts: [
      { keys: ['\u2190', '\u2192'], description: 'Move between attachments' },
      { keys: ['Space'], description: 'Play or pause video and audio' },
      { keys: [','], description: 'Rewind video or audio by 5 seconds' },
      { keys: ['.'], description: 'Advance video or audio by 5 seconds' },
      { keys: ['\\'], description: 'Bookmark or unbookmark the current attachment when bookmarking is enabled' },
      { keys: ['Esc'], description: 'Close the attachment viewer' },
    ],
  },
  {
    title: 'Attachment selection',
    shortcuts: [
      { keys: ['Enter'], description: 'Select or deselect the current attachment while selection is active' },
    ],
  },
  {
    title: 'Attachment gallery',
    shortcuts: [
      { keys: ['Page Up'], description: 'Go to the previous attachment tab' },
      { keys: ['Page Down'], description: 'Go to the next attachment tab' },
    ],
  },
  {
    title: 'Gallery filters',
    shortcuts: [
      { keys: ['Enter'], description: 'Focus the sender search, apply the highlighted result, or remove a focused sender filter' },
      { keys: ['Backspace'], description: 'Remove a focused sender filter' },
      { keys: ['+'], description: 'Include the sender entered in the search' },
      { keys: ['-'], description: 'Exclude the sender entered in the search' },
      { keys: ['.'], description: 'Show only senders with items in the current gallery tab; plus or minus can follow the dot' },
      { keys: ['\u2191', '\u2193'], description: 'Move between sender search results' },
      { keys: ['\u2190', '\u2192'], description: 'Switch sender actions or move between active sender filters' },
      { keys: ['Esc'], description: 'Close and unfocus the sender search' },
    ],
  },
  {
    title: 'Date navigator',
    shortcuts: [
      { keys: ['\u2190', 'Page Up'], description: 'Go to the previous date period while hovering over the date header' },
      { keys: ['\u2192', 'Page Down'], description: 'Go to the next date period while hovering over the date header' },
    ],
  },
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return (
    <div className="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcutsTitle">
      <div className="shortcuts-backdrop" onClick={onClose} />
      <div className="shortcuts-card">
        <div className="shortcuts-header">
          <h3 id="shortcutsTitle">Keyboard shortcuts</h3>
          <button ref={closeRef} className="shortcuts-close" onClick={onClose} aria-label="Close keyboard shortcuts">
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map(group => (
            <section className="shortcuts-group" key={group.title}>
              <h4>{group.title}</h4>
              {group.shortcuts.map(shortcut => (
                <div className="shortcut-row" key={`${group.title}:${shortcut.description}`}>
                  <span className="shortcut-keys">
                    {shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}
                  </span>
                  <span>{shortcut.description}</span>
                </div>
              ))}
            </section>
          ))}
          <p className="shortcuts-note">
            Attachment arrow direction follows the current view: the gallery moves left toward newer items,
            while the chat viewer uses the opposite order.
          </p>
        </div>
      </div>
    </div>
  );
}
