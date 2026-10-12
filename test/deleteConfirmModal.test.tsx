import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeleteResultNotice } from '../src/types/deletion';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import { CalculationProgressStore } from '../src/services/calculationProgress';

function entry(name: string): ChatListEntry {
  return {
    folderName: name,
    title: name,
    participants: [],
    messageCount: 0,
    folderSize: 10,
    dirHandle: createMockDirectoryHandle(name, {}),
    jsonFileCount: 1,
    source: 'inbox',
  };
}

async function renderResult(resultNotice: DeleteResultNotice): Promise<string> {
  vi.stubGlobal('window', { location: { hostname: 'localhost' } });
  const { DeleteConfirmModal } = await import('../src/components/Modals/DeleteConfirmModal');
  return renderToStaticMarkup(
    <DeleteConfirmModal
      entry={resultNotice.failures.map(failure => failure.entry)}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      onRetryCalculation={vi.fn()}
      preparation={{ status: 'skipped' }}
      resultNotice={resultNotice}
    />
  );
}

describe('DeleteConfirmModal failure results', () => {
  it('shows a text calculation count without a progress bar', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const progress = new CalculationProgressStore();
    progress.report({ stage: 'ownership', label: 'Checking shared attachments', done: 4, total: 10, unit: 'files' });
    const { DeleteConfirmModal } = await import('../src/components/Modals/DeleteConfirmModal');
    const html = renderToStaticMarkup(
      <DeleteConfirmModal
        entry={entry('calculation')}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        preparation={{ status: 'loading', calculatingSizes: false, progress }}
      />
    );

    expect(html).toContain('4 / 10 files (40%)');
    expect(html).not.toContain('<progress');
  });

  it('keeps Check attachments available after a size-skipped ownership check finishes', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const { DeleteConfirmModal } = await import('../src/components/Modals/DeleteConfirmModal');
    const html = renderToStaticMarkup(
      <DeleteConfirmModal
        entry={entry('size-skipped')}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onCheckAttachments={vi.fn()}
        preparation={{
          status: 'skipped',
          info: {
            jsonSize: 0, chatFileCount: 0, mediaSize: 0, totalSize: 0,
            exclusiveMediaFiles: [], exclusiveMediaCount: 0, sharedMediaCount: 0,
          },
        }}
      />
    );

    expect(html).toContain('Check attachments');
  });

  it('shows running deletion progress as a number without a visual bar', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const { DeleteConfirmModal } = await import('../src/components/Modals/DeleteConfirmModal');
    const html = renderToStaticMarkup(
      <DeleteConfirmModal
        entry={entry('deleting')}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        preparation={{ status: 'ready', info: {
          jsonSize: 0, chatFileCount: 0, mediaSize: 0, totalSize: 0,
          exclusiveMediaFiles: [], exclusiveMediaCount: 0, sharedMediaCount: 0,
        } }}
        progress={{ stage: 'chat', done: 2, total: 5 }}
      />
    );

    expect(html).toContain('2 / 5');
    expect(html).not.toContain('background:var(--accent)');
  });

  it('keeps an ordinary deletion failure visible as retryable', async () => {
    const html = await renderResult({
      message: '0 of 1 chats deleted; 1 failed',
      failures: [{ entry: entry('blocked'), error: new Error('denied'), partial: false }],
    });

    expect(html).toContain('Retry deletion');
    expect(html).toContain('remains available for retry');
    expect(html).not.toContain('attachments may be missing');
  });

  it('reserves the missing-attachment warning for partial failures', async () => {
    const html = await renderResult({
      message: '0 of 1 chats deleted; 1 failed',
      failures: [{
        entry: entry('partial'),
        error: new Error('one removal failed'),
        partial: true,
        removedMediaCount: 2,
        jsonRetained: true,
      }],
    });

    expect(html).toContain('2 media files were removed');
    expect(html).toContain('some attachments may be missing');
  });
});
