import type { ChatListEntry } from '../types/messenger';

const CHAT_SECTIONS = /^(?:inbox|archived_threads|message_requests|e2ee_cutover|filtered_threads)\//i;

export function isRemoteAttachmentPath(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

export function getSharedStickerFileName(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if ([...normalized].some(character => character.charCodeAt(0) < 32) || /[:%?#]/.test(normalized)) return null;
  const match = /^(?:(?:your_facebook_activity|your_instagram_activity)\/messages\/|messages\/)?stickers_used\/([^/]+)$/i.exec(normalized);
  return match && /\.(?:jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(match[1]) ? match[1] : null;
}

export function getSharedStickerIdentity(path: string): string | null {
  const name = getSharedStickerFileName(path);
  return name ? `stickers_used/${name.toLowerCase()}` : null;
}

export function getMetaChatId(entry: Pick<ChatListEntry, 'source' | 'folderName'>): string {
  const section = entry.source === 'requests' ? 'message_requests'
    : entry.source === 'archived' ? 'archived_threads'
    : entry.source === 'e2ee' ? 'e2ee_cutover' : 'inbox';
  return `${section}/${entry.folderName}`;
}

/** Resolve only local export paths; a basename never identifies another chat's file. */
export function getMetaAttachmentPath(reference: string, chatId?: string, category?: string): string | null {
  const normalized = reference.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /[:%?#]/.test(normalized)
    || [...normalized].some(character => character.charCodeAt(0) < 32)) return null;
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  const prefix = /^(?:(?:your_facebook_activity|your_instagram_activity)\/)?messages\//i;
  if (prefix.test(normalized)) {
    const relative = normalized.replace(prefix, '');
    return relative.includes('/') ? relative : null;
  }
  if (/^stickers_used\//i.test(normalized) || CHAT_SECTIONS.test(normalized)) return normalized;
  if (!chatId) return null;
  if (/^(?:photos|videos|audio|gifs|files|stickers)\//i.test(normalized)) return `${chatId}/${normalized}`;
  if (!normalized.includes('/') && category && /^(?:photos|videos|audio|audio_files|gifs|files)$/.test(category)) {
    return `${chatId}/${category === 'audio_files' ? 'audio' : category}/${normalized}`;
  }
  return null;
}

export function getMetaAttachmentIdentity(reference: string, chatId?: string, category?: string): string | null {
  return getMetaAttachmentPath(reference, chatId, category)?.toLowerCase() || null;
}

export function getAttachmentFolderChatId(relativePath: string): string | null {
  return CHAT_SECTIONS.test(relativePath) ? relativePath.split('/').slice(0, 2).join('/') : null;
}
