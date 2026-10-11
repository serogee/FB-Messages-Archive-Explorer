import type { ResolvedAttachment, SelectableItem } from '../types/messenger';

export function normalizeAttachmentPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function getAttachmentIdentity(item: Pick<ResolvedAttachment, 'category' | 'mediaPath'>): string {
  return `${item.category}:${normalizeAttachmentPath(item.mediaPath)}`;
}

export function getSelectableItemIdentity(item: SelectableItem): string {
  return item.category === 'links'
    ? `links:${item.messageIndex}:${item.url}`
    : getAttachmentIdentity(item);
}

export function countUniqueSelectableItems(items: SelectableItem[]): number {
  return new Set(items.map(getSelectableItemIdentity)).size;
}
