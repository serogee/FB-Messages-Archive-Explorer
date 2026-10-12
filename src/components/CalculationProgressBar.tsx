import { useSyncExternalStore } from 'react';
import type { CalculationProgressStore } from '../services/calculationProgress';

export function CalculationProgressBar({ source, label, active = true }: {
  source: CalculationProgressStore;
  label: string;
  active?: boolean;
}) {
  const progress = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const total = progress?.total;
  const done = progress?.done || 0;
  const knownTotal = total !== undefined;
  const percent = knownTotal ? total > 0 ? Math.min(100, Math.round(done / total * 100)) : 100 : undefined;
  const progressText = progress
    ? knownTotal
      ? `${done.toLocaleString()} / ${total.toLocaleString()} ${progress.unit} (${percent}%)`
      : `${done.toLocaleString()} ${progress.unit} checked`
    : active ? 'Starting…' : 'Not started';
  return (
    <div className="calculation-progress" role="status" aria-label={label}>
      <div className="calculation-progress-details">
        <span>{progress?.label || label}</span>
        <span className="calculation-progress-count">{progressText}</span>
      </div>
      {progress?.detail && <div className="calculation-progress-count">{progress.detail}</div>}
    </div>
  );
}
