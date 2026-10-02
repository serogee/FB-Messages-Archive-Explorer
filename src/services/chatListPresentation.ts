import type { ChatListEntry } from '../types/messenger';
import { formatFileSize } from './storage';

export function getAvatarChar(title: string): string {
  return (title || '?').trim().charAt(0).toUpperCase();
}

export function getAvatarColor(title: string): string {
  const colors = [
    '#0084ff', '#44bec7', '#fa3c4c', '#d696bb',
    '#6d86d4', '#1da1f2', '#e75d5d', '#5bb974',
  ];
  let hash = 0;
  for (let index = 0; index < title.length; index++) hash = (hash * 31 + title.charCodeAt(index)) & 0xffffff;
  return colors[Math.abs(hash) % colors.length];
}

export function formatEntrySize(entry: ChatListEntry): string {
  if (entry._messengerExport && !entry._sizeIncludesMedia) return `${formatFileSize(entry.folderSize)} + media`;
  if (entry.folderSize <= 0) return `${entry.jsonFileCount} json + media`;
  return formatFileSize(entry.folderSize);
}
