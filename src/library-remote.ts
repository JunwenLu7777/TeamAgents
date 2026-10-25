import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { AgentLibraryError, type AgentLibraryStore } from './agent-library.js';
import type { AgentLibrary } from './library-model.js';
import type { TeamModelOption } from './model.js';
import { TeamModelError, listTeamModels, validateTeamModels } from './model-catalog.js';
import {
  AgentLibraryRemoteRequests, TEAM_LIBRARY_REMOTE, TEAM_LIBRARY_REMOTE_PACKAGE, TEAM_LIBRARY_REMOTE_SERVICE,
  type AgentLibraryRemoteAction, type AgentLibraryRemoteRequest,
} from './library-remote-contract.js';

export function registerAgentLibraryRemote(ctx: Context, library: AgentLibraryStore): void {
  ctx.typert.register({
    package: TEAM_LIBRARY_REMOTE_PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: TEAM_LIBRARY_REMOTE.descriptors,
  });
  new AgentLibraryRemoteService(ctx, library);
}

/** Host-owner reusable settings. Reading/planning never opens an Agent, session, or workspace. */
class AgentLibraryRemoteService extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  constructor(ctx: Context, private readonly library: AgentLibraryStore) {
    super(ctx, TEAM_LIBRARY_REMOTE_SERVICE);
    ctx.effect(() => () => this.lifetime.abort(new Error('Agent library service unloaded')));
  }

  private owner(action: AgentLibraryRemoteAction, signal: AbortSignal) {
    const invocation = this.ctx.invocation;
    const denied = () => new RemoteError('team-agent-library/owner-required', 'Agent library settings require an authenticated host-owner Remote invocation.', {});
    if (!invocation || invocation.peer?.principal?.kind !== 'owner' || invocation.service !== TEAM_LIBRARY_REMOTE_SERVICE ||
      invocation.request.namespace !== TEAM_LIBRARY_REMOTE_SERVICE || invocation.request.method !== action || invocation.signal !== signal) {
      throw denied();
    }
    const peer = invocation.peer;
    const principal = peer.principal;
    const active = AbortSignal.any([signal, invocation.signal, peer.signal, this.lifetime.signal]);
    const check = () => {
      active.throwIfAborted();
      // Recheck the exact authenticated carrier before every delayed write or result admission.
      if (invocation.peer !== peer || peer.principal !== principal || peer.principal.kind !== 'owner') throw denied();
    };
    check();
    return { signal: active, check };
  }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (remoteErrorOf(error)?.code === 'team-agent-library/owner-required') {
        throw new RemoteError('team-agent-library/owner-required', 'Agent library settings require an authenticated host-owner Remote invocation.', {});
      }
      if (error instanceof AgentLibraryError) throw new RemoteError(error.code, error.message, {});
      if (error instanceof TeamModelError) {
        if (error.code === 'team-agents/model-unavailable') {
          throw new RemoteError('team-agent-library/model-unavailable', 'An enabled Agent model is no longer in the Harness catalog. Refresh the models and choose an available model, or disable that Agent.', {});
        }
        throw new RemoteError('team-agent-library/model-catalog-unavailable', 'The Harness model catalog is unavailable. Refresh it or check the host model settings.', {});
      }
      // Unknown persistence/adapter errors can contain secrets. Keep neither their text nor cause on the wire.
      throw new RemoteError('team-agent-library/operation-rejected', 'Agent library operation failed. Reload the saved library and try again.', {});
    }
  }

  @Remote
  async read(request: AgentLibraryRemoteRequest<'read'>, signal: AbortSignal): Promise<AgentLibrary> {
    AgentLibraryRemoteRequests.read.parse(request);
    const owner = this.owner('read', signal);
    return this.operation(async () => { owner.check(); return this.library.read(); });
  }

  @Remote
  async models(request: AgentLibraryRemoteRequest<'models'>, signal: AbortSignal): Promise<TeamModelOption[]> {
    AgentLibraryRemoteRequests.models.parse(request);
    const owner = this.owner('models', signal);
    return this.operation(async () => {
      const models = await listTeamModels(this.ctx, owner.signal);
      owner.check(); return models;
    });
  }

  @Remote
  async save(request: AgentLibraryRemoteRequest<'save'>, signal: AbortSignal): Promise<AgentLibrary> {
    const input = AgentLibraryRemoteRequests.save.parse(request);
    const owner = this.owner('save', signal);
    return this.operation(async () => {
      await validateTeamModels(this.ctx, input.agents.filter(agent => agent.enabled), owner.signal);
      owner.check();
      const saved = await this.library.save(input.agents, input.expectedRevision, owner.signal, owner.check);
      owner.check(); return saved;
    });
  }
}
