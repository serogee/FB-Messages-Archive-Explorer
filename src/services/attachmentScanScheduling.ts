// Only ownership discovery waits here. Chat loading and visible preview jobs
// hold a lease so new background reads do not compete with them.
let foregroundJobs = 0;
const waiters = new Set<() => void>();

export function prioritizeAttachmentPreview(signal?: AbortSignal): () => void {
  if (signal?.aborted) return () => {};
  foregroundJobs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', release);
    foregroundJobs--;
    if (foregroundJobs === 0) for (const resume of [...waiters]) resume();
  };
  signal?.addEventListener('abort', release, { once: true });
  return release;
}

export async function withAttachmentPreviewPriority<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = prioritizeAttachmentPreview(signal);
  try { return await work(); } finally { release(); }
}

export async function waitForAttachmentPreview(signal?: AbortSignal): Promise<void> {
  while (foregroundJobs > 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise<void>((resolve, reject) => {
      const resume = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
      const cleanup = () => { waiters.delete(resume); signal?.removeEventListener('abort', abort); };
      waiters.add(resume);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
