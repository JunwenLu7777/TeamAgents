import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteCodecSpec, TypertRemoteMethodSpec, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol';
import { TeamPlanSchema, TeamSchema, TeamModelOptionsSchema, taskId, type Team, type TeamModelOption } from './model.js';
import {
  TeamRunExportRequestSchema, TeamRunExportResultSchema,
  type TeamRunExportRequest, type TeamRunExportResult,
} from './run-export-contract.js';

/** These are ACL action names, not new policies. Unrecognized actions remain default-deny. */
export const TEAM_REMOTE_ENDPOINTS = {
  read: 'teamAgents/read', save: 'teamAgents/save', start: 'teamAgents/start',
  stop: 'teamAgents/stop', retry: 'teamAgents/retry', models: 'teamAgents/models',
  exportRun: 'teamAgents/exportRun',
} as const;
export type TeamRemoteAction = keyof typeof TEAM_REMOTE_ENDPOINTS;
export const TEAM_REMOTE_SERVICE = 'teamAgents';
export const TEAM_REMOTE_PACKAGE = 'dsh-team-agents';

// A session address is a resource, never proof of the caller's authority.
export const TeamSessionIdSchema = z.string().min(1).max(200).regex(/^\S+$/);
const revision = z.number().int().nonnegative();
const address = z.strictObject({ sessionId: TeamSessionIdSchema });
export const TeamRemoteRequests = {
  read: address,
  models: address,
  save: address.extend({ plan: TeamPlanSchema, expectedRevision: revision.nullable() }),
  start: address.extend({ expectedRevision: revision }),
  stop: address,
  retry: address.extend({ taskId, expectedRevision: revision }),
  // Options only: no owner, principal, path, team selector, model or revision
  // mutation can be supplied by a caller.
  exportRun: TeamRunExportRequestSchema,
} as const;
export type TeamRemoteRequest<Action extends TeamRemoteAction> = z.infer<(typeof TeamRemoteRequests)[Action]>;

// Public DSH 0.2.1 codec/contribution contracts, shared by both faces. No SRC
// fallback, invented transport types, or declarations standing in for runtime validation.
// Refinements (notably DAG validation) are not losslessly representable as tool
// JSON Schema. Remote needs the real parser, not a lossy tool-schema projection.
function codec(name: string, schema: z.ZodType): TypertRemoteCodecSpec {
  return {
    mode: 'strict', typeSymbol: `${TEAM_REMOTE_PACKAGE}#${name}`, create: () => schema,
    jsonSchemaError: 'Team constraints require the runtime Zod parser; no lossless tool-schema projection.',
  };
}
function method(action: TeamRemoteAction, result: TypertRemoteCodecSpec): TypertRemoteMethodSpec {
  const request = codec(`${action}Request`, TeamRemoteRequests[action]);
  return {
    service: TEAM_REMOTE_SERVICE, invocation: { kind: 'direct' },
    parameters: [{ name: 'request', source: 'json', codec: request, strictCodec: request }],
    cancellation: { parameter: 'signal' },
    result,
  };
}
const teamResult = (name: string, nullable = false) =>
  codec(name, nullable ? TeamSchema.nullable() : TeamSchema);

/** Same strict descriptors are registered at the Host and mounted by the native Client Remote service. */
export const TEAM_REMOTE = createTypertRemoteInfo({
  package: TEAM_REMOTE_PACKAGE,
  methods: {
    [TEAM_REMOTE_ENDPOINTS.read]: method('read', teamResult('TeamOrNull', true)),
    [TEAM_REMOTE_ENDPOINTS.models]: method('models', codec('TeamModelOptions', TeamModelOptionsSchema)),
    [TEAM_REMOTE_ENDPOINTS.save]: method('save', teamResult('Team')),
    [TEAM_REMOTE_ENDPOINTS.start]: method('start', teamResult('Team')),
    [TEAM_REMOTE_ENDPOINTS.stop]: method('stop', teamResult('Team')),
    [TEAM_REMOTE_ENDPOINTS.retry]: method('retry', teamResult('Team')),
    // The export envelope is validated by its own schema, never by TeamSchema.
    [TEAM_REMOTE_ENDPOINTS.exportRun]: method('exportRun', codec('TeamRunExportResult', TeamRunExportResultSchema)),
  },
}, z);

declare module '@deepseek-ai/dsh-typert-protocol' {
  // The current SDK's typed endpoint vocabulary must describe the actual
  // mounted runtime methods above (also consumed by native useAccess()).
  interface TypertRemoteMap {
    'teamAgents/read': (request: TeamRemoteRequest<'read'>, signal?: AbortSignal) => Promise<RemoteResult<Team | null>>;
    'teamAgents/models': (request: TeamRemoteRequest<'models'>, signal?: AbortSignal) => Promise<RemoteResult<TeamModelOption[]>>;
    'teamAgents/exportRun': (request: TeamRunExportRequest, signal?: AbortSignal) => Promise<RemoteResult<TeamRunExportResult>>;
    'teamAgents/save': (request: TeamRemoteRequest<'save'>, signal?: AbortSignal) => Promise<RemoteResult<Team>>;
    'teamAgents/start': (request: TeamRemoteRequest<'start'>, signal?: AbortSignal) => Promise<RemoteResult<Team>>;
    'teamAgents/stop': (request: TeamRemoteRequest<'stop'>, signal?: AbortSignal) => Promise<RemoteResult<Team>>;
    'teamAgents/retry': (request: TeamRemoteRequest<'retry'>, signal?: AbortSignal) => Promise<RemoteResult<Team>>;
  }
  interface TypertRemoteNamespaceMap {
    teamAgents: TypertRemoteNamespace<'teamAgents'>;
  }
  interface RemoteErrorDetailsMap {
    'team-agents/owner-required': {};
    'team-agents/session-unavailable': {};
    'team-agents/workspace-mismatch': {};
    'team-agents/model-required': {};
    'team-agents/model-unavailable': {};
    'team-agents/model-catalog-unavailable': {};
    'team-agents/operation-rejected': {};
    'team-agents/no-team': {};
    'team-agents/export-too-large': {};
    'team-agents/export-invalid-snapshot': {};
  }
}
