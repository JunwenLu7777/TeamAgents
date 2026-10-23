import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { apply as applyClientGateway } from '@deepseek-ai/dsh-api-gateway/client';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { remoteMethods, remoteErrorOf, type PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import { TeamEngine, type TeamDriver } from '../src/engine.js';
import { TeamPlanSchema, TeamSchema, type Team, type TeamPlan } from '../src/model.js';
import { registerTeamRemote } from '../src/remote.js';
import { mountTeamRemote, type MountedTeamRemote } from '../src/remote-client.js';
import { TEAM_REMOTE, TEAM_REMOTE_ENDPOINTS, type TeamRemoteAction } from '../src/remote-contract.js';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'team-transport-test': { readonly kind: 'team-transport-test'; readonly id: string }; }
}

const plan = (): TeamPlan => TeamPlanSchema.parse({ name: 'Transport team', goal: 'Test native controls',
  members: [{ name: 'researcher', role: 'Research' }],
  tasks: [{ id: 'inspect', subject: 'Inspect', description: 'Read only', assignee: 'researcher' }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const host = new Context();
  new TypertRegistry(host);
  new RemoteAccess(host);
  new Gateway(host, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const rows = new Map<string, Team>();
  const actors = new Map<string, Agent>();
  const runtimeChildren = new Set<string>();
  const sessions = new Map<string, Session>();
  const persisted = new Map<string, Session>();
  const archived: ReturnType<typeof SessionId>[] = [];
  const workspace = { id: 'workspace' };
  const resolveByPath = vi.fn(async (_path: string) => workspace);
  const workspaceGet = vi.fn(() => workspace);
  const createAgent = vi.fn();
  const driver: TeamDriver = { run: vi.fn(async () => 'Verified'), deliver: vi.fn(async () => false), dispose: vi.fn(async () => {}) };
  const engine = new TeamEngine({ get: key => rows.get(key), entries: () => rows.entries(),
    put: async (key, value) => { rows.set(key, structuredClone(value)); } }, driver);
  host.provide('agents', { get: (id: string) => actors.get(id), roots: () => [...actors.values()].filter(agent => !runtimeChildren.has(agent.id)),
    create: createAgent, resume: createAgent });
  host.provide('sessions', { get: (id: string) => sessions.get(id) });
  host.provide('workspaceRegistry', { archivedSessionIds: archived, resolveByPath, get: workspaceGet });
  const inspect = vi.fn(async (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const session = sessions.get(id) ?? persisted.get(id);
    if (!session) throw new Error('Session not found');
    return { meta: session.header, inheritedEventCount: 0, events: session.snapshotEvents() };
  });
  const resolveAgent = vi.fn(async (id: string) => {
    const existing = actors.get(id);
    if (existing) return { agent: existing };
    const cold = persisted.get(id);
    if (!cold) throw new Error('Session not found');
    createAgent();
    return { agent: actor(id, cold.header) };
  });
  host.provide('sessionController', { inspect, resolveAgent });
  const defaultSelection = vi.fn((): { provider: string; model: string } | undefined => undefined);
  host.provide('agentDefaultModel', { currentSelection: defaultSelection });
  host.provide('sessionProjections', { stateOf: () => undefined });
  const remoteFiber = host.plugin({ name: 'test-team-remote',
    inject: ['typert', 'agents', 'sessions', 'workspaceRegistry', 'sessionController', 'agentDefaultModel', 'sessionProjections'],
    apply(ctx: Context) { registerTeamRemote(ctx, engine); },
  });
  await remoteFiber;
  const owner = new Peer(host, { principal: { kind: 'owner' }, interactions: 'none' });
  const guest = new Peer(host, { principal: { kind: 'team-transport-test', id: 'guest' }, interactions: 'none' });
  function actor(id: string, header: Partial<Session['header']> = {}, options: AgentOptions = { provider: 'configured', model: 'selected' }) {
    const session = Session.create(SessionId(id), header.isSeeded ? [] : undefined, { version: 4, id: SessionId(id), createdAt: 0,
      isSeeded: false, cwd: '/workspace', ...header }, SessionLogOffset(0));
    const agent = { id: session.id, session, options } as Agent;
    actors.set(id, agent); sessions.set(id, session); persisted.set(id, session);
    return agent;
  }
  const captain = actor('captain');
  function call(method: TeamRemoteAction, request: unknown = { sessionId: 'captain' }, peer: PeerScope = owner, signal?: AbortSignal) {
    return host.typertGateway.invoke({ namespace: 'teamAgents', method, args: { request }, peer, signal }) as Promise<Team | null>;
  }
  const save = (value = plan(), expectedRevision: number | null = null, sessionId = 'captain') =>
    call('save', { sessionId, expectedRevision, plan: value }) as Promise<Team>;
  cleanups.push(async () => { await engine.dispose(); await host.fiber.dispose(); });
  return { host, rows, actors, runtimeChildren, sessions, persisted, archived, workspace, resolveByPath, workspaceGet, createAgent,
    inspect, resolveAgent, defaultSelection, engine, driver, captain, actor, owner, guest, call, save, remoteFiber };
}

async function clientFixture(h: Awaited<ReturnType<typeof fixture>>, peer: PeerScope = h.owner) {
  const client = new Context();
  new TypertRegistry(client);
  const calls: Array<{ endpoint: string; args: unknown; signal: AbortSignal }> = [];
  class Connection extends Service {
    interactions = 'none' as const;
    rpc = {
      open: () => { throw new Error('No stream or network expected'); },
      call: async (channel: string, endpoint: string, payload: { args: Record<string, unknown> }, signal: AbortSignal) => {
        expect(channel).toBe('/api');
        calls.push({ endpoint, args: payload.args, signal });
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
  new Connection(client);
  applyClientGateway(client);
  const mount = vi.spyOn(client.remote, '$mount');
  let actions!: MountedTeamRemote;
  const fiber = client.plugin({ name: 'test-team-client', inject: ['remote'],
    async apply(ctx: Context) { actions = await mountTeamRemote(ctx); },
  });
  await fiber;
  cleanups.push(async () => { await client.fiber.dispose(); });
  return { client, actions, fiber, calls, mount };
}

describe('current SDK native TeamAgents Remote descriptors', () => {
  it('registers real strict descriptors and session resource markers for every action', async () => {
    const h = await fixture();
    expect(TEAM_REMOTE.descriptors).toHaveLength(5);
    const markers = remoteMethods(h.host.get('teamAgents'));
    expect(markers.map(marker => marker.method).sort()).toEqual(['read', 'retry', 'save', 'start', 'stop']);
    for (const action of Object.keys(TEAM_REMOTE_ENDPOINTS) as TeamRemoteAction[]) {
      const endpoint = TEAM_REMOTE_ENDPOINTS[action];
      const descriptor = h.host.typert.local.get(endpoint)!;
      expect(descriptor.id).toBe(`dsh-team-agents#${endpoint}`);
      expect(descriptor.parameters).toMatchObject([{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict' } }]);
      expect(descriptor.cancellation).toEqual({ parameter: 'signal' });
      expect(descriptor.result.mode).toBe('strict');
      expect(markers.find(marker => marker.method === action)?.resources?.session?.({ sessionId: 'captain' })).toBe('captain');
    }
    const input = TEAM_REMOTE.methods[TEAM_REMOTE_ENDPOINTS.save]!.input({ strict: true }).create();
    expect(input.parse({ request: { sessionId: 'captain', expectedRevision: null, plan: plan() } })).toBeDefined();
    expect(() => input.parse({ request: { sessionId: 'captain', expectedRevision: null, plan: plan(), principal: { kind: 'owner' } } })).toThrow();
    expect(() => input.parse({ request: { sessionId: 'captain', expectedRevision: null, plan: { ...plan(), tasks: [{ ...plan().tasks[0], dependencies: ['inspect'] }] } } })).toThrow('cycle');
    expect(() => descriptorResult('save').parse({})).toThrow();
    await h.remoteFiber.dispose();
    expect(h.host.typert.local.get(TEAM_REMOTE_ENDPOINTS.read)).toBeUndefined();
    await expect(h.call('read')).rejects.toMatchObject({ code: 'gateway/definition-unavailable' });
  });

  it('rejects malformed input through actual Gateway codecs before any domain lookup', async () => {
    const h = await fixture();
    for (const request of [{ sessionId: '' }, { sessionId: ' captain' }, { sessionId: 'captain', ownerSessionId: 'other' }, { sessionId: 'captain', principal: { kind: 'owner' } }]) {
      await expect(h.call('read', request)).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    }
    await expect(h.call('save', { sessionId: 'captain', expectedRevision: null, plan: { ...plan(), ownerSessionId: 'other' } })).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    await expect(h.call('start', { sessionId: 'captain', expectedRevision: -1 })).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    expect(h.resolveByPath).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(0);
    expect(h.driver.run).not.toHaveBeenCalled();
  });
});
function descriptorResult(action: TeamRemoteAction) { return TEAM_REMOTE.methods[TEAM_REMOTE_ENDPOINTS[action]]!.result.create(); }

describe('owner provenance, root isolation, and cancellation', () => {
  it('requires an owner invocation even when an unrelated native policy grants a guest access', async () => {
    const h = await fixture();
    await expect(h.host.get('teamAgents').read({ sessionId: 'captain' }, new AbortController().signal)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    await expect(h.call('read', undefined, h.guest)).rejects.toMatchObject({ code: 'remote-access/denied' });
    h.host.remoteAccess.registerPolicy('team-transport-test', {
      bindings: () => [{ role: { name: 'test only grant', resource: 'session', actions: Object.values(TEAM_REMOTE_ENDPOINTS) }, resource: { kind: 'session', id: SessionId('captain') } }],
    });
    await expect(h.call('read', undefined, h.guest)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    await expect(h.call('save', { sessionId: 'captain', expectedRevision: null, plan: plan() }, h.guest)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    await expect(h.call('read', { sessionId: 'other' }, h.guest)).rejects.toMatchObject({ code: 'remote-access/denied' });
    expect(h.resolveByPath).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(0);
    expect(h.driver.run).not.toHaveBeenCalled();
    await h.owner.dispose();
    await expect(h.call('read')).rejects.toMatchObject({ code: 'gateway/peer-disposed' });
  });

  it('isolates roots and refuses unknown, delegated, member, archived, or mismatched stored identities', async () => {
    const h = await fixture();
    const saved = await h.save();
    h.actor('other');
    expect(await h.call('read', { sessionId: 'other' })).toBeNull();
    for (const id of ['unknown', 'child', 'runtime-child', 'fork', 'nested', 'member']) {
      if (id === 'child') h.actor(id, { origin: 'subagent' });
      if (id === 'runtime-child') { h.actor(id); h.runtimeChildren.add(id); }
      if (id === 'fork') h.actor(id, { parentSession: SessionId('captain') });
      if (id === 'nested') h.actor(id, { delegationDepth: 1 });
      if (id === 'member') {
        h.actor(id); saved.members[0]!.sessionId = id; h.rows.set('captain', saved);
      }
      await expect(h.call('read', { sessionId: id })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    }
    h.archived.push(SessionId('captain'));
    await expect(h.call('read')).rejects.toThrow('Archived');
    h.archived.length = 0;
    h.rows.set('captain', { ...saved, ownerSessionId: 'other' });
    await expect(h.call('read')).rejects.toMatchObject({ code: 'team-agents/workspace-mismatch' });
    h.rows.set('captain', { ...saved, workspaceId: 'other-workspace' });
    await expect(h.call('read')).rejects.toMatchObject({ code: 'team-agents/workspace-mismatch' });
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it.each(['replace-agent', 'replace-session', 'archive', 'remove-workspace', 'cancel', 'dispose-peer', 'unload'] as const)(
    'rechecks %s after the async workspace lookup before saving', async change => {
      const h = await fixture();
      const entered = deferred<void>();
      const lookup = deferred<typeof h.workspace>();
      h.resolveByPath.mockImplementation(async () => { entered.resolve(); return lookup.promise; });
      const abort = new AbortController();
      const pending = h.call('save', { sessionId: 'captain', expectedRevision: null, plan: plan() }, h.owner, abort.signal);
      const rejection = expect(pending).rejects.toThrow();
      await entered.promise;
      if (change === 'replace-agent') h.actors.set('captain', { ...h.captain } as Agent);
      if (change === 'replace-session') h.sessions.set('captain', Session.create(SessionId('captain')));
      if (change === 'archive') h.archived.push(SessionId('captain'));
      if (change === 'remove-workspace') h.workspaceGet.mockReturnValue({ id: 'different' });
      if (change === 'cancel') abort.abort(new Error('Cancelled by browser'));
      if (change === 'dispose-peer') await h.owner.dispose();
      if (change === 'unload') await h.remoteFiber.dispose();
      lookup.resolve(h.workspace);
      await rejection;
      expect(h.rows.size).toBe(0);
      expect(h.createAgent).not.toHaveBeenCalled();
      expect(h.driver.run).not.toHaveBeenCalled();
    });
});

describe('native controls and engine CAS without planning-time models', () => {
  it('saves a complete draft atomically and never starts a model, tool, or human turn', async () => {
    const h = await fixture();
    expect(await h.call('read')).toBeNull();
    const results = await Promise.allSettled([h.save(), h.save({ ...plan(), name: 'Concurrent edit' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const saved = h.engine.snapshot('captain')!;
    expect(TeamSchema.parse(saved)).toMatchObject({ ownerSessionId: 'captain', workspaceId: 'workspace', status: 'draft' });
    const updated = await h.save({ ...plan(), name: 'Saved version' }, saved.revision);
    await expect(h.save(plan(), saved.revision)).rejects.toThrow('Plan changed');
    await expect(h.call('start', { sessionId: 'captain', expectedRevision: saved.revision })).rejects.toThrow('Plan changed');
    expect(h.engine.snapshot('captain')).toEqual(updated);
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(h.captain.session.snapshotEvents()).toHaveLength(0);
  });

  it('starts only the saved revision, stops, and prepares retries only at the current revision', async () => {
    const h = await fixture();
    const saved = await h.save();
    await h.call('start', { sessionId: 'captain', expectedRevision: saved.revision });
    await vi.waitFor(() => expect(h.driver.run).toHaveBeenCalledOnce());
    await h.call('stop');
    const paused = h.engine.snapshot('captain')!;
    paused.tasks[0]!.status = 'failed'; paused.tasks[0]!.error = 'Test failure';
    h.rows.set('captain', paused);
    await expect(h.call('retry', { sessionId: 'captain', taskId: 'inspect', expectedRevision: saved.revision })).rejects.toThrow('Plan changed');
    const retried = await h.call('retry', { sessionId: 'captain', taskId: 'inspect', expectedRevision: paused.revision });
    expect(retried?.tasks[0]).toMatchObject({ id: 'inspect', status: 'pending' });
    expect(h.driver.run).toHaveBeenCalledOnce();
    await expect(h.save(plan(), retried!.revision)).rejects.toThrow('executed plan');
  });

  it('allows planning without a model but start returns an actionable model-selection error', async () => {
    const h = await fixture();
    h.actor('blank', {}, {});
    const saved = await h.save(plan(), null, 'blank');
    await expect(h.call('start', { sessionId: 'blank', expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'team-agents/model-required' });
    expect(h.engine.snapshot('blank')?.status).toBe('draft');
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
  });
});

describe('cold ordinary sessions and explicit Start admission', () => {
  function cold(h: Awaited<ReturnType<typeof fixture>>, id = 'cold') {
    const original = h.actor(id, {}, {});
    h.actors.delete(id); h.sessions.delete(id);
    return original;
  }

  it('reads, saves, stops, and retries cold roots without materializing an Agent or resolving a model', async () => {
    const h = await fixture();
    const original = cold(h);
    expect(await h.call('read', { sessionId: 'cold' })).toBeNull();
    const saved = await h.save(plan(), null, 'cold');
    await h.call('stop', { sessionId: 'cold' });
    const paused = h.engine.snapshot('cold')!;
    paused.tasks[0]!.status = 'failed'; paused.tasks[0]!.attempt = 1;
    h.rows.set('cold', paused);
    const retried = await h.call('retry', { sessionId: 'cold', taskId: 'inspect', expectedRevision: paused.revision });
    expect(retried?.id).toBe(saved.id);
    expect(retried?.tasks[0]?.status).toBe('pending');
    expect(h.inspect).toHaveBeenCalled();
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.defaultSelection).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(original.session.snapshotEvents()).toHaveLength(0);
  });

  it('rejects cold unknown, child, archived, and forged inspection addresses without activation', async () => {
    const h = await fixture();
    cold(h);
    h.actor('cold-child', { origin: 'subagent', parentSession: SessionId('captain') });
    h.actors.delete('cold-child'); h.sessions.delete('cold-child');
    await expect(h.call('read', { sessionId: 'cold-child' })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    await expect(h.call('read', { sessionId: 'missing' })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    h.archived.push(SessionId('cold'));
    await expect(h.save(plan(), null, 'cold')).rejects.toThrow('Archived');
    h.archived.length = 0;
    h.inspect.mockResolvedValueOnce({ meta: h.captain.session.header, inheritedEventCount: 0, events: [] });
    await expect(h.save(plan(), null, 'cold')).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    expect(h.rows.size).toBe(0);
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
  });

  it('accepts live and cold ordinary seeded forks without inheriting the parent team', async () => {
    const h = await fixture();
    const parent = await h.save();
    h.actor('user-fork', { isSeeded: true, parentSession: SessionId('captain') });
    expect(await h.call('read', { sessionId: 'user-fork' })).toBeNull();
    const fork = await h.save({ ...plan(), name: 'Fork team' }, null, 'user-fork');
    h.actors.delete('user-fork'); h.sessions.delete('user-fork');
    expect(await h.call('read', { sessionId: 'user-fork' })).toEqual(fork);
    expect(fork.ownerSessionId).toBe('user-fork');
    expect(fork.id).not.toBe(parent.id);
    expect(h.engine.snapshot('captain')).toEqual(parent);
    h.actor('owned-fork', { isSeeded: true, parentSession: SessionId('captain') });
    h.runtimeChildren.add('owned-fork');
    await expect(h.call('read', { sessionId: 'owned-fork' })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
  });

  it('starts an authorized saved cold root with the configured UI default and no dummy chat', async () => {
    const h = await fixture();
    const original = cold(h);
    const saved = await h.save(plan(), null, 'cold');
    h.defaultSelection.mockReturnValue({ provider: 'gui-provider', model: 'gui-model' });
    h.resolveAgent.mockImplementationOnce(async () => ({ agent: h.actor('cold', original.session.header, {}) }));
    await expect(h.call('start', { sessionId: 'cold', expectedRevision: saved.revision - 1 })).rejects.toThrow('Plan changed');
    expect(h.resolveAgent).not.toHaveBeenCalled();
    await h.call('start', { sessionId: 'cold', expectedRevision: saved.revision });
    expect(h.resolveAgent).toHaveBeenCalledOnce();
    expect(h.defaultSelection).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.driver.run).toHaveBeenCalledOnce());
    expect(h.actors.get('cold')!.session.snapshotEvents()).toHaveLength(0);
  });

  it.each(['forged-agent', 'changed-header', 'archive', 'cancel', 'changed-plan'] as const)(
    'refuses %s after authorized cold activation and before engine start', async change => {
      const h = await fixture();
      const original = cold(h);
      const saved = await h.save(plan(), null, 'cold');
      const entered = deferred<void>();
      const resolved = deferred<{ agent: Agent }>();
      h.resolveAgent.mockImplementationOnce(async () => { entered.resolve(); return resolved.promise; });
      const abort = new AbortController();
      const start = h.call('start', { sessionId: 'cold', expectedRevision: saved.revision }, h.owner, abort.signal);
      const rejection = expect(start).rejects.toThrow();
      await entered.promise;
      const live = h.actor('cold', { ...original.session.header, ...(change === 'changed-header' ? { cwd: '/elsewhere' } : {}) });
      if (change === 'archive') h.archived.push(SessionId('cold'));
      if (change === 'cancel') abort.abort(new Error('Start cancelled'));
      if (change === 'changed-plan') await h.engine.savePlan('cold', 'workspace', saved.revision, { ...plan(), name: 'New plan' });
      resolved.resolve({ agent: change === 'forged-agent' ? { ...live } as Agent : live });
      await rejection;
      expect(h.engine.snapshot('cold')?.status).toBe('draft');
      expect(h.driver.run).not.toHaveBeenCalled();
    });
});

describe('real Client Remote mount and session-bound settings actions', () => {
  it('mounts once, binds each closure to one captain, and removes methods with the plugin fiber', async () => {
    const h = await fixture();
    h.actor('other');
    const c = await clientFixture(h);
    const a = c.actions.forSession('captain');
    const b = c.actions.forSession('other');
    expect(await a.read()).toBeNull();
    const saved = await a.save(plan(), null);
    expect(await b.read()).toBeNull();
    expect((await a.read())?.id).toBe(saved.id);
    expect(c.mount).toHaveBeenCalledOnce();
    expect(c.calls.map(call => (call.args as { request: { sessionId: string } }).request.sessionId)).toEqual(['captain', 'captain', 'other', 'captain']);
    expect(h.driver.run).not.toHaveBeenCalled();
    const abort = new AbortController(); abort.abort(new Error('Discarded form'));
    const count = c.calls.length;
    await expect(a.read(abort.signal)).rejects.toThrow('Discarded form');
    expect(c.calls).toHaveLength(count);
    await c.fiber.dispose();
    expect(c.client.typert.remotes.list()).toHaveLength(0);
    await expect(a.read()).rejects.toThrow('unloaded');
  });

  it('preserves native authorization and revision errors rather than fabricating success', async () => {
    const h = await fixture();
    const c = await clientFixture(h);
    const a = c.actions.forSession('captain');
    const saved = await a.save(plan(), null);
    await expect(a.save(plan(), null)).rejects.toMatchObject({ code: 'team-agents/operation-rejected' });
    await expect(a.start(saved.revision - 1)).rejects.toThrow('Plan changed');
    const denied = await clientFixture(h, h.guest);
    await expect(denied.actions.forSession('captain').read()).rejects.toMatchObject({ code: 'remote-access/denied' });
    expect(h.driver.run).not.toHaveBeenCalled();
  });
});
