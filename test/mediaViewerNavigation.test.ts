import { describe, expect, it } from 'vitest';
import { getAttachmentJumpTab } from '../src/components/AttachmentGallery/attachmentJump';
import { findNextNavigableIndex } from '../src/components/MediaViewer/mediaViewerNavigation';

describe('selected-item viewer navigation', () => {
  it('skips items that are no longer selected without removing the current item', () => {
    const items = ['first', 'current', 'removed', 'next'];
    const selected = new Set(['first', 'next']);

    expect(findNextNavigableIndex(items, 1, 1, item => selected.has(item))).toBe(3);
    expect(findNextNavigableIndex(items, 1, -1, item => selected.has(item))).toBe(0);
  });

  it('disables traversal when no selected item remains in that direction', () => {
    expect(findNextNavigableIndex(['current', 'removed'], 0, 1, () => false)).toBe(-1);
  });
});

describe('attachment jump tab', () => {
  it('keeps a matching category tab', () => {
    expect(getAttachmentJumpTab('photos', 'photos')).toBe('photos');
  });

  it('uses All when the current tab does not match the item category', () => {
    expect(getAttachmentJumpTab('files', 'photos')).toBe('all');
    expect(getAttachmentJumpTab(undefined, 'photos')).toBe('all');
  });
});
