import type { Team, TeamModelOption, TeamPlan } from './model.js';
import type { AgentDefinition, AgentLibrary } from './library-model.js';
import type { TeamRunExportOptions, TeamRunExportResult } from './run-export-contract.js';
import type { MemberActivity } from './member-activity-contract.js';

/** Legacy session execution Remote, retained for conversation controls and old clients. */
export interface TeamSettingsActions {
  read(signal?: AbortSignal): Promise<Team | null>;
  models(signal?: AbortSignal): Promise<TeamModelOption[]>;
  save(plan: TeamPlan, expectedRevision: number | null, signal?: AbortSignal): Promise<Team>;
  start(expectedRevision: number, signal?: AbortSignal): Promise<Team>;
  stop(signal?: AbortSignal): Promise<Team>;
  retry(taskId: string, expectedRevision: number, signal?: AbortSignal): Promise<Team>;
  /** One read-only retained-snapshot export for this bound session. Never mutates state. */
  exportRun(options: TeamRunExportOptions, signal?: AbortSignal): Promise<TeamRunExportResult>;
  /** Optional for older clients; viewing never activates or sends input to a member. */
  watchMember?(member: string, signal?: AbortSignal): AsyncIterable<MemberActivity>;
}

/** Host-owner configuration only. No session, objective, task, execution, or export methods. */
export interface AgentLibraryActions {
  read(signal?: AbortSignal): Promise<AgentLibrary>;
  models(signal?: AbortSignal): Promise<TeamModelOption[]>;
  save(agents: AgentDefinition[], expectedRevision: number, signal?: AbortSignal): Promise<AgentLibrary>;
}

export interface TeamSettingsData {
  library: AgentLibrary | undefined;
  loading?: boolean;
  canRead?: boolean;
  canManage?: boolean;
  unavailableReason?: string;
  modelOptions?: TeamModelOption[];
  modelsLoading?: boolean;
  modelsError?: string;
  onRefreshModels?: () => void;
}