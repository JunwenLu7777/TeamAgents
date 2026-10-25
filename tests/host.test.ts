import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { assertSupportedJsonSchema, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { apply, inject, teamDomain } from '../src/index.js';
import type { Team } from '../src/model.js';
import { agentLibraryDomain } from '../src/agent-library.js';
import type { AgentLibrary } from '../src/library-model.js';
import { registerTeamRemote } from '../src/remote.js';
import { registerAgentLibraryRemote } from '../src/library-remote.js';

// These tests isolate chat-tool glue; remote suites use the real native Gateway.
vi.mock('../src/remote.js', () => ({ registerTeamRemote: vi.fn() }));
vi.mock('../src/library-remote.js', () => ({ registerAgentLibraryRemote: vi.fn() }));

async function host(initialTeams: Team[] = []) {
  const rows = new Map<string, Team>(initialTeams.map(team => [team.ownerSessionId, structuredClone(team)]));
  const libraryRows = new Map<string, AgentLibrary>();
  const tools = new Map<string, ToolDefinition>();
  const actors = new Map<string, Agent>();
  const effects: Array<() => unknown> = [];
  const handlers = new Map<string, Function[]>();
  const close = vi.fn(async () => {});
  const closeLibrary = vi.fn(async () => {});
  const putTeam = vi.fn(async (key: string, team: Team) => { rows.set(key, structuredClone(team)); });
  const putLibrary = vi.fn(async (key: string, library: AgentLibrary) => { libraryRows.set(key, structuredClone(library)); });
  const open = vi.fn(async (definition: { name: string }) => {
    if (definition.name === teamDomain.name) return { table: () => ({
      get: (key: string) => rows.get(key), entries: () => rows.entries(), put: putTeam,
    }), close };
    if (definition.name === agentLibraryDomain.name) return { table: () => ({
      get: (key: string) => libraryRows.get(key), entries: () => libraryRows.entries(), put: putLibrary,
    }), close: closeLibrary };
    throw new Error(`Unexpected domain: ${definition.name}`);
  });
  const contextPrompt = vi.fn();
  const createAgent = vi.fn();
  const listProviders = vi.fn(() => [{ id: 'configured', name: 'Configured provider' }]);
  const listModels = vi.fn(async () => [{ provider: 'configured', id: 'selected', name: 'Selected model' }]);
  const context = {
    llm: { listProviders, listModels },
    storageDomain: { open },
    agents: { get: (id: string) => actors.get(id), create: createAgent },
    sessions: { get: (id: string) => actors.get(id)?.session },
    workspaceRegistry: { resolveByPath: async () => ({ id: 'workspace' }) },
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); } },
    sessionProjections: { register: vi.fn() },
    systemPrompt: { context: contextPrompt, getContextOrder: () => 125 },
    effect: (register: () => () => unknown) => { effects.push(register()); },
    on: (name: string, fn: Function) => { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
  } as unknown as Context;
  function actor(id: string, origin?: 'subagent', delegationDepth?: number) {
    const session = Session.create(SessionId(id), undefined, { version: 4, id: SessionId(id), createdAt: 0,
      isSeeded: false, cwd: '/workspace', ...(origin ? { origin } : {}), ...(delegationDepth === undefined ? {} : { delegationDepth }) });
    const agent = { id: session.id, session, options: {} } as Agent;
    actors.set(id, agent); return agent;
  }
  await apply(context);
  const library = [...vi.mocked(registerAgentLibraryRemote).mock.calls].reverse().find(([ctx]) => ctx === context)![1];
  const engine = [...vi.mocked(registerTeamRemote).mock.calls].reverse().find(([ctx]) => ctx === context)![1];
  const captain = actor('captain');
  async function call<T = Team | null>(name: string, args: unknown = {}, agent: Agent | undefined = captain, signal = new AbortController().signal) {
    return tools.get(`team_agents_${name}`)!.execute(args, { agent, signal } as ToolRunContext) as Promise<T>;
  }
  const dispose = async () => { for (const effect of [...effects].reverse()) await effect(); };
  return { rows, libraryRows, library, engine, open, putTeam, putLibrary, tools, actors, handlers, captain, actor, call,
    close, closeLibrary, createAgent, dispose, listProviders, listModels, contextPrompt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('global library to conversation snapshots', () => {
  it('keeps independent durable domains and saves an empty-session library without execution', async () => {
    const h = await host();
    expect(h.open.mock.calls.map(([definition]) => definition)).toEqual([teamDomain, agentLibraryDomain]);
    expect(teamDomain).toMatchObject({ name: 'dsh_team_agents', version: 1 });
    expect(Object.keys(teamDomain.tables)).toEqual(['teams']);
    expect(await h.call<AgentLibrary>('list_agents')).toEqual({ revision: 0, agents: [], updatedAt: null });
    h.actors.clear();
    const saved = await h.library.save([{ name: 'reader', role: 'Read only', enabled: true }], 0);
    expect(saved.revision).toBe(1);
    expect(h.rows.size).toBe(0); expect(h.putTeam).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.listModels).not.toHaveBeenCalled();
    const captain = h.actor('fresh-conversation');
    const listed = await h.call<AgentLibrary>('list_agents', {}, captain);
    expect(listed).toEqual(saved);
    listed.agents[0]!.role = 'Client-side mutation';
    expect(h.library.read().agents[0]!.role).toBe('Read only');
    expect(captain.session.snapshotEvents()).toEqual([]);
    await h.dispose(); expect(h.closeLibrary).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
  });

  it('atomically copies selected enabled agents once, preserving their models and requested order', async () => {
    const h = await host();
    const saved = await h.library.save([
      { name: 'reader', role: 'Read only', instructions: 'Do not modify files.', enabled: true },
      { name: 'reviewer', role: 'Review', enabled: true, model: { provider: 'configured', model: 'selected' } },
      { name: 'disabled', role: 'Not selected', enabled: false },
    ], 0);
    expect(h.tools.get('team_agents_create')!.parameters).toMatchObject({ properties: {
      agents: { type: 'array', items: { type: 'string' } }, libraryRevision: { type: 'integer' },
    } });
    const created = await h.call('create', { name: 'Review crew', goal: 'Review this user-requested change',
      agents: ['reviewer', 'reader'], libraryRevision: saved.revision });
    expect(created).toMatchObject({ revision: 1, status: 'draft', tasks: [], members: [
      { name: 'reviewer', role: 'Review', model: { provider: 'configured', model: 'selected' } },
      { name: 'reader', role: 'Read only', instructions: 'Do not modify files.' },
    ] });
    expect(created!.members.every(member => !('enabled' in member) && !('sessionId' in member))).toBe(true);
    expect(h.putTeam).toHaveBeenCalledOnce();
    expect(h.captain.session.snapshotEvents()).toHaveLength(1);
    expect(h.library.read()).toEqual(saved);
    expect(h.createAgent).not.toHaveBeenCalled();
    await h.dispose();
  });

  it.each([
    { agents: ['reader'] },
    { libraryRevision: 1 },
    { agents: [], libraryRevision: 1 },
    { agents: ['reader', 'reader'], libraryRevision: 1 },
    { agents: ['reader', 'missing'], libraryRevision: 1 },
    { agents: ['reader', 'disabled'], libraryRevision: 1 },
    { agents: ['reader'], libraryRevision: 0 },
    { agents: ['reader'], libraryRevision: -1 },
    { agents: ['reader'], libraryRevision: 1.5 },
    { agents: ['reader'], libraryRevision: Number.MAX_SAFE_INTEGER + 1 },
    { agents: Array.from({ length: 13 }, (_, i) => `reader-${i}`), libraryRevision: 1 },
    { agents: 'reader', libraryRevision: 1 },
    { agents: ['captain'], libraryRevision: 1 },
  ])('refuses invalid or stale selection without a partial team: %j', async selection => {
    const h = await host();
    await h.library.save([{ name: 'reader', role: 'Read only', enabled: true }, { name: 'disabled', role: 'Disabled', enabled: false }], 0);
    await expect(h.call('create', { name: 'Crew', goal: 'User goal', ...selection })).rejects.toThrow();
    expect(h.rows.size).toBe(0); expect(h.putTeam).not.toHaveBeenCalled();
    expect(h.captain.session.snapshotEvents()).toEqual([]);
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it('rejects unavailable selected models before writing any team', async () => {
    const h = await host();
    await h.library.save([
      { name: 'reader', role: 'Read only', enabled: true },
      { name: 'reviewer', role: 'Review', enabled: true, model: { provider: 'deleted', model: 'old-model' } },
    ], 0);
    await expect(h.call('create', { name: 'Crew', goal: 'User goal', agents: ['reader', 'reviewer'], libraryRevision: 1 })).rejects.toThrow('no longer');
    expect(h.rows.size).toBe(0); expect(h.putTeam).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it('rechecks the library revision when model validation outlives a settings edit', async () => {
    const h = await host();
    const definition = { name: 'reader', role: 'Read only', enabled: true, model: { provider: 'configured', model: 'selected' } };
    await h.library.save([definition], 0);
    const catalog = deferred<Awaited<ReturnType<typeof h.listModels>>>();
    h.listModels.mockReturnValueOnce(catalog.promise);
    const creating = h.call('create', { name: 'Crew', goal: 'User goal', agents: ['reader'], libraryRevision: 1 });
    await vi.waitFor(() => expect(h.listModels).toHaveBeenCalledOnce());
    await h.library.save([{ ...definition, enabled: false }], 1);
    const rejected = expect(creating).rejects.toThrow(/changed|revision/i);
    catalog.resolve([{ provider: 'configured', id: 'selected', name: 'Selected model' }]);
    await rejected;
    expect(h.putTeam).not.toHaveBeenCalled(); expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it.each(['cancelled', 'replaced'] as const)('rejects %s captain after catalog lookup without saving', async reason => {
    const h = await host();
    await h.library.save([{ name: 'reader', role: 'Read', enabled: true, model: { provider: 'configured', model: 'selected' } }], 0);
    const catalog = deferred<Awaited<ReturnType<typeof h.listModels>>>();
    h.listModels.mockReturnValueOnce(catalog.promise);
    const controller = new AbortController();
    const creating = h.call('create', { name: 'Crew', goal: 'User goal', agents: ['reader'], libraryRevision: 1 }, h.captain, controller.signal);
    const rejected = expect(creating).rejects.toThrow();
    await vi.waitFor(() => expect(h.listModels).toHaveBeenCalledOnce());
    if (reason === 'cancelled') controller.abort(new Error('Cancelled'));
    else h.actor('captain');
    catalog.resolve([{ provider: 'configured', id: 'selected', name: 'Selected model' }]);
    await rejected;
    expect(h.putTeam).not.toHaveBeenCalled(); expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it('isolates old session snapshots from library updates, disable, and deletion', async () => {
    const h = await host();
    await h.library.save([{ name: 'reader', role: 'Original role', enabled: true }], 0);
    const original = await h.call('create', { name: 'Old crew', goal: 'Original user goal', agents: ['reader'], libraryRevision: 1 });
    await h.library.save([{ name: 'reader', role: 'Updated role', enabled: true, model: { provider: 'configured', model: 'selected' } }], 1);
    const other = h.actor('other');
    const fresh = await h.call('create', { name: 'New crew', goal: 'New user goal', agents: ['reader'], libraryRevision: 2 }, other);
    expect(fresh!.members[0]).toEqual({ name: 'reader', role: 'Updated role', model: { provider: 'configured', model: 'selected' } });
    expect(await h.call('status')).toEqual(original);
    await h.library.save([{ name: 'reader', role: 'Disabled later', enabled: false }], 2);
    expect(await h.call('status')).toEqual(original);
    await h.library.save([], 3);
    expect(await h.call('status')).toEqual(original);
    expect(await h.call('status', {}, other)).toEqual(fresh);
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it('preserves an existing team when a second atomic create is attempted', async () => {
    const h = await host();
    const old = await h.call('create', { name: 'Legacy', goal: 'Existing goal' });
    await h.library.save([{ name: 'reader', role: 'Read', enabled: true }], 0);
    await expect(h.call('create', { name: 'Replacement', goal: 'New goal', agents: ['reader'], libraryRevision: 1 })).rejects.toThrow('changed');
    expect(await h.call('status')).toEqual(old); expect(h.putTeam).toHaveBeenCalledOnce();
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it('does not migrate or rewrite persisted legacy teams when the independent library opens', async () => {
    const previous = await host();
    await previous.call('create', { name: 'Legacy', goal: 'Existing goal' });
    const old = (await previous.call('add_member', { name: 'reader', role: 'Inherited model' }))!;
    await previous.dispose();
    const h = await host([old]);
    expect(await h.call('status')).toEqual(old); expect(h.putTeam).not.toHaveBeenCalled();
    expect(h.library.read()).toEqual({ revision: 0, agents: [], updatedAt: null });
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });

  it('does not expose the global library to delegated, bound-member, stale, or agentless callers', async () => {
    const h = await host();
    const tool = h.tools.get('team_agents_list_agents')!;
    await expect(tool.execute({}, { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow('exact live');
    await expect(h.call('list_agents', {}, h.actor('child', 'subagent'))).rejects.toThrow('top-level');
    await expect(h.call('list_agents', {}, h.actor('deep-child', undefined, 1))).rejects.toThrow('top-level');
    await expect(h.call('list_agents', {}, { ...h.captain } as Agent)).rejects.toThrow('exact live');
    await expect(h.call('list_agents', { ownerSessionId: 'other' })).rejects.toThrow();
    await h.call('create', { name: 'Crew', goal: 'User goal' });
    const saved = (await h.call('add_member', { name: 'reader', role: 'Read' }))!;
    saved.members[0]!.sessionId = 'bound-member'; h.rows.set('captain', saved);
    await expect(h.call('list_agents', {}, h.actor('bound-member'))).rejects.toThrow('top-level');
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.call('list_agents', {}, h.captain, controller.signal)).rejects.toThrow('Cancelled');
    await h.dispose();
  });

  it('keeps the later-human-turn approval protocol and never starts while listing, selecting, or planning', async () => {
    const h = await host();
    const context = h.contextPrompt.mock.calls[0]![0] as { text(input: { agent?: Agent }): string };
    const prompt = context.text({ agent: h.captain });
    expect(prompt).toContain('Settings only saves the global Agent configuration library');
    expect(prompt).toContain('goal must come from the human conversation');
    expect(prompt).toContain('First call team_agents_list_agents');
    expect(prompt).toContain('END the turn for explicit human approval');
    expect(prompt).toContain('NOT proof of user consent');
    expect(prompt).toContain('later human turn');
    expect(context.text({ agent: h.actor('child', 'subagent') })).toBe('');
    const start = vi.spyOn(h.engine, 'start');
    await h.library.save([{ name: 'reader', role: 'Read', enabled: true }], 0);
    await h.call('list_agents');
    await h.call('create', { name: 'Crew', goal: 'User goal', agents: ['reader'], libraryRevision: 1 });
    const ready = (await h.call('add_task', { id: 'inspect', subject: 'Inspect', description: 'Review safely', assignee: 'reader' }))!;
    await expect(h.call('start', { expectedRevision: ready.revision })).rejects.toThrow();
    await expect(h.call('start', { expectedRevision: ready.revision, confirmation: ' ' })).rejects.toThrow();
    expect(start).not.toHaveBeenCalled(); expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });
});

describe('dual-domain cleanup', () => {
  it('closes the existing domain when opening the library fails', async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn().mockResolvedValueOnce({ close }).mockRejectedValueOnce(new Error('Library open failed'));
    await expect(apply({ storageDomain: { open } } as unknown as Context)).rejects.toThrow('Library open failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes both domains even if flushing the library fails', async () => {
    const h = await host();
    vi.spyOn(h.library, 'dispose').mockRejectedValueOnce(new Error('Library flush failed'));
    await expect(h.dispose()).rejects.toThrow('Library flush failed');
    expect(h.closeLibrary).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
  });

  it('still flushes the library and closes both domains if engine disposal fails', async () => {
    const h = await host();
    vi.spyOn(h.engine, 'dispose').mockRejectedValueOnce(new Error('Engine dispose failed'));
    const libraryDispose = vi.spyOn(h.library, 'dispose');
    await expect(h.dispose()).rejects.toThrow('Engine dispose failed');
    expect(libraryDispose).toHaveBeenCalledOnce();
    expect(h.closeLibrary).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('host plugin wiring and caller isolation', () => {
  it('registers ten valid SDK tools and does not call a model while planning', async () => {
    const h = await host();
    expect(h.tools.size).toBe(10);
    expect(registerTeamRemote).toHaveBeenCalled();
    expect(registerAgentLibraryRemote).toHaveBeenCalled();
    for (const tool of h.tools.values()) {
      expect(() => assertSupportedJsonSchema(tool.parameters)).not.toThrow();
      expect(() => assertSupportedJsonSchema(tool.output.schema)).not.toThrow();
    }
    const team = await h.call('create', { name: 'Demo', goal: 'Test the plugin' });
    expect(team?.status).toBe('draft');
    await h.call('add_member', { name: 'researcher', role: 'Read only research' });
    await h.call('add_task', { id: 'inspect', subject: 'Inspect', description: 'Read docs', assignee: 'researcher' });
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.captain.session.snapshotEvents().every(e => pluginRecordOf(e)?.type === 'plugin:dsh-team-agents/snapshot')).toBe(true);
    await h.dispose(); expect(h.close).toHaveBeenCalledOnce(); expect(h.closeLibrary).toHaveBeenCalledOnce();
  });
  it('accepts configured explicit models through chat but refuses invalid/deleted selections without a model call', async () => {
    const h = await host();
    await h.call('create', { name: 'Models', goal: 'Choose configured member models' });
    await expect(h.call('add_member', { name: 'bad', role: 'Invalid', model: { provider: 'unknown', model: 'selected' } })).rejects.toThrow('catalog');
    await expect(h.call('add_member', { name: 'bad', role: 'Invalid', model: { provider: 'configured' } })).rejects.toThrow();
    const added = await h.call('add_member', { name: 'researcher', role: 'Research', model: { provider: 'configured', model: 'selected' } });
    expect(added!.members[0]!.model).toEqual({ provider: 'configured', model: 'selected' });
    const ready = await h.call('add_task', { id: 'inspect', subject: 'Inspect', description: 'Read docs', assignee: 'researcher' });
    h.listModels.mockResolvedValue([]);
    await expect(h.call('start', { expectedRevision: ready!.revision, confirmation: 'Approved' })).rejects.toThrow('no longer');
    expect(h.rows.get('captain')?.revision).toBe(ready!.revision);
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });
  it('isolates captain sessions and ignores caller-supplied owner ids', async () => {
    const h = await host();
    await h.call('create', { name: 'A', goal: 'A goal' });
    const other = h.actor('other');
    expect(await h.call('status', { ownerSessionId: 'captain' }, other)).toBeNull();
    await h.call('create', { name: 'B', goal: 'B goal' }, other);
    expect((await h.call('status', {}, other))?.name).toBe('B');
    expect((await h.call('status'))?.name).toBe('A');
    await h.dispose();
  });
  it('rejects agentless, stale, delegated, cancelled, and malformed management calls', async () => {
    const h = await host();
    const create = h.tools.get('team_agents_create')!;
    await expect(create.execute({}, { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow('exact live');
    await expect(h.call('create', {}, { ...h.captain } as Agent)).rejects.toThrow('exact live');
    await expect(h.call('create', { name: 'Bad', goal: 'Bad goal' }, h.actor('child', 'subagent'))).rejects.toThrow('top-level');
    await expect(h.call('create', { name: 'Bad', goal: 'Bad goal', arbitrary: true })).rejects.toThrow();
    const abort = new AbortController(); abort.abort(new Error('Cancelled before call'));
    await expect(h.call('create', { name: 'Bad', goal: 'Bad goal' }, h.captain, abort.signal)).rejects.toThrow('Cancelled');
    expect(h.rows.size).toBe(0); await h.dispose();
  });
  it('validates the current plan revision and attributes messages to the caller', async () => {
    const h = await host();
    const initial = await h.call('create', { name: 'A', goal: 'A goal' });
    await h.call('add_member', { name: 'researcher', role: 'Research' });
    await expect(h.call('start', { expectedRevision: initial!.revision, confirmation: 'Approved' })).rejects.toThrow('Plan changed');
    await expect(h.call('message', { to: 'researcher', text: 'Hello', from: 'forged' })).rejects.toThrow();
    const state = await h.call('message', { to: 'researcher', text: 'Hello' });
    expect(state!.messages[0]).toMatchObject({ from: 'captain', to: 'researcher' });
    expect(h.createAgent).not.toHaveBeenCalled(); await h.dispose();
  });
  it('requires real lifecycle services instead of writing private plugin state files', () => {
    expect(inject).toEqual(expect.arrayContaining(['sessionPersistence', 'storageDomain', 'sessionProjections', 'workspaceRegistry', 'workingDirectory', 'llm']));
  });
});
