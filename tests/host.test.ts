import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { assertSupportedJsonSchema, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { apply, inject } from '../src/index.js';
import type { Team } from '../src/model.js';
import { registerTeamRemote } from '../src/remote.js';

// These tests isolate the legacy chat-tool glue; remote.test.ts uses the real native Gateway.
vi.mock('../src/remote.js', () => ({ registerTeamRemote: vi.fn() }));

async function host() {
  const rows = new Map<string, Team>();
  const tools = new Map<string, ToolDefinition>();
  const actors = new Map<string, Agent>();
  const effects: Array<() => unknown> = [];
  const handlers = new Map<string, Function[]>();
  const close = vi.fn(async () => {});
  const createAgent = vi.fn();
  const context = {
    storageDomain: { open: async () => ({ table: () => ({
      get: (key: string) => rows.get(key), entries: () => rows.entries(),
      put: async (key: string, team: Team) => { rows.set(key, structuredClone(team)); },
    }), close }) },
    agents: { get: (id: string) => actors.get(id), create: createAgent },
    sessions: { get: (id: string) => actors.get(id)?.session },
    workspaceRegistry: { resolveByPath: async () => ({ id: 'workspace' }) },
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); } },
    sessionProjections: { register: vi.fn() },
    systemPrompt: { context: vi.fn(), getContextOrder: () => 125 },
    effect: (register: () => () => unknown) => { effects.push(register()); },
    on: (name: string, fn: Function) => { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
  } as unknown as Context;
  function actor(id: string, origin?: 'subagent') {
    const session = Session.create(SessionId(id), undefined, { version: 4, id: SessionId(id), createdAt: 0,
      isSeeded: false, cwd: '/workspace', ...(origin ? { origin } : {}) });
    const agent = { id: session.id, session } as Agent;
    actors.set(id, agent); return agent;
  }
  await apply(context);
  const captain = actor('captain');
  async function call(name: string, args: unknown = {}, agent: Agent | undefined = captain, signal = new AbortController().signal) {
    return tools.get(`team_agents_${name}`)!.execute(args, { agent, signal } as ToolRunContext) as Promise<Team | null>;
  }
  const dispose = async () => { for (const effect of effects.reverse()) await effect(); };
  return { rows, tools, actors, handlers, captain, actor, call, close, createAgent, dispose };
}

describe('host plugin wiring and caller isolation', () => {
  it('registers nine valid SDK tools and does not call a model while planning', async () => {
    const h = await host();
    expect(h.tools.size).toBe(9);
    expect(registerTeamRemote).toHaveBeenCalled();
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
    await h.dispose(); expect(h.close).toHaveBeenCalledOnce();
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
    expect(inject).toEqual(expect.arrayContaining(['sessionPersistence', 'storageDomain', 'sessionProjections', 'workspaceRegistry', 'workingDirectory']));
  });
});
