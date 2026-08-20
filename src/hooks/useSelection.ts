import { useState, useCallback, useRef } from 'react';
import type { ResolvedAttachment } from '../types/messenger';

export function useSelection() {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Keep a ref in sync so isSelected doesn't need selectedKeys in its dep array
  const keysRef = useRef(selectedKeys);
  keysRef.current = selectedKeys;

  const toggle = useCallback((attachment: ResolvedAttachment) => {
    const key = `${attachment.category}:${attachment.mediaPath.toLowerCase()}`;
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
  }, []);

  // Stable reference — reads from ref, never changes identity
  const isSelected = useCallback(
    (attachment: ResolvedAttachment) => {
      const key = `${attachment.category}:${attachment.mediaPath.toLowerCase()}`;
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

  const selectedCount = selectedKeys.size;

  return {
    selectedKeys,
    toggle,
    deselectAll,
    isSelected,
    selectedCount,
    getSelectedAttachments,
  };
}
