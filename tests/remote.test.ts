import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { LlmAttemptId, type LlmModelInfo, type LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { MemberActivitySchema, type MemberActivity } from '../src/member-activity-contract.js';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { apply as applyClientGateway } from '@deepseek-ai/dsh-api-gateway/client';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { remoteMethods, remoteErrorOf, type PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import { TeamEngine, type TeamDriver } from '../src/engine.js';
import { TeamPlanSchema, TeamSchema, type Team, type TeamPlan, type TeamModelOption } from '../src/model.js';
import { registerTeamRemote } from '../src/remote.js';
import { mountTeamRemote, type MountedTeamRemote } from '../src/remote-client.js';
import { TEAM_REMOTE, TEAM_REMOTE_ENDPOINTS, type TeamRemoteAction } from '../src/remote-contract.js';
import { TeamRunExportDocumentSchema, type TeamRunExportResult } from '../src/run-export-contract.js';

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
    create: createAgent, resume: createAgent,
    isOwnedBy: (id: string, owner: Agent) => runtimeChildren.has(id) && actors.get(id)?.session.header.parentSession === owner.id });
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
  const listProviders = vi.fn((): LlmProviderInfo[] => [{ id: 'configured', name: 'Configured provider' }]);
  const listModels = vi.fn(async (provider: string): Promise<LlmModelInfo[]> => [{ provider, id: 'selected', name: 'Selected model' }]);
  const stream = vi.fn(() => { throw new Error('No real model execution allowed'); });
  host.provide('llm', { listProviders, listModels, stream });
  const remoteFiber = host.plugin({ name: 'test-team-remote',
    inject: ['typert', 'agents', 'sessions', 'workspaceRegistry', 'sessionController', 'agentDefaultModel', 'sessionProjections', 'llm'],
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
  function call<Action extends TeamRemoteAction>(method: Action, request: unknown = { sessionId: 'captain' }, peer: PeerScope = owner, signal?: AbortSignal) {
    return host.typertGateway.invoke({ namespace: 'teamAgents', method, args: { request }, peer, signal }) as Promise<Action extends 'models' ? TeamModelOption[] : Action extends 'exportRun' ? TeamRunExportResult : Team | null>;
  }
  const save = (value = plan(), expectedRevision: number | null = null, sessionId = 'captain') =>
    call('save', { sessionId, expectedRevision, plan: value }) as Promise<Team>;
  cleanups.push(async () => { await engine.dispose(); await host.fiber.dispose(); });
  return { host, rows, actors, runtimeChildren, sessions, persisted, archived, workspace, resolveByPath, workspaceGet, createAgent,
    inspect, resolveAgent, defaultSelection, engine, driver, captain, actor, owner, guest, call, save, remoteFiber, listProviders, listModels, stream };
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
  const connection = new Connection(client);
  applyClientGateway(client);
  const mount = vi.spyOn(client.remote, '$mount');
  let actions!: MountedTeamRemote;
  const fiber = client.plugin({ name: 'test-team-client', inject: ['remote'],
    async apply(ctx: Context) { actions = await mountTeamRemote(ctx); },
  });
  await fiber;
  cleanups.push(async () => { await client.fiber.dispose(); });
  return { client, connection, actions, fiber, calls, mount };
}

describe('current SDK native TeamAgents Remote descriptors', () => {
  it('registers real strict descriptors and session resource markers for every action', async () => {
    const h = await fixture();
    expect(TEAM_REMOTE.descriptors).toHaveLength(8);
    const markers = remoteMethods(h.host.get('teamAgents'));
    expect(markers.map(marker => marker.method).sort()).toEqual(['exportRun', 'models', 'read', 'retry', 'save', 'start', 'stop', 'watchMember']);
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

describe('read-only run export over the real native Gateway', () => {
  it('exports a cold retained snapshot without activation, catalog queries or mutation', async () => {
    const h = await fixture(); const saved = await h.save();
    saved.members[0]!.instructions = 'PRIVATE_ROLE_INSTRUCTIONS';
    saved.messages.push({ id: 'm', from: 'captain', to: 'researcher', text: 'PRIVATE_MAILBOX', createdAt: 'now' });
    h.rows.set('captain', saved); h.actors.delete('captain'); h.sessions.delete('captain');
    h.listModels.mockClear(); h.listProviders.mockClear();
    const before = structuredClone(h.rows.get('captain'));
    const exported = await h.call('exportRun', { sessionId: 'captain', format: 'json' });
    const doc = TeamRunExportDocumentSchema.parse(JSON.parse(exported.content));
    expect(doc).toMatchObject({ ownerSessionId: 'captain', sourceRevision: saved.revision, includeMessages: false });
    expect(doc).not.toHaveProperty('messages');
    expect(exported.content).not.toContain('PRIVATE_ROLE_INSTRUCTIONS'); expect(exported.content).not.toContain('PRIVATE_MAILBOX');
    expect(h.rows.get('captain')).toEqual(before);
    for (const fn of [h.createAgent, h.resolveAgent, h.listModels, h.listProviders, h.defaultSelection, h.driver.run, h.driver.deliver, h.stream]) expect(fn).not.toHaveBeenCalled();
  });
  it('preserves export domain failures instead of flattening them to successful replies', async () => {
    const h = await fixture();
    await expect(h.call('exportRun', { sessionId: 'captain', format: 'json' })).rejects.toMatchObject({ code: 'team-agents/no-team' });
    const saved = await h.save(); Object.assign(saved.tasks[0]!, { status: 'PRIVATE_BAD_STATE' }); h.rows.set('captain', saved);
    await expect(h.call('exportRun', { sessionId: 'captain', format: 'json' })).rejects.toMatchObject({ code: 'team-agents/export-invalid-snapshot' });
    saved.tasks[0]!.status = 'pending'; saved.tasks[0]!.output = 'x'.repeat(8 * 1024 * 1024); h.rows.set('captain', saved);
    await expect(h.call('exportRun', { sessionId: 'captain', format: 'json' })).rejects.toMatchObject({ code: 'team-agents/export-too-large' });
    expect(h.driver.run).not.toHaveBeenCalled(); expect(h.resolveAgent).not.toHaveBeenCalled();
  });
  it('rejects forged selectors and invalid options before any data lookup', async () => {
    const h = await fixture();
    for (const request of [
      { sessionId: 'captain', format: 'html' }, { sessionId: 'captain', format: 'json', includeMessages: 'true' },
      { sessionId: 'captain', format: 'json', ownerSessionId: 'other' }, { sessionId: 'captain', format: 'json', path: '/tmp/out.json' },
      { sessionId: 'captain', format: 'json', principal: { kind: 'owner' } },
    ]) await expect(h.call('exportRun', request)).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    expect(h.inspect).not.toHaveBeenCalled(); expect(h.rows.size).toBe(0);
  });
  it('requires authenticated owner provenance even when a guest is granted the endpoint', async () => {
    const h = await fixture();
    const request = { sessionId: 'captain', format: 'json', includeMessages: false };
    await expect(h.host.get('teamAgents').exportRun(request, new AbortController().signal)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    await expect(h.call('exportRun', request, h.guest)).rejects.toMatchObject({ code: 'remote-access/denied' });
    h.host.remoteAccess.registerPolicy('team-transport-test', { bindings: () => [{
      role: { name: 'test export grant', resource: 'session', actions: [TEAM_REMOTE_ENDPOINTS.exportRun] },
      resource: { kind: 'session', id: SessionId('captain') },
    }] });
    await expect(h.call('exportRun', request, h.guest)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    expect(h.inspect).not.toHaveBeenCalled();
  });
  it('keeps two owners isolated and refuses archived, delegated or mismatched stored state', async () => {
    const h = await fixture(); const saved = await h.save(); h.actor('other');
    await h.save({ ...plan(), name: 'OTHER_TEAM' }, null, 'other');
    const a = await h.call('exportRun', { sessionId: 'captain', format: 'json' });
    const b = await h.call('exportRun', { sessionId: 'other', format: 'json' });
    expect(a.content).not.toContain('OTHER_TEAM'); expect(b.ownerSessionId).toBe('other');
    h.actor('child', { origin: 'subagent' });
    await expect(h.call('exportRun', { sessionId: 'child', format: 'json' })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    h.archived.push(SessionId('captain'));
    await expect(h.call('exportRun', { sessionId: 'captain', format: 'json' })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    h.archived.length = 0; h.rows.set('captain', { ...saved, ownerSessionId: 'other' });
    await expect(h.call('exportRun', { sessionId: 'captain', format: 'json' })).rejects.toMatchObject({ code: 'team-agents/workspace-mismatch' });
  });
  it.each(['cancel', 'replace-agent', 'archive', 'dispose-peer', 'unload'] as const)('refuses export when %s occurs during authorization', async change => {
    const h = await fixture(); const saved = await h.save();
    const entered = deferred<void>(); const lookup = deferred<typeof h.workspace>();
    h.resolveByPath.mockImplementation(async () => { entered.resolve(); return lookup.promise; });
    const abort = new AbortController();
    const pending = h.call('exportRun', { sessionId: 'captain', format: 'json' }, h.owner, abort.signal);
    const rejected = expect(pending).rejects.toThrow(); await entered.promise;
    if (change === 'cancel') abort.abort();
    if (change === 'replace-agent') h.actors.set('captain', { ...h.captain } as Agent);
    if (change === 'archive') h.archived.push(SessionId('captain'));
    if (change === 'dispose-peer') await h.owner.dispose();
    if (change === 'unload') await h.remoteFiber.dispose();
    lookup.resolve(h.workspace); await rejected;
    expect(h.rows.get('captain')).toEqual(saved); expect(h.resolveAgent).not.toHaveBeenCalled();
  });
  it('round-trips an escaped multi-megabyte export through real host/client codecs without HTTP or model calls', async () => {
    const h = await fixture(); const saved = await h.save();
    saved.tasks[0]!.output = '中文\\"\\n'.repeat(100_000); h.rows.set('captain', saved);
    const c = await clientFixture(h);
    const originalCall = c.connection.rpc.call.bind(c.connection.rpc);
    vi.spyOn(c.connection.rpc, 'call').mockImplementation(async (...args) => JSON.parse(JSON.stringify(await originalCall(...args))));
    const result = await c.actions.forSession('captain').exportRun({ format: 'json' });
    expect(JSON.parse(result.content).team.tasks[0].output).toBe(saved.tasks[0]!.output);
    expect(result.byteLength).toBeGreaterThan(1_000_000); expect(c.calls[0]!.endpoint).toBe('teamAgents/exportRun');
    expect(h.resolveAgent).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
    await c.fiber.dispose(); await expect(c.actions.forSession('captain').exportRun({ format: 'json' })).rejects.toThrow();
  });
});

async function activityFixture(cold = false) {
  const h = await fixture(); const saved = await h.save();
  const child = h.actor('child', { parentSession: h.captain.id, origin: 'subagent', delegationDepth: 1 });
  Object.assign(child, { status: 'running' }); h.runtimeChildren.add(child.id);
  saved.members[0]!.sessionId = child.id; h.rows.set('captain', saved);
  const log: SessionEvent[] = [];
  const original = h.inspect.getMockImplementation()!;
  h.inspect.mockImplementation(async (id, signal) => id === 'child'
    ? { meta: child.session.header, inheritedEventCount: 0, events: [...log] } : original(id, signal));
  const emit = (type: string, data: unknown) => {
    const event = { type, data, seq: log.length, time: Date.now() } as unknown as SessionEvent;
    log.push(event); h.host.emit('session/event', child.session, event); return event;
  };
  if (cold) { h.actors.delete('child'); h.sessions.delete('child'); }
  async function open(request: unknown = { sessionId: 'captain', member: 'researcher' }, peer = h.owner) {
    const abort = new AbortController();
    const stream = await h.host.typertGateway.stream({ namespace: 'teamAgents', method: 'watchMember', args: { request }, peer, signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const stop = async () => { abort.abort(); await iterator.return?.().catch(() => {}); };
    cleanups.push(stop);
    return { abort, iterator, stop, next: async () => {
      const next = await iterator.next();
      return next.done ? undefined : MemberActivitySchema.parse(next.value);
    } };
  }
  return { ...h, child, log, emit, open };
}

describe('authorized live member observation without activation', () => {
  it('shows a not-yet-created member without inspecting any child or running a model', async () => {
    const h = await activityFixture(); h.rows.get('captain')!.members[0]!.sessionId = undefined;
    const stream = await h.open(); const value = await stream.next();
    expect(value).toMatchObject({ status: 'not-started', childSessionId: null, member: 'researcher', entries: [] });
    expect(await stream.next()).toBeUndefined();
    expect(h.inspect.mock.calls.every(([id]) => id === 'captain')).toBe(true);
    expect(h.resolveAgent).not.toHaveBeenCalled(); expect(h.driver.run).not.toHaveBeenCalled();
  });
  it('reads cold history with tool results and task failure without restoring an Agent', async () => {
    const h = await activityFixture(true);
    h.emit('turn/start', { turn: 1 }); h.emit('tool/call', { callId: 'call', name: 'read', arguments: '{"path":"README.md","token":"PRIVATE"}' });
    h.emit('tool/result', { message: { source: { callId: 'call' }, content: [{ type: 'text', text: 'Read completed' }], isError: false } });
    h.emit('turn/end', { reason: { kind: 'aborted', reason: { kind: 'parent' } } });
    Object.assign(h.rows.get('captain')!.tasks[0]!, { status: 'failed', attempt: 1, error: 'Task deadline exceeded' });
    const before = structuredClone(h.rows.get('captain'));
    const stream = await h.open(); const value = (await stream.next())!;
    expect(value).toMatchObject({ live: false, status: 'failed', phase: 'idle', task: { error: 'Task deadline exceeded' } });
    expect(value.entries.find(entry => entry.kind === 'tool')).toMatchObject({ label: 'read', status: 'completed', text: 'Read completed' });
    expect(JSON.stringify(value)).not.toContain('PRIVATE'); expect(value.elapsedMs).not.toBeNull();
    await stream.stop(); expect(h.rows.get('captain')).toEqual(before);
    for (const fn of [h.createAgent, h.resolveAgent, h.driver.run, h.listModels, h.stream]) expect(fn).not.toHaveBeenCalled();
  });
  it('opens mid-stream with cached public text, follows new chunks, and replaces them with committed history', async () => {
    const h = await activityFixture(); h.emit('turn/start', { turn: 1 }); h.emit('step/start', { turn: 1, step: 1 });
    const id = LlmAttemptId('attempt');
    h.host.emit('agent/assistant-stream', { agent: h.child, frame: { type: 'start', attemptId: id, revision: 1, turn: 1, step: 1 } });
    h.host.emit('agent/assistant-stream', { agent: h.child, frame: { type: 'chunk', attemptId: id, revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: 'Hello' } } });
    h.host.emit('agent/assistant-stream', { agent: h.child, frame: { type: 'chunk', attemptId: id, revision: 3, index: 1, time: Date.now(), chunk: { type: 'reasoning-delta', index: 1, text: 'PRIVATE_REASONING' } } });
    const stream = await h.open(); expect(await stream.next()).toMatchObject({ live: true, liveOutput: 'Hello', phase: 'model' });
    const next = stream.next();
    h.host.emit('agent/assistant-stream', { agent: h.child, frame: { type: 'chunk', attemptId: id, revision: 4, index: 2, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: ' world' } } });
    const update = (await next)!; expect(update.liveOutput).toBe('Hello world'); expect(JSON.stringify(update)).not.toContain('PRIVATE_REASONING');
    const final = stream.next();
    const event = h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Hello world' }] }, stream: [] });
    h.host.emit('agent/assistant-stream', { agent: h.child, frame: { type: 'end', attemptId: id, revision: 5, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } } });
    Object.assign(h.child, { status: 'idle' }); h.emit('turn/end', { reason: { kind: 'completed' } });
    const value = (await final)!; expect(value.liveOutput).toBe(''); expect(value.status).toBe('completed');
    expect(value.entries.filter(entry => entry.text === 'Hello world')).toHaveLength(1); await stream.stop();
  });
  it('does not lose or duplicate events published while the opening read awaits', async () => {
    const h = await activityFixture(); h.emit('turn/start', { turn: 1 });
    const before = [...h.log]; const gate = deferred<void>(); const entered = deferred<void>();
    const original = h.inspect.getMockImplementation()!;
    h.inspect.mockImplementation(async (id, signal) => {
      if (id !== 'child') return original(id, signal);
      entered.resolve(); await gate.promise;
      return { meta: h.child.session.header, inheritedEventCount: 0, events: before };
    });
    const stream = await h.open(); const first = stream.next(); await entered.promise;
    const event = h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Between snapshot and live' }] }, stream: [] });
    gate.resolve(); const value = (await first)!;
    expect(value.entries.filter(item => item.text === 'Between snapshot and live')).toHaveLength(1);
    const second = stream.next(); h.host.emit('session/event', h.child.session, event);
    expect((await second)!.entries.filter(item => item.text === 'Between snapshot and live')).toHaveLength(1);
    await stream.stop();
  });
  it('coalesces many updates into bounded frames and releases observers when closed', async () => {
    const h = await activityFixture(); const stream = await h.open(); await stream.next();
    for (let i = 0; i < 200; i++) h.emit('assistant/message', { message: { content: [{ type: 'text', text: `output-${i} ${'中'.repeat(9000)}` }] }, stream: [] });
    const value = (await stream.next())!;
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(192 * 1024);
    expect(value.historyTruncated).toBe(true); expect(value.entries.at(-1)!.text).toContain('output-199');
    await stream.stop();
    const spy = vi.spyOn(h.engine, 'activityTarget');
    h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'After close' }] }, stream: [] });
    expect(spy).not.toHaveBeenCalled(); expect(h.driver.run).not.toHaveBeenCalled();
  });
  it('rechecks archive authority even when no further member event arrives', async () => {
    const h = await activityFixture(); const stream = await h.open(); await stream.next();
    const pending = stream.next(); const rejected = expect(pending).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    h.archived.push(SessionId('captain'));
    await rejected; await stream.stop(); expect(h.resolveAgent).not.toHaveBeenCalled();
  });
  it('closing one viewer leaves another viewer subscribed to the same member', async () => {
    const h = await activityFixture(); const one = await h.open(); const two = await h.open();
    await one.next(); await two.next(); await one.stop();
    const next = two.next(); h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Still subscribed' }] }, stream: [] });
    expect((await next)!.entries.some(entry => entry.text === 'Still subscribed')).toBe(true);
    await two.stop(); expect(h.driver.run).not.toHaveBeenCalled();
  });
  it.each(['missing', 'wrong-parent', 'wrong-workspace', 'runtime-owner', 'archived'] as const)('fails closed for %s member ownership', async change => {
    const h = await activityFixture();
    if (change === 'missing') h.rows.get('captain')!.members.length = 0;
    if (change === 'wrong-parent') h.actor('child', { parentSession: SessionId('other'), origin: 'subagent' });
    if (change === 'wrong-workspace') h.actor('child', { parentSession: h.captain.id, origin: 'subagent', cwd: '/other' });
    if (change === 'runtime-owner') h.runtimeChildren.delete('child');
    if (change === 'archived') h.archived.push(SessionId('child'));
    const stream = await h.open(); await expect(stream.next()).rejects.toThrow();
    expect(h.resolveAgent).not.toHaveBeenCalled();
  });
  it('requires owner authorization even when a guest has a session-specific stream grant', async () => {
    const h = await activityFixture();
    await expect(h.open(undefined, h.guest)).rejects.toMatchObject({ code: 'remote-access/denied' });
    h.host.remoteAccess.registerPolicy('team-transport-test', { bindings: () => [{ role: { name: 'inspect', resource: 'session', actions: [TEAM_REMOTE_ENDPOINTS.watchMember] }, resource: { kind: 'session', id: h.captain.id } }] });
    const granted = await h.open(undefined, h.guest); await expect(granted.next()).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    const direct = h.host.get('teamAgents').watchMember({ sessionId: 'captain', member: 'researcher' }, new AbortController().signal);
    await expect(direct.next()).rejects.toMatchObject({ code: 'team-agents/owner-required' });
  });
  it.each(['roster', 'archive', 'replace', 'unload'] as const)('ends an open stream after %s changes without leaking another frame', async change => {
    const h = await activityFixture(); const stream = await h.open(); await stream.next();
    const pending = stream.next(); const observed = pending.then(value => ({ value }), error => ({ error }));
    if (change === 'roster') h.rows.get('captain')!.members[0]!.sessionId = 'another-child';
    if (change === 'archive') h.archived.push(SessionId('captain'));
    if (change === 'replace') h.actor('child', { parentSession: h.captain.id, origin: 'subagent' });
    if (change === 'unload') await h.remoteFiber.dispose();
    else h.host.emit('session/event', h.captain.session, { type: 'turn/start', data: { turn: 2 }, seq: 0, time: Date.now() } as SessionEvent);
    const outcome = await observed;
    expect('error' in outcome || outcome.value === undefined).toBe(true); await stream.stop();
  });
});

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

describe('owner-only configured member model catalog and admission', () => {
  const explicitPlan = () => {
    const value = plan(); value.members[0]!.model = { provider: 'configured', model: 'selected' }; return value;
  };
  it('returns only public model options without materializing an Agent or model call', async () => {
    const h = await fixture();
    h.actors.delete('captain'); h.sessions.delete('captain');
    h.listProviders.mockReturnValue([{ id: 'configured', name: 'Configured provider', apiKey: 'SECRET' } as LlmProviderInfo]);
    h.listModels.mockResolvedValue([{ provider: 'configured', id: 'selected', name: 'Selected model', description: 'SECRET endpoint details' }]);
    expect(await h.call('models')).toEqual([{ provider: 'configured', model: 'selected', providerLabel: 'Configured provider', modelLabel: 'Selected model' }]);
    expect(h.resolveAgent).not.toHaveBeenCalled(); expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled(); expect(h.defaultSelection).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(0);
  });
  it('authorizes models with the same owner/session boundary, even under a guest policy grant', async () => {
    const h = await fixture();
    await expect(h.host.get('teamAgents').models({ sessionId: 'captain' }, new AbortController().signal)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    await expect(h.call('models', undefined, h.guest)).rejects.toMatchObject({ code: 'remote-access/denied' });
    h.host.remoteAccess.registerPolicy('team-transport-test', {
      bindings: () => [{ role: { name: 'test grant', resource: 'session', actions: [TEAM_REMOTE_ENDPOINTS.models] }, resource: { kind: 'session', id: SessionId('captain') } }],
    });
    await expect(h.call('models', undefined, h.guest)).rejects.toMatchObject({ code: 'team-agents/owner-required' });
    h.actor('child', { origin: 'subagent' });
    await expect(h.call('models', { sessionId: 'child' })).rejects.toMatchObject({ code: 'team-agents/session-unavailable' });
    h.archived.push(SessionId('captain'));
    await expect(h.call('models')).rejects.toThrow('Archived');
    expect(h.listProviders).not.toHaveBeenCalled(); expect(h.listModels).not.toHaveBeenCalled();
  });
  it('refuses unknown selections before saving and deleted selections before activating or starting', async () => {
    const h = await fixture(); const value = explicitPlan();
    value.members[0]!.model!.model = 'not-configured';
    await expect(h.save(value)).rejects.toMatchObject({ code: 'team-agents/model-unavailable' });
    expect(h.rows.size).toBe(0);
    const saved = await h.save(explicitPlan());
    h.listModels.mockResolvedValue([]);
    await expect(h.save(explicitPlan(), saved.revision)).rejects.toMatchObject({ code: 'team-agents/model-unavailable' });
    await expect(h.call('start', { sessionId: 'captain', expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'team-agents/model-unavailable' });
    expect(h.engine.snapshot('captain')).toEqual(saved);
    expect(h.resolveAgent).not.toHaveBeenCalled(); expect(h.driver.run).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
  });
  it('starts all-explicit teams without a captain model, but mixed inherited work still requires one', async () => {
    const h = await fixture(); h.actor('captain', {}, {});
    const saved = await h.save(explicitPlan());
    await h.call('start', { sessionId: 'captain', expectedRevision: saved.revision });
    await vi.waitFor(() => expect(h.driver.run).toHaveBeenCalledOnce());
    expect(h.defaultSelection).not.toHaveBeenCalled();
    const mixed = explicitPlan(); mixed.members.push({ name: 'reviewer', role: 'Review' });
    mixed.tasks.push({ id: 'review', subject: 'Review', description: 'Review output', assignee: 'reviewer', dependencies: [], writeScopes: [] });
    h.actor('mixed', {}, {});
    const other = await h.save(mixed, null, 'mixed');
    await expect(h.call('start', { sessionId: 'mixed', expectedRevision: other.revision })).rejects.toMatchObject({ code: 'team-agents/model-required' });
    expect(h.engine.snapshot('mixed')?.status).toBe('draft');
    expect(h.driver.run).toHaveBeenCalledOnce();
  });
  it('does not return adapter failure secrets via native Remote diagnostics', async () => {
    const h = await fixture(); h.listModels.mockRejectedValue(new Error('SECRET key or endpoint'));
    await expect(h.call('models')).rejects.toMatchObject({ code: 'team-agents/model-catalog-unavailable' });
    await expect(h.call('models')).rejects.not.toThrow('SECRET');
  });
  it.each(['replace-agent', 'archive', 'cancel', 'dispose-peer', 'unload'] as const)(
    'rechecks %s while awaiting the model catalog before saving', async change => {
      const h = await fixture(); const entered = deferred<void>(); const lookup = deferred<LlmModelInfo[]>();
      h.listModels.mockImplementation(async () => { entered.resolve(); return lookup.promise; });
      const abort = new AbortController();
      const pending = h.call('save', { sessionId: 'captain', expectedRevision: null, plan: explicitPlan() }, h.owner, abort.signal);
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      if (change === 'replace-agent') h.actors.set('captain', { ...h.captain } as Agent);
      if (change === 'archive') h.archived.push(SessionId('captain'));
      if (change === 'cancel') abort.abort(new Error('Cancelled while listing'));
      if (change === 'dispose-peer') await h.owner.dispose();
      if (change === 'unload') await h.remoteFiber.dispose();
      lookup.resolve([{ provider: 'configured', id: 'selected', name: 'Selected model' }]);
      await rejected;
      expect(h.rows.size).toBe(0); expect(h.driver.run).not.toHaveBeenCalled(); expect(h.createAgent).not.toHaveBeenCalled();
    });
  it('retains optimistic revisions across a slow catalog validation', async () => {
    const h = await fixture(); const initial = await h.save(explicitPlan());
    const entered = deferred<void>(); const lookup = deferred<LlmModelInfo[]>();
    h.listModels.mockImplementationOnce(async () => { entered.resolve(); return lookup.promise; });
    const pending = h.save(explicitPlan(), initial.revision);
    const rejected = expect(pending).rejects.toThrow('Plan changed');
    await entered.promise;
    const updated = await h.engine.savePlan('captain', 'workspace', initial.revision, { ...explicitPlan(), name: 'Newer plan' });
    lookup.resolve([{ provider: 'configured', id: 'selected', name: 'Selected model' }]);
    await rejected; expect(h.engine.snapshot('captain')).toEqual(updated);
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

  it('loads model options through the bound native Remote without weakening team result ownership', async () => {
    const h = await fixture(); const c = await clientFixture(h); const a = c.actions.forSession('captain');
    expect(await a.models()).toEqual([{ provider: 'configured', model: 'selected', providerLabel: 'Configured provider', modelLabel: 'Selected model' }]);
    expect(c.calls[0]).toMatchObject({ endpoint: 'teamAgents/models', args: { request: { sessionId: 'captain' } } });
    const malformed = vi.spyOn(c.connection.rpc, 'call').mockResolvedValueOnce({ ok: true, value: { models: [] } });
    await expect(a.models()).rejects.toThrow();
    h.actor('other'); const other = await h.save(plan(), null, 'other');
    malformed.mockResolvedValueOnce({ ok: true, value: other });
    await expect(a.read()).rejects.toThrow('another captain');
    malformed.mockRestore();
    const abort = new AbortController(); abort.abort(new Error('Discarded catalog'));
    const before = c.calls.length;
    await expect(a.models(abort.signal)).rejects.toThrow('Discarded catalog');
    expect(c.calls).toHaveLength(before);
    await c.fiber.dispose(); await expect(a.models()).rejects.toThrow('unloaded');
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
