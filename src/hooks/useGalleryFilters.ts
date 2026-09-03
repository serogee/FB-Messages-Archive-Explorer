import { useCallback, useMemo, useState } from 'react';
import type { SelectableItem } from '../types/messenger';

export type GalleryBookmarkFilter = 'all' | 'bookmarked' | 'not-bookmarked';

export interface GalleryFilterState {
  includeSenders: Set<string>;
  excludeSenders: Set<string>;
  bookmarkFilter: GalleryBookmarkFilter;
}

export interface GallerySenderOption {
  key: string;
  label: string;
  hasCurrentTabItems: boolean;
}

const EMPTY_FILTER_STATE: GalleryFilterState = {
  includeSenders: new Set(),
  excludeSenders: new Set(),
  bookmarkFilter: 'all',
};

export function normalizeGallerySender(name: string): string {
  return name.trim().toLowerCase();
}

export function parseGallerySenderSearch(query: string): {
  mode: 'include' | 'exclude';
  term: string;
  currentTabOnly: boolean;
} {
  let trimmed = query.trimStart();
  const currentTabOnly = trimmed.startsWith('.');
  if (currentTabOnly) trimmed = trimmed.slice(1).trimStart();
  return {
    mode: trimmed.startsWith('-') ? 'exclude' : 'include',
    term: trimmed.replace(/^[+-]\s*/, '').trim().toLowerCase(),
    currentTabOnly,
  };
}

export function getGallerySenderSearchResults<T extends { label: string }>(
  senders: T[],
  query: string,
  limit = 5,
): T[] {
  const { term } = parseGallerySenderSearch(query);
  return senders
    .filter(sender => sender.label.toLowerCase().includes(term))
    .slice(0, limit);
}

export function getGallerySenderOptions(
  participantNames: string[],
  allItems: SelectableItem[],
  currentItems: SelectableItem[],
): GallerySenderOption[] {
  const labels = new Map<string, string>();
  for (const item of allItems) {
    const key = normalizeGallerySender(item.sender);
    if (key && !labels.has(key)) labels.set(key, item.sender.trim() || 'Unknown');
  }
  for (const name of participantNames) {
    const key = normalizeGallerySender(name);
    if (key && !labels.has(key)) labels.set(key, name.trim());
  }

  const currentSenders = new Set(currentItems.map(item => normalizeGallerySender(item.sender)));
  return [...labels]
    .map(([key, label]) => ({ key, label, hasCurrentTabItems: currentSenders.has(key) }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
}

export function toggleGallerySenderFilter(
  previous: GalleryFilterState,
  name: string,
  mode: 'include' | 'exclude',
): GalleryFilterState {
  const sender = normalizeGallerySender(name);
  if (!sender) return previous;
  const includeSenders = new Set(previous.includeSenders);
  const excludeSenders = new Set(previous.excludeSenders);
  const activeSet = mode === 'include' ? includeSenders : excludeSenders;
  const oppositeSet = mode === 'include' ? excludeSenders : includeSenders;

  if (activeSet.has(sender)) activeSet.delete(sender);
  else {
    activeSet.add(sender);
    oppositeSet.clear();
  }
  return { ...previous, includeSenders, excludeSenders };
}

export function setGallerySenderFilter(
  previous: GalleryFilterState,
  name: string,
  mode: 'include' | 'exclude',
): GalleryFilterState {
  const sender = normalizeGallerySender(name);
  if (!sender) return previous;
  const includeSenders = new Set(previous.includeSenders);
  const excludeSenders = new Set(previous.excludeSenders);
  if ((mode === 'include' && includeSenders.has(sender) && excludeSenders.size === 0)
    || (mode === 'exclude' && excludeSenders.has(sender) && includeSenders.size === 0)) {
    return previous;
  }
  if (mode === 'include') {
    includeSenders.add(sender);
    excludeSenders.clear();
  } else {
    excludeSenders.add(sender);
    includeSenders.clear();
  }
  return { ...previous, includeSenders, excludeSenders };
}

export function removeGallerySenderFilter(
  previous: GalleryFilterState,
  name: string,
): GalleryFilterState {
  const sender = normalizeGallerySender(name);
  if (!sender || (!previous.includeSenders.has(sender) && !previous.excludeSenders.has(sender))) {
    return previous;
  }
  const includeSenders = new Set(previous.includeSenders);
  const excludeSenders = new Set(previous.excludeSenders);
  includeSenders.delete(sender);
  excludeSenders.delete(sender);
  return { ...previous, includeSenders, excludeSenders };
}

export function applyGalleryFilters<T extends SelectableItem>(
  items: T[],
  filters: GalleryFilterState,
  isBookmarked: (item: SelectableItem) => boolean,
): T[] {
  const { includeSenders, excludeSenders, bookmarkFilter } = filters;
  if (includeSenders.size === 0 && excludeSenders.size === 0 && bookmarkFilter === 'all') {
    return items;
  }

  return items.filter(item => {
    const sender = normalizeGallerySender(item.sender);
    if (includeSenders.size > 0 && !includeSenders.has(sender)) return false;
    if (excludeSenders.has(sender)) return false;

    if (bookmarkFilter !== 'all') {
      const bookmarked = isBookmarked(item);
      if (bookmarkFilter === 'bookmarked' && !bookmarked) return false;
      if (bookmarkFilter === 'not-bookmarked' && bookmarked) return false;
    }

    return true;
  });
}

function getGalleryFilterItemKey(item: SelectableItem): string {
  return item.category === 'links'
    ? `links:${item.messageIndex}:${item.url}`
    : `${item.category}:${item.messageIndex}:${item.mediaPath.toLowerCase()}`;
}

export function shouldClearFiltersForGalleryJump(
  unfilteredItems: SelectableItem[],
  filteredItems: SelectableItem[],
  target: SelectableItem,
  hasActiveFilters: boolean,
): boolean {
  if (!hasActiveFilters) return false;
  const targetKey = getGalleryFilterItemKey(target);
  return unfilteredItems.some(item => getGalleryFilterItemKey(item) === targetKey)
    && !filteredItems.some(item => getGalleryFilterItemKey(item) === targetKey);
}

export function useGalleryFilters() {
  const [filters, setFilters] = useState<GalleryFilterState>(EMPTY_FILTER_STATE);

  const toggleIncludeSender = useCallback((name: string) => {
    setFilters(previous => toggleGallerySenderFilter(previous, name, 'include'));
  }, []);

  const toggleExcludeSender = useCallback((name: string) => {
    setFilters(previous => toggleGallerySenderFilter(previous, name, 'exclude'));
  }, []);

  const setSenderFilter = useCallback((name: string, mode: 'include' | 'exclude') => {
    setFilters(previous => setGallerySenderFilter(previous, name, mode));
  }, []);

  const removeSenderFilter = useCallback((name: string) => {
    setFilters(previous => removeGallerySenderFilter(previous, name));
  }, []);

  const setBookmarkFilter = useCallback((bookmarkFilter: GalleryBookmarkFilter) => {
    setFilters(previous => previous.bookmarkFilter === bookmarkFilter
      ? previous
      : { ...previous, bookmarkFilter });
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters(previous => (
      previous.includeSenders.size === 0
      && previous.excludeSenders.size === 0
      && previous.bookmarkFilter === 'all'
        ? previous
        : { includeSenders: new Set(), excludeSenders: new Set(), bookmarkFilter: 'all' }
    ));
  }, []);

  const hasActiveFilters = filters.includeSenders.size > 0
    || filters.excludeSenders.size > 0
    || filters.bookmarkFilter !== 'all';

  return useMemo(() => ({
    ...filters,
    hasActiveFilters,
    toggleIncludeSender,
    toggleExcludeSender,
    setSenderFilter,
    removeSenderFilter,
    setBookmarkFilter,
    clearAllFilters,
  }), [
    clearAllFilters,
    filters,
    hasActiveFilters,
    removeSenderFilter,
    setBookmarkFilter,
    setSenderFilter,
    toggleExcludeSender,
    toggleIncludeSender,
  ]);
}
