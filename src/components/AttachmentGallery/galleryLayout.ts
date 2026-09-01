import type { ResolvedAttachment } from '../../types/messenger';

const GRID_MIN_WIDTH = 110;
const GRID_GAP = 4;
const MONTH_HEADER_HEIGHT = 34;
const GROUP_BOTTOM_MARGIN = 8;

export interface GalleryGroup {
  key: string;
  label: string;
  items: ResolvedAttachment[];
}

export type GalleryLayoutRow =
  | { type: 'header'; key: string; label: string; top: number; height: number }
  | { type: 'items'; key: string; label: string; items: ResolvedAttachment[]; top: number; height: number };

export interface GalleryLayout {
  columns: number;
  itemSize: number;
  totalHeight: number;
  rows: GalleryLayoutRow[];
}

export function calculateGalleryLayout(
  groups: GalleryGroup[],
  width: number,
  minWidth = GRID_MIN_WIDTH,
  gap = GRID_GAP,
): GalleryLayout {
  if (width <= 0 || groups.length === 0) {
    return { columns: 1, itemSize: minWidth, totalHeight: 0, rows: [] };
  }

  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const itemSize = Math.max(1, (width - gap * (columns - 1)) / columns);
  const rows: GalleryLayoutRow[] = [];
  let top = 0;

  for (const group of groups) {
    rows.push({ type: 'header', key: `header:${group.key}`, label: group.label, top, height: MONTH_HEADER_HEIGHT });
    top += MONTH_HEADER_HEIGHT;

    for (let index = 0; index < group.items.length; index += columns) {
      const isLastRow = index + columns >= group.items.length;
      const height = itemSize + (isLastRow ? GROUP_BOTTOM_MARGIN : gap);
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

  return { columns, itemSize, totalHeight: top, rows };
}
