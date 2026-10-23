import type { Team, TeamPlan } from './model.js';

/** Browser actions are bound to one host-authorized captain session by the integration layer. */
export interface TeamSettingsActions {
  read(signal?: AbortSignal): Promise<Team | null>;
  save(plan: TeamPlan, expectedRevision: number | null, signal?: AbortSignal): Promise<Team>;
  start(expectedRevision: number, signal?: AbortSignal): Promise<Team>;
  stop(signal?: AbortSignal): Promise<Team>;
  retry(taskId: string, expectedRevision: number, signal?: AbortSignal): Promise<Team>;
}

/** Current saved state comes from the existing DSH projection; undefined is not an empty team. */
export interface TeamSettingsData {
  sessionId?: string;
  team: Team | null | undefined;
  loading?: boolean;
  unavailableReason?: string;
  canManage?: boolean;
}
