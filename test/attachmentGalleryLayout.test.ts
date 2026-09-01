import { describe, expect, it } from 'vitest';
import { calculateGalleryLayout, getStickyMonth } from '../src/components/AttachmentGallery/galleryLayout';
import type { ResolvedAttachment } from '../src/types/messenger';

function attachments(count: number): ResolvedAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    mediaPath: `media/photo-${index}.jpg`,
    category: 'photos',
    messageIndex: index,
    timestamp: index,
    sender: 'Tester',
    mediaEntry: null,
  }));
}

describe('attachment gallery layout', () => {
  it('calculates responsive month headers and fixed thumbnail rows', () => {
    const layout = calculateGalleryLayout([
      { key: 'first', label: 'January 2026', items: attachments(7) },
      { key: 'second', label: 'December 2025', items: attachments(2) },
    ], 338);

    expect(layout.columns).toBe(3);
    expect(layout.itemSize).toBe(110);
    expect(layout.rows.filter(row => row.type === 'header')).toHaveLength(2);
    expect(layout.rows.filter(row => row.type === 'items')).toHaveLength(4);
    expect(layout.rows.every((row, index) => index === 0 || row.top >= layout.rows[index - 1].top + layout.rows[index - 1].height)).toBe(true);
  });

  it('represents thousands of attachments as rows rather than mounted tiles', () => {
    const layout = calculateGalleryLayout([
      { key: 'large', label: 'January 2026', items: attachments(3_000) },
    ], 566);

    expect(layout.columns).toBe(5);
    expect(layout.rows).toHaveLength(601);
    expect(layout.totalHeight).toBeGreaterThan(0);
  });

  it('finds the sticky month while hiding it at a visible header boundary', () => {
    const layout = calculateGalleryLayout([
      { key: 'first', label: 'January 2026', items: attachments(7) },
      { key: 'second', label: 'December 2025', items: attachments(2) },
    ], 338);
    const secondHeader = layout.rows.find(row => row.type === 'header' && row.label === 'December 2025');

    expect(getStickyMonth(layout.rows, 0)).toBe('');
    expect(getStickyMonth(layout.rows, 10)).toBe('January 2026');
    expect(secondHeader).toBeDefined();
    expect(getStickyMonth(layout.rows, secondHeader!.top)).toBe('');
    expect(getStickyMonth(layout.rows, secondHeader!.top + 2)).toBe('December 2025');
  });
});
