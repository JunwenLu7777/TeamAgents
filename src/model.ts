import { z } from 'zod';

export const memberName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).refine(n => n !== 'captain', 'captain is reserved');
const text = z.string().trim().min(1).max(20_000);
export const taskId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const scopePath = z.string().min(1).max(300).refine(path =>
  path === '.' || (!path.startsWith('/') && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.' || p === '')),
'Write scopes must be normalized workspace-relative POSIX paths (or .)');

// Provider/model ids are opaque host routes; never normalize them into a different route.
const modelId = z.string().min(1).max(1024).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'Invalid model route id');
export const TeamModelSelectionSchema = z.strictObject({ provider: modelId, model: modelId });
export type TeamModelSelection = z.infer<typeof TeamModelSelectionSchema>;
export const TeamModelOptionSchema = TeamModelSelectionSchema.extend({
  providerLabel: z.string().min(1).max(2000), modelLabel: z.string().min(1).max(2000),
});
export const TeamModelOptionsSchema = z.array(TeamModelOptionSchema);
export type TeamModelOption = z.infer<typeof TeamModelOptionSchema>;

export const memberInput = z.strictObject({
  name: memberName, role: text, instructions: text.optional(), model: TeamModelSelectionSchema.optional(),
});
export const taskInput = z.strictObject({
  id: taskId, subject: z.string().trim().min(1).max(200), description: text,
  assignee: memberName, dependencies: z.array(taskId).max(100).default([]),
  writeScopes: z.array(scopePath).max(30).default([]),
});
// Zod applies defaults even under .partial(); replace defaulted fields so omission is a no-op.
export const taskPatch = taskInput.omit({ id: true }).partial().extend({
  dependencies: z.array(taskId).max(100).optional(),
  writeScopes: z.array(scopePath).max(30).optional(),
});
export const createInput = z.strictObject({
  name: z.string().trim().min(1).max(100), goal: text,
  maxConcurrency: z.number().int().min(1).max(8).default(3),
});
export const MemberSchema = memberInput.extend({ sessionId: z.string().optional() });
export const TaskSchema = taskInput.extend({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  attempt: z.number().int().nonnegative(), attemptId: z.string().optional(),
  output: z.string().optional(), error: z.string().optional(),
  startedAt: z.string().optional(), endedAt: z.string().optional(),
});
export const MessageSchema = z.strictObject({
  id: z.string(), from: z.string(), to: z.string(), text, createdAt: z.string(),
  deliveredAt: z.string().optional(),
});
export const TeamSchema = createInput.extend({
  id: z.string(), ownerSessionId: z.string(), workspaceId: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['draft', 'running', 'paused', 'blocked', 'completed']),
  createdAt: z.string(), updatedAt: z.string(),
  members: z.array(MemberSchema).max(12), tasks: z.array(TaskSchema).max(200),
  messages: z.array(MessageSchema).max(500),
});
export type Team = z.infer<typeof TeamSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TeamMessage = z.infer<typeof MessageSchema>;

/** Editable plan only: runtime ids, status, sessions and attempts cannot arrive from the browser. */
export const TeamPlanSchema = createInput.extend({
  members: z.array(memberInput).max(12),
  tasks: z.array(taskInput).max(200),
}).superRefine((plan, ctx) => {
  try { validateGraph(plan); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); }
});
export type TeamPlan = z.infer<typeof TeamPlanSchema>;

export function planOf(team: Team): TeamPlan {
  return {
    name: team.name, goal: team.goal, maxConcurrency: team.maxConcurrency,
    members: team.members.map(({ name, role, instructions, model }) => ({
      name, role, ...(instructions === undefined ? {} : { instructions }), ...(model === undefined ? {} : { model: { ...model } }),
    })),
    tasks: team.tasks.map(({ id, subject, description, assignee, dependencies, writeScopes }) => ({
      id, subject, description, assignee, dependencies: [...dependencies], writeScopes: [...writeScopes],
    })),
  };
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export function validateGraph(team: {
  members: readonly Pick<Member, 'name'>[];
  tasks: readonly Pick<Task, 'id' | 'assignee' | 'dependencies'>[];
}): void {
  if (new Set(team.members.map(m => m.name)).size !== team.members.length) throw new Error('Duplicate member name');
  const tasks = new Map(team.tasks.map(t => [t.id, t]));
  if (tasks.size !== team.tasks.length) throw new Error('Duplicate task id');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Task dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (!task) throw new Error(`Unknown dependency: ${id}`);
    if (!team.members.some(m => m.name === task.assignee)) throw new Error(`Unknown member: ${task.assignee}`);
    visiting.add(id);
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of team.tasks) visit(task.id);
}

export function blockingReason(team: Team, task: Task): string | undefined {
  if (task.status !== 'pending') return undefined;
  const unfinished = task.dependencies.filter(id => team.tasks.find(t => t.id === id)?.status !== 'completed');
  if (unfinished.length) return `Waiting for: ${unfinished.join(', ')}`;
  const active = team.tasks.filter(t => t.status === 'running');
  if (active.some(t => t.assignee === task.assignee)) return 'Member is busy';
  if (active.some(t => scopesOverlap(t.writeScopes, task.writeScopes))) return 'Overlapping write scope';
  if (active.length >= team.maxConcurrency) return 'Concurrency limit';
  if (team.status !== 'running') return 'Team is not running';
  return undefined;
}
