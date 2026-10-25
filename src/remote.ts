import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { requireInheritedTeamModel } from './model-route.js';
import { TeamModelError, listTeamModels, validateTeamModels } from './model-catalog.js';
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-workspace';
import type { TeamEngine } from './engine.js';
import type { Team, TeamModelOption } from './model.js';
import {
  TEAM_REMOTE, TEAM_REMOTE_PACKAGE, TEAM_REMOTE_SERVICE, TeamRemoteRequests,
  type TeamRemoteAction, type TeamRemoteRequest,
} from './remote-contract.js';

/** Install only after durable engine recovery. Both registrations belong to this plugin fiber. */
export function registerTeamRemote(ctx: Context, engine: TeamEngine): void {
  ctx.typert.register({
    package: TEAM_REMOTE_PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: TEAM_REMOTE.descriptors,
  });
  new TeamRemoteService(ctx, engine);
}

const sessionResource = (request: { sessionId: string }) => SessionId(request.sessionId);

/** No tool execution or human-message fabrication: browser controls call the domain directly. */
class TeamRemoteService extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  constructor(ctx: Context, private readonly engine: TeamEngine) {
    super(ctx, TEAM_REMOTE_SERVICE);
    ctx.effect(() => () => { this.lifetime.abort(new Error('Team settings service unloaded')); });
  }

  private async captain(action: TeamRemoteAction, sessionId: string, signal: AbortSignal) {
    // Capture the Gateway's immutable carrier principal, not principalOf() (which
    // also returns undefined outside a call), a request field, or an Agent identity.
    const ctx = this.ctx;
    const invocation = ctx.invocation;
    if (!invocation || invocation.peer?.principal?.kind !== 'owner' || invocation.service !== TEAM_REMOTE_SERVICE ||
      invocation.request.namespace !== TEAM_REMOTE_SERVICE || invocation.request.method !== action || invocation.signal !== signal) {
      throw new RemoteError('team-agents/owner-required', 'Team settings require an authenticated host-owner Remote invocation.', {});
    }
    const active = AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifetime.signal]);
    const id = SessionId(sessionId);
    const initialAgent = ctx.agents.get(id);
    const initialSession = ctx.sessions.get(id);
    let header: SessionHeader | undefined;
    let workspace: Awaited<ReturnType<Context['workspaceRegistry']['resolveByPath']>>;
    const unavailable = () => new RemoteError('team-agents/session-unavailable', 'This captain session is missing, delegated, or changed during the request. Reopen its settings.', {});
    const root = (value: SessionHeader) => {
      // A seeded ordinary fork retains durable parent lineage but can be its
      // own runtime root. Unseeded parent links remain ambiguous when cold.
      if (value.id !== id || (value.parentSession !== undefined && !value.isSeeded) ||
        value.origin === 'subagent' || (value.delegationDepth ?? 0) !== 0) throw unavailable();
    };
    const sameHeader = (value: SessionHeader) => !header || (
      value.id === header.id && value.cwd === header.cwd && value.createdAt === header.createdAt &&
      value.parentSession === header.parentSession && value.origin === header.origin &&
      value.delegationDepth === header.delegationDepth && value.isSeeded === header.isSeeded
    );
    const assertCurrent = (agent: Agent | undefined, session: Session | undefined) => {
      active.throwIfAborted();
      if (ctx.agents.get(id) !== agent || ctx.sessions.get(id) !== session || this.engine.identity(id)) throw unavailable();
      if (agent && (agent.id !== id || agent.session !== session || !ctx.agents.roots().includes(agent))) throw unavailable();
      if (session) { root(session.header); if (!sameHeader(session.header)) throw unavailable(); }
      if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
        throw new RemoteError('team-agents/session-unavailable', 'Archived sessions cannot manage teams. Unarchive the captain first.', {});
      }
      if (workspace) {
        if (ctx.workspaceRegistry.get(workspace.id) !== workspace) {
          throw new RemoteError('team-agents/workspace-mismatch', 'The captain workspace is no longer registered in DSH.', {});
        }
        const current = this.engine.snapshot(id);
        if (current && (current.ownerSessionId !== id || current.workspaceId !== workspace.id)) {
          throw new RemoteError('team-agents/workspace-mismatch', 'The saved team does not belong to this captain and workspace.', {});
        }
      }
    };
    const check = () => assertCurrent(initialAgent, initialSession);
    check();
    // The public Session owner cold-reads without resuming an Agent, starting a
    // turn, or resolving a model. SessionInspection calls its header `meta`.
    try { header = (await ctx.sessionController.inspect(id, active)).meta; }
    catch (error) { active.throwIfAborted(); throw new RemoteError('team-agents/session-unavailable', 'The captain session could not be inspected. Open an existing ordinary session.', {}, { cause: error }); }
    check(); root(header);
    if (!header.cwd) throw new RemoteError('team-agents/workspace-mismatch', 'The captain session has no workspace directory.', {});
    workspace = await ctx.workspaceRegistry.resolveByPath(header.cwd);
    // Every asynchronous lookup can outlive cancellation, archival, unload, or
    // replacement by another Agent with the same id. Recheck before admission.
    check();
    if (!workspace) throw new RemoteError('team-agents/workspace-mismatch', 'The captain workspace is not currently registered in DSH.', {});
    return {
      owner: id, workspaceId: workspace.id, check, signal: active,
      acceptLive: (agent: Agent) => {
        if (initialAgent && initialAgent !== agent) throw unavailable();
        const liveCheck = () => { assertCurrent(agent, agent.session); root(agent.session.header); };
        liveCheck();
        return liveCheck;
      },
    };
  }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (remoteErrorOf(error)) throw error;
      if (error instanceof TeamModelError) throw new RemoteError(error.code, error.message, {});
      // Keep actionable engine CAS/plan diagnostics on the native failure face.
      // Gateway cancellation takes precedence if the carrier was cancelled.
      throw new RemoteError('team-agents/operation-rejected', error instanceof Error ? error.message : 'Team operation failed.', {}, { cause: error });
    }
  }

  @Remote({ resources: { session: sessionResource } })
  async read(request: TeamRemoteRequest<'read'>, signal: AbortSignal): Promise<Team | null> {
    const input = TeamRemoteRequests.read.parse(request);
    const captain = await this.captain('read', input.sessionId, signal);
    captain.check();
    return this.engine.snapshot(captain.owner);
  }

  @Remote({ resources: { session: sessionResource } })
  async models(request: TeamRemoteRequest<'models'>, signal: AbortSignal): Promise<TeamModelOption[]> {
    const input = TeamRemoteRequests.models.parse(request);
    const captain = await this.captain('models', input.sessionId, signal);
    return this.operation(async () => {
      const models = await listTeamModels(this.ctx, captain.signal);
      captain.check();
      return models;
    });
  }

  @Remote({ resources: { session: sessionResource } })
  async save(request: TeamRemoteRequest<'save'>, signal: AbortSignal): Promise<Team> {
    const input = TeamRemoteRequests.save.parse(request);
    const captain = await this.captain('save', input.sessionId, signal);
    return this.operation(async () => {
      await validateTeamModels(this.ctx, input.plan.members, captain.signal);
      captain.check();
      return this.engine.savePlan(captain.owner, captain.workspaceId, input.expectedRevision, input.plan);
    });
  }

  @Remote({ resources: { session: sessionResource } })
  async start(request: TeamRemoteRequest<'start'>, signal: AbortSignal): Promise<Team> {
    const input = TeamRemoteRequests.start.parse(request);
    const captain = await this.captain('start', input.sessionId, signal);
    const saved = this.engine.snapshot(captain.owner);
    if (!saved) throw new RemoteError('team-agents/operation-rejected', 'Save a team plan before starting it.', {});
    if (saved.revision !== input.expectedRevision) {
      throw new RemoteError('team-agents/operation-rejected', 'Plan changed. Reload and approve the current saved revision.', {});
    }
    return this.operation(async () => {
      await validateTeamModels(this.ctx, saved.members, captain.signal);
      captain.check();
      // Only an explicit authenticated Start can materialize a cold root. This
      // public API composes the ordinary Session; it never fabricates a prompt.
      const resolved = await this.ctx.sessionController.resolveAgent(captain.owner);
      if ('error' in resolved) { captain.check(); throw resolved.error; }
      const checkLive = captain.acceptLive(resolved.agent);
      requireInheritedTeamModel(this.ctx, resolved.agent, saved);
      checkLive();
      return this.engine.start(captain.owner, input.expectedRevision);
    });
  }

  @Remote({ resources: { session: sessionResource } })
  async stop(request: TeamRemoteRequest<'stop'>, signal: AbortSignal): Promise<Team> {
    const input = TeamRemoteRequests.stop.parse(request);
    const captain = await this.captain('stop', input.sessionId, signal);
    captain.check();
    return this.operation(() => this.engine.stop(captain.owner));
  }

  @Remote({ resources: { session: sessionResource } })
  async retry(request: TeamRemoteRequest<'retry'>, signal: AbortSignal): Promise<Team> {
    const input = TeamRemoteRequests.retry.parse(request);
    const captain = await this.captain('retry', input.sessionId, signal);
    captain.check();
    return this.operation(() => this.engine.retry(captain.owner, input.taskId, input.expectedRevision));
  }
}
