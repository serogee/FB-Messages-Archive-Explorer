import { useState, useEffect, useCallback } from 'react';
import { storageGet, storageSet } from '../services/storage';

export interface Settings {
  darkMode: boolean;
  showMyName: boolean;
  showTheirName: boolean;
  showReactions: boolean;
  autoCollapseDateNav: boolean;
  dateAttachmentFilenames: boolean;
  attachmentFilenameTemplate: string;
  longAttachmentFilenames: boolean;
  attachmentBookmarkingEnabled: boolean;
  deletionEnabled: boolean;
  sidebarWidth: number;
  infoPanelWidth: number;
  infoPanelOpen: boolean;
  dontShowTrustModal: boolean;
}

const DEFAULTS: Settings = {
  darkMode: true,
  showMyName: false,
  showTheirName: true,
  showReactions: true,
  autoCollapseDateNav: true,
  dateAttachmentFilenames: true,
  attachmentFilenameTemplate: '{-chat}_{date}_{time}_{ms}',
  longAttachmentFilenames: false,
  attachmentBookmarkingEnabled: false,
  deletionEnabled: false,
  sidebarWidth: 360,
  infoPanelWidth: 360,
  infoPanelOpen: false,
  dontShowTrustModal: false,
};

function loadSettings(): Settings {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const stored = storageGet('setting_' + key);
    if (stored === null) continue;
    const defaultVal = DEFAULTS[key];
    if (typeof defaultVal === 'boolean') {
      (settings as Record<keyof Settings, unknown>)[key] = stored === '1' || stored === 'true';
    } else if (typeof defaultVal === 'number') {
      const n = Number(stored);
      if (Number.isFinite(n) && n > 0) {
        (settings as Record<keyof Settings, unknown>)[key] = n;
      }
    } else if (typeof defaultVal === 'string') {
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
    setSettings(prev => ({ ...prev, [key]: value }));
    storageSet('setting_' + key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }, []);

  return { settings, setSetting };
}
