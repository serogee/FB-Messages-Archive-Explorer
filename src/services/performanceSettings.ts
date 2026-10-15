import { LiveConcurrencyLimit } from './concurrency';

export const PERFORMANCE_LIMIT_MIN = 1;
export const PERFORMANCE_LIMIT_MAX = 16;
export const PERFORMANCE_FIELDS = {
  archiveReads: { label: 'Archive and chat reads', default: 4, unit: ['chat folder or JSON file', 'chat folders or JSON files'], description: 'For Facebook and Instagram archive lists, count chat folders across all sections. For standalone Messenger exports and multi-file chats, count conversation JSON files. File preparation and text reading apply the limit in separate stages.' },
  attachmentReads: { label: 'Attachment loading', default: 4, unit: ['attachment', 'attachments'], description: 'Look up local files and read media dimensions, one attachment per job. File lookup and dimension reads each use their own queue and apply this limit independently.' },
  imagePreviews: { label: 'Chat image previews', default: 2, unit: ['image preview', 'image previews'], description: 'Generate previews for visible chat images. Each job creates one preview of an image at the requested size.' },
  videoPreviews: { label: 'Chat video previews', default: 2, unit: ['video preview', 'video previews'], description: 'Generate one video preview per job for visible chat messages.' },
  galleryPreviews: { label: 'Gallery image previews', default: 4, unit: ['image thumbnail', 'image thumbnails'], description: 'Generate one photo or GIF thumbnail per job for the attachment gallery.' },
  galleryVideoPreviews: { label: 'Gallery video previews', default: 4, unit: ['video thumbnail', 'video thumbnails'], description: 'Generate one video thumbnail per job for the attachment gallery. Preset limits are higher than chat video limits.' },
  scans: { label: 'Shared-attachment scans', default: 4, unit: ['folder or file', 'folders or files'], description: 'Limit folders scanned at once, conversation JSON files read at once, and shared attachment files verified at once. Each stage applies this value independently. Visible previews retain priority.' },
  messengerScans: { label: 'Messenger scan reads', default: 1, unit: ['JSON file', 'JSON files'], description: 'Read one standalone Messenger conversation JSON file per job when checking shared attachments.' },
  sizes: { label: 'Size calculations', default: 1, unit: ['chat folder or file', 'chat folders or files'], description: 'For Facebook and Instagram, count chat folders per chat section; file reads within each section also use this limit. For Messenger, count individual JSON or media files during size reads.' },
  sizeDetails: { label: 'Size detail reads', default: 4, unit: ['chat folder or file', 'chat folders or files'], description: 'For Facebook and Instagram deletion details, limit chat folders inspected at once and total file reads across that batch independently. Shared sticker size checks also count individual files.' },
  deletions: { label: 'Attachment deletions', default: 4, unit: ['attachment file', 'attachment files'], description: 'Remove one Messenger attachment file per job. Finalize each chat in order to preserve shared-file ownership checks.' },
  stickerDeletions: { label: 'Shared sticker cleanup', default: 1, unit: ['sticker file', 'sticker files'], description: 'Remove one unused shared sticker file per job after its conversations have been deleted successfully.' },
} as const;
export type PerformanceCategory = keyof typeof PERFORMANCE_FIELDS;
export type PerformanceLimits = Record<PerformanceCategory, number>;
export const BACKGROUND_ACTIVITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', ultra: 'Ultra' } as const;
export type BackgroundActivity = keyof typeof BACKGROUND_ACTIVITY_LABELS;
export interface PerformancePreferences {
  advanced: boolean;
  archiveReads: number;
  backgroundActivity: BackgroundActivity;
  advancedLimits: PerformanceLimits;
}
export const defaultPerformanceLimits = (): PerformanceLimits => Object.fromEntries(
  Object.entries(PERFORMANCE_FIELDS).map(([key, field]) => [key, field.default]),
) as PerformanceLimits;
export function backgroundPerformanceLimits(activity: BackgroundActivity): PerformanceLimits {
  const values = defaultPerformanceLimits();
  const factor = { low: 0.5, normal: 1, high: 2, ultra: 4 }[activity];
  for (const key of ['imagePreviews', 'galleryPreviews', 'videoPreviews', 'galleryVideoPreviews', 'scans', 'messengerScans', 'sizes', 'sizeDetails'] as const) {
    values[key] = Math.max(PERFORMANCE_LIMIT_MIN, Math.min(PERFORMANCE_LIMIT_MAX, Math.floor(values[key] * factor)));
  }
  return values;
}
export const defaultPerformancePreferences = (): PerformancePreferences => ({
  advanced: false, archiveReads: 4, backgroundActivity: 'normal', advancedLimits: defaultPerformanceLimits(),
});
export function normalizePerformanceLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(PERFORMANCE_LIMIT_MAX, Math.max(PERFORMANCE_LIMIT_MIN, Math.round(value))) : fallback;
}
export function normalizePerformancePreferences(value: unknown): PerformancePreferences {
  const defaults = defaultPerformancePreferences();
  if (!value || typeof value !== 'object') return defaults;
  const stored = value as Partial<PerformancePreferences>;
  const backgroundActivity = typeof stored.backgroundActivity === 'string' && Object.hasOwn(BACKGROUND_ACTIVITY_LABELS, stored.backgroundActivity) ? stored.backgroundActivity : 'normal';
  const baseline = backgroundPerformanceLimits(backgroundActivity);
  return {
    advanced: stored.advanced === true,
    archiveReads: normalizePerformanceLimit(stored.archiveReads, defaults.archiveReads),
    backgroundActivity,
    advancedLimits: Object.fromEntries(Object.entries(baseline).map(([key, defaultValue]) => {
      let storedValue = stored.advancedLimits?.[key as PerformanceCategory];
      // Gallery thumbnails previously shared the attachment read setting.
      if (key === 'galleryPreviews' && storedValue === undefined) storedValue = stored.advancedLimits?.attachmentReads;
      return [key, normalizePerformanceLimit(storedValue, defaultValue)];
    })) as PerformanceLimits,
  };
}

const limits = Object.fromEntries(Object.entries(PERFORMANCE_FIELDS).map(([key, field]) => [
  key, new LiveConcurrencyLimit(field.default),
])) as Record<PerformanceCategory, LiveConcurrencyLimit>;

export const performanceLimit = (category: PerformanceCategory): LiveConcurrencyLimit => limits[category];

export function resolvePerformanceLimits(value: unknown): PerformanceLimits {
  const preferences = normalizePerformancePreferences(value);
  const values = preferences.advanced ? preferences.advancedLimits : backgroundPerformanceLimits(preferences.backgroundActivity);
  if (!preferences.advanced) values.archiveReads = preferences.archiveReads;
  return values;
}

/** Apply active limits without adding a global cap across independent pools. */
export function configurePerformance(value: unknown): void {
  const values = resolvePerformanceLimits(value);
  for (const key of Object.keys(limits) as PerformanceCategory[]) limits[key].set(values[key]);
}
