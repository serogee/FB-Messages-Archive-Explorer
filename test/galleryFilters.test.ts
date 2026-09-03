import { describe, expect, it, vi } from 'vitest';
import {
  applyGalleryFilters,
  getGallerySenderOptions,
  getGallerySenderSearchResults,
  normalizeGallerySender,
  parseGallerySenderSearch,
  removeGallerySenderFilter,
  setGallerySenderFilter,
  shouldClearFiltersForGalleryJump,
  toggleGallerySenderFilter,
  type GalleryFilterState,
} from '../src/hooks/useGalleryFilters';
import { addItemsToSelection, removeItemsFromSelection, shouldConfirmBulkSelection, sortSelectableItemsNewestFirst } from '../src/hooks/useSelection';
import type { ResolvedAttachment, ResolvedLink, SelectableItem } from '../src/types/messenger';

function attachment(sender: string, index: number): ResolvedAttachment {
  return {
    mediaPath: `photos/${sender}-${index}.jpg`,
    category: 'photos',
    messageIndex: index,
    timestamp: index,
    sender,
    mediaEntry: null,
  };
}

function link(sender: string, index: number): ResolvedLink {
  return {
    category: 'links',
    url: `https://example.com/${index}`,
    messageIndex: index,
    timestamp: index,
    sender,
  };
}

function filters(overrides: Partial<GalleryFilterState> = {}): GalleryFilterState {
  return {
    includeSenders: new Set(),
    excludeSenders: new Set(),
    bookmarkFilter: 'all',
    searchQuery: '',
    ...overrides,
  };
}

describe('attachment gallery filters', () => {
  const items: SelectableItem[] = [
    attachment('Alice', 1),
    attachment('ALICE', 2),
    attachment('Bob', 3),
    link('Carol', 4),
  ];

  it('normalizes sender identity without changing display data', () => {
    expect(normalizeGallerySender('  ALIce ')).toBe('alice');
  });

  it('unions chat participants with attachment senders and marks current-tab availability', () => {
    const options = getGallerySenderOptions(['Alice', 'Dave'], items, [items[0]]);

    expect(options.map(option => option.key)).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(options.find(option => option.key === 'alice')?.hasCurrentTabItems).toBe(true);
    expect(options.find(option => option.key === 'bob')?.hasCurrentTabItems).toBe(false);
    expect(options.find(option => option.key === 'dave')?.hasCurrentTabItems).toBe(false);
  });

  it('uses sender operators anywhere in the query and limits results to five', () => {
    const senders = Array.from({ length: 8 }, (_, index) => ({ label: `Person ${index}` }));

    expect(parseGallerySenderSearch(' - person')).toEqual({ mode: 'exclude', term: 'person', currentTabOnly: false });
    expect(parseGallerySenderSearch('+ Person 2')).toEqual({ mode: 'include', term: 'person 2', currentTabOnly: false });
    expect(parseGallerySenderSearch('.- Person 3')).toEqual({ mode: 'exclude', term: 'person 3', currentTabOnly: true });
    expect(parseGallerySenderSearch('Person.+ 4')).toEqual({ mode: 'include', term: '4', currentTabOnly: true });
    expect(parseGallerySenderSearch('Existing search + Person 5')).toEqual({ mode: 'include', term: 'person 5', currentTabOnly: false });
    expect(parseGallerySenderSearch('Person 6')).toEqual({ mode: 'include', term: 'person 6', currentTabOnly: false });
    expect(getGallerySenderSearchResults(senders, '+person')).toHaveLength(5);
    expect(getGallerySenderSearchResults(senders, '-Person 6')).toEqual([{ label: 'Person 6' }]);
    expect(getGallerySenderSearchResults(senders, 'son 4')).toEqual([{ label: 'Person 4' }]);
  });

  it('supports the gallery dropdown maximum of 20 matching senders', () => {
    const senders = Array.from({ length: 25 }, (_, index) => ({ label: `Person ${index}` }));
    expect(getGallerySenderSearchResults(senders, 'person', 20)).toHaveLength(20);
  });

  it('returns the original array when no filters are active', () => {
    expect(applyGalleryFilters(items, filters(), () => false)).toBe(items);
  });

  it('applies case-insensitive inclusive OR filtering', () => {
    const result = applyGalleryFilters(
      items,
      filters({ includeSenders: new Set(['alice', 'carol']) }),
      () => false,
    );

    expect(result.map(item => item.sender)).toEqual(['Alice', 'ALICE', 'Carol']);
  });

  it('applies exclusions after inclusive matching', () => {
    const result = applyGalleryFilters(
      items,
      filters({ includeSenders: new Set(['alice', 'bob']), excludeSenders: new Set(['bob']) }),
      () => false,
    );

    expect(result.map(item => item.sender)).toEqual(['Alice', 'ALICE']);
  });

  it('searches link URLs, link labels, and attachment filenames', () => {
    const searchableItems: SelectableItem[] = [
      { ...link('Alice', 1), url: 'https://drive.google.com/example' },
      { ...link('Bob', 2), label: 'Project notes' },
      { ...attachment('Carol', 3), mediaPath: 'files/Quarterly Report.pdf' },
    ];

    expect(applyGalleryFilters(searchableItems, filters({ searchQuery: 'drive' }), () => false)).toEqual([searchableItems[0]]);
    expect(applyGalleryFilters(searchableItems, filters({ searchQuery: 'notes' }), () => false)).toEqual([searchableItems[1]]);
    expect(applyGalleryFilters(searchableItems, filters({ searchQuery: 'report' }), () => false)).toEqual([searchableItems[2]]);
  });

  it('checks bookmark membership only when a bookmark filter is active', () => {
    const isBookmarked = vi.fn((item: SelectableItem) => item.messageIndex === 3);
    expect(applyGalleryFilters(items, filters(), isBookmarked)).toBe(items);
    expect(isBookmarked).not.toHaveBeenCalled();

    expect(applyGalleryFilters(
      items,
      filters({ bookmarkFilter: 'bookmarked' }),
      isBookmarked,
    )).toEqual([items[2]]);
  });

  it('atomically prevents a sender from being both included and excluded', () => {
    const included = toggleGallerySenderFilter(filters(), 'Alice', 'include');
    const excluded = toggleGallerySenderFilter(included, 'ALICE', 'exclude');

    expect(excluded.includeSenders.has('alice')).toBe(false);
    expect(excluded.excludeSenders.has('alice')).toBe(true);
    expect(toggleGallerySenderFilter(excluded, 'alice', 'exclude').excludeSenders.has('alice')).toBe(false);
  });

  it('sets, switches, and removes an explicit sender filter', () => {
    const included = setGallerySenderFilter(filters(), 'Alice', 'include');
    expect(setGallerySenderFilter(included, 'alice', 'include')).toBe(included);

    const excluded = setGallerySenderFilter(included, 'ALICE', 'exclude');
    expect(excluded.includeSenders.has('alice')).toBe(false);
    expect(excluded.excludeSenders.has('alice')).toBe(true);
    expect(removeGallerySenderFilter(excluded, 'Alice')).toEqual(filters());
  });

  it('clears filters of the opposite polarity when adding a sender', () => {
    const included = setGallerySenderFilter(
      setGallerySenderFilter(filters(), 'Alice', 'include'),
      'Bob',
      'include',
    );
    const excluded = setGallerySenderFilter(included, 'Carol', 'exclude');

    expect(included.includeSenders).toEqual(new Set(['alice', 'bob']));
    expect(excluded.includeSenders.size).toBe(0);
    expect(excluded.excludeSenders).toEqual(new Set(['carol']));
  });

  it('clears active filters only when they hide a requested jump target', () => {
    expect(shouldClearFiltersForGalleryJump(items, [items[2]], items[0], true)).toBe(true);
    expect(shouldClearFiltersForGalleryJump(items, items, items[0], true)).toBe(false);
    expect(shouldClearFiltersForGalleryJump(items, [items[2]], items[0], false)).toBe(false);
    expect(shouldClearFiltersForGalleryJump(items, [], attachment('Missing', 99), true)).toBe(false);
  });
});

describe('bulk gallery selection', () => {
  it('orders selected attachments and links from most recent to oldest', () => {
    const oldestPhoto = attachment('Alice', 1);
    const newestLink = link('Bob', 3);
    const middlePhoto = attachment('Carol', 2);

    expect(sortSelectableItemsNewestFirst([oldestPhoto, newestLink, middlePhoto])).toEqual([
      newestLink,
      middlePhoto,
      oldestPhoto,
    ]);
  });

  it('adds attachments and links without toggling or duplicating existing keys', () => {
    const photo = attachment('Alice', 1);
    const samePhotoPath = { ...photo, messageIndex: 99 };
    const sharedLink = link('Alice', 2);
    const selected = addItemsToSelection(new Set(['photos:already-selected.jpg']), [
      photo,
      samePhotoPath,
      sharedLink,
    ]);

    expect(selected).toEqual(new Set([
      'photos:already-selected.jpg',
      `photos:${photo.mediaPath.toLowerCase()}`,
      `links:${sharedLink.messageIndex}:${sharedLink.url}`,
    ]));
  });

  it('removes only the items in the current filtered result', () => {
    const photo = attachment('Alice', 1);
    const sharedLink = link('Alice', 2);
    const outsideCurrentFilter = 'photos:outside-filter.jpg';
    const selected = addItemsToSelection(new Set([outsideCurrentFilter]), [photo, sharedLink]);

    expect(removeItemsFromSelection(selected, [photo, sharedLink])).toEqual(new Set([
      outsideCurrentFilter,
    ]));
  });

  it('requires confirmation only above the 500-item safety threshold', () => {
    expect(shouldConfirmBulkSelection(500)).toBe(false);
    expect(shouldConfirmBulkSelection(501)).toBe(true);
  });
});
