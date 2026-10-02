import { useState, useMemo } from 'react';
import type { MessengerMessage } from '../../types/messenger';
import { displayReactionEmoji, formatReactionTime } from '../../services/reactions';
import { useReactionContext } from '../../hooks/useReactionFeature';

interface ReactionModalProps {
  reactions: NonNullable<MessengerMessage['reactions']>;
  onClose: () => void;
  messageIndex: number;
}

export function ReactionModal({ reactions, onClose, messageIndex }: ReactionModalProps) {
  const feature = useReactionContext();
  const [activeTab, setActiveTab] = useState<string>('All');

  const { counts, uniqueEmojis } = useMemo(() => {
    const c: Record<string, number> = {};
    const u = new Set<string>();
    reactions.forEach(r => {
      c[r.reaction] = (c[r.reaction] || 0) + 1;
      u.add(r.reaction);
    });
    return { counts: c, uniqueEmojis: Array.from(u) };
  }, [reactions]);

  const filteredReactions = useMemo(() => {
    return reactions.map((reaction, index) => ({ reaction, index })).filter(({ reaction }) => activeTab === 'All' || reaction.reaction === activeTab);
  }, [reactions, activeTab]);

  return (
    <div className="reaction-modal-overlay" onClick={onClose}>
      <div className="reaction-modal-content" onClick={e => e.stopPropagation()}>
        <div className="reaction-modal-header">
          <h3>Message Reactions</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        
        <div className="reaction-modal-tabs">
          <button 
            className={`reaction-tab ${activeTab === 'All' ? 'active' : ''}`}
            onClick={() => setActiveTab('All')}
          >
            All {reactions.length}
          </button>
          {uniqueEmojis.map(emoji => (
            <button 
              key={emoji}
              className={`reaction-tab ${activeTab === emoji ? 'active' : ''}`}
              onClick={() => setActiveTab(emoji)}
            >
              {displayReactionEmoji(emoji)} {counts[emoji]}
            </button>
          ))}
        </div>

        <div className="reaction-modal-list">
          {filteredReactions.map(({ reaction: r, index: i }) => {
            const time = feature.time(r, messageIndex, i);
            const timeText = formatReactionTime(time.timestamp, time.method);
            return (
              <div key={i} className="reaction-modal-item">
                <span className="modal-emoji">{displayReactionEmoji(r.reaction)}</span>
                <div className="modal-actor-info">
                  <span className={`modal-actor${timeText ? ' has-time-info' : ''}`} title={timeText || undefined}>{r.actor}</span>
                  {timeText && <span className="modal-time">{timeText}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
