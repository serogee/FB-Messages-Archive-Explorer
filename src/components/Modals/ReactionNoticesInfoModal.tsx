import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ReactionNoticesInfoModalProps {
  onClose: () => void;
}

export function ReactionNoticesInfoModal({ onClose }: ReactionNoticesInfoModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return (
    <div className="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="reactionNoticesInfoTitle">
      <div className="shortcuts-backdrop" onClick={onClose} />
      <div className="shortcuts-card">
        <div className="shortcuts-header">
          <h3 id="reactionNoticesInfoTitle">Reaction notices</h3>
          <button ref={closeRef} className="shortcuts-close" onClick={onClose} aria-label="Close reaction notices information">
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-body">
          <section className="shortcuts-group">
            <h4>Reaction notices</h4>
            <p className="shortcuts-note">A reaction notice is a message that reports a reaction.</p>
            <div className="shortcut-row reaction-notice-example">
              <span className="shortcut-keys"><kbd>Notice</kbd></span>
              <span>A text message, for example: “Alex reacted ❤️ to your message”.</span>
            </div>
            <div className="shortcut-row reaction-notice-example">
              <span className="shortcut-keys"><kbd>Reaction</kbd></span>
              <span>An emoji attached to a message, for example: ❤️ by Alex.</span>
            </div>
            <p className="shortcuts-note">“Hide reaction notices” hides notice-like messages in the chat and search results. It can hide typed messages that look like notices. It does not change message counts or previews.</p>
          </section>
          <section className="shortcuts-group">
            <h4>Reaction timestamp matching</h4>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>“Don&apos;t guess”</kbd></span><span>Hide estimated timestamps. Stop new checks. Keep saved matches.</span></div>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>“Guess nearby”</kbd></span><span>Match notices and reactions in the same activity block.</span></div>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>“Guess aggressively”</kbd></span><span>Also match notices and reactions in older activity blocks.</span></div>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>~</kbd></span><span>Mark a strict or nearby match. Example: ~ Jan 15, 2024, 10:30 AM.</span></div>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>~~</kbd></span><span>Mark a match in an older activity block. Example: ~~ Jan 15, 2024, 10:30 AM.</span></div>
            <p className="shortcuts-note">A recorded timestamp has no mark.</p>
          </section>
          <section className="shortcuts-group">
            <h4>Full archive consistency check</h4>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>“Full archive consistency check”</kbd></span><span>Read all chats. Check whether notices match reactions.</span></div>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>Percentage passed</kbd></span><span>Show the percentage of supported notices that match reactions.</span></div>
            <div className="shortcut-row"><span className="shortcut-keys"><kbd>“View inconsistent matches”</kbd></span><span>List chats with notices that do not match reactions.</span></div>
            <p className="shortcuts-note">The check does not check timestamp accuracy.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
