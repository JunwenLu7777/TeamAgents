import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import { AgentLibrarySchema } from './library-model.js';
import { TeamModelOptionsSchema } from './model.js';
import type { AgentLibraryActions } from './settings-contract.js';
import {
  TEAM_LIBRARY_REMOTE, TEAM_LIBRARY_REMOTE_ENDPOINTS,
  type AgentLibraryRemoteAction, type AgentLibraryRemoteRequest,
} from './library-remote-contract.js';

/** Mount once per client plugin. This reusable library has no current-session binding. */
export async function mountAgentLibraryRemote(ctx: Context): Promise<AgentLibraryActions> {
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(new Error('Agent library client unloaded')));
  await ctx.remote.$mount(TEAM_LIBRARY_REMOTE);
  let mountedRemote: Context['remote'] | undefined;
  await ctx.inject(['remote', 'remote.teamAgentLibrary'], scope => {
    const remote = scope.remote;
    mountedRemote = remote;
    scope.effect(() => () => { if (mountedRemote === remote) mountedRemote = undefined; });
  });
  lifetime.signal.throwIfAborted();
  async function invoke<Action extends AgentLibraryRemoteAction>(action: Action, request: AgentLibraryRemoteRequest<Action>, signal?: AbortSignal) {
    const active = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    active.throwIfAborted();
    const method = TEAM_LIBRARY_REMOTE.methods[TEAM_LIBRARY_REMOTE_ENDPOINTS[action]];
    if (!method || method.mode === 'stream') throw new Error('Agent library unary Remote descriptor is unavailable');
    const input = method.input({ strict: true }).create().parse({ request });
    const remote = mountedRemote;
    if (!remote) throw new Error('Agent library Remote namespace is unavailable');
    const result = await method.invoke(remote, input, active);
    active.throwIfAborted();
    if (!('ok' in result)) throw new Error('Agent library expected a unary Remote result');
    if (!result.ok) throw result.error;
    return result.value;
  }
  return Object.freeze({
    read: async (signal?: AbortSignal) => AgentLibrarySchema.parse(await invoke('read', {}, signal)),
    models: async (signal?: AbortSignal) => TeamModelOptionsSchema.parse(await invoke('models', {}, signal)),
    save: async (agents, expectedRevision, signal) => AgentLibrarySchema.parse(await invoke('save', { agents, expectedRevision }, signal)),
  } satisfies AgentLibraryActions);
}
