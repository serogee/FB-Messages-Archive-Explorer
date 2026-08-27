// Settings storage is best-effort: prefer localStorage, fall back to cookies,
// and never block startup when either mechanism is unavailable.
const STORAGE_PREFIX = 'majv_' + (window.location.hostname || 'local') + '_';

function setCookie(name: string, value: string, days = 365): void {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie =
      encodeURIComponent(name) + '=' + encodeURIComponent(value) +
      '; expires=' + expires + '; path=/';
  } catch {}
}

function getCookie(name: string): string | null {
  try {
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (const c of cookies) {
      const [k, v] = c.split('=');
      if (decodeURIComponent(k) === name) return decodeURIComponent(v || '');
    }
  } catch {}
  return null;
}

export function storageSet(key: string, value: string): void {
  const k = STORAGE_PREFIX + key;
  try { localStorage.setItem(k, String(value)); return; } catch {}
  try { setCookie(k, String(value)); } catch {}
}

export function storageGet(key: string): string | null {
  const k = STORAGE_PREFIX + key;
  try { const v = localStorage.getItem(k); if (v !== null) return v; } catch {}
  try { const v = getCookie(k); if (v !== null) return v; } catch {}
  return null;
}

export function storageRemove(key: string): void {
  const k = STORAGE_PREFIX + key;
  try { localStorage.removeItem(k); } catch {}
  try { setCookie(k, '', -1); } catch {}
}

export function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
  );
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export function formatInfoNumber(value: number): string {
  return Number(value || 0).toLocaleString();
}

export function formatInfoDate(timestamp: number | null): string {
  return timestamp
    ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'Unknown';
}

export function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
