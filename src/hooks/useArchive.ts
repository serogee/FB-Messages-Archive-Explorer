import { useState, useCallback, useRef } from 'react';
import type { ChatListEntry } from '../types/messenger';
import {
  pickMessagesFolder,
  pickFolderWithWriteAccess,
  listChatFolders,
  computeFolderSize,
  deleteChat as deleteChatFs,
} from '../services/fileSystem';
import { isMessengerExport, listMessengerExportChats } from '../services/messengerExport';

async function resolveMessagesRoot(handle: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  const commonPaths = [
    [], // Maybe they selected 'messages' directly
    ['messages'], // E.g. inside facebook-xyz folder
    ['your_facebook_activity', 'messages'], // Newer Facebook export format
    ['your_instagram_activity', 'messages'] // Just in case
  ];

  for (const path of commonPaths) {
    try {
      let current = handle;
      for (const segment of path) {
        current = await current.getDirectoryHandle(segment);
      }
      // Check if it's the right place by looking for inbox or archived_threads
      let isValid = false;
      try { await current.getDirectoryHandle('inbox'); isValid = true; } catch {}
      if (!isValid) {
        try { await current.getDirectoryHandle('archived_threads'); isValid = true; } catch {}
      }
      if (isValid) return current;
    } catch {
      // Path doesn't exist, try next
    }
  }

  return null;
}

export function useArchive(): {
  rootHandle: FileSystemDirectoryHandle | null;
  originalRootHandle: FileSystemDirectoryHandle | null;

  inboxList: ChatListEntry[];
  archivedList: ChatListEntry[];
  requestsList: ChatListEntry[];
  loading: boolean;
  loadProgress: { done: number; total: number } | null;
  sizeProgress: { done: number; total: number } | null;
  error: string | null;
  openFolder: (requestWrite?: boolean) => Promise<boolean>;
  openFolderWithWriteAccess: () => Promise<void>;
  deleteChat: (entry: ChatListEntry) => Promise<void>;
  deleteChats: (entries: ChatListEntry[], onProgress?: (done: number, total: number) => void) => Promise<void>;
  updateFolderSize: (entry: ChatListEntry, size: number) => void;
} {
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [originalRootHandle, setOriginalRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [inboxList, setInboxList] = useState<ChatListEntry[]>([]);
  const [archivedList, setArchivedList] = useState<ChatListEntry[]>([]);
  const [requestsList, setRequestsList] = useState<ChatListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<{ done: number; total: number } | null>(null);
  const [sizeProgress, setSizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMessengerExportRef = useRef(false);

  const inboxListRef = useRef<ChatListEntry[]>([]);
  const archivedListRef = useRef<ChatListEntry[]>([]);
  const requestsListRef = useRef<ChatListEntry[]>([]);
  inboxListRef.current = inboxList;
  archivedListRef.current = archivedList;
  requestsListRef.current = requestsList;

  const startLazySizeComputation = useCallback((entries: ChatListEntry[], setList: React.Dispatch<React.SetStateAction<ChatListEntry[]>>, onProgress?: (done: number) => void, signal?: AbortSignal) => {
    let done = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingSizes = new Map<string, number>();

    if (entries.length === 0 && onProgress) {
      onProgress(0);
      return;
    }

    const flushUpdates = () => {
      flushTimer = null;
      if (signal?.aborted) return;

      const updates = new Map(pendingSizes);
      pendingSizes.clear();

      if (updates.size > 0) {
        setList(prev =>
          prev.map(e => {
            const size = updates.get(e.folderName);
            return size == null ? e : { ...e, folderSize: size };
          })
        );
      }

      if (onProgress) onProgress(done);
    };

    const scheduleFlush = (immediate = false) => {
      if (flushTimer) {
        if (!immediate) return;
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      if (immediate || pendingSizes.size >= 20 || done >= entries.length) {
        flushUpdates();
      } else {
        flushTimer = setTimeout(flushUpdates, 500);
      }
    };

    signal?.addEventListener('abort', () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingSizes.clear();
    }, { once: true });

    const processNext = (index: number) => {
      if (signal?.aborted) return;
      if (index >= entries.length) {
        scheduleFlush(true);
        return;
      }
      const entry = entries[index];
      setTimeout(async () => {
        if (signal?.aborted) return;
        try {
          const size = await computeFolderSize(entry.dirHandle);
          if (signal?.aborted) return;
          pendingSizes.set(entry.folderName, size);
        } catch { /* ignore */ }
        done++;
        scheduleFlush(done >= entries.length);
        processNext(index + 1);
      }, 0);
    };
    processNext(0);
  }, []);

  const openFolder = useCallback(async (requestWrite?: boolean): Promise<boolean> => {
    let abortCtrl: AbortController | null = null;
    try {
      const handle = requestWrite ? await pickFolderWithWriteAccess() : await pickMessagesFolder();
      
      setError(null);
      setLoading(true);
      setLoadProgress({ done: 0, total: 0 });

      if (abortControllerRef.current) abortControllerRef.current.abort();
      abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;
      
      setInboxList([]);
      setArchivedList([]);
      setRequestsList([]);
      setRootHandle(null);
      setOriginalRootHandle(null);
      isMessengerExportRef.current = false;
      
      const messagesRoot = await resolveMessagesRoot(handle);
      if (!messagesRoot) {
        const messengerExport = await isMessengerExport(handle);
        if (!messengerExport) {
          throw new Error("Could not find messages in this folder. Make sure you selected an extracted Facebook archive or Messenger export.");
        }

        isMessengerExportRef.current = true;
        setOriginalRootHandle(handle);
        setRootHandle(handle);

        const inbox = await listMessengerExportChats(
          handle,
          (done, total) => setLoadProgress({ done, total }),
          abortCtrl.signal
        );
        if (abortCtrl.signal.aborted) return false;

        setInboxList(inbox);
        setArchivedList([]);
        setRequestsList([]);
        setSizeProgress(null);
        return true;
      }

      setOriginalRootHandle(handle);
      setRootHandle(messagesRoot);

      const progresses = [
        { done: 0, total: 0 },
        { done: 0, total: 0 },
        { done: 0, total: 0 },
        { done: 0, total: 0 }
      ];
      const updateProgress = (idx: number, done: number, total: number) => {
        progresses[idx] = { done, total };
        let sumDone = 0;
        let sumTotal = 0;
        for (const p of progresses) {
          sumDone += p.done;
          sumTotal += p.total;
        }
        setLoadProgress({ done: sumDone, total: sumTotal });
      };

      const [inbox, archived, requests, e2ee] = await Promise.all([
        listChatFolders(messagesRoot, 'inbox', 'inbox', (d, t) => updateProgress(0, d, t), abortCtrl.signal),
        listChatFolders(messagesRoot, 'archived_threads', 'archived', (d, t) => updateProgress(1, d, t), abortCtrl.signal),
        listChatFolders(messagesRoot, 'message_requests', 'requests', (d, t) => updateProgress(2, d, t), abortCtrl.signal),
        listChatFolders(messagesRoot, 'e2ee_cutover', 'e2ee', (d, t) => updateProgress(3, d, t), abortCtrl.signal),
      ]);
      if (abortCtrl.signal.aborted) return false;
      const mergedInbox = [...inbox, ...e2ee].sort((a, b) => {
        if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
        if (a.lastTimestamp == null) return 1;
        if (b.lastTimestamp == null) return -1;
        return b.lastTimestamp - a.lastTimestamp;
      });
      setInboxList(mergedInbox);
      setArchivedList(archived);
      setRequestsList(requests);
      
      const sizeProgresses = [
        { done: 0, total: mergedInbox.length },
        { done: 0, total: archived.length },
        { done: 0, total: requests.length }
      ];
      const totalSizeToCompute = mergedInbox.length + archived.length + requests.length;
      if (totalSizeToCompute > 0) {
        setSizeProgress({ done: 0, total: totalSizeToCompute });
      }

      const updateSizeProgress = (idx: number, done: number) => {
        sizeProgresses[idx].done = done;
        let sumDone = 0;
        let sumTotal = 0;
        for (const p of sizeProgresses) {
          sumDone += p.done;
          sumTotal += p.total;
        }
        if (sumDone === sumTotal) {
          setSizeProgress(null);
        } else {
          setSizeProgress({ done: sumDone, total: sumTotal });
        }
      };

      startLazySizeComputation(mergedInbox, setInboxList, (d) => updateSizeProgress(0, d), abortCtrl.signal);
      startLazySizeComputation(archived, setArchivedList, (d) => updateSizeProgress(1, d), abortCtrl.signal);
      startLazySizeComputation(requests, setRequestsList, (d) => updateSizeProgress(2, d), abortCtrl.signal);
      return true;
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        setError(e.message || 'Failed to open folder');
        return true;
      }
      return false;
    } finally {
      if (abortControllerRef.current === abortCtrl) {
        setLoading(false);
        setLoadProgress(null);
      }
    }
  }, [startLazySizeComputation]);

  const openFolderWithWriteAccess = useCallback(async () => {
    setError(null);
    try {
      const handle = await pickFolderWithWriteAccess();
      setRootHandle(handle);
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        setError(e.message || 'Failed to get write access');
      }
    }
  }, []);

  const deleteChat = useCallback(async (entry: ChatListEntry) => {
    if (!rootHandle) throw new Error('No folder open');
    const subfolderName =
      entry.source === 'inbox'    ? 'inbox' :
      entry.source === 'requests' ? 'message_requests' :
      entry.source === 'e2ee'     ? 'e2ee_cutover' :
      'archived_threads';
    await deleteChatFs(rootHandle, subfolderName, entry.folderName);
    if (entry.source === 'inbox' || entry.source === 'e2ee') {
      setInboxList(prev => prev.filter(e => e.folderName !== entry.folderName));
    } else if (entry.source === 'requests') {
      setRequestsList(prev => prev.filter(e => e.folderName !== entry.folderName));
    } else {
      setArchivedList(prev => prev.filter(e => e.folderName !== entry.folderName));
    }
  }, [rootHandle]);

  const deleteChats = useCallback(async (entries: ChatListEntry[], onProgress?: (done: number, total: number) => void) => {
    if (!rootHandle) throw new Error('No folder open');
    
    const foldersToRemove = new Set(entries.map(e => e.folderName));
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const subfolderName =
        entry.source === 'inbox'    ? 'inbox' :
        entry.source === 'requests' ? 'message_requests' :
        entry.source === 'e2ee'     ? 'e2ee_cutover' :
        'archived_threads';
      try {
        await deleteChatFs(rootHandle, subfolderName, entry.folderName);
      } catch (err) {
        console.error(`Failed to delete ${entry.folderName}`, err);
      }
      if (onProgress) onProgress(i + 1, entries.length);
    }

    setInboxList(prev => prev.filter(e => !foldersToRemove.has(e.folderName)));
    setRequestsList(prev => prev.filter(e => !foldersToRemove.has(e.folderName)));
    setArchivedList(prev => prev.filter(e => !foldersToRemove.has(e.folderName)));
  }, [rootHandle]);

  const updateFolderSize = useCallback((entry: ChatListEntry, size: number) => {
    if (entry.source === 'inbox' || entry.source === 'e2ee') {
      setInboxList(prev => prev.map(e => e.folderName === entry.folderName ? { ...e, folderSize: size } : e));
    } else if (entry.source === 'requests') {
      setRequestsList(prev => prev.map(e => e.folderName === entry.folderName ? { ...e, folderSize: size } : e));
    } else {
      setArchivedList(prev => prev.map(e => e.folderName === entry.folderName ? { ...e, folderSize: size } : e));
    }
  }, []);

  return {
    rootHandle, originalRootHandle, inboxList, archivedList, requestsList,    loading, loadProgress, sizeProgress, error,
    openFolder, openFolderWithWriteAccess, deleteChat, deleteChats, updateFolderSize,
  };
}
