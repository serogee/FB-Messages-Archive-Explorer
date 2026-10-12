// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimatedProgressLabel } from '../src/components/AnimatedProgressLabel';
import { CalculationProgressBar } from '../src/components/CalculationProgressBar';
import { CalculationProgressStore } from '../src/services/calculationProgress';
import { DeleteConfirmModal } from '../src/components/Modals/DeleteConfirmModal';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('attachment progress display', () => {
  it('types dots from none through three, loops, and stops its timer on unmount', () => {
    vi.useFakeTimers();
    const { container, unmount } = render(<AnimatedProgressLabel>Scanning for shared attachments</AnimatedProgressLabel>);
    expect(container.textContent).toBe('Scanning for shared attachments');
    for (const dots of ['.', '..', '...', '']) {
      act(() => { vi.advanceTimersByTime(500); });
      expect(container.textContent).toBe(`Scanning for shared attachments${dots}`);
    }
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps folder/JSON totals visible during shared-file verification without an entries count', () => {
    const progress = new CalculationProgressStore();
    progress.report({ stage: 'verification', label: 'Scanning for shared attachments',
      done: 1, total: 2, unit: 'files', foldersChecked: 1574, jsonFound: 712 });
    render(<CalculationProgressBar source={progress} label="Verification" />);
    expect(screen.getByRole('status').textContent).toContain('1,574 Folders/Subfolders Checked - 712 JSON Found');
    expect(screen.getByRole('status').textContent).not.toContain('entries');
    progress.dispose();
  });

  it('shows the shared-media summary once and preserves the batch size counters', () => {
    const progress = new CalculationProgressStore();
    progress.report({ stage: 'sizes', label: 'Calculating chat sizes', done: 2, total: 5, unit: 'chats', detail: '48 files checked' });
    const entry = { title: 'A', folderName: 'a', source: 'inbox' as const, participants: [], messageCount: 0,
      folderSize: 0, jsonFileCount: 1, dirHandle: createMockDirectoryHandle('a', {}) };
    render(<DeleteConfirmModal entry={[entry]} onConfirm={() => {}} onCancel={() => {}}
      preparation={{ status: 'loading', calculatingSizes: true, progress, info: {
        jsonSize: 0, chatFileCount: 0, mediaSize: 0, totalSize: 0, exclusiveMediaFiles: [],
        exclusiveMediaCount: 0, sharedMediaCount: 23,
      } }} />);
    expect(screen.getAllByText('Shared Attachments: 23 shared media files will be kept.')).toHaveLength(1);
    const status = screen.getByRole('status', { name: 'Deletion calculation progress' });
    expect(status.textContent).toContain('Calculating chat sizes');
    expect(status.textContent).toContain('2 / 5 chats (40%) - 48 files checked');
    expect(status.textContent).not.toContain('Scanning');
    progress.dispose();
  });

  it('offers the skip action for the active stage and keeps unchecked size calculation disabled until finished', () => {
    const entry = { title: 'A', folderName: 'a', source: 'inbox' as const, participants: [], messageCount: 0,
      folderSize: 0, jsonFileCount: 1, dirHandle: createMockDirectoryHandle('a', {}) };
    const callbacks = { onConfirm() {}, onCancel() {}, onSkipCheck() {}, onSkipCalculation() {}, onCheckAttachments() {} };
    const { rerender } = render(<DeleteConfirmModal entry={entry} {...callbacks}
      preparation={{ status: 'loading', calculatingSizes: false }} />);
    expect(screen.getByRole('button', { name: 'Skip check' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Skip calculation' })).toBeNull();
    rerender(<DeleteConfirmModal entry={entry} {...callbacks}
      preparation={{ status: 'loading', calculatingSizes: true, attachmentCheckSkipped: true }} />);
    expect(screen.getByRole('button', { name: 'Skip calculation' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Skip check' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Calculating sizes...' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: 'Deletion calculation progress' }).textContent).toContain('Calculating chat sizes');
    expect(screen.getByText('Shared Attachments: Check skipped.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Check attachments' })).toBeNull();
    rerender(<DeleteConfirmModal entry={entry} {...callbacks}
      preparation={{ status: 'unchecked', attachmentCheckSkipped: true }} />);
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Check attachments' })).toBeDefined();
    expect(screen.queryByRole('status', { name: 'Deletion calculation progress' })).toBeNull();
  });
});
