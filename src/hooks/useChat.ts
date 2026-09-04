import { useState, useCallback, useRef } from 'react';
import type { ChatListEntry, MessengerThread, MediaState } from '../types/messenger';
import type { ReadableDirectoryHandle } from '../types/fileSystem';
import { loadChatMessages } from '../services/fileSystem';
import { processMediaFromDirectory, processFacebookStickerReferences, createMediaState, revokeAllMedia } from '../services/media';
import { loadMessengerExportChat, processMessengerExportMedia } from '../services/messengerExport';
import { enrichReactionTimestamps } from '../services/reactions';
import { storageGet, storageSet } from '../services/storage';
import { getParticipantNames } from '../services/parser';

export function useChat(): {
  chatData: MessengerThread | null;
  mediaState: MediaState;
  msgProgress: number;    // 0–1
  msgStatusText: string;
  error: string | null;
  loading: boolean;
  selectedPerspective: string;
  setSelectedPerspective: (name: string) => void;
  loadChat: (entry: ChatListEntry, messagesRootHandle?: ReadableDirectoryHandle | null) => Promise<void>;
  clearChat: () => void;
  activeEntry: ChatListEntry | null;
} {
  const [chatData, setChatData] = useState<MessengerThread | null>(null);
  const [mediaState, setMediaState] = useState<MediaState>(createMediaState);
  const [msgProgress, setMsgProgress] = useState(0);
  const [msgStatusText, setMsgStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeEntry, setActiveEntry] = useState<ChatListEntry | null>(null);
  const [selectedPerspective, setSelectedPerspectiveState] = useState<string>(() => {
    return storageGet('selectedPerspective') || '';
  });

  const setSelectedPerspective = useCallback((name: string) => {
    setSelectedPerspectiveState(name);
    storageSet('selectedPerspective', name);
  }, []);

  const mediaAbortControllerRef = useRef<AbortController | null>(null);

  const loadChat = useCallback(async (entry: ChatListEntry, messagesRootHandle?: ReadableDirectoryHandle | null) => {
    setActiveEntry(entry);
    setChatData(null);
    setError(null);
    setLoading(true);
    setMsgProgress(0);
    setMsgStatusText("");

    if (mediaAbortControllerRef.current) {
      mediaAbortControllerRef.current.abort();
    }
    const abortCtrl = new AbortController();
    mediaAbortControllerRef.current = abortCtrl;

    await new Promise(r => setTimeout(r, 10));
    try {
      setMediaState(prev => {
        revokeAllMedia(prev);
        return createMediaState();
      });

      const newMediaState = createMediaState();
      let messageProgress = 0;
      let attachmentProgress = 0;
      let attachmentLoadingComplete = false;
      const updateCombinedProgress = () => {
        if (!abortCtrl.signal.aborted) {
          setMsgProgress((messageProgress + attachmentProgress) / 2);
        }
      };
      const updateAttachmentProgress = (done: number, total: number) => {
        attachmentProgress = total > 0 ? done / total : 1;
        updateCombinedProgress();
      };
      const attachmentTask = (entry._messengerExport
        ? processMessengerExportMedia(entry.dirHandle, newMediaState, updateAttachmentProgress, abortCtrl.signal)
        : processMediaFromDirectory(entry.dirHandle, newMediaState, updateAttachmentProgress, abortCtrl.signal))
        .then(() => {
          if (abortCtrl.signal.aborted) return;
          attachmentProgress = 1;
          updateCombinedProgress();
          setMediaState({ ...newMediaState });
        })
        .catch(() => { /* Media indexing is best-effort; messages remain usable. */ })
        .finally(() => {
          attachmentLoadingComplete = true;
        });

      const updateMessageProgress = (progress: number, statusText: string) => {
        if (abortCtrl.signal.aborted) return;
        messageProgress = progress;
        updateCombinedProgress();
        setMsgStatusText(statusText);
      };

      const data = entry._messengerExport
        ? await loadMessengerExportChat(entry.dirHandle, entry._jsonFileName!, updateMessageProgress, abortCtrl.signal)
        : await loadChatMessages(entry.dirHandle, updateMessageProgress, abortCtrl.signal);

      messageProgress = 1;
      updateCombinedProgress();
      if (!attachmentLoadingComplete) setMsgStatusText("Loading attachments");

      if (!entry._messengerExport && messagesRootHandle && !abortCtrl.signal.aborted) {
        await processFacebookStickerReferences(
          messagesRootHandle,
          data.messages || [],
          newMediaState,
          abortCtrl.signal
        );
        if (!abortCtrl.signal.aborted) setMediaState({ ...newMediaState });
      }
      
      if (abortCtrl.signal.aborted) return;

      await attachmentTask;
      if (abortCtrl.signal.aborted) return;

      setMsgStatusText("Loading messages...");
      await new Promise(r => setTimeout(r, 10));

      const participants = getParticipantNames(data);
      const stored = storageGet('selectedPerspective');
      const perspective = (stored && participants.includes(stored))
        ? stored
        : (participants[0] || '');
      setSelectedPerspectiveState(perspective);

      setChatData(data);
      setLoading(false);
      setMsgProgress(1);
      
      if (!data._reactionsEnriched) {
        const enrichAbort = abortCtrl;
        requestAnimationFrame(() => {
          if (enrichAbort.signal.aborted) return;
          enrichReactionTimestamps(data.messages, undefined, enrichAbort.signal)
            .then(() => {
              if (enrichAbort.signal.aborted) return;
              data._reactionsEnriched = true;
            })
            .catch(() => { /* Reaction enrichment is best-effort; base messages remain usable. */ });
        });
      }

    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mediaAbortControllerRef.current === abortCtrl) {
        setLoading(false);
        const detail = err instanceof Error ? err.message : String(err);
        const workerFailure = /worker error|failed to fetch|networkerror|loading module/i.test(detail);
        setError(workerFailure && typeof navigator !== 'undefined' && navigator.onLine === false
          ? 'The chat parser could not be loaded while offline. Reconnect once and wait until the app confirms it is ready for offline use.'
          : 'This chat could not be loaded. The parser may be unavailable, or the selected files may no longer be accessible.');
      }
      console.error('Failed to load chat:', err);
    }
  }, []);

  const clearChat = useCallback(() => {
    if (mediaAbortControllerRef.current) {
      mediaAbortControllerRef.current.abort();
      mediaAbortControllerRef.current = null;
    }
    setMediaState(prev => { revokeAllMedia(prev); return createMediaState(); });
    setChatData(null);
    setActiveEntry(null);
    setError(null);
    setLoading(false);
    setMsgProgress(0);
    setMsgStatusText("");
  }, []);

  return {
    chatData, mediaState, msgProgress, msgStatusText, error,
    loading, selectedPerspective, setSelectedPerspective, loadChat, clearChat, activeEntry,
  };
}
