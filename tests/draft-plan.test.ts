import { describe, expect, it, vi } from 'vitest';
import { TeamEngine, type TeamDriver, type TeamTable } from '../src/engine.js';
import { TeamPlanSchema, TeamSchema, planOf, type Team, type TeamPlan } from '../src/model.js';

function draft(): TeamPlan {
  return { name: 'Analysis team', goal: 'Inspect the project without changing it', maxConcurrency: 2,
    members: [{ name: 'researcher', role: 'Research' }, { name: 'reviewer', role: 'Review' }],
    // Browser editors can submit a complete DAG in any display order.
    tasks: [
      { id: 'summary', subject: 'Summarize', description: 'Summarize verified findings', assignee: 'reviewer', dependencies: ['inspect'], writeScopes: [] },
      { id: 'inspect', subject: 'Inspect', description: 'Read the project', assignee: 'researcher', dependencies: [], writeScopes: [] },
    ],
  };
}
function setup(seed?: Team) {
  const rows = new Map<string, Team>();
  if (seed) rows.set(seed.ownerSessionId, structuredClone(seed));
  const table: TeamTable = {
    get: key => rows.get(key), entries: () => rows.entries(),
    put: vi.fn(async (key, value) => { rows.set(key, structuredClone(value)); }),
  };
  const driver: TeamDriver = { run: vi.fn(async () => 'done'), deliver: vi.fn(async () => false), dispose: vi.fn(async () => {}) };
  const engine = new TeamEngine(table, driver);
  return { engine, rows, table, driver };
}
function seed(overrides: Partial<Team> = {}): Team {
  return TeamSchema.parse({ ...draft(), id: 'saved-team', ownerSessionId: 'captain', workspaceId: 'workspace',
    revision: 4, status: 'draft', createdAt: 'created', updatedAt: 'updated', messages: [],
    tasks: draft().tasks.map(task => ({ ...task, status: 'pending', attempt: 0 })), ...overrides });
}

describe('visual plan boundary', () => {
  it('creates a whole draft atomically in arbitrary DAG display order without executing models', async () => {
    const { engine, table, driver } = setup();
    const result = await engine.savePlan('captain', 'workspace', null, draft());
    expect(result).toMatchObject({ status: 'draft', revision: 1, ownerSessionId: 'captain' });
    expect(result.tasks.every(task => task.attempt === 0 && task.status === 'pending')).toBe(true);
    expect(table.put).toHaveBeenCalledOnce(); expect(driver.run).not.toHaveBeenCalled();
    await engine.dispose();
  });
  it('preserves identity and audit messages while replacing an unstarted plan', async () => {
    const before = seed({ messages: [{ id: 'm', from: 'captain', to: 'researcher', text: 'Keep this guidance', createdAt: 'now' }] });
    const { engine, table } = setup(before);
    const plan = { ...draft(), name: 'Updated name', maxConcurrency: 3 };
    const result = await engine.savePlan('captain', 'workspace', before.revision, plan);
    expect(result).toMatchObject({ id: before.id, createdAt: before.createdAt, revision: 5, name: plan.name, maxConcurrency: 3 });
    expect(result.messages).toEqual(before.messages); expect(table.put).toHaveBeenCalledOnce();
    expect(planOf(result)).toEqual(plan);
    await engine.dispose();
  });
  it('rejects a stale save instead of overwriting another tab or chat edit', async () => {
    const { engine, table } = setup(seed());
    await expect(engine.savePlan('captain', 'workspace', 3, draft())).rejects.toThrow('Plan changed');
    await expect(engine.savePlan('captain', 'workspace', null, draft())).rejects.toThrow('Plan changed');
    expect(table.put).not.toHaveBeenCalled(); expect(engine.snapshot('captain')?.revision).toBe(4);
    await engine.dispose();
  });
  it('does not recreate a missing team using a stale non-null revision', async () => {
    const { engine } = setup();
    await expect(engine.savePlan('captain', 'workspace', 0, draft())).rejects.toThrow('Plan changed');
    expect(engine.snapshot('captain')).toBeNull(); await engine.dispose();
  });
  it('serializes competing create requests, allowing exactly one', async () => {
    const { engine, table } = setup();
    const results = await Promise.allSettled([
      engine.savePlan('captain', 'workspace', null, draft()),
      engine.savePlan('captain', 'workspace', null, { ...draft(), name: 'Another tab' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(table.put).toHaveBeenCalledOnce(); await engine.dispose();
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', async revision => {
    const { engine, table } = setup();
    await expect(engine.savePlan('captain', 'workspace', revision, draft())).rejects.toThrow('Expected revision');
    expect(table.put).not.toHaveBeenCalled(); await engine.dispose();
  });
  it('refuses a different workspace even with a valid revision', async () => {
    const { engine } = setup(seed());
    await expect(engine.savePlan('captain', 'different', 4, draft())).rejects.toThrow('workspace');
    expect(engine.snapshot('captain')?.workspaceId).toBe('workspace'); await engine.dispose();
  });
  it.each(['running', 'completed', 'failed'] as const)('cannot erase %s task history', async status => {
    const before = seed(); before.tasks[0]!.status = status; before.tasks[0]!.attempt = 1;
    const { engine, table } = setup(before);
    await expect(engine.savePlan('captain', 'workspace', 4, draft())).rejects.toThrow('executed plan');
    expect(table.put).not.toHaveBeenCalled(); await engine.dispose();
  });
  it('refuses replacement while team is running or a member is already materialized', async () => {
    const h = setup(seed({ status: 'running' }));
    await expect(h.engine.savePlan('captain', 'workspace', 4, draft())).rejects.toThrow('Stop the team');
    await h.engine.dispose();
    const before = seed(); before.members[0]!.sessionId = 'child';
    const second = setup(before);
    await expect(second.engine.savePlan('captain', 'workspace', 4, draft())).rejects.toThrow('executed plan');
    await second.engine.dispose();
  });
  it('does not publish or mutate state when durable save fails', async () => {
    const { engine, table } = setup(seed());
    vi.mocked(table.put).mockRejectedValueOnce(new Error('Disk full'));
    await expect(engine.savePlan('captain', 'workspace', 4, draft())).rejects.toThrow('Disk full');
    expect(engine.snapshot('captain')).toEqual(seed()); await engine.dispose();
  });
  it('normalizes duplicate dependency/scope declarations but preserves the caller input', async () => {
    const { engine } = setup(); const plan = draft();
    plan.tasks[0]!.dependencies.push('inspect'); plan.tasks[0]!.writeScopes = ['docs', 'docs'];
    const snapshot = structuredClone(plan);
    const result = await engine.savePlan('captain', 'workspace', null, plan);
    expect(result.tasks[0]!.dependencies).toEqual(['inspect']); expect(result.tasks[0]!.writeScopes).toEqual(['docs']);
    expect(plan).toEqual(snapshot); await engine.dispose();
  });
  it('rejects forged runtime fields and duplicate roster identities', () => {
    expect(() => TeamPlanSchema.parse({ ...draft(), status: 'running' })).toThrow();
    const plan = draft(); plan.members.push(plan.members[0]!);
    expect(() => TeamPlanSchema.parse(plan)).toThrow('Duplicate member name');
    const other = draft(); Object.assign(other.tasks[0]!, { attempt: 2, output: 'forged success' });
    expect(() => TeamPlanSchema.parse(other)).toThrow();
  });
  it('rejects unknown members, references and cycles before creating state', async () => {
    const { engine, table } = setup();
    const missingMember = draft(); missingMember.tasks[0]!.assignee = 'unknown';
    const missingDependency = draft(); missingDependency.tasks[0]!.dependencies = ['unknown'];
    const cyclic = draft(); cyclic.tasks[1]!.dependencies = ['summary'];
    for (const plan of [missingMember, missingDependency, cyclic]) {
      await expect(engine.savePlan('captain', 'workspace', null, plan)).rejects.toThrow();
    }
    expect(table.put).not.toHaveBeenCalled(); await engine.dispose();
  });
  it('retry supports optimistic revision checks without breaking the chat tool API', async () => {
    const before = seed(); before.tasks[0]!.status = 'failed'; before.tasks[0]!.attempt = 1;
    const { engine } = setup(before);
    await expect(engine.retry('captain', 'summary', 3)).rejects.toThrow('Plan changed');
    expect((await engine.retry('captain', 'summary', 4)).tasks[0]!.status).toBe('pending');
    await engine.dispose();
  });
  it('planOf strips all runtime authority fields and defensively copies arrays', () => {
    const original = seed(); original.members[0]!.sessionId = 'child'; original.tasks[0]!.output = 'report';
    const plan = planOf(original);
    expect(TeamPlanSchema.parse(plan)).toEqual(draft());
    plan.tasks[0]!.dependencies.length = 0;
    expect(original.tasks[0]!.dependencies).toEqual(['inspect']);
  });
});
