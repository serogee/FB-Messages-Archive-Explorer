import { describe, expect, it, vi } from 'vitest';
import { getMediaFileSize } from '../src/services/mediaMetadata';
import type { MediaEntry } from '../src/types/messenger';

describe('media metadata', () => {
  it('reads and caches file size from a media handle', async () => {
    const getFile = vi.fn().mockResolvedValue(new File(['hello'], 'note.txt'));
    const entry: MediaEntry = {
      type: 'unknown',
      handle: { kind: 'file', name: 'note.txt', getFile },
    };

    await expect(getMediaFileSize(entry)).resolves.toBe(5);
    await expect(getMediaFileSize(entry)).resolves.toBe(5);
    expect(getFile).toHaveBeenCalledOnce();
  });

  it('returns an unknown size when the file cannot be read', async () => {
    const entry: MediaEntry = {
      type: 'unknown',
      handle: {
        kind: 'file',
        name: 'missing.txt',
        getFile: vi.fn().mockRejectedValue(new Error('unreadable')),
      },
    };

    await expect(getMediaFileSize(entry)).resolves.toBeNull();
  });
});
