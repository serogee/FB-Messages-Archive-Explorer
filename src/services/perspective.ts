import type { ChatListEntry } from '../types/messenger';
import { getBookmarkChatId } from './bookmarks';
import { fixEncoding } from './parser';
import { storageGet, storageSet } from './storage';

export const PERSPECTIVE_DETECTOR_VERSION = 1;

const STORAGE_KEY = 'archivePerspectivesV1';
const MAX_SAVED_ARCHIVES = 20;
const MAX_STORAGE_JSON_LENGTH = 900;
const MAX_COOKIE_VALUE_LENGTH = 3000;

export interface ArchivePerspectiveResolution {
  archiveKey: string;
  name: string;
  source: 'manual' | 'detected' | null;
}

interface SavedPerspective {
  name: string;
  source: 'manual' | 'detected';
  detectorVersion?: number;
  updatedAt: number;
}

interface SavedPerspectiveMap {
  version: 1;
  records: Record<string, SavedPerspective>;
}

interface ParticipantDescriptor {
  key: string;
  display: string;
}

interface ConversationDescriptor {
  id: string;
  participants: string[];
  participantNames: ParticipantDescriptor[];
}

export function normalizePerspectiveName(name: string): string {
  return fixEncoding(name).trim().normalize('NFC');
}

function getConversationDescriptors(entries: readonly ChatListEntry[]): ConversationDescriptor[] {
  return entries.map(entry => {
    const participantsByName = new Map<string, string>();
    for (const name of entry.participants || []) {
      if (typeof name !== 'string') continue;
      const display = fixEncoding(name);
      const key = display.trim().normalize('NFC');
      if (key && !participantsByName.has(key)) participantsByName.set(key, display);
    }
    const participantNames = Array.from(participantsByName, ([key, display]) => ({ key, display }));

    return {
      id: getBookmarkChatId(entry),
      participants: participantNames.map(participant => participant.key).sort(),
      participantNames,
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function hashFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    hash ^= BigInt(code & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(code >>> 8);
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, '0');
}

function getArchiveKey(
  descriptors: readonly ConversationDescriptor[],
  format: 'facebook' | 'messenger'
): string {
  const fingerprintDescriptors = descriptors.map(({ id, participants }) => [id, participants]);
  return `${format}:v1:${hashFingerprint(JSON.stringify(fingerprintDescriptors))}`;
}

function isSavedPerspective(value: unknown): value is SavedPerspective {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SavedPerspective>;
  return typeof record.name === 'string'
    && record.name.trim().length > 0
    && (record.source === 'manual' || record.source === 'detected')
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt)
    && (record.source !== 'detected' || typeof record.detectorVersion === 'number');
}

function readSavedPerspectives(): Record<string, SavedPerspective> {
  try {
    const raw = storageGet(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SavedPerspectiveMap>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== 'object') return {};

    return Object.fromEntries(
      Object.entries(parsed.records)
        .filter((entry): entry is [string, SavedPerspective] => isSavedPerspective(entry[1]))
    );
  } catch {
    return {};
  }
}

function writeSavedPerspectives(records: Record<string, SavedPerspective>): void {
  const ordered = Object.entries(records)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_SAVED_ARCHIVES);

  while (ordered.length > 0) {
    const raw = JSON.stringify({ version: 1, records: Object.fromEntries(ordered) } satisfies SavedPerspectiveMap);
    if (raw.length <= MAX_STORAGE_JSON_LENGTH && encodeURIComponent(raw).length <= MAX_COOKIE_VALUE_LENGTH) {
      storageSet(STORAGE_KEY, raw);
      return;
    }
    ordered.pop();
  }

  storageSet(STORAGE_KEY, JSON.stringify({ version: 1, records: {} } satisfies SavedPerspectiveMap));
}

function getSavedPerspective(archiveKey: string): SavedPerspective | null {
  const record = readSavedPerspectives()[archiveKey];
  if (!record) return null;
  if (record.source === 'detected' && record.detectorVersion !== PERSPECTIVE_DETECTOR_VERSION) return null;
  return record;
}

export function saveManualArchivePerspective(archiveKey: string | null, name: string): void {
  const normalized = normalizePerspectiveName(name);
  if (!archiveKey || !normalized) return;

  const records = readSavedPerspectives();
  records[archiveKey] = {
    name: normalized,
    source: 'manual',
    updatedAt: Date.now(),
  };
  writeSavedPerspectives(records);
}

function inferLikelyArchiveOwner(descriptors: readonly ConversationDescriptor[]): string | null {
  const seenPairs = new Set<string>();
  let commonParticipants: Set<string> | null = null;
  let qualifyingPairCount = 0;

  for (const descriptor of descriptors) {
    const participants = descriptor.participantNames;
    if (participants.length !== 2) continue;

    const pair = participants.map(participant => participant.key).sort();
    const pairKey = JSON.stringify(pair);
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    qualifyingPairCount++;

    if (commonParticipants === null) {
      commonParticipants = new Set(pair);
    } else {
      for (const participant of commonParticipants) {
        if (!pair.includes(participant)) commonParticipants.delete(participant);
      }
    }

    if (commonParticipants.size === 0) return null;
    if (qualifyingPairCount >= 3 && commonParticipants.size === 1) {
      const commonName = commonParticipants.values().next().value;
      return typeof commonName === 'string' ? commonName : null;
    }
  }

  return null;
}

export function resolveArchivePerspective(
  entries: readonly ChatListEntry[],
  format: 'facebook' | 'messenger'
): ArchivePerspectiveResolution {
  const descriptors = getConversationDescriptors(entries);
  const archiveKey = getArchiveKey(descriptors, format);
  const saved = getSavedPerspective(archiveKey);
  if (saved) {
    return { archiveKey, name: saved.name, source: saved.source };
  }

  const detectedName = inferLikelyArchiveOwner(descriptors);
  if (detectedName) {
    const records = readSavedPerspectives();
    records[archiveKey] = {
      name: detectedName,
      source: 'detected',
      detectorVersion: PERSPECTIVE_DETECTOR_VERSION,
      updatedAt: Date.now(),
    };
    writeSavedPerspectives(records);
    return { archiveKey, name: detectedName, source: 'detected' };
  }

  return { archiveKey, name: '', source: null };
}
