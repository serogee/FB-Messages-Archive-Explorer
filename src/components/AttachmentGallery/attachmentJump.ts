import type { GalleryCategory } from '../../hooks/useAttachments';
import type { SelectableItem } from '../../types/messenger';

export function getAttachmentJumpTab(
  currentTab: GalleryCategory | undefined,
  itemCategory: SelectableItem['category'],
): GalleryCategory {
  return currentTab === itemCategory ? itemCategory : 'all';
}
