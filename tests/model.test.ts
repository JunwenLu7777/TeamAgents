import { describe, expect, it } from 'vitest';
import {
  blockingReason, createInput, memberInput, memberName, scopePath, scopesOverlap,
  taskId, taskInput, taskPatch, TeamSchema, TeamModelOptionSchema, validateGraph, type Task, type Team,
} from '../src/model.js';

const timestamp = '2026-10-23T00:00:00.000Z';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, subject: id, description: `Do ${id}`, assignee: 'alice',
    dependencies: [], writeScopes: [`work/${id}`], status: 'pending', attempt: 0,
    ...overrides,
  };
}

function team(tasks: Task[] = [], overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1', ownerSessionId: 'owner-1', workspaceId: 'workspace-1',
    name: 'Test team', goal: 'Test the scheduler', maxConcurrency: 3,
    revision: 1, status: 'running', createdAt: timestamp, updatedAt: timestamp,
    members: [{ name: 'alice', role: 'Engineer' }, { name: 'bob', role: 'Reviewer' }],
    tasks, messages: [], ...overrides,
  };
}

describe('input schemas', () => {
  it('trims human-readable fields and supplies creation defaults', () => {
    expect(createInput.parse({ name: '  Team  ', goal: '  Ship it  ' })).toEqual({
      name: 'Team', goal: 'Ship it', maxConcurrency: 3,
    });
    expect(memberInput.parse({ name: 'alice', role: '  Engineer  ', instructions: '  Check tests  ' }))
      .toEqual({ name: 'alice', role: 'Engineer', instructions: 'Check tests' });
    expect(taskInput.parse({ id: 'task-1', subject: '  Work  ', description: '  Details  ', assignee: 'alice' }))
      .toEqual({ id: 'task-1', subject: 'Work', description: 'Details', assignee: 'alice', dependencies: [], writeScopes: [] });
  });

  it('keeps legacy members inherited and round-trips explicit opaque route ids', () => {
    const legacy = TeamSchema.parse(team());
    expect(legacy.members[0]).not.toHaveProperty('model');
    const model = { provider: 'configured-gateway', model: 'org/model:preview' };
    const explicit = memberInput.parse({ name: 'alice', role: 'Engineer', model });
    expect(explicit.model).toEqual(model);
    expect(TeamSchema.parse(team([], { members: [explicit] })).members[0]!.model).toEqual(model);
  });

  it.each([null, {}, { provider: 'p' }, { provider: '', model: 'm' }, { provider: 'p', model: ' ' },
    { provider: ' p', model: 'm' }, { provider: 'p', model: 'm\n' },
    { provider: 'p', model: 'm', apiKey: 'not-accepted' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }])
    ('rejects malformed or expanded member model selection %#', model => {
      expect(memberInput.safeParse({ name: 'alice', role: 'Engineer', model }).success).toBe(false);
    });

  it('keeps browser model options on a strict four-field allowlist', () => {
    const option = { provider: 'p', model: 'm', providerLabel: 'Provider', modelLabel: 'Model' };
    expect(TeamModelOptionSchema.parse(option)).toEqual(option);
    expect(TeamModelOptionSchema.safeParse({ ...option, apiKey: 'not-accepted' }).success).toBe(false);
  });

  it.each([0, 9, 1.5, Number.NaN])('rejects invalid maxConcurrency %s', maxConcurrency => {
    expect(createInput.safeParse({ name: 'Team', goal: 'Goal', maxConcurrency }).success).toBe(false);
  });

  it.each([1, 8])('accepts maxConcurrency boundary %s', maxConcurrency => {
    expect(createInput.parse({ name: 'Team', goal: 'Goal', maxConcurrency }).maxConcurrency).toBe(maxConcurrency);
  });

  it.each(['a', 'alice', 'worker-2', 'a'.repeat(40)])('accepts member name %s', name => {
    expect(memberName.parse(name)).toBe(name);
  });

  it.each(['', 'captain', 'Alice', '2worker', '-worker', 'under_score', ' alice', 'a'.repeat(41)])
    ('rejects invalid or reserved member name %s', name => {
      expect(memberName.safeParse(name).success).toBe(false);
    });

  it.each(['a', 'Task_12-next', '0', 'a'.repeat(80)])('accepts task id %s', id => {
    expect(taskId.parse(id)).toBe(id);
  });

  it.each(['', '-task', '_task', 'a/b', 'a b', 'a'.repeat(81)])('rejects task id %s', id => {
    expect(taskId.safeParse(id).success).toBe(false);
  });

  it('rejects unknown fields and user-supplied execution state', () => {
    expect(createInput.safeParse({ name: 'Team', goal: 'Goal', status: 'running' }).success).toBe(false);
    expect(memberInput.safeParse({ name: 'alice', role: 'Engineer', sessionId: 'injected' }).success).toBe(false);
    expect(taskInput.safeParse({ ...task('a') }).success).toBe(false);
    expect(taskPatch.safeParse({ id: 'new-id' }).success).toBe(false);
    expect(taskPatch.safeParse({ status: 'completed' }).success).toBe(false);
  });

  it('rejects blank text and excessive task arrays', () => {
    expect(createInput.safeParse({ name: ' ', goal: 'Goal' }).success).toBe(false);
    expect(memberInput.safeParse({ name: 'alice', role: ' ' }).success).toBe(false);
    const input = { id: 'a', subject: 'Work', description: 'Details', assignee: 'alice' };
    expect(taskInput.safeParse({ ...input, subject: ' ' }).success).toBe(false);
    expect(taskInput.safeParse({ ...input, description: ' ' }).success).toBe(false);
    expect(taskInput.safeParse({ ...input, dependencies: Array.from({ length: 101 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(taskInput.safeParse({ ...input, writeScopes: Array.from({ length: 31 }, (_, i) => `dir${i}`) }).success).toBe(false);
  });

  it('does not insert defaults into an empty task patch', () => {
    expect(taskPatch.parse({})).toEqual({});
  });

  it('preserves omission of dependencies and writeScopes in a subject-only patch', () => {
    expect(taskPatch.parse({ subject: '  Revised subject  ' })).toEqual({ subject: 'Revised subject' });
  });

  it('allows explicitly clearing dependencies and writeScopes', () => {
    expect(taskPatch.parse({ dependencies: [], writeScopes: [] })).toEqual({ dependencies: [], writeScopes: [] });
  });

  it('validates persisted lifecycle fields and collection limits', () => {
    expect(TeamSchema.parse(team([task('a', { status: 'completed', attempt: 1, output: 'done' })])))
      .toEqual(team([task('a', { status: 'completed', attempt: 1, output: 'done' })]));
    expect(TeamSchema.safeParse(team([], { revision: -1 })).success).toBe(false);
    expect(TeamSchema.safeParse(team([task('a', { attempt: -1 })])).success).toBe(false);
    expect(TeamSchema.safeParse({ ...team(), status: 'unknown' }).success).toBe(false);
    expect(TeamSchema.safeParse(team([], { members: Array.from({ length: 13 }, (_, i) => ({ name: `m${i}`, role: 'Engineer' })) })).success).toBe(false);
    expect(TeamSchema.safeParse(team(Array.from({ length: 201 }, (_, i) => task(`t${i}`)))).success).toBe(false);
  });
});

describe('workspace-relative write scopes', () => {
  it.each(['.', 'src', 'src/model.ts', '.github/workflows/test.yml', 'packages/ui/src', 'src..old', 'a'.repeat(300)])
    ('accepts normalized POSIX scope %s', path => {
      expect(scopePath.parse(path)).toBe(path);
    });

  it.each(['', '/', '/tmp/file', '..', '../src', 'src/../secret', './src', 'src/./file',
    'src/.', 'src//file', 'src/', '\\root', 'src\\file', 'a'.repeat(301)])
    ('rejects non-relative or non-normalized scope %s', path => {
      expect(scopePath.safeParse(path).success).toBe(false);
    });

  it.each([
    { left: [], right: [], expected: false },
    { left: [], right: ['.'], expected: false },
    { left: ['.'], right: ['src/file.ts'], expected: true },
    { left: ['.'], right: ['.'], expected: true },
    { left: ['src/file.ts'], right: ['src/file.ts'], expected: true },
    { left: ['src'], right: ['src/nested/file.ts'], expected: true },
    { left: ['src'], right: ['src-old/file.ts'], expected: false },
    { left: ['src/a'], right: ['src/ab'], expected: false },
    { left: ['src/a'], right: ['src/b'], expected: false },
    { left: ['src', 'docs'], right: ['assets', 'docs/api'], expected: true },
  ])('detects overlap symmetrically: $left / $right => $expected', ({ left, right, expected }) => {
    expect(scopesOverlap(left, right)).toBe(expected);
    expect(scopesOverlap(right, left)).toBe(expected);
  });
});

describe('validateGraph', () => {
  it('accepts an empty graph and a diamond whose tasks are not topologically ordered', () => {
    expect(() => validateGraph(team())).not.toThrow();
    expect(() => validateGraph(team([
      task('join', { dependencies: ['left', 'right'] }),
      task('left', { dependencies: ['root'] }),
      task('right', { dependencies: ['root'] }),
      task('root'),
    ]))).not.toThrow();
  });

  it('rejects duplicate task ids', () => {
    expect(() => validateGraph(team([task('a'), task('a')]))).toThrow('Duplicate task id');
  });

  it('rejects unknown dependencies', () => {
    expect(() => validateGraph(team([task('a', { dependencies: ['missing'] })]))).toThrow('Unknown dependency: missing');
  });

  it('rejects unknown assignees, including disconnected tasks', () => {
    expect(() => validateGraph(team([task('a'), task('b', { assignee: 'unknown' })]))).toThrow('Unknown member: unknown');
  });

  it('rejects a self-dependency', () => {
    expect(() => validateGraph(team([task('a', { dependencies: ['a'] })]))).toThrow(/dependency cycle/);
  });

  it('rejects an indirect dependency cycle', () => {
    expect(() => validateGraph(team([
      task('a', { dependencies: ['b'] }), task('b', { dependencies: ['c'] }), task('c', { dependencies: ['a'] }),
    ]))).toThrow(/dependency cycle/);
  });
});

describe('blockingReason', () => {
  it.each(['running', 'completed', 'failed'] as const)('does not block a task already %s', status => {
    const candidate = task('candidate', { status, dependencies: ['missing'] });
    expect(blockingReason(team([candidate], { status: 'paused' }), candidate)).toBeUndefined();
  });

  it.each(['pending', 'running', 'failed'] as const)('waits for a dependency that is %s', status => {
    const candidate = task('candidate', { dependencies: ['dependency'] });
    expect(blockingReason(team([task('dependency', { status }), candidate]), candidate)).toBe('Waiting for: dependency');
  });

  it('reports every unfinished dependency in declared order and gives dependencies priority', () => {
    const candidate = task('candidate', { dependencies: ['missing', 'done', 'failed', 'active'] });
    const state = team([
      task('done', { status: 'completed' }), task('failed', { status: 'failed' }),
      task('active', { status: 'running' }), candidate,
    ], { status: 'paused', maxConcurrency: 1 });
    expect(blockingReason(state, candidate)).toBe('Waiting for: missing, failed, active');
  });

  it('allows completed dependencies and ignores completed tasks as resource locks', () => {
    const candidate = task('candidate', { dependencies: ['done'], writeScopes: ['.'] });
    expect(blockingReason(team([task('done', { status: 'completed', writeScopes: ['.'] }), candidate]), candidate))
      .toBeUndefined();
  });

  it('prioritizes member serialization over scope and concurrency restrictions', () => {
    const candidate = task('candidate', { writeScopes: ['src'] });
    const active = task('active', { status: 'running', writeScopes: ['src/file.ts'] });
    expect(blockingReason(team([active, candidate], { maxConcurrency: 1 }), candidate)).toBe('Member is busy');
  });

  it('prioritizes overlapping scopes over concurrency restrictions', () => {
    const candidate = task('candidate', { assignee: 'bob', writeScopes: ['src'] });
    const active = task('active', { status: 'running', writeScopes: ['src/file.ts'] });
    expect(blockingReason(team([active, candidate], { maxConcurrency: 1 }), candidate)).toBe('Overlapping write scope');
  });

  it('enforces maxConcurrency for otherwise independent work', () => {
    const candidate = task('candidate', { assignee: 'bob' });
    expect(blockingReason(team([task('active', { status: 'running' }), candidate], { maxConcurrency: 1 }), candidate))
      .toBe('Concurrency limit');
  });

  it.each(['draft', 'paused', 'blocked', 'completed'] as const)('does not authorize execution while the team is %s', status => {
    const candidate = task('candidate');
    expect(blockingReason(team([candidate], { status }), candidate)).toBe('Team is not running');
  });

  it('allows pending work with no dependencies or resource conflicts in a running team', () => {
    const candidate = task('candidate', { assignee: 'bob' });
    expect(blockingReason(team([task('active', { status: 'running' }), candidate]), candidate)).toBeUndefined();
  });
});
