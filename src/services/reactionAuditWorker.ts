import { compactReactionThread, inferReactionOwner, matchReactionThread, normalizeReactionName, type CompactReactionThread } from './reactionMatching';
import { readReactionFile, parseReactionFiles } from './reactionSnapshot';
import type { ReactionWorkerInput, ReactionWorkerReply, ReactionConsistencyReport } from './reactionAuditProtocol';

const threads = new Map<string, { compact: CompactReactionThread; snapshot: string }>();
const participants = new Map<string, { participants: string[] }>();
const resultCache = new Map<string, ReactionWorkerReply>();
const owner = () => inferReactionOwner([...participants.values()]);
const size = (thread: CompactReactionThread) => thread.targets.length + thread.notices.length + thread.boundaries.length;
let records = 0;
self.onmessage = async (event: MessageEvent<ReactionWorkerInput>) => {
  try {
    const input = event.data;
    if (input.type === 'verify') {
      const snapshot: [string, string][] = [];
      for (const file of input.files!) snapshot.push([file.name, (await readReactionFile(file)).hash]);
      self.postMessage({ type: 'verified', snapshot: JSON.stringify(snapshot) });
      return;
    }
    if (input.type === 'owner') {
      // Read one part for participant metadata, without normalizing or matching
      // this other chat's message history. Never use the chosen view perspective.
      const { text } = await readReactionFile(input.files![0]);
      const data = JSON.parse(text);
      if (!Array.isArray(data.messages) || !Array.isArray(data.participants) || data.participants.some((p: { name?: unknown } | null) => !p || typeof p.name !== 'string')) throw new Error('Invalid owner metadata.');
      participants.set(input.id!, { participants: data.participants.map((p: { name: string }) => normalizeReactionName(p.name)).filter(Boolean) });
      resultCache.clear();
      self.postMessage({ type: 'ready', owner: owner() });
      return;
    }
    if (input.type === 'thread') {
      resultCache.clear();
      const data = await parseReactionFiles(input.files!, true);
      const compact = compactReactionThread(data);
      const previous = threads.get(input.id!);
      records += size(compact) - (previous ? size(previous.compact) : 0);
      // Conservative compact-record budget; resource limits fail the audit instead of truncating history.
      if (records > 500_000) throw new Error('Reaction audit reached its memory budget.');
      threads.set(input.id!, { compact, snapshot: data._reactionSnapshot! });
      participants.set(input.id!, compact);
      self.postMessage({ type: 'ready', snapshot: data._reactionSnapshot, owner: owner() });
      return;
    }
    const detectedOwner = owner();
    if (input.type === 'report') {
      const report: ReactionConsistencyReport = { status: 'incomplete', reason: '', owner: detectedOwner, notices: 0, candidates: 0, inconsistentChats: [], unmatchedChats: [] };
      if (!detectedOwner) {
        const pairs = new Set([...participants.values()].map(t => [...new Set(t.participants)].sort()).filter(p => p.length === 2).map(p => JSON.stringify(p)));
        report.status = pairs.size >= 3 ? 'inconsistent' : 'incomplete';
        report.reason = pairs.size >= 3 ? 'Participant matches do not identify one export owner.' : 'Not enough distinct two-person chats to identify the export owner.';
      } else {
        for (const [id, { compact }] of threads) {
          const result = matchReactionThread(compact, detectedOwner, 'near');
          report.notices += result.syntaxCount;
          report.candidates += result.candidates;
          if (result.candidates < result.syntaxCount) report.unmatchedChats.push({ id, notices: result.syntaxCount, candidates: result.candidates });
          if (result.syntaxCount >= 20 && result.candidates / result.syntaxCount < .95) {
            report.inconsistentChats.push({ id, notices: result.syntaxCount, candidates: result.candidates });
          }
        }
        if (report.notices < 20) report.reason = `Not enough supported notices (${report.notices}; at least 20 needed).`;
        else {
          report.status = report.candidates / report.notices >= .95 && report.inconsistentChats.length === 0 ? 'consistent' : 'inconsistent';
          report.reason = `${report.candidates}/${report.notices} supported notices match reactions.${report.inconsistentChats.length ? ` ${report.inconsistentChats.length} chats have inconsistent matches.` : ''} This checks match consistency, not timestamp accuracy.`;
        }
      }
      self.postMessage({ type: 'report', report });
      return;
    }
    const key = JSON.stringify([input.id, input.mode, detectedOwner]);
    const cached = resultCache.get(key);
    if (cached) { self.postMessage(cached); return; }
    if (!detectedOwner) { self.postMessage({ type: 'unavailable', reason: 'Not enough independent chats to identify the export owner.' }); return; }
    const thread = threads.get(input.id!);
    if (!thread) throw new Error('Current chat has not been checked.');
    const result = matchReactionThread(thread.compact, detectedOwner, input.mode!);
    // A small current chat can yield useful guesses. The optional full report
    // retains its minimum sample size; other chats never supply its timestamps.
    if (!result.syntaxCount || result.candidates / result.syntaxCount < .95) {
      self.postMessage({ type: 'unavailable', reason: !result.syntaxCount ? 'No supported reaction notices in this chat.' : `Inconsistent matches in this chat (${result.candidates}/${result.syntaxCount} notices have matches).` }); return;
    }
    const reply: ReactionWorkerReply = { type: 'complete', results: [{ id: input.id!, snapshot: thread.snapshot, owner: detectedOwner, estimates: result.estimates, suppressedGroups: result.suppressedGroups }], owner: detectedOwner };
    resultCache.set(key, reply);
    self.postMessage(reply);
  } catch (error) {
    self.postMessage({ type: 'error', reason: error instanceof Error ? error.message : String(error) });
  }
};
