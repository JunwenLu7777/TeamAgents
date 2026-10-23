import { randomUUID } from 'node:crypto';
import {
  TeamSchema, TeamPlanSchema, createInput, memberInput, taskInput, taskPatch, validateGraph,
  scopesOverlap, type Team, type Task, type Member, type TeamMessage,
} from './model.js';

/** Durable values are borrowed immutable data. Never mutate a value returned by get(). */
export interface TeamTable {
  get(key: string): Team | undefined;
  entries(): IterableIterator<[string, Team]>;
  put(key: string, value: Team): Promise<void>;
}
export interface Execution {
  team: Team; member: Member; task: Task; signal: AbortSignal;
  bindSession(sessionId: string): Promise<void>;
}
export interface TeamDriver {
  /** Resolve only when the execution and its writes have reached quiescence. */
  run(execution: Execution): Promise<string>;
  /** Deliver without starting idle members. Captain context may be queued without waking. False keeps the durable mailbox queued. */
  deliver(team: Team, message: TeamMessage): Promise<boolean>;
  settled?(team: Team, task: Task): void;
  dispose(): Promise<void>;
}
interface Running {
  owner: string; task: Task; controller: AbortController; done?: Promise<void>;
}
export interface EngineOptions {
  taskTimeoutMs?: number;
  onChange?(team: Team): void;
  onError?(error: unknown): void;
}
const bounded = (text: string) => text.length > 50_000 ? text.slice(0, 50_000) + '\n[Output truncated at 50,000 characters]' : text;

/** One serialized state writer, with model work outside the write queue. */
export class TeamEngine {
  private tail: Promise<unknown> = Promise.resolve();
  private runs = new Map<string, Running>();
  private closing = false;
  private readonly timeout: number;
  constructor(private table: TeamTable, private driver: TeamDriver, private options: EngineOptions = {}) {
    this.timeout = options.taskTimeoutMs ?? 20 * 60_000;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  private report(error: unknown): void { this.options.onError?.(error); }
  private get(owner: string): Team {
    const team = this.table.get(owner);
    if (!team) throw new Error('No team in this captain session. Create a team first.');
    return structuredClone(team);
  }
  snapshot(owner: string): Team | null {
    const team = this.table.get(owner);
    return team ? structuredClone(team) : null;
  }
  identity(sessionId: string): { owner: string; member: string } | undefined {
    for (const [owner, team] of this.table.entries()) {
      const member = team.members.find(m => m.sessionId === sessionId);
      if (member) return { owner, member: member.name };
    }
    return undefined;
  }
  private async save(team: Team): Promise<Team> {
    team.revision++;
    team.updatedAt = new Date().toISOString();
    const validated = TeamSchema.parse(team);
    await this.table.put(team.ownerSessionId, validated);
    try { this.options.onChange?.(structuredClone(validated)); } catch (error) { this.report(error); }
    return structuredClone(validated);
  }
  private assertOpen(): void { if (this.closing) throw new Error('Team plugin is shutting down'); }
  private assertEditable(team: Team): void {
    if (team.status === 'running') throw new Error('Stop the team before editing its plan');
  }
  async create(owner: string, workspaceId: string, input: unknown): Promise<Team> {
    const values = createInput.parse(input);
    return this.serial(async () => {
      this.assertOpen();
      if (this.table.get(owner)) throw new Error('This session already has a team. Use a new captain session for a new team.');
      const now = new Date().toISOString();
      return this.save({ ...values, id: randomUUID(), ownerSessionId: owner, workspaceId,
        revision: 0, status: 'draft', createdAt: now, updatedAt: now, members: [], tasks: [], messages: [] });
    });
  }
  /** Atomic browser-authored draft; a stale form can never replace a newer plan. */
  async savePlan(owner: string, workspaceId: string, expectedRevision: number | null, input: unknown): Promise<Team> {
    const plan = TeamPlanSchema.parse(input);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new Error('Expected revision must be a non-negative safe integer or null');
    }
    return this.serial(async () => {
      this.assertOpen();
      const existing = this.table.get(owner);
      if ((existing?.revision ?? null) !== expectedRevision) throw new Error('Plan changed. Reload the saved version before saving again.');
      if (existing) {
        this.assertEditable(existing);
        if (existing.workspaceId !== workspaceId) throw new Error('Team workspace does not match the captain workspace');
        if (existing.tasks.some(task => task.attempt !== 0 || task.status !== 'pending') ||
          existing.members.some(member => member.sessionId) || [...this.runs.values()].some(run => run.owner === owner)) {
          throw new Error('An executed plan cannot be replaced. Use a new captain session to plan a new team.');
        }
      }
      const now = new Date().toISOString();
      const next: Team = {
        ...plan,
        id: existing?.id ?? randomUUID(), ownerSessionId: owner, workspaceId,
        revision: existing?.revision ?? 0, status: 'draft',
        createdAt: existing?.createdAt ?? now, updatedAt: now,
        members: plan.members,
        tasks: plan.tasks.map(task => ({ ...task, dependencies: [...new Set(task.dependencies)],
          writeScopes: [...new Set(task.writeScopes)], status: 'pending', attempt: 0 })),
        messages: existing ? structuredClone(existing.messages) : [],
      };
      return this.save(next);
    });
  }
  async addMember(owner: string, input: unknown): Promise<Team> {
    const member = memberInput.parse(input);
    return this.serial(async () => {
      this.assertOpen();
      const team = this.get(owner); this.assertEditable(team);
      if (team.members.some(m => m.name === member.name)) throw new Error('Member name already exists');
      team.members.push(member); team.status = 'draft';
      return this.save(team);
    });
  }
  async addTask(owner: string, input: unknown): Promise<Team> {
    const task = taskInput.parse(input);
    return this.serial(async () => {
      this.assertOpen();
      const team = this.get(owner); this.assertEditable(team);
      team.tasks.push({ ...task, dependencies: [...new Set(task.dependencies)], status: 'pending', attempt: 0 });
      validateGraph(team); team.status = 'draft';
      return this.save(team);
    });
  }
  async updateTask(owner: string, id: string, input: unknown): Promise<Team> {
    const patch = taskPatch.parse(input);
    return this.serial(async () => {
      this.assertOpen();
      const team = this.get(owner); this.assertEditable(team);
      const task = team.tasks.find(t => t.id === id);
      if (!task || task.status !== 'pending' || task.attempt !== 0) throw new Error('Only never-started pending tasks may be edited');
      Object.assign(task, patch); validateGraph(team); team.status = 'draft';
      return this.save(team);
    });
  }
  async start(owner: string, expectedRevision: number): Promise<Team> {
    const team = await this.serial(async () => {
      this.assertOpen();
      const team = this.get(owner);
      if (team.revision !== expectedRevision) throw new Error('Plan changed. Read status and approve the current revision.');
      if (team.status === 'running') throw new Error('Team is already running');
      if (!team.tasks.some(t => t.status === 'pending')) throw new Error('No pending tasks; retry failed work explicitly first');
      if ([...this.runs.values()].some(r => r.owner === owner)) throw new Error('Previous execution is still stopping');
      validateGraph(team); team.status = 'running';
      return this.save(team);
    });
    this.kick(owner); return team;
  }
  async retry(owner: string, id: string, expectedRevision?: number): Promise<Team> {
    return this.serial(async () => {
      this.assertOpen();
      const team = this.get(owner); this.assertEditable(team);
      if (expectedRevision !== undefined && team.revision !== expectedRevision) throw new Error('Plan changed. Reload before retrying this task.');
      const task = team.tasks.find(t => t.id === id);
      if (!task || task.status !== 'failed') throw new Error('Only failed tasks can be retried');
      if ([...this.runs.values()].some(r => r.owner === owner && r.task.id === id)) throw new Error('Previous attempt is still stopping');
      task.status = 'pending'; delete task.attemptId; delete task.output; delete task.error;
      delete task.startedAt; delete task.endedAt; team.status = 'draft';
      return this.save(team);
    });
  }
  async stop(owner: string): Promise<Team> {
    const state = await this.serial(async () => {
      const team = this.get(owner);
      team.status = 'paused';
      for (const task of team.tasks.filter(t => t.status === 'running')) {
        task.status = 'failed'; task.error = 'Stopped. Inspect partial changes before explicitly retrying.';
        task.endedAt = new Date().toISOString(); delete task.attemptId;
      }
      const saved = await this.save(team);
      for (const run of this.runs.values()) if (run.owner === owner) run.controller.abort(new Error('Team stopped'));
      return saved;
    });
    await Promise.all([...this.runs.values()].filter(r => r.owner === owner).map(r => r.done));
    return state;
  }
  async message(owner: string, from: string, to: string, text: string): Promise<Team> {
    let message!: TeamMessage;
    const team = await this.serial(async () => {
      this.assertOpen();
      const team = this.get(owner);
      for (const name of [from, to]) if (name !== 'captain' && !team.members.some(m => m.name === name)) throw new Error(`Unknown member: ${name}`);
      message = { id: randomUUID(), from, to, text, createdAt: new Date().toISOString() };
      if (team.messages.length === 500) {
        const removable = team.messages.findIndex(m => m.deliveredAt);
        if (removable < 0) throw new Error('Mailbox is full; deliver queued messages before adding more');
        team.messages.splice(removable, 1);
      }
      team.messages.push(message);
      return this.save(team);
    });
    if (team.status === 'running' && await this.driver.deliver(team, message)) {
      await this.markDelivered(owner, [message.id]);
    }
    return this.get(owner);
  }
  async markDelivered(owner: string, ids: string[]): Promise<void> {
    await this.serial(async () => {
      const team = this.get(owner);
      for (const message of team.messages) if (ids.includes(message.id)) message.deliveredAt = new Date().toISOString();
      await this.save(team);
    });
  }
  /** Recovery is fail-closed: restarting a host never silently restarts model work. */
  async recover(): Promise<void> {
    await this.serial(async () => {
      for (const [owner, current] of this.table.entries()) {
        if (current.status !== 'running' && !current.tasks.some(t => t.status === 'running')) continue;
        const team = this.get(owner); team.status = 'paused';
        for (const task of team.tasks.filter(t => t.status === 'running')) {
          task.status = 'failed'; task.error = 'Host restarted during execution; inspect partial changes before retrying.';
          delete task.attemptId; task.endedAt = new Date().toISOString();
        }
        await this.save(team);
      }
    });
  }
  private kick(owner: string): void {
    if (!this.closing) void this.pump(owner).catch(error => this.report(error));
  }
  private async pump(owner: string): Promise<void> {
    const launch = await this.serial(async () => {
      if (this.closing) return [];
      const team = this.get(owner);
      if (team.status !== 'running') return [];
      const active = [...this.runs.values()].filter(r => r.owner === owner).map(r => r.task);
      const launch: Running[] = [];
      for (const task of team.tasks) {
        if (active.length >= team.maxConcurrency) break;
        if (task.status !== 'pending' || task.dependencies.some(id => team.tasks.find(t => t.id === id)?.status !== 'completed')) continue;
        if (active.some(t => t.assignee === task.assignee || scopesOverlap(t.writeScopes, task.writeScopes))) continue;
        task.status = 'running'; task.attempt++; task.attemptId = randomUUID(); task.startedAt = new Date().toISOString();
        const run: Running = { owner, task: structuredClone(task), controller: new AbortController() };
        active.push(task); launch.push(run);
      }
      if (!active.length) team.status = team.tasks.every(t => t.status === 'completed') ? 'completed' : 'blocked';
      if (launch.length || team.status !== 'running') {
        await this.save(team);
        for (const run of launch) this.runs.set(run.task.attemptId!, run);
      }
      return launch;
    });
    for (const run of launch) run.done = this.execute(run).catch(error => this.report(error));
  }
  private async execute(run: Running): Promise<void> {
    const { owner, task, controller } = run;
    const timer = setTimeout(() => controller.abort(new Error('Task deadline exceeded')), this.timeout);
    timer.unref?.();
    let output: string | undefined; let failure: string | undefined;
    try {
      controller.signal.throwIfAborted();
      const team = this.get(owner);
      const member = team.members.find(m => m.name === task.assignee)!;
      output = await this.driver.run({ team, member, task, signal: controller.signal,
        bindSession: async sessionId => {
          await this.serial(async () => {
            controller.signal.throwIfAborted();
            const latest = this.get(owner);
            if (latest.tasks.find(t => t.id === task.id)?.attemptId !== task.attemptId) throw new Error('Stale task attempt');
            latest.members.find(m => m.name === member.name)!.sessionId = sessionId;
            await this.save(latest);
          });
        },
      });
      controller.signal.throwIfAborted();
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { clearTimeout(timer); }
    try {
      const finished = await this.serial(async () => {
        const team = this.get(owner);
        const current = team.tasks.find(t => t.id === task.id);
        // Late completion cannot resurrect a stopped, retried, or replaced attempt.
        if (!current || current.status !== 'running' || current.attemptId !== task.attemptId) return;
        current.status = failure === undefined ? 'completed' : 'failed';
        current.endedAt = new Date().toISOString();
        if (failure !== undefined) current.error = bounded(failure);
        if (output !== undefined) current.output = bounded(output);
        const saved = await this.save(team);
        return { team: saved, task: structuredClone(current) };
      });
      if (finished) {
        try { this.driver.settled?.(finished.team, finished.task); } catch (error) { this.report(error); }
      }
    } finally { this.runs.delete(task.attemptId!); this.kick(owner); }
  }
  async dispose(): Promise<void> {
    this.closing = true;
    try {
      for (const [owner, team] of this.table.entries()) if (team.status === 'running') await this.stop(owner);
      await Promise.all([...this.runs.values()].map(r => r.done));
      await this.tail;
    } finally { await this.driver.dispose(); }
  }
}
