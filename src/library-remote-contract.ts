import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteCodecSpec, TypertRemoteMethodSpec, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol';
import { TeamModelOptionsSchema, type TeamModelOption } from './model.js';
import {
  AgentDefinitionsSchema, AgentLibraryRevisionSchema, AgentLibrarySchema, type AgentLibrary,
} from './library-model.js';

export const TEAM_LIBRARY_REMOTE_ENDPOINTS = {
  read: 'teamAgentLibrary/read', models: 'teamAgentLibrary/models', save: 'teamAgentLibrary/save',
} as const;
export const TEAM_LIBRARY_REMOTE_SERVICE = 'teamAgentLibrary';
// Typert requires unique contribution package keys on both faces. Keep the legacy
// execution Remote mounted independently; this is a protocol identity, not an npm dependency.
export const TEAM_LIBRARY_REMOTE_PACKAGE = 'dsh-team-agents-library';
export type AgentLibraryRemoteAction = keyof typeof TEAM_LIBRARY_REMOTE_ENDPOINTS;
export const AgentLibraryRemoteRequests = {
  read: z.strictObject({}),
  models: z.strictObject({}),
  save: z.strictObject({ agents: AgentDefinitionsSchema, expectedRevision: AgentLibraryRevisionSchema }),
} as const;
export type AgentLibraryRemoteRequest<Action extends AgentLibraryRemoteAction> = z.infer<(typeof AgentLibraryRemoteRequests)[Action]>;

function codec(name: string, schema: z.ZodType): TypertRemoteCodecSpec {
  return {
    mode: 'strict', typeSymbol: `${TEAM_LIBRARY_REMOTE_PACKAGE}#library.${name}`, create: () => schema,
    jsonSchemaError: 'Library uniqueness constraints require the runtime Zod parser.',
  };
}
function method(action: AgentLibraryRemoteAction): TypertRemoteMethodSpec {
  const request = codec(`${action}Request`, AgentLibraryRemoteRequests[action]);
  return {
    service: TEAM_LIBRARY_REMOTE_SERVICE, invocation: { kind: 'direct' },
    parameters: [{ name: 'request', source: 'json', codec: request, strictCodec: request }],
    cancellation: { parameter: 'signal' },
    result: action === 'models' ? codec('TeamModelOptions', TeamModelOptionsSchema) : codec('AgentLibrary', AgentLibrarySchema),
  };
}

/** No resource address: the Gateway applies its global ACL, then the service requires its owner carrier. */
export const TEAM_LIBRARY_REMOTE = createTypertRemoteInfo({
  package: TEAM_LIBRARY_REMOTE_PACKAGE,
  methods: {
    [TEAM_LIBRARY_REMOTE_ENDPOINTS.read]: method('read'),
    [TEAM_LIBRARY_REMOTE_ENDPOINTS.models]: method('models'),
    [TEAM_LIBRARY_REMOTE_ENDPOINTS.save]: method('save'),
  },
}, z);

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'teamAgentLibrary/read': (request: AgentLibraryRemoteRequest<'read'>, signal?: AbortSignal) => Promise<RemoteResult<AgentLibrary>>;
    'teamAgentLibrary/models': (request: AgentLibraryRemoteRequest<'models'>, signal?: AbortSignal) => Promise<RemoteResult<TeamModelOption[]>>;
    'teamAgentLibrary/save': (request: AgentLibraryRemoteRequest<'save'>, signal?: AbortSignal) => Promise<RemoteResult<AgentLibrary>>;
  }
  interface TypertRemoteNamespaceMap { teamAgentLibrary: TypertRemoteNamespace<'teamAgentLibrary'>; }
  interface RemoteErrorDetailsMap {
    'team-agent-library/owner-required': {};
    'team-agent-library/revision-conflict': {};
    'team-agent-library/selection-invalid': {};
    'team-agent-library/unavailable': {};
    'team-agent-library/model-unavailable': {};
    'team-agent-library/model-catalog-unavailable': {};
    'team-agent-library/operation-rejected': {};
  }
}
