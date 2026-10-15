import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  PERFORMANCE_FIELDS, PERFORMANCE_LIMIT_MIN, PERFORMANCE_LIMIT_MAX,
  defaultPerformancePreferences, normalizePerformancePreferences, normalizePerformanceLimit,
  resolvePerformanceLimits, backgroundPerformanceLimits, BACKGROUND_ACTIVITY_LABELS,
  type BackgroundActivity, type PerformanceCategory, type PerformancePreferences,
} from '../../services/performanceSettings';
import { OptionDropdown } from './OptionDropdown';
import { ResetButton } from './ResetButton';
import { SettingsInfoRow } from '../Modals/SettingsInfoModal';

function compareWithDefault(value: number, defaultValue: number) {
  return value === defaultValue ? 'default' : value > defaultValue ? 'above' : 'below';
}

function concurrencyUnit(category: PerformanceCategory, count: number) {
  return `${PERFORMANCE_FIELDS[category].unit[count === 1 ? 0 : 1]} at a time`;
}

function backgroundActivityLabel(preferences: PerformancePreferences) {
  const baseline = backgroundPerformanceLimits(preferences.backgroundActivity);
  const custom = preferences.advanced && (Object.keys(PERFORMANCE_FIELDS) as PerformanceCategory[])
    .some(category => preferences.advancedLimits[category] !== baseline[category]);
  return `${BACKGROUND_ACTIVITY_LABELS[preferences.backgroundActivity]}${custom ? ' - Custom' : ''}`;
}

function NumberControl({ label, value, defaultValue, onChange }: {
  label: string; value: number; defaultValue: number; onChange: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const current = draft.trim() ? normalizePerformanceLimit(Number(draft), value) : value;
  const changeBy = (step: number) => {
    const next = normalizePerformanceLimit(current + step, value);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return <div className="settings-row performance-row">
    <label htmlFor={id}>{label}</label>
    <div className="performance-number-control">
      <input id={id} type="number" inputMode="numeric" min={PERFORMANCE_LIMIT_MIN} max={PERFORMANCE_LIMIT_MAX} step={1}
        value={draft} className="performance-number performance-value" data-comparison={compareWithDefault(current, defaultValue)}
        title={`Preset default: ${defaultValue}`} onChange={event => {
          const next = event.target.value;
          setDraft(next);
          const number = Number(next);
          if (next && Number.isInteger(number) && number >= PERFORMANCE_LIMIT_MIN && number <= PERFORMANCE_LIMIT_MAX) onChange(number);
        }} onBlur={() => {
          setDraft(String(current));
          if (current !== value) onChange(current);
        }} />
      <div className="performance-number-arrows">
        <button type="button" className="performance-number-step" aria-label={`Increase ${label.toLowerCase()}`}
          aria-controls={id} disabled={current >= PERFORMANCE_LIMIT_MAX} onClick={() => changeBy(1)}>
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        <button type="button" className="performance-number-step" aria-label={`Decrease ${label.toLowerCase()}`}
          aria-controls={id} disabled={current <= PERFORMANCE_LIMIT_MIN} onClick={() => changeBy(-1)}>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
    <ResetButton className="performance-reset" aria-label={`Reset ${label.toLowerCase()}`} onClick={() => {
      setDraft(String(defaultValue)); onChange(defaultValue);
    }} />
  </div>;
}

export function PerformanceControls({ value, onChange }: {
  value: PerformancePreferences; onChange: (value: PerformancePreferences) => void;
}) {
  const preferences = normalizePerformancePreferences(value);
  const baseline = backgroundPerformanceLimits(preferences.backgroundActivity);
  const id = useId();
  const [resetVersion, setResetVersion] = useState(0);
  const selectPreset = (backgroundActivity: BackgroundActivity) => {
    setResetVersion(version => version + 1);
    onChange({ ...preferences, backgroundActivity, advancedLimits: backgroundPerformanceLimits(backgroundActivity) });
  };
  return <>
    <div className="settings-row">
      <label htmlFor={id}>Advanced performance</label>
      <label className="switch"><input id={id} type="checkbox" checked={preferences.advanced}
        onChange={event => onChange({ ...preferences, advanced: event.target.checked })} /><span className="slider" /></label>
    </div>
    <ResetButton className="performance-reset-all" onClick={() => {
      setResetVersion(version => version + 1);
      onChange({ ...defaultPerformancePreferences(), advanced: preferences.advanced });
    }}>Reset all values</ResetButton>
    <NumberControl key={`${preferences.advanced ? 'advanced' : 'basic'}-archive-${resetVersion}`}
      label={PERFORMANCE_FIELDS.archiveReads.label}
      value={preferences.advanced ? preferences.advancedLimits.archiveReads : preferences.archiveReads}
      defaultValue={baseline.archiveReads} onChange={archiveReads => onChange(preferences.advanced
        ? { ...preferences, advancedLimits: { ...preferences.advancedLimits, archiveReads } }
        : { ...preferences, archiveReads })} />
    <div className="performance-background">
      <label id={`${id}-background`}>Background activity</label>
      <div className="performance-dropdown-row">
        <OptionDropdown label="Background activity" value={preferences.backgroundActivity}
          displayLabel={backgroundActivityLabel(preferences)} onChange={selectPreset}
          options={(Object.keys(BACKGROUND_ACTIVITY_LABELS) as BackgroundActivity[]).map(activity => ({ value: activity, label: BACKGROUND_ACTIVITY_LABELS[activity] }))} />
        <ResetButton className="performance-reset" aria-label="Reset background activity" onClick={() => selectPreset('normal')} />
      </div>
    </div>
    {preferences.advanced && (Object.keys(PERFORMANCE_FIELDS) as PerformanceCategory[]).filter(category => category !== 'archiveReads').map(category => <NumberControl
      key={`advanced-${category}-${resetVersion}`} label={PERFORMANCE_FIELDS[category].label}
      value={preferences.advancedLimits[category]} defaultValue={baseline[category]}
      onChange={number => onChange({ ...preferences, advancedLimits: { ...preferences.advancedLimits, [category]: number } })} />)}
  </>;
}

export function PerformanceInformation({ value }: { value: PerformancePreferences }) {
  const preferences = normalizePerformancePreferences(value);
  const limits = resolvePerformanceLimits(preferences);
  const baseline = backgroundPerformanceLimits(preferences.backgroundActivity);
  const statsId = useId();
  return <>
    <section className="performance-current-settings" aria-labelledby={statsId}>
      <div className="performance-stats-heading">
        <h4 id={statsId}>Current concurrency settings</h4>
        <span>{preferences.advanced ? 'Advanced' : 'Basic'} · {backgroundActivityLabel(preferences)}</span>
      </div>
      <p className="performance-info-note">Maximum jobs allowed to run at the same time for each operation. Muted values match the preset; blue values are higher and red values are lower.</p>
      <dl className="performance-stats">
        {(Object.keys(PERFORMANCE_FIELDS) as PerformanceCategory[]).map(category => <div key={category}>
          <dt><span>{PERFORMANCE_FIELDS[category].label}</span><small className="performance-stat-unit">{concurrencyUnit(category, limits[category])}</small></dt>
          <dd className="performance-value" data-comparison={compareWithDefault(limits[category], baseline[category])}
            title={`${limits[category]} ${concurrencyUnit(category, limits[category])}. Preset default: ${baseline[category]}`}>{limits[category]}</dd>
        </div>)}
      </dl>
    </section>
    <section className="shortcuts-group" aria-labelledby={`${statsId}-general`}>
      <h4 id={`${statsId}-general`}>General controls</h4>
      <SettingsInfoRow label="Advanced performance">Choose individual limits. Turning this off saves those values and restores the separate basic settings. Turning it back on restores your advanced values.</SettingsInfoRow>
      <SettingsInfoRow label="Live changes">Changes apply to queued work immediately. Running reads and deletions finish normally before a lower limit takes effect. Already completed work is kept.</SettingsInfoRow>
      <SettingsInfoRow label="Reset all values">Restore Normal defaults in both modes, including saved advanced values. Keep the current mode selected.</SettingsInfoRow>
      <SettingsInfoRow label={PERFORMANCE_FIELDS.archiveReads.label}>Current limit: {limits.archiveReads} {concurrencyUnit('archiveReads', limits.archiveReads)}. {PERFORMANCE_FIELDS.archiveReads.description} Default: {baseline.archiveReads}.</SettingsInfoRow>
      <SettingsInfoRow label="Background activity">Choose the preset that sets your defaults in both modes. Normal uses the default limits. Low halves preview, scan, and size limits, with at least one job per pool. High doubles those limits. Ultra uses four times Normal's limits, up to 16 jobs per pool. Selecting any preset replaces all advanced values, even when you select the same preset again.</SettingsInfoRow>
      <SettingsInfoRow label="Limits">Enter whole numbers from {PERFORMANCE_LIMIT_MIN} to {PERFORMANCE_LIMIT_MAX}. Each operation or stage applies its limit independently. Higher limits can use more memory and may not load faster.</SettingsInfoRow>
    </section>
    <section className="shortcuts-group" aria-labelledby={`${statsId}-background`}>
      <h4 id={`${statsId}-background`}>Advanced background settings</h4>
      <p className="performance-info-note">These individual concurrency controls are available when Advanced performance is on. Defaults and row resets follow Background activity. Custom means at least one advanced value differs from the selected preset.</p>
      {(Object.keys(PERFORMANCE_FIELDS) as PerformanceCategory[]).filter(category => category !== 'archiveReads').map(category => <SettingsInfoRow key={category} label={PERFORMANCE_FIELDS[category].label}>
        Current limit: {limits[category]} {concurrencyUnit(category, limits[category])}. {PERFORMANCE_FIELDS[category].description} Default: {baseline[category]}.
      </SettingsInfoRow>)}
    </section>
  </>;
}
