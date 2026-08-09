import { useState, useCallback } from 'react';
import type { ChatListEntry, MessengerThread, MediaState } from '../types/messenger';
import { loadChatMessages } from '../services/fileSystem';
import { processMediaFromDirectory, createMediaState, revokeAllMedia } from '../services/media';
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

  const loadChat = useCallback(async (entry: ChatListEntry) => {
    setActiveEntry(entry);
    setChatData(null);
    setLoading(true);
    setMsgProgress(0);
    setMsgStatusText("");
    setMediaProgress(0);

    // Yield to let React paint the selected highlight and clear the old chat
    await new Promise(r => setTimeout(r, 10));
    try {
      // Revoke previous media
      setMediaState(prev => {
        revokeAllMedia(prev);
        return createMediaState();
      });

      // Load messages with progress
      const data = await loadChatMessages(entry.dirHandle, (progress, statusText) => {
        setMsgProgress(progress);
        setMsgStatusText(statusText);
      });

      setMsgProgress(0.95);
      setMsgStatusText("Enriching data...");
      await new Promise(r => setTimeout(r, 10));

      // Enrich reaction timestamps (mutates in-place)
      if (!data._reactionsEnriched) {
        enrichReactionTimestamps(data.messages);
        data._reactionsEnriched = true;
      }

      // Set perspective — try stored, fall back to first participant
      const participants = getParticipantNames(data);
      const stored = storageGet('selectedPerspective');
      const perspective = (stored && participants.includes(stored))
        ? stored
        : (participants[0] || '');
      setSelectedPerspectiveState(perspective);

      // Load media in background (don't block chat display)
      const newMediaState = createMediaState();
      setChatData(data);
      setLoading(false);
      setMsgProgress(1);

      // Load media asynchronously after chat is shown
      setMediaLoading(true);
      setMediaProgress(0);
      processMediaFromDirectory(entry.dirHandle, newMediaState, (done, total) => {
        setMediaProgress(total > 0 ? done / total : 1);
      })
        .then(() => {
          setMediaState({ ...newMediaState });
          setMediaLoading(false);
          setMediaProgress(1);
        })
        .catch(() => {
          setMediaLoading(false);
          setMediaProgress(1);
        });

    } catch (e) {
      setLoading(false);
      console.error('Failed to load chat:', e);
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
