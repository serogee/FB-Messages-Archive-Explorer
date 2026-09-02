import { useMemo, type ReactNode } from 'react';
import type { MessengerThread, MessengerMessage, MediaState, ChatListEntry } from '../../types/messenger';
import { Image as ImageIcon, Film, Music, FileText, Smile, Link as LinkIcon, Sticker, ChevronRight } from 'lucide-react';
import {
  formatCompactInfoDate,
  formatCompactInfoNumber,
  formatInfoDate,
  formatInfoNumber,
} from '../../services/storage';
import { getMessageTimestamp } from '../../services/parser';
import { getMessageAttachmentReferences, isMediaReferenceFound } from '../../services/media';
import { isReactionNoticeMessage } from '../../services/reactions';
import { getMessageLinks } from '../../services/messageLinks';

interface InfoPanelProps {
  chatData: MessengerThread | null;
  activeEntry: ChatListEntry | null;
  mediaState: MediaState;
  selectedPerspective: string;
  onSelectPerspective: (name: string) => void;
  onOpenGallery?: (tab?: string) => void;
  header?: ReactNode;
}

interface MemberStat {
  name: string;
  count: number;
  percent: number;
}

function ResponsiveValue({ full, compact }: { full: string; compact: string }) {
  return (
    <span className="responsive-value" title={full !== compact ? full : undefined}>
      <span className="responsive-full">{full}</span>
      <span className="responsive-compact">{compact}</span>
    </span>
  );
}

function ResponsiveNumber({ value }: { value: number }) {
  return (
    <ResponsiveValue
      full={formatInfoNumber(value)}
      compact={formatCompactInfoNumber(value)}
    />
  );
}

function ResponsiveDate({ timestamp }: { timestamp: number | null }) {
  return (
    <ResponsiveValue
      full={formatInfoDate(timestamp)}
      compact={formatCompactInfoDate(timestamp)}
    />
  );
}

function computeStats(messages: MessengerMessage[], mediaState: MediaState, countChatMediaOnly: boolean) {
  let minTs: number | null = null;
  let maxTs: number | null = null;
  let visibleCount = 0;

  const memberCounts: Record<string, number> = {};
  const seenAttachments = new Set<string>();
  let photos = 0, videos = 0, audio = 0, gifs = 0, files = 0, stickers = 0, stickersFound = 0, totalReported = 0;
  let links = 0;
  let loadedChatAttachments = 0;

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

    links += getMessageLinks(msg).length;

    const refs = getMessageAttachmentReferences(msg);
    for (const { path, category, shared } of refs) {
      if (!shared) totalReported++;
      const key = `${category}:${path.toLowerCase()}`;
      if (!seenAttachments.has(key)) {
        seenAttachments.add(key);
        const isFound = isMediaReferenceFound(mediaState, path);
        if (isFound && !shared) loadedChatAttachments++;
        if (category === 'photos') photos++;
        else if (category === 'videos') videos++;
        else if (category === 'audio') audio++;
        else if (category === 'gifs') gifs++;
        else if (category === 'files') files++;
        else if (category === 'stickers') {
          stickers++;
          if (isFound) stickersFound++;
        }
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
  const mediaFound = countChatMediaOnly ? loadedChatAttachments : mediaState.mediaFileCount;

  return {
    visibleCount, minTs, maxTs, memberStats, memberCounts,
    attachments: { photos, videos, audio, gifs, files, stickers, stickersFound, foundTotal, reported: totalReported, mediaFound },
    links,
  };
}

export function InfoPanel({ chatData, activeEntry, mediaState, selectedPerspective, onSelectPerspective, onOpenGallery, header }: InfoPanelProps) {
  const stats = useMemo(() => {
    if (!chatData) return null;
    return computeStats(chatData.messages, mediaState, activeEntry?._messengerExport === true);
  }, [activeEntry?._messengerExport, chatData, mediaState]);

  return (
    <div className="chat-info-panel" id="chatInfoPanel" aria-hidden={!chatData ? 'true' : 'false'}>
      {header || (
        <div className="info-panel-header">
          <strong>{chatData?.title || activeEntry?.title || 'Chat Info'}</strong>
        </div>
      )}
      <div className="info-panel-content">
        {!chatData || !stats ? (
          activeEntry ? (
            <p className="info-empty">Loading chat details...</p>
          ) : (
            <p className="info-empty">Open a chat to see details.</p>
          )
        ) : (
          <>
            <div className="info-section">
              <strong>Chat Info</strong>
              <div className="info-stats">
                <div className="info-metric">
                  <span>Messages</span>
                  <strong><ResponsiveNumber value={stats.visibleCount} /></strong>
                </div>
                <div className="info-metric">
                  <span>Members</span>
                  <strong><ResponsiveNumber value={chatData.participants.length} /></strong>
                </div>
                <div className="info-row">
                  <span>Created</span>
                  <span><ResponsiveDate timestamp={stats.minTs} /></span>
                </div>
                <div className="info-row">
                  <span>
                    <span className="responsive-full">Last message</span>
                    <span className="responsive-compact">Most Recent</span>
                  </span>
                  <span><ResponsiveDate timestamp={stats.maxTs} /></span>
                </div>
              </div>
            </div>

            <div className="info-section">
              <strong
                className={onOpenGallery ? 'info-section-clickable' : ''}
                onClick={() => onOpenGallery?.()}
                role={onOpenGallery ? 'button' : undefined}
                tabIndex={onOpenGallery ? 0 : undefined}
                title="Open attachments"
              >Attachments</strong>
              <div className="info-list">
                {[
                  { label: 'Photos', count: stats.attachments.photos, tab: 'photos', Icon: ImageIcon },
                  { label: 'Videos', count: stats.attachments.videos, tab: 'videos', Icon: Film },
                  { label: 'Audio', count: stats.attachments.audio, tab: 'audio', Icon: Music },
                  { label: 'GIFs', count: stats.attachments.gifs, tab: 'gifs', Icon: Smile },
                  { label: 'Files', count: stats.attachments.files, tab: 'files', Icon: FileText },
                  { label: 'Links', count: stats.links, tab: 'links', Icon: LinkIcon },
                  ...(!activeEntry?._messengerExport
                    ? [{ label: 'Stickers', count: stats.attachments.stickers, found: stats.attachments.stickersFound, tab: 'stickers', Icon: Sticker }]
                    : []),
                ].map(({ label, count, tab, Icon, ...row }) => (
                  <div
                    key={label}
                    className={`info-row ${onOpenGallery ? 'info-row-clickable' : ''}`}
                    onClick={() => onOpenGallery?.(tab)}
                    role={onOpenGallery ? 'button' : undefined}
                    tabIndex={onOpenGallery ? 0 : undefined}
                    title={`View ${label.toLowerCase()}`}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Icon size={16} className="info-icon" />
                      {label}
                    </span>
                    <span className={`${onOpenGallery ? 'info-row-action' : 'attachment-count'}${tab === 'links' || tab === 'stickers' ? ' info-row-action-muted' : ''}`}>
                      {'found' in row
                        ? <><ResponsiveNumber value={row.found as number} /><span> / </span><ResponsiveNumber value={count} /></>
                        : <ResponsiveNumber value={count} />}
                      {onOpenGallery && <ChevronRight size={14} />}
                    </span>
                  </div>
                ))}
                <div className="info-row">
                  <span>Media files</span>
                  <span className="attachment-count">
                    <ResponsiveNumber value={stats.attachments.mediaFound} />
                    <span className="attachment-found"> / <ResponsiveNumber value={stats.attachments.foundTotal} /></span>
                  </span>
                </div>
              </div>
            </div>

            <div className="info-section">
              <strong>
                <span className="responsive-full">Messages Per Member</span>
                <span className="responsive-compact">By Member</span>
              </strong>
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
                    <span className="member-stat-meta">
                      <ResponsiveValue
                        full={`${formatInfoNumber(count)} (${percent}%)`}
                        compact={`${formatCompactInfoNumber(count)} · ${percent}%`}
                      />
                    </span>
                    <div className="member-stat-bar">
                      <span style={{ width: `${Math.max(1, percent)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

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
