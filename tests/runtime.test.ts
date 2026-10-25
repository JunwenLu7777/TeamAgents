import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session';
import { DshTeamDriver, taskPrompt } from '../src/runtime.js';
import { TeamSchema, type TeamMessage } from '../src/model.js';
import type { Execution } from '../src/engine.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>();
  const live = new Map<string, FakeAgent>();
  const saved = new Map<string, Session>();
  const guards: Array<(exec: { name: string }) => unknown> = [];
  const composeFrom = vi.fn();
  const toolDefinition = {};
  const setDirectory = vi.fn(async (_agent: unknown, directory: string) => directory);
  const services: Record<string, unknown> = {
    workingDirectory: { set: setDirectory },
    agentPresets: { composeFrom, composedPreset: () => 'test-preset' },
    permissionPresets: { current: () => 'danger-full-access' },
    sandboxPolicy: { overrideOf: () => 'workspace-write' }, approval: {},
  };
  const scopedListeners = new Map<string, Function>();
  const childCtx = {
    on: (name: string, callback: Function) => { scopedListeners.set(name, callback); return () => scopedListeners.delete(name); },
    get: (name: string) => services[name],
    tools: { guard: (guard: typeof guards[number]) => guards.push(guard), get: () => toolDefinition },
    systemPrompt: { context: vi.fn(), getContextOrder: () => 125 },
  } as unknown as Context;
  class FakeAgent {
    status: 'idle' | 'running' = 'idle';
    options: AgentOptions = { provider: 'test-provider', model: 'test-model' };
    ctx = childCtx;
    idle = deferred();
    turn = 0;
    autoFinish = true;
    autoCancel = true;
    constructor(readonly session: Session) {}
    get id() { return this.session.id; }
    emit(type: string, data: unknown) {
      const event = { type, data, seq: 0, time: Date.now() } as unknown as SessionEvent;
      for (const listener of listeners) listener(this.session, event);
    }
    followup = vi.fn((_message: UserMessage) => {
      this.status = 'running'; this.idle = deferred(); this.turn++;
      this.emit('turn/start', { turn: this.turn });
      this.emit('step/start', { turn: this.turn, step: 1 });
      if (this.autoFinish) queueMicrotask(() => this.finish({ kind: 'completed' }, `report ${this.turn}`));
    });
    whenIdle = vi.fn(() => this.status === 'idle' ? Promise.resolve() : this.idle.promise);
    cancel = vi.fn(() => { if (this.autoCancel && this.status === 'running') this.finish({ kind: 'aborted', reason: { kind: 'user' } }); });
    inject = vi.fn();
    steer = vi.fn();
    finish(reason: TurnEndReason, text?: string) {
      if (text !== undefined) this.emit('assistant/message', {
        turn: this.turn, step: 1, stream: [],
        message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test-provider', model: 'test-model' } }),
      });
      this.emit('turn/end', { turn: this.turn, reason });
      this.status = 'idle'; this.idle.resolve();
    }
  }
  const parent = new FakeAgent(Session.create(SessionId('captain'), undefined, {
    version: 4, id: SessionId('captain'), createdAt: 0, isSeeded: false, cwd: '/workspace',
  }));
  live.set(parent.id, parent);
  let configure: (agent: FakeAgent) => void = () => {};
  const disposers: ReturnType<typeof vi.fn>[] = [];
  async function materialize(session: Session, setup: CreateAgentOptions['setup'], options: AgentOptions = {}) {
    const agent = new FakeAgent(session); agent.options = options; configure(agent);
    await setup?.(childCtx, agent as unknown as Agent);
    saved.set(agent.id, session); live.set(agent.id, agent);
    const dispose = vi.fn(async () => { agent.cancel(); await agent.whenIdle(); live.delete(agent.id); });
    disposers.push(dispose);
    return { agent, dispose } as unknown as AgentHandle;
  }
  const create = vi.fn(async (options: CreateAgentOptions) => materialize(Session.create(options.sessionId, undefined, {
    version: 4, id: options.sessionId, createdAt: Date.now(), isSeeded: false, ...options.meta,
  }), options.setup, options.agentOptions));
  const resume = vi.fn(async (options: ResumeAgentOptions) => {
    const session = saved.get(options.resumeSessionId);
    if (!session) throw new Error('Missing persisted member');
    return materialize(session, options.setup, options.agentOptions);
  });
  const listModels = vi.fn(async (provider: string) => [
    { provider, id: 'member-model', name: 'Member model' }, { provider, id: 'test-model', name: 'Test model' },
  ]);
  const llm = { listProviders: () => [{ id: 'member-provider', name: 'Member provider' }, { id: 'test-provider', name: 'Test provider' }], listModels };
  const ctx = {
    llm,
    agents: { get: (id: string) => live.get(id), create, resume },
    on: (_name: string, fn: typeof listeners extends Set<infer F> ? F : never) => {
      listeners.add(fn); return () => { listeners.delete(fn); };
    },
  } as unknown as Context;
  const team = TeamSchema.parse({ name: 'Team', goal: 'Goal', id: 'team', ownerSessionId: parent.id,
    workspaceId: 'workspace', revision: 1, status: 'running', createdAt: 'now', updatedAt: 'now',
    members: [{ name: 'engineer', role: 'Developer' }],
    tasks: [{ id: 'build', subject: 'Build', description: 'Implement and test', assignee: 'engineer',
      dependencies: [], writeScopes: ['feature'], status: 'running', attempt: 1, attemptId: 'attempt-1' }], messages: [],
  });
  const controller = new AbortController();
  const bound = deferred();
  const bindSession = vi.fn(async (id: string) => { team.members[0]!.sessionId = id; bound.resolve(); });
  const execution: Execution = { team, member: team.members[0]!, task: team.tasks[0]!, signal: controller.signal, bindSession };
  const driver = new DshTeamDriver(ctx);
  return { driver, execution, team, parent, live, saved, create, resume, guards, composeFrom, childCtx, ctx, llm, scopedListeners,
    configure: (fn: typeof configure) => { configure = fn; }, controller, bound, listeners, disposers, setDirectory };
}

describe('DSH runtime adapter using real delegation and output helpers', () => {
  it('creates on first task, inherits route/permissions, and reuses the durable member', async () => {
    const h = fixture();
    expect(await h.driver.run(h.execution)).toBe('report 1');
    expect(await h.driver.run(h.execution)).toBe('report 2');
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.setDirectory).toHaveBeenCalledTimes(2);
    expect(h.setDirectory.mock.calls.every(([, directory]) => directory === '/workspace')).toBe(true);
    expect(h.execution.bindSession).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[0]![0].agentOptions).toMatchObject({ provider: 'test-provider', model: 'test-model', subagentDepth: 1 });
    expect(h.composeFrom).toHaveBeenCalledOnce();
    const session = h.saved.get(h.execution.member.sessionId!)!;
    expect(session.snapshotEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }),
      expect.objectContaining({ type: 'sandbox/mode', data: { mode: 'workspace-write', source: 'delegation' } }),
    ]));
    expect(h.listeners.size).toBe(0);
    await h.driver.dispose();
    expect(h.disposers[0]).toHaveBeenCalledOnce();
  });
  it('resumes the recorded session after an adapter reload, without minting a replacement', async () => {
    const h = fixture(); await h.driver.run(h.execution); await h.driver.dispose();
    // A new adapter owns the same registry facade; previous instance cannot be reused.
    const options = h.create.mock.calls[0]![0];
    const id = h.execution.member.sessionId!;
    h.configure(agent => { expect(agent.session.header.parentSession).toBe(options.parentAgent!.id); });
    const newDriver = new DshTeamDriver({ agents: {
      get: (key: string) => h.live.get(key), create: h.create, resume: h.resume,
    }, on: (_name: string, fn: (session: Session, event: SessionEvent) => void) => {
      h.listeners.add(fn); return () => h.listeners.delete(fn);
    } } as unknown as Context);
    expect(await newDriver.run(h.execution)).toBe('report 1');
    expect(h.resume.mock.calls[0]![0].resumeSessionId).toBe(id);
    expect(h.create).toHaveBeenCalledOnce();
    await newDriver.dispose();
  });
  it('keeps explicit member routing on create, reuse, and resume regardless of captain changes', async () => {
    const h = fixture();
    const selected = { provider: 'member-provider', model: 'member-model' };
    h.execution.member.model = selected;
    h.parent.options = { provider: 'test-provider', model: 'test-model', reasoningEffort: ReasoningEffortId('captain-effort') };
    await h.driver.run(h.execution);
    expect(h.create.mock.calls[0]![0].agentOptions).toMatchObject(selected);
    expect(h.create.mock.calls[0]![0].agentOptions).not.toHaveProperty('reasoningEffort');
    h.parent.options = { provider: 'other-provider', model: 'other-model' };
    await h.driver.run(h.execution);
    expect(h.create).toHaveBeenCalledOnce(); expect(h.resume).not.toHaveBeenCalled();
    await h.driver.dispose();
    const resumed = new DshTeamDriver(h.ctx);
    await resumed.run(h.execution);
    expect(h.resume.mock.calls[0]![0].agentOptions).toMatchObject(selected);
    expect(h.resume.mock.calls[0]![0].agentOptions).not.toHaveProperty('reasoningEffort');
    expect(h.llm.listModels).toHaveBeenCalledTimes(3);
    await resumed.dispose();
  });
  it('uses the real SDK selection hook for prompt/request routing and clears resumed effort', async () => {
    const h = fixture(); h.execution.member.model = { provider: 'test-provider', model: 'test-model' };
    await h.driver.run(h.execution);
    // Drive the actual installModelSelection waterfalls without invoking a provider or Agent loop.
    const assembly = h.scopedListeners.get('system-prompt/assemble')!;
    const request = h.scopedListeners.get('agent/request')!;
    expect(await assembly({}, {}, async () => ({ variables: { provider: 'old', model: 'old' } }))).toMatchObject({
      variables: { provider: 'test-provider', model: 'test-model' },
    });
    const staleRequest = { provider: 'old', model: 'old', reasoningEffort: ReasoningEffortId('old-effort'), maxTokens: 4096 };
    expect(await request({}, async () => staleRequest)).toEqual({ provider: 'test-provider', model: 'test-model', maxTokens: 4096 });
    // Omission also clears effort when the old header names the very same route.
    expect(await request({}, async () => ({ ...staleRequest, provider: 'test-provider', model: 'test-model' })))
      .not.toHaveProperty('reasoningEffort');
    await h.driver.dispose();
  });
  it('independently routes two members without requiring a configured captain', async () => {
    const h = fixture(); h.parent.options = {};
    h.execution.member.model = { provider: 'member-provider', model: 'member-model' };
    await h.driver.run(h.execution);
    const other = { name: 'reviewer', role: 'Review', model: { provider: 'test-provider', model: 'test-model' } };
    h.team.members.push(other);
    await h.driver.run({ ...h.execution, member: other, bindSession: async () => {} });
    expect(h.create.mock.calls.map(([options]) => options.agentOptions)).toMatchObject([
      { provider: 'member-provider', model: 'member-model' }, { provider: 'test-provider', model: 'test-model' },
    ]);
    await h.driver.dispose();
  });
  it('rejects removed models both before creation and before reuse rather than falling back', async () => {
    const h = fixture(); h.execution.member.model = { provider: 'member-provider', model: 'member-model' };
    h.llm.listModels.mockResolvedValueOnce([]);
    await expect(h.driver.run(h.execution)).rejects.toThrow('no longer');
    expect(h.create).not.toHaveBeenCalled();
    await h.driver.run(h.execution);
    const child = h.live.get(h.execution.member.sessionId!)!;
    h.llm.listModels.mockResolvedValue([]);
    await expect(h.driver.run(h.execution)).rejects.toThrow('no longer');
    expect(child.followup).toHaveBeenCalledOnce();
    await h.driver.dispose();
  });
  it('refuses silently reusing a handle after its explicit plan selection changes', async () => {
    const h = fixture(); h.execution.member.model = { provider: 'member-provider', model: 'member-model' };
    await h.driver.run(h.execution);
    h.execution.member.model = { provider: 'test-provider', model: 'test-model' };
    await expect(h.driver.run(h.execution)).rejects.toThrow('selection changed');
    expect(h.create).toHaveBeenCalledOnce(); await h.driver.dispose();
  });
  it('rebinds a retained idle handle after a state write failure', async () => {
    const h = fixture();
    h.execution.bindSession = vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(undefined);
    await expect(h.driver.run(h.execution)).rejects.toThrow('Disk full');
    expect(await h.driver.run(h.execution)).toBe('report 1');
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.execution.bindSession).toHaveBeenCalledTimes(2);
    await h.driver.dispose();
  });
  it.each(['error', 'max-tokens', 'blocked'] as const)('does not turn %s into successful output', async kind => {
    const h = fixture();
    h.configure(agent => {
      agent.followup.mockImplementation(() => {
        agent.status = 'running'; agent.turn++;
        agent.emit('turn/start', { turn: agent.turn });
        agent.emit('step/start', { turn: agent.turn, step: 1 });
        const reason = (kind === 'error' ? { kind, error: { code: 'UNKNOWN', message: 'test failure' } } : { kind }) as TurnEndReason;
        queueMicrotask(() => agent.finish(reason, 'partial report'));
      });
    });
    await expect(h.driver.run(h.execution)).rejects.toThrow(`stop reason: ${kind}`);
    expect(h.listeners.size).toBe(0); await h.driver.dispose();
  });
  it('cancellation waits for quiescence and suppresses late successful text', async () => {
    const h = fixture(); h.configure(agent => { agent.autoFinish = false; agent.autoCancel = false; });
    const result = h.driver.run(h.execution);
    await h.bound.promise;
    await vi.waitFor(() => expect(h.live.get(h.team.members[0]!.sessionId!)?.status).toBe('running'));
    const child = h.live.get(h.team.members[0]!.sessionId!)!;
    h.controller.abort(new Error('Stopped by test'));
    let settled = false;
    const observed = result.then(() => { settled = true; }, error => { settled = true; throw error; });
    await Promise.resolve(); expect(settled).toBe(false); expect(child.cancel).toHaveBeenCalled();
    child.finish({ kind: 'completed' }, 'late result');
    await expect(observed).rejects.toThrow('Stopped by test');
    expect(h.listeners.size).toBe(0); await h.driver.dispose();
  });
  it('guards nested delegation and captain management, but allows ordinary tools', async () => {
    const h = fixture(); await h.driver.run(h.execution);
    const guard = h.guards[0]!;
    for (const name of ['subagent', 'subagent_fork', 'agent_teams_create', 'team_agents_start', 'team_task_create', 'workflow', 'ralph', 'create_goal', 'update_goal', 'schedule_create', 'schedule_update']) expect(guard({ name })).toBeTypeOf('string');
    for (const name of ['read', 'edit', 'team_agents_status', 'team_agents_message']) expect(guard({ name })).toBeUndefined();
    await h.driver.dispose();
  });
  it('queues captain context without waking and never wakes an idle member', async () => {
    const h = fixture(); await h.driver.run(h.execution);
    const message: TeamMessage = { id: 'm1', from: 'engineer', to: 'captain', text: 'Need guidance', createdAt: 'now' };
    expect(await h.driver.deliver(h.team, message)).toBe(true);
    expect(h.parent.inject).toHaveBeenCalledOnce(); expect(h.parent.steer).not.toHaveBeenCalled();
    expect(await h.driver.deliver(h.team, { ...message, to: 'engineer' })).toBe(false);
    await h.driver.dispose();
  });
  it('reports completion only to its captain and suppresses notifications after disposal', async () => {
    const h = fixture(); const task = { ...h.execution.task, status: 'completed' as const, output: 'done' };
    h.driver.settled(h.team, task); expect(h.parent.steer).toHaveBeenCalledOnce();
    h.driver.settled({ ...h.team, status: 'paused' }, task); expect(h.parent.steer).toHaveBeenCalledOnce();
    await h.driver.dispose(); h.driver.settled(h.team, task); expect(h.parent.steer).toHaveBeenCalledOnce();
  });
  it('fails closed for missing captain and wrong persisted lineage', async () => {
    const h = fixture(); h.live.delete(h.parent.id);
    await expect(h.driver.run(h.execution)).rejects.toThrow('Captain session is not live');
    h.live.set(h.parent.id, h.parent);
    h.team.members[0]!.sessionId = 'unrelated';
    h.saved.set('unrelated', Session.create(SessionId('unrelated')));
    await expect(h.driver.run(h.execution)).rejects.toThrow('lineage');
    await h.driver.dispose();
  });
  it('includes dependency results and only the recipient unread mailbox in prompts', () => {
    const h = fixture(); const execution = h.execution;
    execution.team.tasks.push({ ...execution.task, id: 'before', output: 'x'.repeat(12_000), status: 'completed' });
    execution.task.dependencies.push('before');
    execution.team.messages = [
      { id: 'one', from: 'captain', to: 'engineer', text: 'private task data', createdAt: 'now' },
      { id: 'two', from: 'captain', to: 'other', text: 'other mailbox', createdAt: 'now' },
    ];
    const prompt = taskPrompt(execution);
    expect(prompt).toContain('untrusted task data'); expect(prompt).toContain('private task data');
    expect(prompt).not.toContain('other mailbox'); expect(prompt).not.toContain('x'.repeat(10_001));
  });
});
