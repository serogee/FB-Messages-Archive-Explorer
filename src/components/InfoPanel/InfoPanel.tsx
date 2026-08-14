import { useMemo } from 'react';
import type { MessengerThread, MessengerMessage, MediaState, ChatListEntry } from '../../types/messenger';
import { formatInfoNumber, formatInfoDate } from '../../services/storage';
import { getMessageTimestamp } from '../../services/parser';
import { getMessageAttachmentReferences } from '../../services/media';
import { isReactionNoticeMessage } from '../../services/reactions';

interface InfoPanelProps {
  chatData: MessengerThread | null;
  activeEntry: ChatListEntry | null;
  mediaState: MediaState;
  selectedPerspective: string;
  onSelectPerspective: (name: string) => void;
  onOpenGallery?: (tab?: string) => void;
}

interface MemberStat {
  name: string;
  count: number;
  percent: number;
}

function computeStats(messages: MessengerMessage[], _mediaState: MediaState) {
  let minTs: number | null = null;
  let maxTs: number | null = null;
  let visibleCount = 0;

  const memberCounts: Record<string, number> = {};
  const seenAttachments = new Set<string>();
  let photos = 0, videos = 0, audio = 0, gifs = 0, files = 0, totalReported = 0;

  for (const msg of messages) {
    if (isReactionNoticeMessage(msg)) continue;
    visibleCount++;

    const ts = getMessageTimestamp(msg);
    if (ts !== null) {
      if (minTs === null || ts < minTs) minTs = ts;
      if (maxTs === null || ts > maxTs) maxTs = ts;
    }

    const sender = msg.senderName || msg.sender_name || 'Unknown';
    memberCounts[sender] = (memberCounts[sender] || 0) + 1;

    const refs = getMessageAttachmentReferences(msg);
    for (const { path, category } of refs) {
      totalReported++;
      const key = `${category}:${path.toLowerCase()}`;
      if (!seenAttachments.has(key)) {
        seenAttachments.add(key);
        if (category === 'photos') photos++;
        else if (category === 'videos') videos++;
        else if (category === 'audio') audio++;
        else if (category === 'gifs') gifs++;
        else if (category === 'files') files++;
      }
    }
  }

  const memberStats: MemberStat[] = Object.entries(memberCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({
      name,
      count,
      percent: visibleCount > 0 ? Math.round((count / visibleCount) * 100) : 0,
    }));

  const foundTotal = photos + videos + audio + gifs + files;
  const mediaFound = _mediaState.pathIndex.size;

  return {
    visibleCount, minTs, maxTs, memberStats, memberCounts,
    attachments: { photos, videos, audio, gifs, files, foundTotal, reported: totalReported, mediaFound },
  };
}

export function InfoPanel({ chatData, activeEntry, mediaState, selectedPerspective, onSelectPerspective, onOpenGallery }: InfoPanelProps) {
  const stats = useMemo(() => {
    if (!chatData) return null;
    return computeStats(chatData.messages, mediaState);
  }, [chatData, mediaState]);

  return (
    <div className="chat-info-panel" id="chatInfoPanel" aria-hidden={!chatData ? 'true' : 'false'}>
      <div className="info-panel-header">
        <strong>{chatData?.title || activeEntry?.title || 'Chat Info'}</strong>
      </div>
      <div className="info-panel-content">
        {!chatData || !stats ? (
          activeEntry ? (
            <p className="info-empty">Loading chat details...</p>
          ) : (
            <p className="info-empty">Open a chat to see details.</p>
          )
        ) : (
          <>
            {/* Section 1: Chat Info */}
            <div className="info-section">
              <strong>Chat Info</strong>
              <div className="info-stats">
                <div className="info-metric">
                  <span>Messages</span>
                  <strong>{formatInfoNumber(stats.visibleCount)}</strong>
                </div>
                <div className="info-metric">
                  <span>Members</span>
                  <strong>{formatInfoNumber(chatData.participants.length)}</strong>
                </div>
                <div className="info-row">
                  <span>Created</span>
                  <span>{formatInfoDate(stats.minTs)}</span>
                </div>
                <div className="info-row">
                  <span>Last message</span>
                  <span>{formatInfoDate(stats.maxTs)}</span>
                </div>
              </div>
            </div>

            {/* Section 2: Attachments */}
            <div className="info-section">
              <strong
                className={onOpenGallery ? 'info-section-clickable' : ''}
                onClick={() => onOpenGallery?.('all')}
                role={onOpenGallery ? 'button' : undefined}
                tabIndex={onOpenGallery ? 0 : undefined}
                title="View all attachments"
              >Attachments</strong>
              <div className="info-list">
                {[
                  { label: 'Photos', count: stats.attachments.photos, tab: 'photos' },
                  { label: 'Videos', count: stats.attachments.videos, tab: 'videos' },
                  { label: 'Audio', count: stats.attachments.audio, tab: 'audio' },
                  { label: 'GIFs', count: stats.attachments.gifs, tab: 'gifs' },
                  { label: 'Files', count: stats.attachments.files, tab: 'files' },
                ].map(({ label, count, tab }: { label: string; count: number; tab: string }) => (
                  <div
                    key={label}
                    className={`info-row ${onOpenGallery ? 'info-row-clickable' : ''}`}
                    onClick={() => onOpenGallery?.(tab)}
                    role={onOpenGallery ? 'button' : undefined}
                    tabIndex={onOpenGallery ? 0 : undefined}
                    title={`View ${label.toLowerCase()}`}
                  >
                    <span>{label}</span>
                    <span className="attachment-count">
                      {formatInfoNumber(count)}
                    </span>
                  </div>
                ))}
                <div className="info-row">
                  <span>Media loaded</span>
                  <span className="attachment-count">
                    {formatInfoNumber(stats.attachments.mediaFound)}
                    <span className="attachment-found"> / {formatInfoNumber(stats.attachments.foundTotal)}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Section 3: Messages Per Member — clickable to set perspective */}
            <div className="info-section">
              <strong>Messages Per Member</strong>
              <div className="info-list">
                {stats.memberStats.map(({ name, count, percent }: MemberStat) => (
                  <div
                    key={name}
                    className={`member-stat selectable${name === selectedPerspective ? ' selected' : ''}`}
                    onClick={() => onSelectPerspective(name)}
                    role="button"
                    tabIndex={0}
                    title={`Set "${name}" as perspective`}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelectPerspective(name); }}
                  >
                    <span className="member-stat-name" title={name}>{name}</span>
                    <span className="member-stat-meta">{formatInfoNumber(count)} ({percent}%)</span>
                    <div className="member-stat-bar">
                      <span style={{ width: `${Math.max(1, percent)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Section 4: Members — clickable to set perspective */}
            <div className="info-section">
              <strong>Members</strong>
              <div className="member-list">
                {chatData.participants.map(p => (
                  <div
                    key={p.name}
                    className={`member-chip selectable${p.name === selectedPerspective ? ' selected' : ''}`}
                    title={`Set "${p.name}" as perspective`}
                    onClick={() => onSelectPerspective(p.name)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelectPerspective(p.name); }}
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
