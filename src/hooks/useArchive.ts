import { useState, useCallback, useRef } from 'react';
import type { ChatListEntry } from '../types/messenger';
import {
  pickMessagesFolder,
  pickFolderWithWriteAccess,
  listChatFolders,
  computeFolderSize,
  deleteChat as deleteChatFs,
} from '../services/fileSystem';

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
  error: string | null;
  openFolder: (requestWrite?: boolean) => Promise<void>;
  openFolderWithWriteAccess: () => Promise<void>;
  deleteChat: (entry: ChatListEntry) => Promise<void>;
  updateFolderSize: (entry: ChatListEntry, size: number) => void;
} {
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [originalRootHandle, setOriginalRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [inboxList, setInboxList] = useState<ChatListEntry[]>([]);
  const [archivedList, setArchivedList] = useState<ChatListEntry[]>([]);
  const [requestsList, setRequestsList] = useState<ChatListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a ref to current lists so lazy size computation always works with latest state
  const inboxListRef = useRef<ChatListEntry[]>([]);
  const archivedListRef = useRef<ChatListEntry[]>([]);
  const requestsListRef = useRef<ChatListEntry[]>([]);
  inboxListRef.current = inboxList;
  archivedListRef.current = archivedList;
  requestsListRef.current = requestsList;

  const startLazySizeComputation = useCallback((entries: ChatListEntry[], setList: React.Dispatch<React.SetStateAction<ChatListEntry[]>>) => {
    // Process one folder at a time with a small delay to avoid blocking UI
    const processNext = (index: number) => {
      if (index >= entries.length) return;
      const entry = entries[index];
      setTimeout(async () => {
        try {
          const size = await computeFolderSize(entry.dirHandle);
          setList(prev =>
            prev.map(e => e.folderName === entry.folderName ? { ...e, folderSize: size } : e)
          );
        } catch { /* ignore */ }
        processNext(index + 1);
      }, 0);
    };
    processNext(0);
  }, []);

  const openFolder = useCallback(async (requestWrite?: boolean) => {
    setError(null);
    setLoading(true);
    try {
      const handle = requestWrite ? await pickFolderWithWriteAccess() : await pickMessagesFolder();
      
      const messagesRoot = await resolveMessagesRoot(handle);
      if (!messagesRoot) {
        throw new Error("Could not find messages in this folder. Make sure you selected an extracted Facebook archive.");
      }

      setOriginalRootHandle(handle);
      setRootHandle(messagesRoot);
      const [inbox, archived, requests, e2ee] = await Promise.all([
        listChatFolders(messagesRoot, 'inbox', 'inbox'),
        listChatFolders(messagesRoot, 'archived_threads', 'archived'),
        listChatFolders(messagesRoot, 'message_requests', 'requests'),
        listChatFolders(messagesRoot, 'e2ee_cutover', 'e2ee'),
      ]);
      // Merge e2ee into inbox and re-sort by lastTimestamp descending
      const mergedInbox = [...inbox, ...e2ee].sort((a, b) => {
        if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
        if (a.lastTimestamp == null) return 1;
        if (b.lastTimestamp == null) return -1;
        return b.lastTimestamp - a.lastTimestamp;
      });
      setInboxList(mergedInbox);
      setArchivedList(archived);
      setRequestsList(requests);
      startLazySizeComputation(mergedInbox, setInboxList);
      startLazySizeComputation(archived, setArchivedList);
      startLazySizeComputation(requests, setRequestsList);
    } catch (e: unknown) {
      // User cancelled the picker — not an error worth surfacing
      if (e instanceof Error && e.name !== 'AbortError') {
        setError(e.message || 'Failed to open folder');
      }
    } finally {
      setLoading(false);
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
    rootHandle, originalRootHandle, inboxList, archivedList, requestsList, loading, error,
    openFolder, openFolderWithWriteAccess, deleteChat, updateFolderSize,
  };
}
