// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/Sidebar/SettingsPanel';
import { ReactionFeatureContext, useReactionContext } from '../src/hooks/useReactionFeature';
import { useSettings } from '../src/hooks/useSettings';
import { reactionConversationId } from '../src/services/reactionAuditInventory';
import { configurePerformance, defaultPerformancePreferences } from '../src/services/performanceSettings';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

type ReactionFeature = ReturnType<typeof useReactionContext>;
const storagePrefix = `majv_${window.location.hostname || 'local'}_setting_`;

afterEach(() => {
  cleanup();
  localStorage.clear();
  configurePerformance(defaultPerformancePreferences());
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

function feature(overrides: Partial<ReactionFeature> = {}): ReactionFeature {
  return { hide: true, applicable: true, status: 'ready', reason: '', mode: 'aggressive',
    hasCache: false, canClear: false, clear: vi.fn(), retry: vi.fn(), showAll: vi.fn(),
    consistency: { status: 'idle', reason: '', inconsistentChats: [], unmatchedChats: [], notices: null, candidates: null },
    canCheckArchive: true, checkArchive: vi.fn(), cancelArchiveCheck: vi.fn(), time: () => ({ timestamp: 0 }),
    ...overrides };
}

function chat(folderName: string): ChatListEntry {
  return { folderName, title: folderName, participants: [], messageCount: 1, folderSize: 0, jsonFileCount: 1,
    source: 'inbox', dirHandle: createMockDirectoryHandle(folderName, {}) };
}

function Harness({ value, entries = [], onSelectChat = async () => {} }: {
  value: ReactionFeature; entries?: ChatListEntry[]; onSelectChat?: (entry: ChatListEntry) => Promise<void>;
}) {
  const { settings, setSetting } = useSettings();
  return <ReactionFeatureContext value={value}>
    <SettingsPanel settings={settings} setSetting={setSetting} selectedPerspective="" setSelectedPerspective={() => {}}
      onOpenFolder={async () => {}} rootHandle={null} onAttachmentBookmarkingChange={async () => true}
      chatEntries={entries} onSelectChat={onSelectChat} />
  </ReactionFeatureContext>;
}

describe('reaction settings presentation', () => {
  it('preserves section order, collapse state, information focus, and immediate setting effects', () => {
    const view = render(<Harness value={feature()} />);
    expect(Array.from(view.container.querySelectorAll('.settings-section-toggle'), button => button.textContent)).toEqual([
      'Messages folder', 'Appearance', 'Chat management', 'Reaction notices', 'Downloads', 'Offline use', 'Performance', 'Debugging', 'Help',
    ]);
    const section = screen.getByRole('button', { name: 'Reaction notices', exact: true });
    const region = document.getElementById(section.getAttribute('aria-controls')!)!;
    expect(region.getAttribute('aria-labelledby')).toBe(section.id);
    fireEvent.click(section);
    expect(region.hidden).toBe(true);
    const information = screen.getByRole('button', { name: 'Open reaction notices information' });
    fireEvent.click(information);
    const dialog = screen.getByRole('dialog', { name: 'Reaction notices' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close reaction notices information' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(information);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dark mode' }));
    expect(localStorage.getItem(`${storagePrefix}darkMode`)).toBe('0');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(section.getAttribute('aria-expanded')).toBe('false');
  });

  it.each([true, false])('retains Off cache label and Clear while the explicit full check remains available (cached=%s)', cached => {
    localStorage.setItem(`${storagePrefix}reactionTimestampGuessingMode`, 'off');
    const value = feature({ hasCache: cached, canClear: true });
    render(<Harness value={value} />);
    expect(screen.getByText(cached ? 'Guesses cached' : 'No guesses cached')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
    expect(value.clear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Check archive', exact: true }));
    expect(value.checkArchive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide reaction notices' }));
    expect(localStorage.getItem(`${storagePrefix}hideLikelyReactionNotices`)).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Reaction timestamp matching', exact: true }));
    fireEvent.click(screen.getByRole('option', { name: 'Guess nearby', exact: true }));
    expect(localStorage.getItem(`${storagePrefix}reactionTimestampGuessingMode`)).toBe('near');
  });

  it('keeps quick Refresh separate from full-check progress, Cancel, and unavailable actions', () => {
    const value = feature({ status: 'checking', consistency: {
      status: 'checking', reason: 'Reading conversation 2 of 3.', notices: null, candidates: null,
      inconsistentChats: [], unmatchedChats: [{ id: 'missing', notices: 20, candidates: 10 }],
    } });
    const view = render(<Harness value={value} />);
    expect(screen.getByText('Checking reaction notices…')).toBeTruthy();
    expect(screen.getByText('Full archive consistency check running. Reading conversation 2 of 3.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View chats with unmatched notices' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(value.retry).toHaveBeenCalledOnce();
    expect(value.cancelArchiveCheck).toHaveBeenCalledOnce();

    view.rerender(<Harness value={feature({ applicable: false })} />);
    expect((screen.getByRole('checkbox', { name: 'Hide reaction notices' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reaction timestamp matching', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Does not apply to this Messenger export.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh', exact: true })).toBeNull();
    expect(screen.queryByText('Full archive consistency check')).toBeNull();
  });

  it('preserves percentage rounding, issue order, unavailable-chat filtering, and focus after result updates', () => {
    const alice = chat('Alice'), bob = chat('Bob');
    const aliceIssue = { id: reactionConversationId(alice.source, alice.folderName), notices: 30, candidates: 29 };
    const bobIssue = { id: reactionConversationId(bob.source, bob.folderName), notices: 20, candidates: 18 };
    const value = feature({ consistency: { status: 'inconsistent', reason: 'Review these chats.', notices: 30, candidates: 29,
      inconsistentChats: [{ id: 'unlisted', notices: 3, candidates: 1 }, bobIssue, aliceIssue], unmatchedChats: [aliceIssue] } });
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const view = render(<Harness value={value} entries={[alice, bob]} onSelectChat={onSelect} />);
    expect(screen.getByText('Full archive consistency check: 96.7% passed. Review these chats.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View inconsistent matches', exact: true }));
    const dialog = screen.getByRole('dialog', { name: 'Chats with inconsistent matches' });
    const rows = within(dialog).getAllByRole('button').filter(button => button.classList.contains('consistency-chat-item'));
    expect(rows.map(button => button.querySelector('.chat-item-title')!.textContent)).toEqual(['Bob', 'Alice']);
    rows[0].focus();
    view.rerender(<Harness value={{ ...value, reason: 'Updated status' }} entries={[alice, bob]} onSelectChat={onSelect} />);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close chats with inconsistent matches' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Bob/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(bob);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View chats with unmatched notices', exact: true }));
    expect(screen.getByRole('dialog', { name: 'Chats with unmatched notices' })).toBeTruthy();
    expect(screen.getByText('29/30 notices match reactions')).toBeTruthy();
  });

  it('retains inconclusive zero-count wording and empty details after chat entries disappear', () => {
    const alice = chat('Alice');
    const value = feature({ canCheckArchive: false, consistency: { status: 'inconsistent', notices: 0, candidates: 0,
      reason: '', inconsistentChats: [{ id: reactionConversationId(alice.source, alice.folderName), notices: 1, candidates: 0 }], unmatchedChats: [] } });
    render(<Harness value={value} />);
    expect(screen.getByText('Full archive consistency check was inconclusive.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check again', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'View inconsistent matches', exact: true }));
    expect(screen.getByRole('dialog', { name: 'Chats with inconsistent matches' })).toBeTruthy();
    expect(screen.getByText('This result was created before chat details were available. Run Check again to list the affected chats.')).toBeTruthy();
  });
});
