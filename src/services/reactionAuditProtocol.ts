import type { ReactionEstimate, ReactionGuessingMode } from './reactions';

export interface ReactionThreadOutput {
  id: string; snapshot: string; owner: string; estimates: ReactionEstimate[]; suppressedGroups: number;
}
export interface ReactionConsistencyReport {
  status: 'consistent' | 'inconsistent' | 'incomplete';
  reason: string; owner: string | null; notices: number; candidates: number;
  inconsistentChats: ReactionConsistencyChat[];
}
export interface ReactionConsistencyChat { id: string; notices: number; candidates: number }
export interface ReactionWorkerInput {
  type: 'thread' | 'owner' | 'finish' | 'verify' | 'report';
  id?: string; files?: File[]; mode?: ReactionGuessingMode;
}
export interface ReactionWorkerReply {
  type: 'ready' | 'complete' | 'verified' | 'unavailable' | 'report' | 'error';
  reason?: string; owner?: string | null; snapshot?: string;
  results?: ReactionThreadOutput[]; report?: ReactionConsistencyReport;
}
