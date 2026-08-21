import { useState, useCallback, useRef } from 'react';
import type { ChatListEntry, MessengerThread, MediaState } from '../types/messenger';
import { loadChatMessages } from '../services/fileSystem';
import { processMediaFromDirectory, createMediaState, revokeAllMedia } from '../services/media';
import { loadMessengerExportChat, processMessengerExportMedia } from '../services/messengerExport';
import { enrichReactionTimestamps } from '../services/reactions';
import { storageGet, storageSet } from '../services/storage';
import { getParticipantNames } from '../services/parser';

export function useChat(): {
  chatData: MessengerThread | null;
  mediaState: MediaState;
  mediaLoading: boolean;
  mediaProgress: number;  // 0–1
  msgProgress: number;    // 0–1
  msgStatusText: string;
  loading: boolean;
  selectedPerspective: string;
  setSelectedPerspective: (name: string) => void;
  loadChat: (entry: ChatListEntry) => Promise<void>;
  clearChat: () => void;
  activeEntry: ChatListEntry | null;
} {
  const [chatData, setChatData] = useState<MessengerThread | null>(null);
  const [mediaState, setMediaState] = useState<MediaState>(createMediaState);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaProgress, setMediaProgress] = useState(0);
  const [msgProgress, setMsgProgress] = useState(0);
  const [msgStatusText, setMsgStatusText] = useState("");
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

  const loadChat = useCallback(async (entry: ChatListEntry) => {
    setActiveEntry(entry);
    setChatData(null);
    setLoading(true);
    setMsgProgress(0);
    setMsgStatusText("");
    setMediaProgress(0);

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
      setMediaLoading(true);
      setMediaProgress(0);
      if (entry._messengerExport) {
        processMessengerExportMedia(entry.dirHandle, newMediaState, (done, total) => {
          setMediaProgress(total > 0 ? done / total : 1);
        }, abortCtrl.signal)
          .then(() => {
            if (abortCtrl.signal.aborted) return;
            setMediaState({ ...newMediaState });
            setMediaLoading(false);
            setMediaProgress(1);
          })
          .catch(() => {
            if (abortCtrl.signal.aborted) return;
            setMediaLoading(false);
            setMediaProgress(1);
          });
      } else {
        processMediaFromDirectory(entry.dirHandle, newMediaState, (done, total) => {
          setMediaProgress(total > 0 ? done / total : 1);
        }, abortCtrl.signal)
          .then(() => {
            if (abortCtrl.signal.aborted) return;
            setMediaState({ ...newMediaState });
            setMediaLoading(false);
            setMediaProgress(1);
          })
          .catch(() => {
            if (abortCtrl.signal.aborted) return;
            setMediaLoading(false);
            setMediaProgress(1);
          });
      }

      const data = entry._messengerExport
        ? await loadMessengerExportChat(entry.dirHandle, entry._jsonFileName!, (progress, statusText) => {
            setMsgProgress(progress);
            setMsgStatusText(statusText);
          }, abortCtrl.signal)
        : await loadChatMessages(entry.dirHandle, (progress, statusText) => {
            setMsgProgress(progress);
            setMsgStatusText(statusText);
          }, abortCtrl.signal);
      
      if (abortCtrl.signal.aborted) return;

      setMsgProgress(0.95);
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
            .catch(() => { /* aborted or error, ignore */ });
        });
      }

    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mediaAbortControllerRef.current === abortCtrl) {
        setLoading(false);
      }
      console.error('Failed to load chat:', err);
    }
  }, []);

  const clearChat = useCallback(() => {
    setMediaState(prev => { revokeAllMedia(prev); return createMediaState(); });
    setChatData(null);
    setActiveEntry(null);
    setMediaLoading(false);
    setMediaProgress(0);
    setMsgProgress(0);
  }, []);

  return {
    chatData, mediaState, mediaLoading, mediaProgress, msgProgress, msgStatusText,
    loading, selectedPerspective, setSelectedPerspective, loadChat, clearChat, activeEntry,
  };
}
