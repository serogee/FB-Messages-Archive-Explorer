import type { ResolvedAttachment, ResolvedLink } from '../../types/messenger';

export type GalleryItem = ResolvedAttachment | ResolvedLink;

const GRID_MIN_WIDTH = 110;
const GRID_GAP = 4;
const MONTH_HEADER_HEIGHT = 34;
const GROUP_BOTTOM_MARGIN = 8;

export interface GalleryGroup {
  key: string;
  label: string;
  items: GalleryItem[];
}

export type GalleryLayoutRow =
  | { type: 'header'; key: string; label: string; top: number; height: number }
  | { type: 'items'; key: string; label: string; items: GalleryItem[]; top: number; height: number };

export interface GalleryLayout {
  columns: number;
  itemSize: number;
  itemHeight: number;
  totalHeight: number;
  rows: GalleryLayoutRow[];
}

/** Finds the active month without scanning every preceding virtual row. */
export function getStickyMonth(rows: GalleryLayoutRow[], scrollTop: number): string {
  let low = 0;
  let high = rows.length;
  const target = scrollTop + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].top <= target) low = middle + 1;
    else high = middle;
  }

  const row = rows[low - 1];
  if (!row) return '';
  return row.type === 'header' && scrollTop <= row.top ? '' : row.label;
}

export function calculateGalleryLayout(
  groups: GalleryGroup[],
  width: number,
  minWidth = GRID_MIN_WIDTH,
  gap = GRID_GAP,
  fixedItemHeight?: number,
): GalleryLayout {
  if (width <= 0 || groups.length === 0) {
    return { columns: 1, itemSize: minWidth, itemHeight: fixedItemHeight || minWidth, totalHeight: 0, rows: [] };
  }

  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const itemSize = Math.max(1, (width - gap * (columns - 1)) / columns);
  const itemHeight = fixedItemHeight || itemSize;
  const rows: GalleryLayoutRow[] = [];
  let top = 0;

  for (const group of groups) {
    rows.push({ type: 'header', key: `header:${group.key}`, label: group.label, top, height: MONTH_HEADER_HEIGHT });
    top += MONTH_HEADER_HEIGHT;

    for (let index = 0; index < group.items.length; index += columns) {
      const isLastRow = index + columns >= group.items.length;
      const height = itemHeight + (isLastRow ? GROUP_BOTTOM_MARGIN : gap);
      rows.push({
        type: 'items',
        key: `items:${group.key}:${index}`,
        label: group.label,
        items: group.items.slice(index, index + columns),
        top,
        height,
      });
      top += height;
    }
  }

  return { columns, itemSize, itemHeight, totalHeight: top, rows };
}
