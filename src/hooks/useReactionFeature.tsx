import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ReadableDirectoryHandle } from '../types/fileSystem';
import type { ChatListEntry, MessengerThread, Reaction } from '../types/messenger';
import { discoverReactionConversations, iterateReactionConversations, reactionConversationId } from '../services/reactionAuditInventory';
import { getLoadedReactionFiles } from '../services/fileSystem';
import { getRecordedReactionTime, getReactionTimestamp, type ReactionEstimate, type ReactionGuessingMode } from '../services/reactions';
import { createReactionWorkerSession, type ReactionWorkerSession } from '../services/reactionWorkerSession';
import type { ReactionConsistencyChat, ReactionConsistencyReport, ReactionThreadOutput, ReactionWorkerReply } from '../services/reactionAuditProtocol';

interface Session extends ReactionWorkerSession {
  root: ReadableDirectoryHandle; revision: number; attempt: number; invalidated: boolean; owner: string | null;
  loaded: Map<string, { data: MessengerThread; snapshot: string }>;
  loading: Map<string, Promise<void>>;
  results: Map<string, ReactionWorkerReply>;
  sampled: Set<string>; ownerTask?: Promise<void>;
}
interface AuditState {
  session: Session | null; id: string; mode: ReactionGuessingMode; status: string; reason: string;
  data: MessengerThread | null; output?: ReactionThreadOutput;
}
interface ConsistencyState {
  status: 'idle' | 'checking' | ReactionConsistencyReport['status']; reason: string;
  inconsistentChats: ReactionConsistencyChat[];
  notices: number | null; candidates: number | null;
}
interface ReactionFeature {
  hide: boolean; applicable: boolean; status: string; reason: string; mode: ReactionGuessingMode;
  hasCache: boolean; canClear: boolean; clear: () => void; retry: () => void; showAll: () => void;
  consistency: ConsistencyState; canCheckArchive: boolean; checkArchive: () => void; cancelArchiveCheck: () => void;
  time: (reaction: Reaction, messageIndex: number, reactionIndex: number) => { timestamp: number; method?: ReactionEstimate['method'] };
}
const emptyAudit: AuditState = { session: null, id: '', mode: 'off', status: 'idle', reason: '', data: null };
const emptyConsistency: ConsistencyState = { status: 'idle', reason: '', inconsistentChats: [], notices: null, candidates: null };
const defaultFeature: ReactionFeature = { hide: true, applicable: true, status: 'off', reason: '', mode: 'off', hasCache: false, canClear: false, clear: () => {}, retry: () => {}, showAll: () => {}, consistency: emptyConsistency, canCheckArchive: false, checkArchive: () => {}, cancelArchiveCheck: () => {}, time: r => ({ timestamp: getReactionTimestamp(r) }) };
export const ReactionFeatureContext = createContext<ReactionFeature>(defaultFeature);
export const useReactionContext = () => useContext(ReactionFeatureContext);
const cacheKey = (id: string, mode: ReactionGuessingMode) => JSON.stringify([id, mode]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
// Ordinary guessing has several short internal stages. Keep its visible state
// steady so selecting a mode does not flash implementation detail in Settings.
const checkingReason = 'Checking reaction notices…';

export function useReactionFeature(options: {
  root: ReadableDirectoryHandle | null; revision: number; standalone: boolean; archiveLoading: boolean;
  chatLoading: boolean; chatData: MessengerThread | null; entry: ChatListEntry | null;
  mode: ReactionGuessingMode; hide: boolean; showAll: () => void;
}): ReactionFeature {
  const { root, revision, standalone, archiveLoading, chatLoading, chatData, entry, mode, hide, showAll } = options;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(v => v + 1), []);
  const modeRef = useRef(mode), busyRef = useRef(chatLoading || archiveLoading);
  modeRef.current = mode; busyRef.current = chatLoading || archiveLoading;
  const sessionRef = useRef<Session | null>(null);
  const fullRef = useRef<ReactionWorkerSession | null>(null);
  const scopeRef = useRef({});
  const [audit, setAudit] = useState<AuditState>(emptyAudit);
  const [consistency, setConsistency] = useState<ConsistencyState>(emptyConsistency);
  const enabled = mode !== 'off';

  useEffect(() => {
    // Off preserves completed per-chat caches. Clear/Refresh and source changes
    // discard quick results and any full consistency report.
    scopeRef.current = {};
    setAudit(emptyAudit);
    setConsistency(emptyConsistency);
    return () => {
      sessionRef.current?.dispose(); sessionRef.current = null;
      fullRef.current?.dispose(); fullRef.current = null;
      scopeRef.current = {};
    };
  }, [root, revision, attempt, standalone, archiveLoading]);

  useEffect(() => {
    if (!enabled || !root || standalone || archiveLoading || sessionRef.current) return;
    const session: Session = {
      ...createReactionWorkerSession(() => busyRef.current || modeRef.current === 'off'),
      root, revision, attempt, invalidated: false, owner: null,
      loaded: new Map(), loading: new Map(), results: new Map(), sampled: new Set(),
    };
    sessionRef.current = session;
    // Avoid an idle render between Refresh creating the worker and the chat
    // effect starting its request. Settings otherwise briefly says “Select a
    // Facebook or Instagram export” despite an export already being open.
    setAudit({ ...emptyAudit, session, status: 'checking', reason: checkingReason });
  }, [root, revision, attempt, enabled, standalone, archiveLoading]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!enabled || !session || audit.session !== session || session.invalidated || session.signal.aborted || chatLoading) return;
    if (!chatData || !entry || entry._messengerExport) {
      setAudit({ ...emptyAudit, session, reason: 'Open a chat to check its reaction notices.' });
      return;
    }
    const id = reactionConversationId(entry.source, entry.folderName);
    let current = true;
    const isCurrent = () => current && sessionRef.current === session && !session.invalidated;
    const publish = (status: string, reason: string, output?: ReactionThreadOutput) => {
      if (isCurrent() && !session.signal.aborted) setAudit({ session, id, mode, status, reason, data: chatData, output });
    };
    const invalidate = (status: string, reason: string) => {
      session.invalidated = true; session.results.clear();
      setAudit({ session, id, mode, status, reason, data: chatData });
    };
    const updateOwner = (reply: ReactionWorkerReply) => {
      if (reply.owner !== undefined && reply.owner !== session.owner) {
        session.owner = reply.owner;
        session.results.clear();
      }
    };
    if (!chatData._reactionInputComplete) {
      invalidate('failed', 'Reaction-time guesses unavailable: this chat has unreadable or invalid message parts. Reopen this chat and refresh guesses to try again.');
      return;
    }
    const files = getLoadedReactionFiles(chatData);
    if (!files) { publish('unavailable', 'Current message files are unavailable. Reopen this chat and refresh guesses.'); return; }
    const cached = session.results.get(cacheKey(id, mode));
    if (session.loaded.get(id)?.data === chatData && cached) {
      publish(cached.type === 'complete' ? 'ready' : 'unavailable', cached.reason || '', cached.results?.[0]);
      return;
    }
    publish('checking', checkingReason);
    void (async () => {
      try {
        await session.idle(isCurrent);
        // A dispatched thread load may finish after a mode change. Share that
        // load, and only dispatch matching for the latest active chat/mode.
        let loading = session.loading.get(id);
        if (!session.loaded.has(id) && !loading) {
          loading = session.request({ type: 'thread', id, files }).then(reply => {
            if (session.signal.aborted) return;
            session.loaded.set(id, { data: chatData, snapshot: reply.snapshot! });
            session.sampled.add(id); updateOwner(reply);
          }).finally(() => session.loading.delete(id));
          session.loading.set(id, loading);
        }
        await loading;
        await session.idle(isCurrent);
        const loaded = session.loaded.get(id)!;
        // First use is tied directly to the exact immutable Files the chat
        // loader used. Reopened chat objects must prove the same byte snapshot.
        if (loaded.data !== chatData) {
          const reply = await session.request({ type: 'verify', files }, isCurrent);
          if (!isCurrent()) return;
          if (reply.snapshot !== loaded.snapshot) { invalidate('unavailable', 'Archive changed. Reopen this chat if its files changed and refresh guesses.'); return; }
          loaded.data = chatData;
        }
        if (!session.owner) {
          publish('checking', checkingReason);
          if (!session.ownerTask) {
            session.ownerTask = (async () => {
              // Lazy discovery stops as soon as three distinct two-person chats
              // support one owner. Other histories are never matched here.
              for await (const conversation of iterateReactionConversations(root!, session.signal, () => session.idle())) {
                if (session.owner) break;
                if (session.sampled.has(conversation.id)) continue;
                await session.idle();
                try {
                  const file = await (await conversation.handle.getFileHandle(conversation.files[0])).getFile();
                  const reply = await session.request({ type: 'owner', id: conversation.id, files: [file] });
                  updateOwner(reply);
                } catch {
                  // Unreadable metadata cannot prove ownership, but another chat
                  // can. Worker startup failures and cancellation still surface.
                  session.check();
                }
                session.sampled.add(conversation.id);
                if (session.owner) break;
              }
            })().finally(() => { session.ownerTask = undefined; });
          }
          await session.ownerTask;
        }
        await session.idle(isCurrent);
        const previous = session.results.get(cacheKey(id, mode));
        publish('checking', checkingReason);
        const result = previous || await session.request({ type: 'finish', id, mode }, isCurrent);
        if (!isCurrent()) return;
        session.results.set(cacheKey(id, mode), result);
        publish(result.type === 'complete' ? 'ready' : 'unavailable', result.reason || '', result.results?.[0]);
      } catch (error) {
        if (isCurrent() && !session.signal.aborted) invalidate('failed', `Reaction-time guesses unavailable. ${errorText(error)}`);
      }
    })();
    return () => { current = false; };
  }, [root, revision, attempt, standalone, archiveLoading, enabled, mode, chatData, entry, chatLoading, audit.session]);

  const cancelArchiveCheck = useCallback(() => {
    if (!fullRef.current) return;
    fullRef.current.dispose(); fullRef.current = null;
    setConsistency({ status: 'incomplete', reason: 'Check canceled. Archive consistency is unknown.', inconsistentChats: [], notices: null, candidates: null });
  }, []);
  const canCheckArchive = !!root && !standalone && !archiveLoading;
  const checkArchive = useCallback(() => {
    if (!canCheckArchive || !root || fullRef.current) return;
    const scope = scopeRef.current;
    // Explicit full checking works even with guessing Off, using an independent
    // worker so its histories and results never fill the quick guessing cache.
    const scan = createReactionWorkerSession(() => busyRef.current);
    fullRef.current = scan;
    const current = () => scopeRef.current === scope && fullRef.current === scan && !scan.signal.aborted;
    const report = (state: ConsistencyState) => { if (current()) setConsistency(state); };
    report({ status: 'checking', reason: 'Finding chats for the full consistency check...', inconsistentChats: [], notices: null, candidates: null });
    void (async () => {
      try {
        const conversations = await discoverReactionConversations(root, scan.signal, () => scan.idle(current));
        let checked = 0, failures = 0;
        for (const conversation of conversations) {
          await scan.idle(current);
          report({ status: 'checking', reason: `Checking archive consistency: ${checked} of ${conversations.length} chats checked...`, inconsistentChats: [], notices: null, candidates: null });
          try {
            const files: File[] = [];
            for (const name of conversation.files) { await scan.idle(current); files.push(await (await conversation.handle.getFileHandle(name)).getFile()); }
            await scan.request({ type: 'thread', id: conversation.id, files }, current);
          } catch { scan.check(); failures++; }
          checked++;
        }
        const reply = await scan.request({ type: 'report' }, current);
        const result = reply.report!;
        report(failures ? { status: 'incomplete', reason: `${failures} chats could not be fully checked. Archive consistency is unknown.`, inconsistentChats: [], notices: null, candidates: null } : result);
        // A full check is advisory for notice coverage. A conflicting owner
        // result does withdraw guesses based on the former owner.
        const session = sessionRef.current;
        if (current() && !failures && session?.owner && (result.owner && result.owner !== session.owner || !result.owner && result.status === 'inconsistent')) {
          session.invalidated = true; session.results.clear();
          setAudit(previous => ({ ...previous, status: 'unavailable', reason: 'The full check conflicts with the sampled export owner. Refresh guesses before using estimated times.', output: undefined }));
        }
      } catch (error) {
        report({ status: 'incomplete', reason: `Full check could not finish. Archive consistency is unknown. ${errorText(error)}`, inconsistentChats: [], notices: null, candidates: null });
      } finally {
        if (fullRef.current === scan) fullRef.current = null;
        scan.dispose();
      }
    })();
  }, [canCheckArchive, root]);

  const applicable = !standalone;
  const session = sessionRef.current;
  const currentSession = !!session && audit.session === session && session.root === root && session.revision === revision && session.attempt === attempt && !session.signal.aborted && !archiveLoading;
  const hasCache = currentSession && !session.invalidated && [...session.results.values()].some(result => result.type === 'complete');
  const id = entry ? reactionConversationId(entry.source, entry.folderName) : '';
  const cached = session?.results.get(cacheKey(id, mode));
  const active = currentSession && !session.invalidated && session.loaded.get(id)?.data === chatData && cached?.results?.[0]?.owner === session.owner ? cached.results[0] : undefined;
  const estimates = useMemo(() => new Map((active?.estimates || []).map(e => [`${e.messageIndex}:${e.reactionIndex}`, e])), [active]);
  const time = useCallback((reaction: Reaction, mi: number, ri: number) => {
    const recorded = getReactionTimestamp(reaction, standalone);
    if (recorded) return { timestamp: recorded };
    if (!enabled || !applicable || getRecordedReactionTime(reaction).kind !== 'missing' || !chatData?._reactionInputComplete) return { timestamp: 0 };
    const estimate = estimates.get(`${mi}:${ri}`);
    if (!estimate || (mode !== 'aggressive' && estimate.method === 'cross')) return { timestamp: 0 };
    return { timestamp: estimate.timestamp, method: estimate.method };
  }, [standalone, enabled, applicable, chatData, estimates, mode]);
  const status = !root ? 'no-archive' : !applicable ? 'not-applicable' : !enabled ? 'off' : currentSession ? audit.status : 'checking';
  return useMemo(() => ({ hide: hide && applicable, applicable, mode, hasCache, canClear: currentSession, clear: retry, status, reason: currentSession ? audit.reason : '', retry, showAll, time, consistency, canCheckArchive, checkArchive, cancelArchiveCheck }), [hide, applicable, mode, hasCache, currentSession, status, audit.reason, retry, showAll, time, consistency, canCheckArchive, checkArchive, cancelArchiveCheck]);
}
