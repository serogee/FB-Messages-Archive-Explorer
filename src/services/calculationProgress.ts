import { createProgressThrottle } from './progressThrottle';

export interface CalculationProgress {
  stage: string;
  label: string;
  done: number;
  total?: number;
  unit: 'files' | 'chats' | 'folders';
  detail?: string;
}

/** Publish progress locally; archive/chat components do not need to rerender. */
export class CalculationProgressStore {
  private snapshot: CalculationProgress | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private throttle = createProgressThrottle<CalculationProgress>(progress => {
    this.snapshot = progress;
    for (const listener of this.listeners) listener();
  }, 200, progress => progress.stage);

  getSnapshot = (): CalculationProgress | null => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  report = (progress: CalculationProgress): void => {
    if (this.disposed) return;
    this.throttle.report(progress, progress.total !== undefined && progress.done >= progress.total);
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.throttle.flush();
    this.throttle.cancel();
    this.disposed = true;
  };
}

export function followCalculationProgress(
  source: CalculationProgressStore | null,
  target?: CalculationProgressStore,
): () => void {
  if (!source || !target || source === target) return () => {};
  const publish = () => {
    const progress = source.getSnapshot();
    if (progress) target.report(progress);
  };
  publish();
  return source.subscribe(publish);
}
