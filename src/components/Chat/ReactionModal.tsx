import React, { useState, useMemo } from 'react';
import type { MessengerMessage } from '../../types/messenger';
import { getReactionTimestamp } from '../../services/reactions';

interface ReactionModalProps {
  reactions: NonNullable<MessengerMessage['reactions']>;
  onClose: () => void;
}

function getReactionTimeText(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function ReactionModal({ reactions, onClose }: ReactionModalProps) {
  const [activeTab, setActiveTab] = useState<string>('All');

  // Compute reaction counts and unique emojis for tabs
  const { counts, uniqueEmojis } = useMemo(() => {
    const c: Record<string, number> = {};
    const u = new Set<string>();
    reactions.forEach(r => {
      c[r.reaction] = (c[r.reaction] || 0) + 1;
      u.add(r.reaction);
    });
    return { counts: c, uniqueEmojis: Array.from(u) };
  }, [reactions]);

  // Filter reactions based on active tab
  const filteredReactions = useMemo(() => {
    if (activeTab === 'All') return reactions;
    return reactions.filter(r => r.reaction === activeTab);
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
              {emoji} {counts[emoji]}
            </button>
          ))}
        </div>

        <div className="reaction-modal-list">
          {filteredReactions.map((r, i) => {
            const reactionTs = getReactionTimestamp(r);
            const timeText = getReactionTimeText(reactionTs);
            return (
              <div key={i} className="reaction-modal-item">
                <span className="modal-emoji">{r.reaction}</span>
                <div className="modal-actor-info">
                  <span className="modal-actor">{r.actor}</span>
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
