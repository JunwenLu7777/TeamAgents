import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamEngine, type EngineOptions, type Execution, type TeamDriver, type TeamTable } from '../src/engine.js';
import { TeamSchema, type Task, type Team, type TeamMessage } from '../src/model.js';

const owner = 'captain-session';
const timestamp = '2026-10-23T00:00:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Borrowed values are frozen; a rejected write never changes durable state. */
class MemoryTable implements TeamTable {
  private readonly rows = new Map<string, Team>();
  private readonly waiters: Array<{ owner: string; matches: (team: Team) => boolean; resolve: (team: Team) => void }> = [];
  failure?: { error: Error; matches: (team: Team) => boolean };

  constructor(seeds: Team[] = []) {
    for (const seed of seeds) this.rows.set(seed.ownerSessionId, freeze(structuredClone(seed)));
  }

  get(key: string): Team | undefined { return this.rows.get(key); }
  entries(): IterableIterator<[string, Team]> { return this.rows.entries(); }

  put = vi.fn(async (key: string, value: Team): Promise<void> => {
    if (this.failure?.matches(value)) {
      const { error } = this.failure;
      this.failure = undefined;
      throw error;
    }
    const saved = freeze(structuredClone(value));
    this.rows.set(key, saved);
    for (const waiter of [...this.waiters]) {
      if (waiter.owner === key && waiter.matches(saved)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(structuredClone(saved));
      }
    }
  });

  rejectNext(error: Error, matches: (team: Team) => boolean = () => true): void {
    this.failure = { error, matches };
  }

  waitFor(key: string, matches: (team: Team) => boolean): Promise<Team> {
    const current = this.get(key);
    if (current && matches(current)) return Promise.resolve(structuredClone(current));
    const barrier = deferred<Team>();
    this.waiters.push({ owner: key, matches, resolve: barrier.resolve });
    return barrier.promise;
  }
}

/** Abort notification and actual quiescence are deliberately separate barriers. */
class ControlledRun {
  private readonly completion = deferred<string>();
  private readonly abort = deferred<unknown>();
  readonly result = this.completion.promise;
  readonly aborted = this.abort.promise;
  quiescent = false;

  constructor(readonly execution: Execution) {
    const observeAbort = () => this.abort.resolve(execution.signal.reason);
    if (execution.signal.aborted) observeAbort();
    else execution.signal.addEventListener('abort', observeAbort, { once: true });
  }

  succeed(output = 'done'): void {
    if (this.quiescent) return;
    this.quiescent = true;
    this.completion.resolve(output);
  }

  fail(error: unknown): void {
    if (this.quiescent) return;
    this.quiescent = true;
    this.completion.reject(error);
  }

  acknowledgeAbort(): void {
    if (!this.execution.signal.aborted) throw new Error('Cannot acknowledge an abort before it is requested');
    this.fail(this.execution.signal.reason);
  }
}

class ControlledDriver implements TeamDriver {
  readonly calls: ControlledRun[] = [];
  private readonly waiters: Array<{ matches: (run: ControlledRun) => boolean; resolve: (run: ControlledRun) => void }> = [];
  private cleaningUp = false;
  acceptDeliveries = true;

  run = vi.fn((execution: Execution): Promise<string> => {
    const call = new ControlledRun(execution);
    this.calls.push(call);
    for (const waiter of [...this.waiters]) {
      if (waiter.matches(call)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(call);
      }
    }
    if (this.cleaningUp) call.succeed('test cleanup');
    return call.result;
  });

  deliver = vi.fn(async (team: Team, message: TeamMessage): Promise<boolean> =>
    this.acceptDeliveries && this.calls.some(call =>
      call.execution.team.ownerSessionId === team.ownerSessionId &&
      call.execution.member.name === message.to && !call.quiescent && !call.execution.signal.aborted));

  settled = vi.fn((_team: Team, _task: Task): void => {});
  dispose = vi.fn(async (): Promise<void> => {});

  waitForRun(id: string, session = owner, attempt = 1): Promise<ControlledRun> {
    const matches = (call: ControlledRun) => call.execution.task.id === id &&
      call.execution.team.ownerSessionId === session && call.execution.task.attempt === attempt;
    const existing = this.calls.find(matches);
    if (existing) return Promise.resolve(existing);
    const barrier = deferred<ControlledRun>();
    this.waiters.push({ matches, resolve: barrier.resolve });
    return barrier.promise;
  }

  releaseForCleanup(): void {
    this.cleaningUp = true;
    for (const call of this.calls) call.succeed('test cleanup');
  }
}

const fixtures: Array<{ engine: TeamEngine; table: MemoryTable; driver: ControlledDriver }> = [];

function harness(options: EngineOptions = {}, seeds: Team[] = []) {
  const table = new MemoryTable(seeds);
  const driver = new ControlledDriver();
  const changes = vi.fn<(team: Team) => void>();
  const errors = vi.fn<(error: unknown) => void>();
  const engine = new TeamEngine(table, driver, {
    ...options,
    onChange: team => { changes(team); options.onChange?.(team); },
    onError: error => { errors(error); options.onError?.(error); },
  });
  const fixture = { engine, table, driver, changes, errors };
  fixtures.push(fixture);
  return fixture;
}

type Harness = ReturnType<typeof harness>;
type PlannedTask = Pick<Task, 'id' | 'assignee'> & Partial<Pick<Task, 'subject' | 'description' | 'dependencies' | 'writeScopes'>>;

function snapshot(h: Harness, session = owner): Team {
  const state = h.engine.snapshot(session);
  if (!state) throw new Error(`Missing team for ${session}`);
  return state;
}

function taskState(h: Harness, id: string, session = owner): Task {
  const task = snapshot(h, session).tasks.find(candidate => candidate.id === id);
  if (!task) throw new Error(`Missing task ${id}`);
  return task;
}

async function plan(h: Harness, tasks: PlannedTask[], options: {
  owner?: string; workspaceId?: string; maxConcurrency?: number; members?: string[];
} = {}): Promise<Team> {
  const session = options.owner ?? owner;
  await h.engine.create(session, options.workspaceId ?? 'workspace-1', {
    name: 'Test team', goal: 'Exercise the engine', maxConcurrency: options.maxConcurrency ?? 3,
  });
  for (const name of options.members ?? ['alice', 'bob', 'carol']) {
    await h.engine.addMember(session, { name, role: `Role for ${name}` });
  }
  for (const task of tasks) {
    await h.engine.addTask(session, {
      subject: task.id, description: `Do ${task.id}`, writeScopes: [`work/${task.id}`], ...task,
    });
  }
  return snapshot(h, session);
}

function start(h: Harness, session = owner): Promise<Team> {
  return h.engine.start(session, snapshot(h, session).revision);
}

function persistedTeam(overrides: Partial<Team> = {}): Team {
  return TeamSchema.parse({
    id: 'persisted-team', ownerSessionId: owner, workspaceId: 'workspace-1',
    name: 'Recovered team', goal: 'Recover safely', maxConcurrency: 3,
    revision: 9, status: 'running', createdAt: timestamp, updatedAt: timestamp,
    members: [{ name: 'alice', role: 'Engineer', sessionId: 'old-session' }, { name: 'bob', role: 'Reviewer' }],
    tasks: [
      { id: 'work', subject: 'Work', description: 'Do work', assignee: 'alice', dependencies: [],
        writeScopes: ['src/work.ts'], status: 'running', attempt: 2, attemptId: 'old-attempt', startedAt: timestamp },
      { id: 'next', subject: 'Next', description: 'Do next', assignee: 'bob', dependencies: ['work'],
        writeScopes: ['docs/next.md'], status: 'pending', attempt: 0 },
    ], messages: [], ...overrides,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) {
    fixture.table.failure = undefined;
    fixture.driver.releaseForCleanup();
    await fixture.engine.dispose();
  }
});

describe('approval and plan editing', () => {
  it('keeps creation, edits, and messages in draft without executing a model', async () => {
    const h = harness();
    const draft = await plan(h, [{ id: 'a', assignee: 'alice' }]);
    expect(draft).toMatchObject({ status: 'draft', ownerSessionId: owner, workspaceId: 'workspace-1' });
    expect(draft.revision).toBe(5);
    await h.engine.updateTask(owner, 'a', { subject: 'Revised work' });
    const queued = await h.engine.message(owner, 'captain', 'alice', 'Read this before starting');
    expect(queued.status).toBe('draft');
    expect(queued.tasks[0]).toMatchObject({ status: 'pending', attempt: 0, subject: 'Revised work' });
    expect(queued.messages[0]?.deliveredAt).toBeUndefined();
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(h.driver.deliver).not.toHaveBeenCalled();
  });

  it('rejects stale approval and starts only the current revision', async () => {
    const h = harness();
    const old = await plan(h, [{ id: 'a', assignee: 'alice' }]);
    const current = await h.engine.updateTask(owner, 'a', { description: 'Changed plan' });
    await expect(h.engine.start(owner, old.revision)).rejects.toThrow('Plan changed');
    expect(snapshot(h)).toEqual(current);
    expect(h.driver.run).not.toHaveBeenCalled();
    const approved = await h.engine.start(owner, current.revision);
    expect(approved).toMatchObject({ status: 'running', revision: current.revision + 1 });
    const run = await h.driver.waitForRun('a');
    expect(run.execution.task).toMatchObject({ status: 'running', attempt: 1, description: 'Changed plan' });
    expect(run.execution.task.attemptId).toEqual(expect.any(String));
    await expect(start(h)).rejects.toThrow('already running');
    expect(h.driver.run).toHaveBeenCalledTimes(1);
  });

  it('cannot approve an empty plan or completed work', async () => {
    const h = harness();
    await plan(h, []);
    await expect(start(h)).rejects.toThrow('No pending tasks');
    await h.engine.addTask(owner, { id: 'a', subject: 'A', description: 'Do A', assignee: 'alice' });
    await start(h);
    (await h.driver.waitForRun('a')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
    await expect(start(h)).rejects.toThrow('No pending tasks');
    await expect(h.engine.retry(owner, 'a')).rejects.toThrow('Only failed tasks');
  });

  it('rejects duplicate teams, duplicate members, and operations on unknown owners', async () => {
    const h = harness();
    await plan(h, []);
    const before = h.table.get(owner);
    await expect(h.engine.create(owner, 'workspace-2', { name: 'Other', goal: 'Other' })).rejects.toThrow('already has a team');
    await expect(h.engine.addMember(owner, { name: 'alice', role: 'Duplicate' })).rejects.toThrow('already exists');
    await expect(h.engine.addMember('unknown', { name: 'alice', role: 'Engineer' })).rejects.toThrow('No team');
    expect(h.engine.snapshot('unknown')).toBeNull();
    expect(h.engine.identity('unknown')).toBeUndefined();
    expect(h.table.get(owner)).toBe(before);
  });

  it('rejects plan edits and retry while running', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'alice' }]);
    await start(h);
    await h.driver.waitForRun('a');
    const before = h.table.get(owner);
    await expect(h.engine.addMember(owner, { name: 'dave', role: 'Engineer' })).rejects.toThrow('Stop the team');
    await expect(h.engine.addTask(owner, { id: 'c', subject: 'C', description: 'C', assignee: 'bob' })).rejects.toThrow('Stop the team');
    await expect(h.engine.updateTask(owner, 'b', { subject: 'Changed' })).rejects.toThrow('Stop the team');
    await expect(h.engine.retry(owner, 'a')).rejects.toThrow('Stop the team');
    expect(h.table.get(owner)).toBe(before);
  });

  it('patches only supplied fields and preserves omitted dependencies and write scopes', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' },
      { id: 'b', assignee: 'bob', dependencies: ['a'], writeScopes: ['docs/b.md'] },
    ]);
    const before = taskState(h, 'b');
    await h.engine.updateTask(owner, 'b', { subject: 'Revised subject' });
    expect(taskState(h, 'b')).toEqual({ ...before, subject: 'Revised subject' });
  });

  it('allows explicitly clearing task dependencies and write scopes', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' },
      { id: 'b', assignee: 'bob', dependencies: ['a'], writeScopes: ['docs/b.md'] },
    ]);
    await h.engine.updateTask(owner, 'b', { dependencies: [], writeScopes: [] });
    expect(taskState(h, 'b')).toMatchObject({ dependencies: [], writeScopes: [], subject: 'b' });
  });

  it('deduplicates dependencies when adding a task', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob', dependencies: ['a', 'a'] }]);
    expect(taskState(h, 'b').dependencies).toEqual(['a']);
  });

  it.each([
    { input: { id: 'a', assignee: 'alice' }, error: 'Duplicate task id' },
    { input: { id: 'b', assignee: 'unknown' }, error: 'Unknown member: unknown' },
    { input: { id: 'b', assignee: 'bob', dependencies: ['missing'] }, error: 'Unknown dependency: missing' },
    { input: { id: 'b', assignee: 'bob', dependencies: ['b'] }, error: 'dependency cycle' },
  ])('rejects invalid task graphs atomically: $error', async ({ input, error }) => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    const before = h.table.get(owner);
    const writes = h.table.put.mock.calls.length;
    await expect(h.engine.addTask(owner, { subject: 'Work', description: 'Details', ...input })).rejects.toThrow(error);
    expect(h.table.get(owner)).toBe(before);
    expect(h.table.put).toHaveBeenCalledTimes(writes);
    expect(h.driver.run).not.toHaveBeenCalled();
  });

  it('rejects a cycle introduced by a task update without saving the patch', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob', dependencies: ['a'] }]);
    const before = h.table.get(owner);
    await expect(h.engine.updateTask(owner, 'a', { dependencies: ['b'] })).rejects.toThrow('dependency cycle');
    expect(h.table.get(owner)).toBe(before);
  });

  it('validates a persisted graph again when approval is requested', async () => {
    const seed = persistedTeam({ status: 'draft' });
    seed.tasks[0]!.status = 'pending';
    seed.tasks[0]!.dependencies = ['next'];
    const h = harness({}, [seed]);
    await expect(start(h)).rejects.toThrow('dependency cycle');
    expect(h.table.put).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
  });

  it.each(['../outside', '/absolute/file', 'src/../escape', 'src//file', './src', 'src\\file'])
    ('rejects unsafe workspace scope %s before saving or launching', async writeScope => {
      const h = harness();
      await plan(h, [{ id: 'a', assignee: 'alice' }]);
      const before = h.table.get(owner);
      await expect(h.engine.addTask(owner, {
        id: 'b', subject: 'B', description: 'B', assignee: 'bob', writeScopes: [writeScope],
      })).rejects.toThrow(/workspace-relative/);
      await expect(h.engine.updateTask(owner, 'a', { writeScopes: [writeScope] })).rejects.toThrow(/workspace-relative/);
      expect(h.table.get(owner)).toBe(before);
      expect(h.driver.run).not.toHaveBeenCalled();
    });

  it('returns isolated snapshots and gives onChange an isolated value', async () => {
    const h = harness({ onChange: team => { team.name = 'Changed by observer'; team.members.length = 0; } });
    const created = await h.engine.create(owner, 'workspace-1', { name: 'Original', goal: 'Goal' });
    created.name = 'Changed by caller';
    const member = await h.engine.addMember(owner, { name: 'alice', role: 'Engineer' });
    member.members[0]!.role = 'Changed by caller';
    const copy = snapshot(h);
    copy.members.length = 0;
    expect(snapshot(h)).toMatchObject({ name: 'Original', members: [{ name: 'alice', role: 'Engineer' }] });
  });

  it('reports observer errors without undoing a successful durable write', async () => {
    const error = new Error('Observer failed');
    const h = harness({ onChange: () => { throw error; } });
    const created = await h.engine.create(owner, 'workspace-1', { name: 'Team', goal: 'Goal' });
    expect(snapshot(h)).toEqual(created);
    expect(h.errors).toHaveBeenCalledWith(error);
  });
});

describe('task scheduling', () => {
  it('launches disjoint tasks for different members in parallel', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob' }], { maxConcurrency: 2 });
    await start(h);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('b')]);
    expect(a.quiescent).toBe(false);
    expect(b.quiescent).toBe(false);
    expect(taskState(h, 'a').status).toBe('running');
    expect(taskState(h, 'b').status).toBe('running');
    expect(a.execution.task.attemptId).not.toBe(b.execution.task.attemptId);
    a.succeed('A output');
    b.succeed('B output');
    const completed = await h.table.waitFor(owner, team => team.status === 'completed');
    expect(completed.tasks.map(task => task.output)).toEqual(['A output', 'B output']);
    expect(h.driver.settled).toHaveBeenCalledTimes(2);
  });

  it('holds the concurrency limit and fills a free slot before other work finishes', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob' }, { id: 'c', assignee: 'carol' },
    ], { maxConcurrency: 2 });
    await start(h);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('b')]);
    expect(h.driver.run).toHaveBeenCalledTimes(2);
    expect(taskState(h, 'c').status).toBe('pending');
    b.succeed();
    const c = await h.driver.waitForRun('c');
    expect(a.quiescent).toBe(false);
    expect(taskState(h, 'a').status).toBe('running');
    a.succeed();
    c.succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it('serializes one member while allowing another member to run', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'alice' }, { id: 'c', assignee: 'bob' },
    ]);
    await start(h);
    const [a, c] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('c')]);
    expect(h.driver.run).toHaveBeenCalledTimes(2);
    expect(taskState(h, 'b').status).toBe('pending');
    a.succeed();
    const b = await h.driver.waitForRun('b');
    expect(c.quiescent).toBe(false);
    b.succeed();
    c.succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it.each([
    { first: 'src/file.ts', second: 'src/file.ts' },
    { first: 'src', second: 'src/nested/file.ts' },
    { first: 'src/nested/file.ts', second: 'src' },
    { first: '.', second: 'docs/file.md' },
  ])('serializes overlapping scopes $first and $second across members', async ({ first, second }) => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice', writeScopes: [first] },
      { id: 'b', assignee: 'bob', writeScopes: [second] },
    ]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    expect(taskState(h, 'b').status).toBe('pending');
    expect(h.driver.run).toHaveBeenCalledTimes(1);
    a.succeed();
    (await h.driver.waitForRun('b')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it('does not confuse a shared path prefix with an overlapping directory', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice', writeScopes: ['src'] },
      { id: 'b', assignee: 'bob', writeScopes: ['src-old'] },
    ]);
    await start(h);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('b')]);
    expect(a.quiescent).toBe(false);
    expect(b.quiescent).toBe(false);
    a.succeed();
    b.succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it('executes a dependency chain in order', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' },
      { id: 'b', assignee: 'bob', dependencies: ['a'] },
      { id: 'c', assignee: 'carol', dependencies: ['b'] },
    ]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    expect(h.driver.calls.map(call => call.execution.task.id)).toEqual(['a']);
    a.succeed('Prerequisite');
    const b = await h.driver.waitForRun('b');
    expect(taskState(h, 'a')).toMatchObject({ status: 'completed', output: 'Prerequisite' });
    expect(taskState(h, 'c').status).toBe('pending');
    b.succeed();
    (await h.driver.waitForRun('c')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
    expect(h.driver.calls.map(call => call.execution.task.id)).toEqual(['a', 'b', 'c']);
  });

  it('waits for every dependency before launching a join task', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob' },
      { id: 'join', assignee: 'carol', dependencies: ['a', 'b'] },
    ]);
    await start(h);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('b')]);
    a.succeed();
    await h.table.waitFor(owner, team => team.tasks.find(task => task.id === 'a')?.status === 'completed');
    expect(taskState(h, 'join').status).toBe('pending');
    expect(h.driver.run).toHaveBeenCalledTimes(2);
    b.succeed();
    (await h.driver.waitForRun('join')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it('leaves dependents pending after failure and finishes unrelated work before becoming blocked', async () => {
    const h = harness();
    await plan(h, [
      { id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob', dependencies: ['a'] },
      { id: 'c', assignee: 'carol' },
    ]);
    await start(h);
    const [a, c] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('c')]);
    a.fail(new Error('Build failed'));
    await h.table.waitFor(owner, team => team.tasks.find(task => task.id === 'a')?.status === 'failed');
    expect(snapshot(h).status).toBe('running');
    expect(taskState(h, 'b')).toMatchObject({ status: 'pending', attempt: 0 });
    expect(c.quiescent).toBe(false);
    c.succeed();
    const blocked = await h.table.waitFor(owner, team => team.status === 'blocked');
    expect(blocked.tasks.map(task => task.status)).toEqual(['failed', 'pending', 'completed']);
    expect(taskState(h, 'a').error).toBe('Build failed');
    expect(h.driver.calls.map(call => call.execution.task.id)).toEqual(['a', 'c']);
  });

  it('bounds outputs and handles non-Error failures', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob' }]);
    await start(h);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('b')]);
    a.succeed('a'.repeat(50_001));
    b.fail('b'.repeat(50_001));
    await h.table.waitFor(owner, team => team.status === 'blocked');
    expect(taskState(h, 'a').output).toBe('a'.repeat(50_000) + '\n[Output truncated at 50,000 characters]');
    expect(taskState(h, 'b').error).toBe('b'.repeat(50_000) + '\n[Output truncated at 50,000 characters]');
  });
});

describe('retry, stop, timeout, and recovery', () => {
  it('requires fresh approval after retry, retains attempt history, and then unblocks dependents', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob', dependencies: ['a'] }]);
    await start(h);
    const first = await h.driver.waitForRun('a');
    first.fail(new Error('Try again'));
    await h.table.waitFor(owner, team => team.status === 'blocked');
    const failed = taskState(h, 'a');
    expect(failed).toMatchObject({ status: 'failed', attempt: 1, error: 'Try again', endedAt: expect.any(String) });
    const retried = await h.engine.retry(owner, 'a');
    expect(retried.status).toBe('draft');
    expect(taskState(h, 'a')).toMatchObject({ status: 'pending', attempt: 1, writeScopes: ['work/a'] });
    for (const field of ['attemptId', 'output', 'error', 'startedAt', 'endedAt']) {
      expect(taskState(h, 'a')).not.toHaveProperty(field);
    }
    expect(h.driver.run).toHaveBeenCalledTimes(1);
    await expect(h.engine.updateTask(owner, 'a', { subject: 'Change attempted work' })).rejects.toThrow('never-started');
    await expect(h.engine.retry(owner, 'b')).rejects.toThrow('Only failed tasks');
    await expect(h.engine.retry(owner, 'missing')).rejects.toThrow('Only failed tasks');
    await expect(h.engine.start(owner, retried.revision - 1)).rejects.toThrow('Plan changed');
    expect(h.driver.run).toHaveBeenCalledTimes(1);
    await h.engine.start(owner, retried.revision);
    const second = await h.driver.waitForRun('a', owner, 2);
    expect(second.execution.task.attemptId).not.toBe(first.execution.task.attemptId);
    second.succeed('Recovered');
    (await h.driver.waitForRun('b')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
    expect(taskState(h, 'a')).toMatchObject({ status: 'completed', attempt: 2, output: 'Recovered' });
  });

  it('waits for stop quiescence, blocks restart meanwhile, and discards stale completion', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob', dependencies: ['a'] }]);
    await start(h);
    const first = await h.driver.waitForRun('a');
    await first.execution.bindSession('first-session');
    let stopResolved = false;
    const stopping = h.engine.stop(owner).then(team => { stopResolved = true; return team; });
    expect(await first.aborted).toEqual(new Error('Team stopped'));
    const paused = snapshot(h);
    expect(paused.status).toBe('paused');
    expect(taskState(h, 'a')).toMatchObject({ status: 'failed', error: expect.stringContaining('Stopped.') });
    expect(taskState(h, 'a')).not.toHaveProperty('attemptId');
    expect(stopResolved).toBe(false);
    await expect(h.engine.retry(owner, 'a')).rejects.toThrow('Previous attempt is still stopping');
    await expect(start(h)).rejects.toThrow('Previous execution is still stopping');
    expect(stopResolved).toBe(false);
    first.succeed('Late output must not overwrite the stopped attempt');
    await expect(stopping).resolves.toEqual(paused);
    expect(snapshot(h)).toEqual(paused);
    expect(taskState(h, 'a')).not.toHaveProperty('output');
    expect(taskState(h, 'b')).toMatchObject({ status: 'pending', attempt: 0 });
    expect(h.driver.settled).not.toHaveBeenCalled();
    expect(h.driver.run).toHaveBeenCalledTimes(1);

    await h.engine.retry(owner, 'a');
    expect(h.driver.run).toHaveBeenCalledTimes(1);
    await start(h);
    const second = await h.driver.waitForRun('a', owner, 2);
    await second.execution.bindSession('second-session');
    await expect(first.execution.bindSession('stale-session')).rejects.toThrow('Team stopped');
    expect(h.engine.identity('first-session')).toBeUndefined();
    expect(h.engine.identity('stale-session')).toBeUndefined();
    expect(h.engine.identity('second-session')).toEqual({ owner, member: 'alice' });
    second.succeed('Fresh output');
    (await h.driver.waitForRun('b')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
    expect(taskState(h, 'a').output).toBe('Fresh output');
  });

  it('waits for every concurrent execution to become quiescent when stopped', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob' }]);
    await start(h);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('b')]);
    let stopResolved = false;
    const stopping = h.engine.stop(owner).then(team => { stopResolved = true; return team; });
    await Promise.all([a.aborted, b.aborted]);
    a.acknowledgeAbort();
    // A queued operation is a deterministic barrier while B still owns its writes.
    await h.engine.message(owner, 'captain', 'bob', 'Stop requested');
    expect(stopResolved).toBe(false);
    b.acknowledgeAbort();
    await stopping;
    expect(stopResolved).toBe(true);
    expect(snapshot(h).tasks.every(task => task.status === 'failed')).toBe(true);
  });

  it('aborts at the deadline but holds the member lock until the driver reaches quiescence', async () => {
    vi.useFakeTimers();
    const h = harness({ taskTimeoutMs: 1_000 });
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'alice' }]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    await vi.advanceTimersByTimeAsync(999);
    expect(a.execution.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await a.aborted).toEqual(new Error('Task deadline exceeded'));
    expect(taskState(h, 'a').status).toBe('running');
    expect(taskState(h, 'b').status).toBe('pending');
    expect(h.driver.run).toHaveBeenCalledTimes(1);
    a.acknowledgeAbort();
    const b = await h.driver.waitForRun('b');
    expect(taskState(h, 'a')).toMatchObject({ status: 'failed', error: 'Task deadline exceeded' });
    expect(b.execution.signal.aborted).toBe(false);
    b.succeed();
    await h.table.waitFor(owner, team => team.status === 'blocked');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers persisted executions as paused failures and never automatically restarts them', async () => {
    const seed = persistedTeam();
    const h = harness({}, [seed]);
    await h.engine.recover();
    const recovered = snapshot(h);
    expect(recovered).toMatchObject({ status: 'paused', revision: seed.revision + 1 });
    expect(taskState(h, 'work')).toMatchObject({
      status: 'failed', attempt: 2, startedAt: timestamp,
      error: expect.stringContaining('Host restarted'), endedAt: expect.any(String),
    });
    expect(taskState(h, 'work')).not.toHaveProperty('attemptId');
    expect(taskState(h, 'next')).toEqual(seed.tasks[1]);
    expect(h.engine.identity('old-session')).toEqual({ owner, member: 'alice' });
    expect(h.driver.run).not.toHaveBeenCalled();
    await h.engine.recover();
    expect(snapshot(h)).toEqual(recovered);
    await h.engine.retry(owner, 'work');
    expect(snapshot(h).status).toBe('draft');
    expect(h.driver.run).not.toHaveBeenCalled();
    await start(h);
    (await h.driver.waitForRun('work', owner, 3)).succeed();
    (await h.driver.waitForRun('next')).succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it('recovers inconsistent running tasks and running plans while preserving untouched teams', async () => {
    const orphan = persistedTeam({ status: 'draft' });
    const approvedOnly = persistedTeam({ ownerSessionId: 'approved-owner' });
    approvedOnly.tasks = approvedOnly.tasks.map(task => ({ ...task, status: 'pending', attempt: 0, attemptId: undefined }));
    const untouched = persistedTeam({ ownerSessionId: 'quiet-owner', status: 'draft', tasks: [] });
    const h = harness({}, [orphan, approvedOnly, untouched]);
    const quietReference = h.table.get('quiet-owner');
    await h.engine.recover();
    expect(snapshot(h).status).toBe('paused');
    expect(taskState(h, 'work').status).toBe('failed');
    expect(snapshot(h, 'approved-owner').status).toBe('paused');
    expect(snapshot(h, 'approved-owner').tasks.every(task => task.status === 'pending')).toBe(true);
    expect(h.table.get('quiet-owner')).toBe(quietReference);
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(h.table.put).toHaveBeenCalledTimes(2);
  });

  it('disposes only after aborting and draining work, and refuses new mutations during shutdown', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    const disposing = h.engine.dispose();
    await a.aborted;
    expect(h.driver.dispose).not.toHaveBeenCalled();
    await expect(h.engine.create('new-owner', 'workspace-1', { name: 'New', goal: 'Goal' })).rejects.toThrow('shutting down');
    await expect(h.engine.message(owner, 'captain', 'alice', 'Too late')).rejects.toThrow('shutting down');
    a.acknowledgeAbort();
    await disposing;
    expect(h.driver.dispose).toHaveBeenCalledTimes(1);
    expect(snapshot(h).status).toBe('paused');
  });
});

describe('durable write atomicity', () => {
  it('does not create a team or notify observers when the first write fails', async () => {
    const h = harness();
    const error = new Error('Disk full');
    h.table.rejectNext(error);
    await expect(h.engine.create(owner, 'workspace-1', { name: 'Team', goal: 'Goal' })).rejects.toBe(error);
    expect(h.engine.snapshot(owner)).toBeNull();
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
    const created = await h.engine.create(owner, 'workspace-1', { name: 'Team', goal: 'Goal' });
    expect(created.revision).toBe(1);
  });

  it('does not mutate borrowed state on rejected edits, approval, or mailbox writes', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    const queued = await h.engine.message(owner, 'captain', 'alice', 'Queued');
    const messageId = queued.messages[0]!.id;
    const actions = [
      () => h.engine.addMember(owner, { name: 'dave', role: 'Engineer' }),
      () => h.engine.addTask(owner, { id: 'b', subject: 'B', description: 'B', assignee: 'bob' }),
      () => h.engine.updateTask(owner, 'a', { subject: 'Not persisted' }),
      () => start(h),
      () => h.engine.stop(owner),
      () => h.engine.message(owner, 'captain', 'alice', 'Not persisted'),
      () => h.engine.markDelivered(owner, [messageId]),
    ];
    for (const action of actions) {
      const before = h.table.get(owner);
      const value = structuredClone(before);
      const notifications = h.changes.mock.calls.length;
      const error = new Error('Write rejected');
      h.table.rejectNext(error);
      await expect(action()).rejects.toBe(error);
      expect(h.table.get(owner)).toBe(before);
      expect(h.table.get(owner)).toEqual(value);
      expect(h.changes).toHaveBeenCalledTimes(notifications);
      expect(h.driver.run).not.toHaveBeenCalled();
      expect(h.driver.deliver).not.toHaveBeenCalled();
    }
    // A rejected writer must not poison later operations in the serialized queue.
    await h.engine.updateTask(owner, 'a', { subject: 'Persisted' });
    expect(taskState(h, 'a').subject).toBe('Persisted');
  });

  it('does not launch or increment durable attempts if saving the scheduled tasks fails', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob' }]);
    const error = new Error('Cannot persist launch');
    h.table.rejectNext(error, team => team.tasks.some(task => task.status === 'running'));
    const approved = await start(h);
    await vi.waitFor(() => expect(h.errors).toHaveBeenCalledWith(error));
    expect(snapshot(h)).toEqual(approved);
    expect(snapshot(h).tasks.every(task => task.status === 'pending' && task.attempt === 0)).toBe(true);
    expect(h.driver.run).not.toHaveBeenCalled();
  });

  it('does not abort live work when persisting the stop fails', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    const before = h.table.get(owner);
    const error = new Error('Cannot persist stop');
    h.table.rejectNext(error);
    await expect(h.engine.stop(owner)).rejects.toBe(error);
    expect(h.table.get(owner)).toBe(before);
    expect(a.execution.signal.aborted).toBe(false);
    a.succeed('Still authorized');
    await h.table.waitFor(owner, team => team.status === 'completed');
    expect(taskState(h, 'a').output).toBe('Still authorized');
  });

  it('preserves failed attempt details if persisting retry fails', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    (await h.driver.waitForRun('a')).fail(new Error('Original failure'));
    await h.table.waitFor(owner, team => team.status === 'blocked');
    const before = h.table.get(owner);
    const error = new Error('Cannot persist retry');
    h.table.rejectNext(error);
    await expect(h.engine.retry(owner, 'a')).rejects.toBe(error);
    expect(h.table.get(owner)).toBe(before);
    expect(taskState(h, 'a')).toMatchObject({ status: 'failed', error: 'Original failure', attempt: 1 });
    expect(h.driver.run).toHaveBeenCalledTimes(1);
  });

  it('does not bind a session when persistence fails', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    const before = h.table.get(owner);
    const error = new Error('Cannot persist session');
    h.table.rejectNext(error);
    await expect(a.execution.bindSession('not-bound')).rejects.toBe(error);
    expect(h.table.get(owner)).toBe(before);
    expect(h.engine.identity('not-bound')).toBeUndefined();
    await a.execution.bindSession('bound-session');
    expect(h.engine.identity('bound-session')).toEqual({ owner, member: 'alice' });
  });

  it('does not partially alter a team when recovery persistence fails', async () => {
    const seed = persistedTeam();
    const h = harness({}, [seed]);
    const before = h.table.get(owner);
    const error = new Error('Cannot persist recovery');
    h.table.rejectNext(error);
    await expect(h.engine.recover()).rejects.toBe(error);
    expect(h.table.get(owner)).toBe(before);
    expect(snapshot(h)).toEqual(seed);
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
    await h.engine.recover();
    expect(snapshot(h).status).toBe('paused');
  });
});

describe('mailboxes and session isolation', () => {
  it('queues draft messages and exposes them to the eventual recipient execution', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    const queued = await h.engine.message(owner, 'captain', 'alice', '  Prepare carefully  ');
    const message = queued.messages[0]!;
    expect(message).toMatchObject({ from: 'captain', to: 'alice', text: 'Prepare carefully', createdAt: expect.any(String) });
    expect(message.deliveredAt).toBeUndefined();
    expect(h.driver.deliver).not.toHaveBeenCalled();
    expect(h.driver.run).not.toHaveBeenCalled();
    await start(h);
    const a = await h.driver.waitForRun('a');
    expect(a.execution.team.messages).toEqual([message]);
    await h.engine.markDelivered(owner, [message.id]);
    expect(snapshot(h).messages[0]?.deliveredAt).toEqual(expect.any(String));
  });

  it('persists a message before live delivery and marks only accepted messages delivered', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    await h.driver.waitForRun('a');
    h.driver.deliver.mockImplementationOnce(async (_team, message) => {
      expect(h.table.get(owner)?.messages.find(candidate => candidate.id === message.id)).toEqual(message);
      expect(message.deliveredAt).toBeUndefined();
      return true;
    });
    const delivered = await h.engine.message(owner, 'captain', 'alice', 'Live update');
    expect(delivered.messages[0]?.deliveredAt).toEqual(expect.any(String));
    h.driver.acceptDeliveries = false;
    const queued = await h.engine.message(owner, 'bob', 'alice', 'Delivery unavailable');
    expect(queued.messages[1]?.deliveredAt).toBeUndefined();
    expect(h.driver.deliver).toHaveBeenCalledTimes(2);
    await h.engine.markDelivered(owner, [queued.messages[1]!.id, 'unknown-message']);
    expect(snapshot(h).messages.every(message => typeof message.deliveredAt === 'string')).toBe(true);
  });

  it('keeps mail for a non-running member queued until it is consumed', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }, { id: 'b', assignee: 'bob', dependencies: ['a'] }]);
    await start(h);
    const a = await h.driver.waitForRun('a');
    const queued = await h.engine.message(owner, 'alice', 'bob', 'Results for your task');
    const message = queued.messages[0]!;
    expect(message.deliveredAt).toBeUndefined();
    expect(h.driver.deliver).toHaveBeenCalledTimes(1);
    a.succeed();
    const b = await h.driver.waitForRun('b');
    expect(b.execution.team.messages).toContainEqual(message);
    expect(snapshot(h).messages[0]?.deliveredAt).toBeUndefined();
    await h.engine.markDelivered(owner, [message.id]);
    expect(snapshot(h).messages[0]?.deliveredAt).toEqual(expect.any(String));
    b.succeed();
    await h.table.waitFor(owner, team => team.status === 'completed');
  });

  it('retains queued mail after a driver delivery error', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    await h.driver.waitForRun('a');
    const error = new Error('Recipient temporarily unavailable');
    h.driver.deliver.mockRejectedValueOnce(error);
    await expect(h.engine.message(owner, 'captain', 'alice', 'Keep this')).rejects.toBe(error);
    expect(snapshot(h).messages).toHaveLength(1);
    expect(snapshot(h).messages[0]).toMatchObject({ text: 'Keep this' });
    expect(snapshot(h).messages[0]?.deliveredAt).toBeUndefined();
  });

  it('does not deliver a message that could not be persisted', async () => {
    const h = harness();
    await plan(h, [{ id: 'a', assignee: 'alice' }]);
    await start(h);
    await h.driver.waitForRun('a');
    const before = h.table.get(owner);
    const error = new Error('Cannot persist mailbox');
    h.table.rejectNext(error);
    await expect(h.engine.message(owner, 'captain', 'alice', 'Unsaved')).rejects.toBe(error);
    expect(h.table.get(owner)).toBe(before);
    expect(h.driver.deliver).not.toHaveBeenCalled();
  });

  it('rejects unknown mailbox participants and empty messages atomically', async () => {
    const h = harness();
    await plan(h, []);
    const before = h.table.get(owner);
    await expect(h.engine.message(owner, 'unknown', 'alice', 'Message')).rejects.toThrow('Unknown member');
    await expect(h.engine.message(owner, 'alice', 'unknown', 'Message')).rejects.toThrow('Unknown member');
    await expect(h.engine.message(owner, 'alice', 'captain', ' ')).rejects.toThrow();
    expect(h.table.get(owner)).toBe(before);
    expect(h.driver.deliver).not.toHaveBeenCalled();
    expect((await h.engine.message(owner, 'alice', 'captain', 'Report')).messages[0]?.to).toBe('captain');
  });

  it('refuses to evict undelivered mail from a full mailbox', async () => {
    const messages = Array.from({ length: 500 }, (_, i) => ({
      id: `message-${i}`, from: 'captain', to: 'alice', text: `Message ${i}`, createdAt: timestamp,
    }));
    const h = harness({}, [persistedTeam({ status: 'draft', tasks: [], messages })]);
    const before = h.table.get(owner);
    await expect(h.engine.message(owner, 'captain', 'alice', 'Overflow')).rejects.toThrow('Mailbox is full');
    expect(h.table.get(owner)).toBe(before);
    expect(h.table.put).not.toHaveBeenCalled();
  });

  it('evicts the first delivered message while preserving queued mail at capacity', async () => {
    const messages: TeamMessage[] = Array.from({ length: 500 }, (_, i) => ({
      id: `message-${i}`, from: 'captain', to: 'alice', text: `Message ${i}`, createdAt: timestamp,
      ...(i === 17 || i === 24 ? { deliveredAt: timestamp } : {}),
    }));
    const h = harness({}, [persistedTeam({ status: 'draft', tasks: [], messages })]);
    const result = await h.engine.message(owner, 'captain', 'alice', 'New message');
    expect(result.messages).toHaveLength(500);
    expect(result.messages.some(message => message.id === 'message-17')).toBe(false);
    expect(result.messages.slice(0, -1)).toEqual(messages.filter(message => message.id !== 'message-17'));
    expect(result.messages.at(-1)).toMatchObject({ text: 'New message' });
  });

  it('isolates same-named tasks, members, scope locks, bindings, mailboxes, and stop across sessions', async () => {
    const h = harness();
    const other = 'other-captain-session';
    const tasks = [{ id: 'a', assignee: 'alice', writeScopes: ['src'] }];
    await plan(h, tasks, { maxConcurrency: 1, workspaceId: 'workspace-1' });
    await plan(h, tasks, { owner: other, maxConcurrency: 1, workspaceId: 'workspace-2' });
    await Promise.all([start(h), start(h, other)]);
    const [a, b] = await Promise.all([h.driver.waitForRun('a'), h.driver.waitForRun('a', other)]);
    expect(a.quiescent).toBe(false);
    expect(b.quiescent).toBe(false);
    expect(a.execution.team.id).not.toBe(b.execution.team.id);
    await a.execution.bindSession('session-a');
    await b.execution.bindSession('session-b');
    expect(h.engine.identity('session-a')).toEqual({ owner, member: 'alice' });
    expect(h.engine.identity('session-b')).toEqual({ owner: other, member: 'alice' });
    await h.engine.message(owner, 'captain', 'alice', 'Only for A');
    expect(snapshot(h, other).messages).toEqual([]);
    const stopping = h.engine.stop(owner);
    await a.aborted;
    expect(b.execution.signal.aborted).toBe(false);
    a.acknowledgeAbort();
    await stopping;
    expect(b.quiescent).toBe(false);
    expect(snapshot(h).status).toBe('paused');
    expect(snapshot(h, other).status).toBe('running');
    b.succeed('B completed independently');
    await h.table.waitFor(other, team => team.status === 'completed');
    expect(taskState(h, 'a', other).output).toBe('B completed independently');
    expect(taskState(h, 'a').status).toBe('failed');
  });
});
