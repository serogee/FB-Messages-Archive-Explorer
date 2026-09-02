import { useState, useCallback, useRef } from 'react';
import type { ResolvedAttachment, SelectableItem } from '../types/messenger';

function getSelectionKey(item: SelectableItem): string {
  return item.category === 'links'
    ? `links:${item.messageIndex}:${item.url}`
    : `${item.category}:${item.mediaPath.toLowerCase()}`;
}

export function useSelection() {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [clearVersion, setClearVersion] = useState(0);
  // Stable selection callbacks avoid rerendering every memoized gallery thumbnail.
  const keysRef = useRef(selectedKeys);
  keysRef.current = selectedKeys;

  const toggle = useCallback((item: SelectableItem) => {
    const key = getSelectionKey(item);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedKeys(new Set());
    setClearVersion((version) => version + 1);
  }, []);

  const isSelected = useCallback(
    (item: SelectableItem) => {
      const key = getSelectionKey(item);
      return keysRef.current.has(key);
    },
    []
  );

  const getSelectedAttachments = useCallback(
    (allAttachments: ResolvedAttachment[]) => {
      return allAttachments.filter(att => {
        const key = `${att.category}:${att.mediaPath.toLowerCase()}`;
        return keysRef.current.has(key);
      });
    },
    []
  );

  const getSelectedItems = useCallback(
    (items: SelectableItem[]) => items.filter(item => keysRef.current.has(getSelectionKey(item))),
    []
  );

  const selectedCount = selectedKeys.size;

  return {
    selectedKeys,
    toggle,
    deselectAll,
    isSelected,
    selectedCount,
    clearVersion,
    getSelectedAttachments,
    getSelectedItems,
  };
}
