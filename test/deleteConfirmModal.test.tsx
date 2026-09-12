import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeleteResultNotice } from '../src/types/deletion';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

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
