// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionPanel } from '../src/components/InfoPanel/SelectionPanel';
import { useBookmarks } from '../src/hooks/useBookmarks';
import * as audioMetadata from '../src/services/audioMetadata';
import { addMediaToIndex, createMediaState } from '../src/services/media';
import type { MediaState, ResolvedAttachment } from '../src/types/messenger';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const attachment: ResolvedAttachment = {
  category: 'audio', mediaPath: 'audio/voice.m4a', messageIndex: 0, timestamp: 1,
  sender: 'Alice', mediaEntry: { type: 'audio', url: 'blob:voice' },
};

function SelectedAudioCard({ item, mediaState }: { item: ResolvedAttachment; mediaState: MediaState }) {
  const bookmarks = useBookmarks(null);
  return <SelectionPanel activeEntry={null}
    chatData={{ title: 'Chat', thread_path: 'inbox/chat', is_still_participant: true, participants: [], messages: [] }}
    mediaState={mediaState} selectedItems={[item]} onDeselect={() => {}} onOpenViewer={() => {}}
    onClearSelection={() => {}} useDateFilenames={false} filenameTemplate="{filename}"
    allowLongFilenames={false} attachmentBookmarkingEnabled={false} bookmarks={bookmarks} />;
}

describe('audio card metadata', () => {
  it.each([
    [null, 'Unknown duration'],
    [-1, '0:00'],
    [59.49, '0:59'],
    [59.5, '1:00'],
    [3599.5, '1:00:00'],
    [3661.4, '1:01:01'],
  ] as const)('displays %s seconds as %s with size and author', async (duration, label) => {
    vi.spyOn(audioMetadata, 'getAudioMetadata').mockResolvedValue({ duration, size: 5 });
    const { container } = render(<SelectedAudioCard item={attachment} mediaState={createMediaState()} />);

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText(`${label} · 5 B`)).toBeTruthy();
    expect(screen.getByTitle('Sent by Alice').textContent).toBe('Alice');
    expect(screen.getByRole('button', { name: 'Deselect voice.m4a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open voice.m4a in viewer' })).toBeTruthy();
    expect(container.querySelector('.gallery-file-meta.gallery-author-size-meta.gallery-even-metadata-spacing')).toBeTruthy();
  });

  it('ignores superseded results, resolves indexed media, and keeps missing-file labels', async () => {
    let resolveFirst!: (metadata: audioMetadata.AudioMetadata) => void;
    let resolveSecond!: (metadata: audioMetadata.AudioMetadata) => void;
    const first = new Promise<audioMetadata.AudioMetadata>(resolve => { resolveFirst = resolve; });
    const second = new Promise<audioMetadata.AudioMetadata>(resolve => { resolveSecond = resolve; });
    const replacementEntry = { type: 'audio', url: 'blob:replacement' };
    vi.spyOn(audioMetadata, 'getAudioMetadata').mockImplementation(entry => entry === replacementEntry ? second : first);
    const mediaState = createMediaState();
    const { rerender } = render(<SelectedAudioCard item={attachment} mediaState={mediaState} />);
    expect(screen.getByText('Loading…')).toBeTruthy();

    const replacement = { ...attachment, mediaEntry: null, sender: 'Bob' };
    const replacementMedia = createMediaState();
    addMediaToIndex(replacementMedia, attachment.mediaPath, replacementEntry);
    rerender(<SelectedAudioCard item={replacement} mediaState={replacementMedia} />);
    await act(async () => { resolveFirst({ duration: 15, size: 10 }); });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.getByTitle('Sent by Bob').textContent).toBe('Bob');

    rerender(<SelectedAudioCard item={replacement} mediaState={createMediaState()} />);
    expect(screen.getByText('Unknown duration · Unknown size')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Audio not found: voice.m4a' })).toBeTruthy();
    await act(async () => { resolveSecond({ duration: 60, size: 5 }); });
    expect(screen.getByText('Unknown duration · Unknown size')).toBeTruthy();
  });
});
