import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { apply as applyClientGateway } from '@deepseek-ai/dsh-api-gateway/client';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { RemoteError, remoteErrorOf, remoteMethods, type PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import { AgentLibraryStore } from '../src/agent-library.js';
import type { AgentDefinition, AgentLibrary } from '../src/library-model.js';
import type { TeamModelOption } from '../src/model.js';
import { registerAgentLibraryRemote } from '../src/library-remote.js';
import { mountAgentLibraryRemote } from '../src/library-remote-client.js';
import { TEAM_LIBRARY_REMOTE, TEAM_LIBRARY_REMOTE_ENDPOINTS, type AgentLibraryRemoteAction } from '../src/library-remote-contract.js';
import type { AgentLibraryActions } from '../src/settings-contract.js';
import { TeamEngine } from '../src/engine.js';
import { registerTeamRemote } from '../src/remote.js';
import { mountTeamRemote } from '../src/remote-client.js';
import { TEAM_REMOTE_ENDPOINTS } from '../src/remote-contract.js';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'library-transport-test': { readonly kind: 'library-transport-test'; readonly id: string }; }
}
const definitions = (): AgentDefinition[] => [{ name: 'researcher', role: 'Research', enabled: true, model: { provider: 'configured', model: 'selected' } }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const host = new Context(); new TypertRegistry(host); new RemoteAccess(host);
  new Gateway(host, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const rows = new Map<string, AgentLibrary>();
  const put = vi.fn(async (key: string, value: AgentLibrary) => { rows.set(key, structuredClone(value)); });
  const library = new AgentLibraryStore({ get: key => rows.get(key), put });
  const listProviders = vi.fn((): LlmProviderInfo[] => [{ id: 'configured', name: 'Configured provider' }]);
  const listModels = vi.fn(async (provider: string): Promise<LlmModelInfo[]> => [{ provider, id: 'selected', name: 'Selected model' }]);
  const forbidden = vi.fn(() => { throw new Error('No settings, credentials, endpoint discovery, or model execution'); });
  host.provide('llm', { listProviders, listModels, stream: forbidden, prepareCall: forbidden, discoverModels: forbidden });
  // Deliberately no sessions, sessionController, agents, workingDirectory, or workspace service.
  const remoteFiber = host.plugin({ name: 'library-test-remote', inject: ['typert', 'llm'], apply(ctx: Context) { registerAgentLibraryRemote(ctx, library); } });
  await remoteFiber;
  const owner = new Peer(host, { principal: { kind: 'owner' }, interactions: 'none' });
  const guest = new Peer(host, { principal: { kind: 'library-transport-test', id: 'guest' }, interactions: 'none' });
  function call<Action extends AgentLibraryRemoteAction>(method: Action, request: unknown = {}, peer: PeerScope = owner, signal?: AbortSignal) {
    return host.typertGateway.invoke({ namespace: 'teamAgentLibrary', method, args: { request }, peer, signal }) as Promise<Action extends 'models' ? TeamModelOption[] : AgentLibrary>;
  }
  const save = (agents = definitions(), expectedRevision = 0) => call('save', { agents, expectedRevision });
  cleanups.push(async () => { await library.dispose(); await host.fiber.dispose(); });
  return { host, rows, put, library, listProviders, listModels, forbidden, remoteFiber, owner, guest, call, save };
}
async function clientFixture(h: Awaited<ReturnType<typeof fixture>>, peer: PeerScope = h.owner) {
  const client = new Context(); new TypertRegistry(client);
  const calls: Array<{ endpoint: string; args: unknown; signal: AbortSignal }> = [];
  class Connection extends Service {
    interactions = 'none' as const;
    rpc = {
      open: () => { throw new Error('No stream expected'); },
      call: async (channel: string, endpoint: string, payload: { args: Record<string, unknown> }, signal: AbortSignal) => {
        expect(channel).toBe('/api'); calls.push({ endpoint, args: payload.args, signal });
        const [namespace, method] = endpoint.split('/');
        try { return { ok: true, value: await h.host.typertGateway.invoke({ namespace: namespace!, method: method!, args: payload.args, peer, signal }) }; }
        catch (error) {
          const remote = remoteErrorOf(error);
          return { ok: false, error: { code: remote?.code ?? 'gateway/internal', message: error instanceof Error ? error.message : String(error), details: remote?.details ?? {} } };
        }
      },
    };
    constructor(ctx: Context) { super(ctx, 'connection'); }
  }
  const connection = new Connection(client); applyClientGateway(client);
  let actions!: AgentLibraryActions;
  const mount = vi.spyOn(client.remote, '$mount');
  const fiber = client.plugin({ name: 'library-test-client', inject: ['remote'], async apply(ctx: Context) { actions = await mountAgentLibraryRemote(ctx); } });
  await fiber;
  cleanups.push(async () => { await client.fiber.dispose(); });
  return { client, connection, actions, calls, mount, fiber };
}

describe('session-independent Agent library native Remote', () => {
  it('registers strict global endpoints and works without a session, workspace, or Agent', async () => {
    const h = await fixture();
    expect(TEAM_LIBRARY_REMOTE.descriptors).toHaveLength(3);
    const markers = remoteMethods(h.host.get('teamAgentLibrary'));
    expect(markers.map(marker => marker.method).sort()).toEqual(['models', 'read', 'save']);
    for (const marker of markers) expect(marker.resources).toBeUndefined();
    for (const endpoint of Object.values(TEAM_LIBRARY_REMOTE_ENDPOINTS)) {
      expect(h.host.typert.local.get(endpoint)).toMatchObject({ cancellation: { parameter: 'signal' }, result: { mode: 'strict' } });
    }
    expect(await h.call('read')).toEqual({ revision: 0, agents: [], updatedAt: null });
    expect(h.put).not.toHaveBeenCalled();
    expect((await h.save()).revision).toBe(1);
    expect((await h.call('read')).agents).toEqual(definitions());
    expect(h.forbidden).not.toHaveBeenCalled();
  });
  it.each(['read', 'models', 'save'] as const)('requires a genuine owner carrier for %s, even if a guest has a global ACL grant', async method => {
    const h = await fixture(); const request = method === 'save' ? { agents: definitions(), expectedRevision: 0 } : {};
    await expect(h.host.get('teamAgentLibrary')[method](request, new AbortController().signal)).rejects.toMatchObject({ code: 'team-agent-library/owner-required' });
    await expect(h.call(method, request, h.guest)).rejects.toMatchObject({ code: 'remote-access/denied' });
    h.host.remoteAccess.registerPolicy('library-transport-test', {
      bindings: () => [{ role: { name: 'test global grant', resource: 'global', actions: Object.values(TEAM_LIBRARY_REMOTE_ENDPOINTS) }, resource: { kind: 'global' } }],
    });
    await expect(h.call(method, request, h.guest)).rejects.toMatchObject({ code: 'team-agent-library/owner-required' });
    expect(h.rows.size).toBe(0); expect(h.listProviders).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('rejects session, goal, tasks, forged principals and runtime fields at the native codec', async () => {
    const h = await fixture();
    for (const request of [{ sessionId: 'captain' }, { goal: 'run something' }, { tasks: [] }, { principal: { kind: 'owner' } }]) {
      await expect(h.call('read', request)).rejects.toMatchObject({ code: 'gateway/input-invalid' });
      await expect(h.call('models', request)).rejects.toMatchObject({ code: 'gateway/input-invalid' });
      await expect(h.call('save', { agents: definitions(), expectedRevision: 0, ...request })).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    }
    await expect(h.call('save', { agents: [{ ...definitions()[0], sessionId: 'forged' }], expectedRevision: 0 })).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    await expect(h.call('save', { agents: definitions(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 })).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    expect(h.put).not.toHaveBeenCalled(); expect(h.listProviders).not.toHaveBeenCalled();
  });
  it('returns only four model fields and does not disclose nested adapter or persistence errors', async () => {
    const h = await fixture();
    h.listProviders.mockReturnValue([{ id: 'configured', name: 'Configured provider', apiKey: 'SECRET' } as LlmProviderInfo]);
    h.listModels.mockResolvedValue([{ provider: 'configured', id: 'selected', name: 'Selected model', description: 'SECRET endpoint' }]);
    expect(await h.call('models')).toEqual([{ provider: 'configured', model: 'selected', providerLabel: 'Configured provider', modelLabel: 'Selected model' }]);
    h.listModels.mockRejectedValue(new Error('SECRET credential in adapter error'));
    await expect(h.call('models')).rejects.toMatchObject({ code: 'team-agent-library/model-catalog-unavailable' });
    await expect(h.call('models')).rejects.not.toThrow('SECRET');
    h.put.mockRejectedValueOnce(new Error('SECRET storage path'));
    await expect(h.save([])).rejects.toMatchObject({ code: 'team-agent-library/operation-rejected' });
    h.put.mockRejectedValueOnce(new RemoteError('team-agent-library/operation-rejected', 'SECRET remote-shaped storage error', {}));
    await expect(h.save([])).rejects.not.toThrow('SECRET');
    expect(h.rows.size).toBe(0); expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('validates enabled models while allowing disabled definitions to retain removed models', async () => {
    const h = await fixture(); const enabled = definitions(); enabled[0]!.model!.model = 'removed';
    await expect(h.save(enabled)).rejects.toMatchObject({ code: 'team-agent-library/model-unavailable' });
    expect(h.rows.size).toBe(0);
    const disabled = [{ ...enabled[0]!, enabled: false }];
    const before = h.listModels.mock.calls.length;
    const saved = await h.save(disabled);
    expect(saved.agents[0]!.model!.model).toBe('removed'); expect(h.listModels).toHaveBeenCalledTimes(before);
    await expect(h.save(enabled, saved.revision)).rejects.toMatchObject({ code: 'team-agent-library/model-unavailable' });
    expect(await h.call('read')).toEqual(saved);
    const repaired = await h.save(definitions(), saved.revision);
    expect(h.library.select(['researcher'], repaired.revision)).toMatchObject([{ name: 'researcher', model: { provider: 'configured', model: 'selected' } }]);
    expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('keeps omission as inheritance and still supports CAS after catalog validation', async () => {
    const h = await fixture();
    const inherited: AgentDefinition[] = [{ name: 'reviewer', role: 'Review', enabled: true }];
    const saved = await h.save(inherited);
    expect(saved.agents[0]).not.toHaveProperty('model'); expect(h.listProviders).not.toHaveBeenCalled();
    const results = await Promise.allSettled([h.save(definitions(), saved.revision), h.save(inherited, saved.revision)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(h.library.read().revision).toBe(2);
  });
  it.each(['cancel', 'revoke-peer', 'unload'] as const)('fails closed when %s occurs during model validation', async change => {
    const h = await fixture(); const entered = deferred<void>(); const gate = deferred<LlmModelInfo[]>();
    h.listModels.mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const abort = new AbortController();
    const pending = h.call('save', { agents: definitions(), expectedRevision: 0 }, h.owner, abort.signal);
    const rejected = expect(pending).rejects.toThrow(); await entered.promise;
    if (change === 'cancel') abort.abort(new Error('Discarded save'));
    if (change === 'revoke-peer') await h.owner.dispose();
    if (change === 'unload') await h.remoteFiber.dispose();
    gate.resolve([{ provider: 'configured', id: 'selected', name: 'Selected model' }]);
    await rejected; expect(h.rows.size).toBe(0); expect(h.forbidden).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'revoke-peer', 'unload'] as const)('checks %s again after a save is queued behind durability', async change => {
    const h = await fixture(); const entered = deferred<void>(); const gate = deferred<void>();
    h.put.mockImplementationOnce(async (key, value) => { entered.resolve(); await gate.promise; h.rows.set(key, structuredClone(value)); });
    const admitted = h.library.save([], 0); await entered.promise;
    const save = vi.spyOn(h.library, 'save');
    const abort = new AbortController();
    const queued = h.call('save', { agents: definitions(), expectedRevision: 1 }, h.owner, abort.signal);
    const rejected = expect(queued).rejects.toThrow();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    if (change === 'cancel') abort.abort(new Error('Discarded queued save'));
    if (change === 'revoke-peer') await h.owner.dispose();
    if (change === 'unload') await h.remoteFiber.dispose();
    gate.resolve(); await admitted; await rejected;
    expect(h.library.read()).toMatchObject({ revision: 1, agents: [] }); expect(h.put).toHaveBeenCalledOnce();
  });
  it('unregisters only its own endpoints when the library service unloads', async () => {
    const h = await fixture(); await h.remoteFiber.dispose();
    expect(h.host.typert.local.get(TEAM_LIBRARY_REMOTE_ENDPOINTS.read)).toBeUndefined();
    await expect(h.call('read')).rejects.toMatchObject({ code: 'gateway/definition-unavailable' });
  });
});

describe('sessionless native library client', () => {
  it('coexists with legacy execution Remote on both faces and unloads independently', async () => {
    const h = await fixture();
    const engine = new TeamEngine({ get: () => undefined, entries: () => new Map().entries(), put: async () => {} }, {
      run: async () => { throw new Error('No model execution'); }, deliver: async () => false, dispose: async () => {},
    });
    const legacyHost = h.host.plugin({ name: 'legacy-host-coexistence', inject: ['typert'], apply(ctx: Context) { registerTeamRemote(ctx, engine); } });
    await legacyHost;
    expect(h.host.typert.local.get(TEAM_REMOTE_ENDPOINTS.read)).toBeDefined();
    expect(h.host.typert.local.get(TEAM_LIBRARY_REMOTE_ENDPOINTS.read)).toBeDefined();
    const c = await clientFixture(h);
    const legacyClient = c.client.plugin({ name: 'legacy-client-coexistence', inject: ['remote'], async apply(ctx: Context) { await mountTeamRemote(ctx); } });
    await legacyClient;
    expect(c.client.typert.remotes.list()).toHaveLength(11);
    await c.fiber.dispose(); expect(c.client.typert.remotes.list()).toHaveLength(8);
    await h.remoteFiber.dispose();
    expect(h.host.typert.local.get(TEAM_REMOTE_ENDPOINTS.read)).toBeDefined();
    expect(h.host.typert.local.get(TEAM_LIBRARY_REMOTE_ENDPOINTS.read)).toBeUndefined();
    await legacyClient.dispose(); await legacyHost.dispose(); await engine.dispose();
  });
  it('mounts once, strictly parses replies and sends no session identity', async () => {
    const h = await fixture(); const c = await clientFixture(h);
    expect(await c.actions.read()).toEqual({ revision: 0, agents: [], updatedAt: null });
    const saved = await c.actions.save(definitions(), 0); expect(saved.revision).toBe(1);
    expect(await c.actions.models()).toHaveLength(1);
    expect(c.calls.map(call => call.args)).toEqual([{ request: {} }, { request: { agents: definitions(), expectedRevision: 0 } }, { request: {} }]);
    expect(c.mount).toHaveBeenCalledOnce();
    const malformed = vi.spyOn(c.connection.rpc, 'call').mockResolvedValueOnce({ ok: true, value: { ...saved, goal: 'injected' } });
    await expect(c.actions.read()).rejects.toThrow();
    malformed.mockResolvedValueOnce({ ok: true, value: [{ provider: 'p', model: 'm', providerLabel: 'P', modelLabel: 'M', apiKey: 'SECRET' }] });
    await expect(c.actions.models()).rejects.toThrow(); malformed.mockRestore();
    await expect(c.actions.save(definitions(), 0)).rejects.toMatchObject({ code: 'team-agent-library/revision-conflict' });
    expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('retains native authorization, cancellation and unload errors without fake success', async () => {
    const h = await fixture(); const c = await clientFixture(h); const denied = await clientFixture(h, h.guest);
    await expect(denied.actions.read()).rejects.toMatchObject({ code: 'remote-access/denied' });
    const abort = new AbortController(); abort.abort(new Error('Abandoned settings'));
    await expect(c.actions.models(abort.signal)).rejects.toThrow('Abandoned settings'); expect(c.calls).toHaveLength(0);
    await c.fiber.dispose();
    expect(c.client.typert.remotes.list()).toHaveLength(0);
    await expect(c.actions.read()).rejects.toThrow('unloaded');
  });
});
