import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface FilenamePlaceholdersModalProps {
  onClose: () => void;
}

const PLACEHOLDERS = [
  { keys: ['{chat}', '{sender}'], description: 'Use normalized names with single spaces.' },
  { keys: ['{_chat}', '{_sender}'], description: 'Replace separators in names with underscores.' },
  { keys: ['{-chat}', '{-sender}'], description: 'Replace separators in names with dashes.' },
  { keys: ['{date}'], description: 'Message date as YYYY-MM-DD.' },
  { keys: ['{time}'], description: 'Message time as HH-mm-ss.' },
  { keys: ['{ms}'], description: 'Message timestamp milliseconds.' },
  { keys: ['{original}'], description: 'Normalized original filename without its extension.' },
];

export function FilenamePlaceholdersModal({ onClose }: FilenamePlaceholdersModalProps) {
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
    <div className="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="filenamePlaceholdersTitle">
      <div className="shortcuts-backdrop" onClick={onClose} />
      <div className="shortcuts-card">
        <div className="shortcuts-header">
          <h3 id="filenamePlaceholdersTitle">Filename placeholders</h3>
          <button ref={closeRef} className="shortcuts-close" onClick={onClose} aria-label="Close filename placeholders">
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-body">
          <section className="shortcuts-group">
            <h4>Available placeholders</h4>
            {PLACEHOLDERS.map(item => (
              <div className="shortcut-row" key={item.keys.join(':')}>
                <span className="shortcut-keys">
                  {item.keys.map(key => <kbd key={key}>{key}</kbd>)}
                </span>
                <span>{item.description}</span>
              </div>
            ))}
          </section>
          <p className="shortcuts-note">
            The final .{'{ext}'} block is always included. Output is normalized and limited to letters,
            numbers, spaces, dashes, and underscores; the extension separator is the only period.
          </p>
        </div>
      </div>
    </div>
  );
}
