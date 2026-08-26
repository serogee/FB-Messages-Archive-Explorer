import { describe, expect, it, vi } from 'vitest';
import { resolveMessageJumpTarget } from '../src/services/messageJump';

function element(id: string): HTMLElement {
  return { id } as HTMLElement;
}

describe('message jump coordination', () => {
  it('returns an already rendered target without activating its chunk', async () => {
    const target = element('target');
    const renderChunk = vi.fn<() => Promise<boolean>>();

    await expect(resolveMessageJumpTarget({
      findMessage: () => target,
      renderChunk,
      isCurrent: () => true,
    })).resolves.toBe(target);
    expect(renderChunk).not.toHaveBeenCalled();
  });

  it('finds the target after its chunk reports that rendering completed', async () => {
    const target = element('target');
    let rendered = false;

    await expect(resolveMessageJumpTarget({
      findMessage: () => rendered ? target : null,
      renderChunk: async () => {
        rendered = true;
        return true;
      },
      isCurrent: () => true,
    })).resolves.toBe(target);
  });

  it('ignores a request that becomes stale while its chunk renders', async () => {
    const target = element('target');
    let current = true;
    let rendered = false;

    await expect(resolveMessageJumpTarget({
      findMessage: () => rendered ? target : null,
      renderChunk: async () => {
        rendered = true;
        current = false;
        return true;
      },
      isCurrent: () => current,
    })).resolves.toBeNull();
  });
});
