import type {} from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-session-projection/types';
import type { Team } from './model.js';

/** Shared wire vocabulary only; never import Host Context into the Client face. */
export const PROJECTION = 'team-agents' as const;
export const SNAPSHOT_RECORD = 'plugin:dsh-team-agents/snapshot' as const;
export interface ProjectionState { owner: string; team: Team | null; }

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-team-agents/snapshot': Team; }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'team-agents': ProjectionState; }
  interface SessionProjectionMap { 'team-agents': Team | null; }
}
