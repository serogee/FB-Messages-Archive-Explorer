import { useEffect, useState } from 'react';
import type { MediaEntry } from '../types/messenger';
import { getMediaFileSize } from '../services/mediaMetadata';
import { formatFileSize } from '../services/storage';

interface MediaFileSizeProps {
  entry: MediaEntry | null;
  className?: string;
}

export function MediaFileSize({ entry, className }: MediaFileSizeProps) {
  const [size, setSize] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (!entry) {
      setSize(null);
      return;
    }

    let mounted = true;
    setSize(undefined);
    void getMediaFileSize(entry).then(result => {
      if (mounted) setSize(result);
    });
    return () => { mounted = false; };
  }, [entry]);

  return (
    <span className={className}>
      {size === undefined ? 'Loading…' : size === null ? 'Unknown size' : formatFileSize(size)}
    </span>
  );
}
