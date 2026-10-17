/** Loads a borrowed source URL; its owner remains responsible for revoking it. */
export function loadImage(source: string, signal: AbortSignal, cancellationMessage: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      image.src = '';
      reject(new DOMException(cancellationMessage, 'AbortError'));
    };
    image.decoding = 'async';
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('Image decode failed'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    image.src = source;
  });
}
