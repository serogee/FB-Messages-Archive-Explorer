import type { GalleryCategory } from '../hooks/useAttachments';
import type { GalleryBookmarkFilter } from '../hooks/useGalleryFilters';
import type { SelectableItem } from '../types/messenger';
import { normalizeAttachmentPath } from './attachmentIdentity';

export type MobileScreen = 'home' | 'chat' | 'info' | 'gallery' | 'selected';
export type SidebarView = 'chats' | 'settings' | 'archived' | 'requests';

/** Occurrence identity, unlike the file identity used for bulk selection. */
export function getNavigationItemKey(item: SelectableItem): string {
  return item.category === 'links'
    ? `links:${item.messageIndex}:${item.url}`
    : `${item.category}:${item.messageIndex}:${normalizeAttachmentPath(item.mediaPath)}`;
}

export interface PreviewRequest {
  items: SelectableItem[];
  index: number;
  source: 'chat' | 'gallery' | 'selected';
  selectionMode?: boolean;
  reverseNavigation?: boolean;
  selectedNavigation?: boolean;
}

export interface PreviewLocation extends Omit<PreviewRequest, 'items' | 'index'> {
  keys: string[];
  currentKey: string;
}

export interface MessagePosition {
  index?: number;
  offset: number;
  scrollTop: number;
  atBottom: boolean;
}

export interface GallerySnapshot {
  highlightedKey?: string;
  tab: GalleryCategory;
  positions: Partial<Record<GalleryCategory, number>>;
  anchor?: { key: string; offset: number };
  filters: { include: string[]; exclude: string[]; bookmark: GalleryBookmarkFilter; query: string };
  expanded: boolean;
  senderSearch: string;
}

export interface NavigationSnapshot {
  message?: MessagePosition;
  gallery?: GallerySnapshot;
  sidebarScroll?: number;
  infoScroll?: number;
  selectedScroll?: number;
}

export interface NavigationLocation {
  screen: MobileScreen;
  chatId?: string;
  sidebarView: SidebarView;
  chatListView: Exclude<SidebarView, 'settings'>;
  galleryTab: GalleryCategory;
  messageTarget?: number;
  attachmentTarget?: string;
  preview?: PreviewLocation;
}

interface PreviewBase {
  location: NavigationLocation;
  snapshot: NavigationSnapshot;
  entry: number | null;
}

export interface NavigationState {
  location: NavigationLocation;
  snapshot?: NavigationSnapshot;
  revision: number;
  restoring: boolean;
  previewBase?: PreviewBase;
  returnTo?: { label: 'attachment' | 'message'; location: NavigationLocation; snapshot: NavigationSnapshot; entry: number | null; previewBase?: PreviewBase };
}

export const HOME_LOCATION: NavigationLocation = {
  screen: 'home', sidebarView: 'chats', chatListView: 'chats', galleryTab: 'all',
};

export function getParentLocation(location: NavigationLocation): NavigationLocation {
  const parent: MobileScreen = location.screen === 'selected' ? 'gallery'
    : location.screen === 'gallery' ? 'info'
    : location.screen === 'info' ? 'chat' : 'home';
  return {
    ...location, screen: parent, preview: undefined, messageTarget: undefined, attachmentTarget: undefined,
    sidebarView: parent === 'home' ? (location.sidebarView === 'settings' ? 'chats' : location.chatListView) : location.sidebarView,
  };
}

type HistoryPort = Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>;
type Marker = { session: string; entry: number };
const HISTORY_KEY = '__fbArchiveNavigation';
const collectionKeys = new WeakMap<SelectableItem[], string[]>();

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Only descriptors and IDs enter browser history. File handles and media stay in the app. */
export class MobileNavigationController {
  private state: NavigationState = { location: { ...HOME_LOCATION }, revision: 0, restoring: false };
  private listeners = new Set<() => void>();
  private entries = new Map<number, NavigationState>();
  private session = createSessionId();
  private sequence = 0;
  private currentEntry: number | null = null;
  private trail: number[] = [];
  private mobile = false;
  private previewClosePending = false;
  capture: () => NavigationSnapshot = () => ({});

  constructor(privatePort: HistoryPort) { this.port = privatePort; }
  private port: HistoryPort;
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  connect = () => {
    this.port.addEventListener('popstate', this.onPopState as EventListener);
    return () => this.port.removeEventListener('popstate', this.onPopState as EventListener);
  };
  setMobile(mobile: boolean) {
    this.mobile = mobile;
    if (mobile && this.currentEntry === null) this.writeEntry(false);
  }
  private publish(state: NavigationState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private marker(): Marker | undefined {
    return this.port.history.state?.[HISTORY_KEY];
  }
  private writeEntry(push: boolean) {
    const entry = ++this.sequence;
    if (push && this.currentEntry !== null) {
      const index = this.trail.indexOf(this.currentEntry);
      for (const removed of this.trail.splice(index + 1)) this.entries.delete(removed);
    }
    if (!push && this.currentEntry !== null) {
      const index = this.trail.indexOf(this.currentEntry);
      if (index >= 0) this.trail[index] = entry;
      this.entries.delete(this.currentEntry);
    } else this.trail.push(entry);
    this.currentEntry = entry;
    this.entries.set(entry, this.state);
    const previous = this.port.history.state;
    const historyState = { ...(previous && typeof previous === 'object' ? previous : {}),
      [HISTORY_KEY]: { session: this.session, entry } satisfies Marker };
    this.port.history[push ? 'pushState' : 'replaceState'](historyState, '');
  }
  private saveCurrent() {
    const snapshot = this.capture();
    this.state = { ...this.state, snapshot,
      ...(this.state.previewBase ? { previewBase: { ...this.state.previewBase, snapshot } } : {}) };
    if (this.currentEntry !== null) {
      this.entries.set(this.currentEntry, this.state);
    }
    return this.state;
  }
  navigate(location: NavigationLocation, returnLabel?: 'attachment' | 'message') {
    if (JSON.stringify(location) === JSON.stringify(this.state.location)) return;
    const source = this.saveCurrent();
    const returnTo = returnLabel ? { label: returnLabel, location: source.location, snapshot: source.snapshot!, entry: this.currentEntry,
      ...(source.previewBase ? { previewBase: source.previewBase } : {}) } : undefined;
    const previewBase = location.preview ? source.previewBase ?? {
      location: { ...source.location, preview: undefined }, snapshot: source.snapshot!, entry: this.currentEntry,
    } : undefined;
    this.publish({ location, revision: this.state.revision + 1, restoring: false,
      ...(returnTo ? { returnTo } : {}), ...(previewBase ? { previewBase } : {}) });
    if (this.mobile) this.writeEntry(true);
    else if (this.currentEntry !== null) this.entries.set(this.currentEntry, this.state);
  }
  update(location: NavigationLocation) {
    this.publish({ ...this.state, location, previewBase: location.preview ? this.state.previewBase : undefined });
    if (this.currentEntry !== null) this.entries.set(this.currentEntry, this.state);
  }
  parent() { this.navigate(getParentLocation(this.state.location)); }
  returnFromJump() {
    const target = this.state.returnTo;
    if (!target) return;
    const index = this.currentEntry === null ? -1 : this.trail.indexOf(this.currentEntry);
    if (this.mobile && target.entry !== null && index > 0 && this.trail[index - 1] === target.entry
      && this.marker()?.session === this.session && this.marker()?.entry === this.currentEntry
      && JSON.stringify(this.entries.get(target.entry)?.location) === JSON.stringify(target.location)) {
      this.port.history.back();
      return;
    }
    this.saveCurrent();
    this.publish({ location: target.location, snapshot: target.snapshot, revision: this.state.revision + 1, restoring: true,
      ...(target.previewBase ? { previewBase: target.previewBase } : {}) });
    if (this.mobile) this.writeEntry(true);
    else if (this.currentEntry !== null) this.entries.set(this.currentEntry, this.state);
  }
  dismissJumpReturn() {
    const { returnTo: _returnTo, ...state } = this.state;
    this.publish(state);
    if (this.currentEntry !== null) this.entries.set(this.currentEntry, this.state);
  }
  openPreview(request: PreviewRequest) {
    const item = request.items[request.index];
    if (!item) return;
    const { items, index: _index, ...options } = request;
    let keys = collectionKeys.get(items);
    if (!keys) { keys = items.map(getNavigationItemKey); collectionKeys.set(items, keys); }
    this.navigate({ ...this.state.location, preview: {
      ...options, keys, currentKey: getNavigationItemKey(item),
    } });
  }
  updatePreview(item: SelectableItem) {
    const preview = this.state.location.preview;
    const currentKey = getNavigationItemKey(item);
    if (preview && preview.currentKey !== currentKey) {
      this.update({ ...this.state.location, preview: { ...preview, currentKey } });
    }
  }
  closePreview() {
    if (!this.state.location.preview || this.previewClosePending) return;
    const source = this.saveCurrent();
    const base = source.previewBase ?? {
      location: { ...source.location, preview: undefined }, snapshot: source.snapshot!, entry: null,
    };
    const index = this.currentEntry === null ? -1 : this.trail.indexOf(this.currentEntry);
    const previousEntry = index > 0 ? this.trail[index - 1] : undefined;
    const previous = previousEntry === undefined ? undefined : this.entries.get(previousEntry);
    if (this.mobile && base.entry !== null && previousEntry === base.entry && previous
      && !previous.location.preview && JSON.stringify(previous.location) === JSON.stringify(base.location)
      && this.marker()?.session === this.session && this.marker()?.entry === this.currentEntry) {
      // Only traverse history when the adjacent entry is the actual underlying page.
      this.entries.set(base.entry, { ...previous, snapshot: base.snapshot });
      this.previewClosePending = true;
      this.port.history.back();
      return;
    }
    this.publish({ location: base.location, snapshot: base.snapshot, revision: source.revision + 1, restoring: true });
    if (this.currentEntry !== null) this.entries.set(this.currentEntry, this.state);
  }
  reset(location: NavigationLocation = { ...HOME_LOCATION }) {
    this.previewClosePending = false;
    this.session = createSessionId();
    this.entries.clear();
    this.trail = [];
    this.currentEntry = null;
    this.publish({ location, revision: this.state.revision + 1, restoring: false });
    if (this.mobile) this.writeEntry(false);
  }
  private onPopState = () => {
    this.previewClosePending = false;
    const marker = this.marker();
    if (!marker) return; // Leave the browser's previous document/initial entry alone.
    this.saveCurrent();
    const target = marker.session === this.session ? this.entries.get(marker.entry) : undefined;
    if (!target) { this.reset(); return; }
    this.currentEntry = marker.entry;
    this.publish({ ...target, revision: this.state.revision + 1, restoring: true });
  };
}
