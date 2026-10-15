import { useState, useEffect, useCallback } from 'react';
import { storageGet, storageSet } from '../services/storage';
import type { ReactionGuessingMode } from '../services/reactions';
import type { FolderAccessMode } from '../types/fileSystem';
import { configurePerformance, defaultPerformancePreferences, normalizePerformancePreferences, type PerformancePreferences } from '../services/performanceSettings';

export interface Settings {
  folderAccessMode: FolderAccessMode;
  darkMode: boolean;
  showMyName: boolean;
  showTheirName: boolean;
  showReactions: boolean;
  hideLikelyReactionNotices: boolean;
  reactionTimestampGuessingMode: ReactionGuessingMode;
  autoCollapseDateNav: boolean;
  viewerNavigation: 'auto' | 'show' | 'hide';
  dateAttachmentFilenames: boolean;
  attachmentFilenameTemplate: string;
  longAttachmentFilenames: boolean;
  attachmentBookmarkingEnabled: boolean;
  deletionEnabled: boolean;
  sidebarWidth: number;
  infoPanelWidth: number;
  infoPanelOpen: boolean;
  dontShowTrustModal: boolean;
  offlineSupportEnabled: boolean;
  debuggingEnabled: boolean;
  performance: PerformancePreferences;
}

const DEFAULTS: Settings = {
  folderAccessMode: 'native',
  darkMode: true,
  showMyName: false,
  showTheirName: true,
  showReactions: true,
  hideLikelyReactionNotices: true,
  reactionTimestampGuessingMode: 'aggressive',
  autoCollapseDateNav: true,
  viewerNavigation: 'auto',
  dateAttachmentFilenames: true,
  attachmentFilenameTemplate: '{-chat}_{date}_{time}_{ms}',
  longAttachmentFilenames: false,
  attachmentBookmarkingEnabled: false,
  deletionEnabled: false,
  sidebarWidth: 360,
  infoPanelWidth: 360,
  infoPanelOpen: false,
  dontShowTrustModal: false,
  offlineSupportEnabled: true,
  debuggingEnabled: false,
  performance: defaultPerformancePreferences(),
};

function loadSettings(): Settings {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const stored = storageGet('setting_' + key);
    if (stored === null) continue;
    const defaultVal = DEFAULTS[key];
    if (key === 'performance') {
      try { settings.performance = normalizePerformancePreferences(JSON.parse(stored)); } catch { /* Use defaults for invalid saved preferences. */ }
    } else if (typeof defaultVal === 'boolean') {
      (settings as Record<keyof Settings, unknown>)[key] = stored === '1' || stored === 'true';
    } else if (typeof defaultVal === 'number') {
      const n = Number(stored);
      if (Number.isFinite(n) && n > 0) {
        (settings as Record<keyof Settings, unknown>)[key] = n;
      }
    } else if (typeof defaultVal === 'string') {
      if (key === 'folderAccessMode' && !['native', 'upload'].includes(stored)) continue;
      if (key === 'reactionTimestampGuessingMode' && !['off', 'near', 'aggressive'].includes(stored)) continue;
      if (key === 'viewerNavigation' && !['auto', 'show', 'hide'].includes(stored)) continue;
      let storedValue = stored;
      if (key === 'attachmentFilenameTemplate') {
        storedValue = storedValue.replace(/\.?\{ext\}\s*$/g, '');
        if (storedValue === '{chat} - {date}_{time}_{ms}') {
          storedValue = '{-chat}_{date}_{time}_{ms}';
        }
      }
      (settings as Record<keyof Settings, unknown>)[key] = storedValue;
    }
  }
  settings.performance = normalizePerformancePreferences(settings.performance);
  configurePerformance(settings.performance);
  return settings;
}

export function useSettings(): {
  settings: Settings;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
} {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    if (settings.darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [settings.darkMode]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${settings.sidebarWidth}px`);
  }, [settings.sidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty('--info-panel-width', `${settings.infoPanelWidth}px`);
  }, [settings.infoPanelWidth]);

  const setSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (key === 'performance') {
      value = normalizePerformancePreferences(value) as Settings[K];
      configurePerformance(value);
    }
    setSettings(prev => ({ ...prev, [key]: value }));
    storageSet('setting_' + key, typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }, []);

  return { settings, setSetting };
}
