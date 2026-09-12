export interface ProgressThrottle<T> {
  report: (value: T, final?: boolean) => void;
  flush: () => void;
  cancel: () => void;
}

export function createProgressThrottle<T>(
  emit: (value: T) => void,
  intervalMs = 75,
  group?: (value: T) => string
): ProgressThrottle<T> {
  let lastEmission: number | null = null;
  let lastGroup: string | undefined;
  let pending: T | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    lastEmission = performance.now();
    lastGroup = group?.(value);
    emit(value);
  };

  const report = (value: T, final = false) => {
    pending = value;
    const now = performance.now();
    const valueGroup = group?.(value);
    const groupChanged = valueGroup !== lastGroup;
    if (final || groupChanged || lastEmission === null || now - lastEmission >= intervalMs) {
      flush();
      return;
    }
    if (!timer) timer = setTimeout(flush, Math.max(0, intervalMs - (now - lastEmission)));
  };

  return {
    report,
    flush,
    cancel: () => {
      clearTimer();
      pending = undefined;
    },
  };
}
