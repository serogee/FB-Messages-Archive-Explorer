// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../src/components/Chat/MessageBubble';
import { InfoPanel } from '../src/components/InfoPanel/InfoPanel';
import { MediaViewer } from '../src/components/MediaViewer/MediaViewer';
import { addMediaToIndex, createMediaState } from '../src/services/media';
import { parseMessengerExportJson } from '../src/services/messengerExport/messengerExportParser';
import { chatVideoPosterCache } from '../src/services/videoPosterCache';
import type { ChatListEntry, MessengerMessage, ResolvedAttachment, SelectableItem } from '../src/types/messenger';
import { parseMessengerJsonContent } from '../src/services/parser';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const failedLabel = 'Failed to download media. Attachment type unknown.';
function thread() {
  return parseMessengerExportJson(JSON.stringify({
    threadName: 'Chat', participants: ['Alice', 'Bob'],
    messages: [
      { senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/photo.jpg' }, { uri: 'Failed to download media' }, { uri: 'Failed to download media' }] },
      { senderName: 'Bob', timestamp: 2, media: [{ uri: 'media/clip.mp4' }, { uri: 'Failed to download media' }] },
    ],
  }));
}
const bubbleProps = {
  isMe: false, showMyName: false, showTheirName: false, showReactions: false,
  mediaState: createMediaState(), highlightQuery: '', msgIndex: 0,
  isFirstInClump: true, isLastInClump: true,
};

describe('unavailable attachments', () => {
  it('renders an encoded Facebook bump quote with safe links, highlights, and reactions', () => {
    const message = parseMessengerJsonContent(JSON.stringify({
      title: 'Chat', thread_path: 'inbox/chat', participants: [], messages: [{
        sender_name: 'Alice', timestamp_ms: 1,
        bumped_message_metadata: { is_bumped: true, bumped_message: 'caf\u00c3\u00a9 plans\nhttps://example.com/report\n<img src=x onerror=alert(1)>' },
        reactions: [{ actor: 'Bob', reaction: '👍' }],
      }],
    })).messages[0];
    const { container } = render(<MessageBubble {...bubbleProps} msg={message} highlightQuery="cafe" showReactions />);
    expect(screen.getByText('Bumped a message').tagName).toBe('EM');
    const quote = container.querySelector('blockquote')!;
    expect(quote.textContent).toContain('café plans\n');
    expect(quote.querySelector('.search-highlight')?.textContent).toBe('café');
    expect(screen.getByRole('link', { name: 'https://example.com/report' }).getAttribute('href')).toBe('https://example.com/report');
    expect(quote.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(quote.querySelector('img')).toBeNull();
    expect(container.querySelector('.reaction-bubble')).toBeTruthy();
    expect(screen.queryByText(/^Message Unavailable:/)).toBeNull();
  });

  it.each(['', ' \n\t ', undefined, '\u200b\u200e'])('marks the bumped message unknown when no visible quote is available: %j', bumped_message => {
    const { container } = render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1,
      bumped_message_metadata: { is_bumped: true, bumped_message },
    }} />);
    expect(screen.getByText('Bumped a message: Unknown').tagName).toBe('EM');
    expect(container.querySelector('blockquote')).toBeNull();
    expect(screen.queryByText(/^Message Unavailable:/)).toBeNull();
  });

  it('keeps other message content and media alongside a bump notice', () => {
    const { container } = render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1,
      content: 'Additional text', photos: [{ uri: 'missing.jpg' }],
      bumped_message_metadata: { is_bumped: true, bumped_message: 'Quoted message' },
    }} />);
    expect(screen.getByText('Additional text')).toBeTruthy();
    expect(screen.getByText('Quoted message')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Image not found or unreadable' })).toBeTruthy();
    expect(container.querySelector('.media-only')).toBeNull();
  });

  it('displays the quote once when the export repeats it in the regular content', () => {
    const { container } = render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1,
      content: 'Repeated body', bumped_message_metadata: { is_bumped: true, bumped_message: 'Repeated body' },
    }} />);
    expect(screen.getAllByText('Repeated body')).toHaveLength(1);
    expect(container.querySelector('blockquote')?.textContent).toBe('Repeated body');
    expect(container.querySelector('.message-text')).toBeNull();
  });

  it('does not expose a bump quote from an unsent message', () => {
    const { container } = render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1,
      is_unsent: true, bumped_message_metadata: { is_bumped: true, bumped_message: 'Removed quote' },
    }} />);
    expect(screen.getByText('Message unsent')).toBeTruthy();
    expect(screen.queryByText('Bumped a message')).toBeNull();
    expect(container.querySelector('blockquote')).toBeNull();
  });

  it('requires the bump flag before interpreting metadata as a bump action', () => {
    render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1, content: 'Original content',
      bumped_message_metadata: { is_bumped: false, bumped_message: 'Inactive quote' },
    }} />);
    expect(screen.getByText('Original content')).toBeTruthy();
    expect(screen.queryByText('Bumped a message')).toBeNull();
    expect(screen.queryByText('Inactive quote')).toBeNull();
  });

  it.each(['media', 'link', 'text'])('shows an italic unavailable label for an empty Messenger %s message', type => {
    const message = parseMessengerExportJson(JSON.stringify({
      threadName: 'Chat', participants: ['Mhel Emmie Plaza', 'Geevoi Plaza'],
      messages: [{ isUnsent: false, senderName: 'Mhel Emmie Plaza', timestamp: 1772536636351,
        text: '  ', media: [], reactions: [], type }],
    })).messages[0];
    render(<MessageBubble {...bubbleProps} msg={message} />);
    const label = screen.getByText(`Message Unavailable: ${type.charAt(0).toUpperCase() + type.slice(1)}`);
    expect(label.tagName).toBe('EM');
    expect(label.classList.contains('msg-unavailable')).toBe(true);
  });

  it('retains the fallback for empty Facebook messages with reactions and an unusable link', () => {
    const message = parseMessengerJsonContent(JSON.stringify({
      title: 'Chat', participants: [{ name: 'Alice' }], thread_path: 'inbox/chat', messages: [
        { sender_name: 'Alice', timestamp_ms: 1, type: 'link', share: { link: 'javascript:alert(1)' },
          reactions: [{ actor: 'Bob', reaction: '❤' }] },
      ],
    })).messages[0];
    const { container } = render(<MessageBubble {...bubbleProps} msg={message} showReactions />);
    expect(screen.getByText('Message Unavailable: Link')).toBeTruthy();
    expect(container.querySelector('.reaction-bubble')).toBeTruthy();
    expect(container.querySelector('a')).toBeNull();
  });

  it('labels an empty message without a recorded type as unknown', () => {
    render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1, content: '\n\t' }} />);
    expect(screen.getByText('Message Unavailable: Unknown')).toBeTruthy();
  });

  it.each<Partial<MessengerMessage>>([
    { text: 'Visible text', type: 'text' },
    { share: { link: 'https://example.com' }, type: 'link' },
    { photos: [{ uri: 'missing.jpg' }], type: 'media' },
    { failedMediaCount: 1, type: 'media' },
    { is_unsent: true, type: 'media' },
  ])('keeps existing content and unsent messages free of the empty-content label: %j', content => {
    render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1, ...content }} />);
    expect(screen.queryByText(/^Message Unavailable:/)).toBeNull();
  });

  it('counts repeated failures below media files without inflating known categories', () => {
    const mediaState = createMediaState();
    addMediaToIndex(mediaState, 'media/photo.jpg', { type: 'image', url: 'blob:photo' });
    const { container } = render(<InfoPanel chatData={thread()} activeEntry={{ _messengerExport: true } as ChatListEntry}
      mediaState={mediaState} selectedPerspective="Alice" onSelectPerspective={() => {}} />);
    const failure = container.querySelector('.info-failed-media')!;
    expect(failure.querySelector('.responsive-full')?.textContent).toBe('3');
    const mediaRow = failure.previousElementSibling!;
    expect(mediaRow.textContent).toContain('Media files');
    expect(Array.from(mediaRow.querySelectorAll('.responsive-full'), el => el.textContent)).toEqual(['1', '5']);
    const photosRow = screen.getByText('Photos').closest('.info-row')!;
    expect(photosRow.querySelector('.responsive-full')?.textContent).toBe('1');
    expect(screen.queryByText('Stickers')).toBeNull();
  });

  it('renders every export failure as a separate fixed-size accessible icon', () => {
    const { container } = render(<MessageBubble {...bubbleProps} msg={thread().messages[0]} />);
    const placeholders = screen.getAllByRole('img', { name: failedLabel });
    expect(placeholders).toHaveLength(2);
    for (const placeholder of placeholders) {
      expect(placeholder.querySelector('svg')?.getAttribute('width')).toBe('24');
      expect(placeholder.querySelector('svg')?.getAttribute('height')).toBe('24');
    }
    expect(screen.getByRole('img', { name: 'Image not found or unreadable' })).toBeTruthy();
    expect(container.querySelector('[data-media-geometry-pending="true"]')).toBeNull();
  });

  it('keeps missing visual media in the grid and audio and files in their compact forms', () => {
    const { container } = render(<MessageBubble {...bubbleProps} msg={{ sender_name: 'Alice', timestamp_ms: 1,
      photos: [{ uri: 'a.jpg' }, { uri: 'b.jpg' }], videos: [{ uri: 'c.mp4' }],
      audio: [{ uri: 'd.ogg' }], files: [{ uri: 'e.pdf' }], sticker: { uri: 'f.webp' },
    }} />);
    expect(container.querySelectorAll('.message-media-grid .unavailable-attachment')).toHaveLength(4);
    expect(screen.getByRole('img', { name: 'Video not found' }).tagName).toBe('SPAN');
    expect(screen.getByRole('img', { name: 'Audio not found or unreadable' }).classList.contains('audio-placeholder')).toBe(true);
    expect(screen.getByRole('img', { name: 'File not found: e.pdf' }).closest('.media-file-card')).toBeTruthy();
    expect(screen.getByText('e.pdf')).toBeTruthy();
  });

  it('does not show attachments on an unsent message', () => {
    render(<MessageBubble {...bubbleProps} msg={{ ...thread().messages[0], is_unsent: true }} />);
    expect(screen.getByText('Message unsent')).toBeTruthy();
    expect(screen.queryByRole('img', { name: failedLabel })).toBeNull();
  });

  it('opens every known missing attachment from chat and leaves pathless failures inert', () => {
    const onMediaClick = vi.fn();
    render(<MessageBubble {...bubbleProps} onMediaClick={onMediaClick} msgIndex={7}
      msg={{ sender_name: 'Alice', timestamp_ms: 1,
        photos: [{ uri: 'a.jpg' }], videos: [{ uri: 'b.mp4' }], audio: [{ uri: 'c.ogg' }],
        files: [{ uri: 'd.pdf' }], sticker: { uri: 'e.webp' }, failedMediaCount: 1,
      }} />);
    for (const [label, path] of [
      ['Image not found or unreadable', 'a.jpg'], ['Video not found', 'b.mp4'],
      ['Audio not found or unreadable', 'c.ogg'], ['File not found: d.pdf', 'd.pdf'],
      ['Sticker not found or unreadable', 'e.webp'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(onMediaClick).toHaveBeenLastCalledWith(path, 7);
    }
    fireEvent.click(screen.getByRole('img', { name: failedLabel }));
    expect(onMediaClick).toHaveBeenCalledTimes(5);
  });

  it('preserves video dimensions after a preview error and keeps the video action', async () => {
    vi.spyOn(chatVideoPosterCache, 'subscribe').mockImplementation((_entry, listener) => {
      queueMicrotask(() => listener({ url: 'blob:poster', duration: 3, sourceWidth: 400, sourceHeight: 200 }));
      return Object.assign(() => {}, { setPriority() {} });
    });
    const mediaState = createMediaState();
    addMediaToIndex(mediaState, 'clip.mp4', { type: 'video', url: 'blob:video' });
    const onMediaClick = vi.fn();
    render(<MessageBubble {...bubbleProps} mediaState={mediaState} onMediaClick={onMediaClick}
      msg={{ sender_name: 'Alice', timestamp_ms: 1, videos: [{ uri: 'clip.mp4' }] }} />);
    fireEvent.error(await screen.findByRole('img', { name: 'Video preview' }));
    const fallback = screen.getByRole('button', { name: 'Video preview unavailable. Open video' });
    expect((fallback.closest('.media-preview-reserved') as HTMLElement).style.aspectRatio).toBe('400 / 200');
    fireEvent.click(fallback);
    expect(onMediaClick).toHaveBeenCalledWith('clip.mp4', 0);
  });

  it('replaces an unreadable audio player with the compact unavailable icon', async () => {
    const mediaState = createMediaState();
    addMediaToIndex(mediaState, 'bad.ogg', { type: 'audio', url: 'blob:audio' });
    const { container } = render(<MessageBubble {...bubbleProps} mediaState={mediaState}
      msg={{ sender_name: 'Alice', timestamp_ms: 1, audio: [{ uri: 'bad.ogg' }] }} />);
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy());
    fireEvent.error(container.querySelector('audio')!);
    expect(screen.getByRole('img', { name: 'Audio not found or unreadable' })).toBeTruthy();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('shows a viewer fallback for a decode failure and clears it on another item', () => {
    const first: ResolvedAttachment = { category: 'photos', mediaPath: 'a.jpg', messageIndex: 0, timestamp: 1, sender: 'Alice', mediaEntry: { type: 'image', url: 'blob:a' } };
    const second: ResolvedAttachment = { ...first, mediaPath: 'b.jpg', messageIndex: 1, mediaEntry: { type: 'image', url: 'blob:b' } };
    render(<MediaViewer items={[first, second]} initialIndex={0} mediaState={createMediaState()} onClose={() => {}} onJumpToMessage={() => {}} />);
    fireEvent.error(screen.getByRole('img', { name: 'a.jpg' }));
    expect(screen.getByText('Attachment could not be displayed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open file' }).getAttribute('href')).toBe('blob:a');
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    expect(screen.getByRole('img', { name: 'b.jpg' })).toBeTruthy();
    expect(screen.queryByText('Attachment could not be displayed')).toBeNull();
  });

  it('copies the original basename of missing attachments and resets feedback on navigation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const first: ResolvedAttachment = { category: 'files', mediaPath: './media/Long original filename — report.pdf',
      messageIndex: 0, timestamp: 1, sender: 'Alice', mediaEntry: null };
    const second: ResolvedAttachment = { ...first, category: 'audio', mediaPath: './media/voice note.ogg', messageIndex: 1 };
    render(<MediaViewer items={[first, second]} initialIndex={0} mediaState={createMediaState()}
      onClose={() => {}} onJumpToMessage={() => {}} useDateFilename chatTitle="Renamed downloads" />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy filename' }));
    expect(writeText).toHaveBeenLastCalledWith('Long original filename — report.pdf');
    expect(await screen.findByRole('button', { name: 'Filename copied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.queryByRole('button', { name: 'Filename copied' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy filename' }));
    expect(writeText).toHaveBeenLastCalledWith('voice note.ogg');
    expect(await screen.findByRole('button', { name: 'Filename copied' })).toBeTruthy();
  });

  it('offers the filename for manual copying if clipboard access fails', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) } });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    const item: ResolvedAttachment = { category: 'photos', mediaPath: './media/missing.jpg',
      messageIndex: 0, timestamp: 1, sender: 'Alice', mediaEntry: null };
    render(<MediaViewer items={[item]} initialIndex={0} mediaState={createMediaState()}
      onClose={() => {}} onJumpToMessage={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy filename' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('Copy filename:', 'missing.jpg'));
    expect(screen.queryByRole('button', { name: 'Filename copied' })).toBeNull();
  });

  it('copies filenames as the last menu option for every attachment category and excludes links', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const categories = ['photos', 'videos', 'audio', 'gifs', 'files', 'stickers'] as const;
    const items: SelectableItem[] = categories.map((category, messageIndex) => ({
      category, messageIndex, mediaPath: `./media/${category}-original-filename.jpeg`,
      timestamp: 1, sender: 'Alice', mediaEntry: null,
    }));
    items.push({ category: 'links', url: 'https://example.com/page', label: 'Shared page',
      messageIndex: 6, timestamp: 1, sender: 'Alice' });
    render(<MediaViewer items={items} initialIndex={0} mediaState={createMediaState()}
      onClose={() => {}} onJumpToMessage={() => {}} onJumpToAttachment={() => {}} />);
    for (const category of categories) {
      expect(screen.getByText(`${category}-original-filename.jpeg`).classList.contains('media-viewer-file-name')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      const copyButton = screen.getByRole('button', { name: 'Copy filename' });
      expect(copyButton.parentElement?.lastElementChild).toBe(copyButton);
      fireEvent.click(copyButton);
      expect(await screen.findByRole('button', { name: 'Filename copied' })).toBeTruthy();
      expect(writeText).toHaveBeenLastCalledWith(`${category}-original-filename.jpeg`);
      fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.queryByRole('button', { name: 'Copy filename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Filename copied' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(6);
  });
});
