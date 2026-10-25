import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import { TeamModelOptionsSchema, TeamSchema } from './model.js';
import type { TeamSettingsActions } from './settings-contract.js';
import {
  TEAM_REMOTE, TEAM_REMOTE_ENDPOINTS, TeamSessionIdSchema,
  type TeamRemoteAction, type TeamRemoteRequest,
} from './remote-contract.js';

export interface MountedTeamRemote {
  forSession(sessionId: string): TeamSettingsActions;
}

/** Await once per Client plugin apply, never in a component or session render. */
export async function mountTeamRemote(ctx: Context): Promise<MountedTeamRemote> {
  const lifetime = new AbortController();
  ctx.effect(() => () => { lifetime.abort(new Error('Team settings client unloaded')); });
  // The native $mount owns its registration/unmount in this calling Cordis
  // fiber, including cleanup if the plugin unloads while mount is pending.
  await ctx.remote.$mount(TEAM_REMOTE);
  let mountedRemote: Context['remote'] | undefined;
  // A real plugin fiber must inject the newly mounted namespace. Injecting it
  // on the parent would deadlock its own mount; using the root would bypass
  // Cordis ownership. This child scope owns the callable namespace view.
  await ctx.inject(['remote', 'remote.teamAgents'], scope => {
    const remote = scope.remote;
    mountedRemote = remote;
    scope.effect(() => () => { if (mountedRemote === remote) mountedRemote = undefined; });
  });
  lifetime.signal.throwIfAborted();
  return {
    forSession(sessionId) {
      const boundId = TeamSessionIdSchema.parse(sessionId);
      async function invoke<Action extends TeamRemoteAction>(action: Action, request: TeamRemoteRequest<Action>, signal?: AbortSignal) {
        const active = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
        active.throwIfAborted();
        const method = TEAM_REMOTE.methods[TEAM_REMOTE_ENDPOINTS[action]];
        if (!method || method.mode === 'stream') throw new Error('Team settings unary Remote descriptor is unavailable');
        const input = method.input({ strict: true }).create().parse({ request });
        const remote = mountedRemote;
        if (!remote) throw new Error('Team settings Remote namespace is unavailable');
        const result = await method.invoke(remote, input, active);
        active.throwIfAborted();
        if (!('ok' in result)) throw new Error('Team settings expected a unary Remote result');
        if (!result.ok) throw result.error;
        return result.value;
      }
      async function call<Action extends Exclude<TeamRemoteAction, 'models'>>(action: Action, request: TeamRemoteRequest<Action>, signal?: AbortSignal) {
        const team = TeamSchema.nullable().parse(await invoke(action, request, signal));
        if (team && team.ownerSessionId !== boundId) throw new Error('Team settings received another captain session\'s state');
        return team;
      }
      async function required<Action extends Exclude<TeamRemoteAction, 'read' | 'models'>>(action: Action, request: TeamRemoteRequest<Action>, signal?: AbortSignal) {
        const team = await call(action, request, signal);
        if (!team) throw new Error('Team settings mutation returned no saved team');
        return team;
      }
      // Every closure keeps this exact session id; switching tabs cannot retarget
      // an in-flight save, start, stop, or retry. Only the Host authorizes it.
      return Object.freeze({
        read: (signal?: AbortSignal) => call('read', { sessionId: boundId }, signal),
        models: async (signal?: AbortSignal) => TeamModelOptionsSchema.parse(await invoke('models', { sessionId: boundId }, signal)),
        save: (plan, expectedRevision, signal) => required('save', { sessionId: boundId, plan, expectedRevision }, signal),
        start: (expectedRevision, signal) => required('start', { sessionId: boundId, expectedRevision }, signal),
        stop: (signal?: AbortSignal) => required('stop', { sessionId: boundId }, signal),
        retry: (taskId, expectedRevision, signal) => required('retry', { sessionId: boundId, taskId, expectedRevision }, signal),
      } satisfies TeamSettingsActions);
    },
  };
}
