import { useSyncExternalStore } from 'react';
import type { CalculationProgressStore } from '../services/calculationProgress';
import { AnimatedProgressLabel } from './AnimatedProgressLabel';

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function CalculationProgressBar({ source, label, active = true, fallbackLabel = 'Scanning for shared attachments', layout = 'inline' }: {
  source?: CalculationProgressStore;
  label: string;
  active?: boolean;
  fallbackLabel?: string;
  layout?: 'inline' | 'list';
}) {
  const progress = useSyncExternalStore(source?.subscribe || emptySubscribe, source?.getSnapshot || emptySnapshot, source?.getSnapshot || emptySnapshot);
  const total = progress?.total;
  const done = progress?.done || 0;
  const knownTotal = total !== undefined;
  const percent = knownTotal ? total > 0 ? Math.min(100, Math.round(done / total * 100)) : 100 : undefined;
  const progressText = progress?.jsonFound !== undefined
    ? `${(progress.foldersChecked ?? done).toLocaleString()} Folders/Subfolders Checked - ${progress.jsonFound.toLocaleString()} JSON Found`
    : progress
    ? knownTotal
      ? `${done.toLocaleString()} / ${total.toLocaleString()} ${progress.unit} (${percent}%)`
      : `${done.toLocaleString()} ${progress.unit} checked`
    : '';
  const progressLabel = progress?.label || fallbackLabel;
  const progressLines = progress?.jsonFound !== undefined
    ? [`${(progress.foldersChecked ?? done).toLocaleString()} Folders/Subfolders Checked`, `${progress.jsonFound.toLocaleString()} JSON Found`]
    : progress?.stage === 'ownership' && progress.unit === 'files'
      ? [`${done.toLocaleString()} JSON Checked${percent !== undefined ? ` (${percent}%)` : ''}`,
        ...(total !== undefined ? [`${total.toLocaleString()} JSON Found`] : [])]
      : progressText ? [progressText] : [];
  return (
    <div className="calculation-progress" role="status" aria-label={label}>
      <div className="calculation-progress-details">
        <AnimatedProgressLabel key={progressLabel} active={active}>{progressLabel}</AnimatedProgressLabel>
        {layout === 'inline' && progressText && <span className="calculation-progress-count">{progressText}{progress?.detail ? ` - ${progress.detail}` : ''}</span>}
      </div>
      {layout === 'list' && progressLines.length > 0 && <ul className="calculation-progress-list">
        {progressLines.map(line => <li key={line}><span aria-hidden="true">&gt;</span><span>{line}</span></li>)}
      </ul>}
    </div>
  );
}
