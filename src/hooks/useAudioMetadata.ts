import { useEffect, useState } from 'react';
import type { MediaState, ResolvedAttachment } from '../types/messenger';
import { getAudioMetadata, type AudioMetadata } from '../services/audioMetadata';
import { findMediaFile } from '../services/media';

export function useAudioMetadata(attachment: ResolvedAttachment, mediaState: MediaState): AudioMetadata | null {
  const [metadata, setMetadata] = useState<AudioMetadata | null>(null);

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setMetadata({ duration: null, size: null });
      return;
    }

    let mounted = true;
    setMetadata(null);
    void getAudioMetadata(entry).then(result => {
      if (mounted) setMetadata(result);
    });
    return () => { mounted = false; };
  }, [attachment, mediaState]);

  return metadata;
}
