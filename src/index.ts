import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-workspace';
import { z } from 'zod';
import { TeamEngine } from './engine.js';
import { TeamSchema, type Team } from './model.js';
import { DshTeamDriver } from './runtime.js';
import { publishSnapshot, registerProjection } from './projection.js';
import { registerTeamRemote } from './remote.js';

export const name = 'team-agents';
export const inject = [
  'tools', 'agents', 'sessions', 'sessionPersistence', 'systemPrompt', 'storageDomain',
  'sessionProjections', 'workspaceRegistry', 'workingDirectory', 'sessionController',
  'agentDefaultModel', 'typert', 'typertGateway', 'remoteAccess',
];
export const teamDomain = defineDomain({
  name: 'dsh_team_agents', version: 1,
  tables: { teams: domainTable<string, Team>(TeamSchema) },
});
const str = (description: string) => ({ type: 'string', description } as const);
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description } as const);
const taskProperties = {
  subject: str('Non-empty task title.'), description: str('Self-contained task, deliverables and acceptance criteria.'),
  assignee: str('Existing member name.'), dependencies: strings('Task ids that must complete successfully first. Add prerequisite tasks first.'),
  writeScopes: strings('Workspace-relative POSIX paths this task expects to change. Empty means read-only; advisory, not a sandbox.'),
};

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(teamDomain);
  const driver = new DshTeamDriver(ctx);
  const report = (error: unknown) => console.error('[dsh-team-agents]', error);
  const engine = new TeamEngine(domain.table('teams'), driver, {
    onError: report,
    onChange: team => {
      const session = ctx.sessions.get(SessionId(team.ownerSessionId));
      if (session) publishSnapshot(session, team);
    },
  });
  // One disposer owns ordering: models quiesce before their state domain closes.
  ctx.effect(() => async () => { try { await engine.dispose(); } finally { await domain.close(); } });
  registerProjection(ctx);
  await engine.recover();
  for (const [, team] of domain.table('teams').entries()) {
    const session = ctx.sessions.get(SessionId(team.ownerSessionId));
    if (session) publishSnapshot(session, team);
  }
  driver.onMailboxDelivered = (owner, ids) => engine.markDelivered(owner, ids);
  registerTeamRemote(ctx, engine);

  const caller = (exec: ToolRunContext) => {
    const agent = exec.agent;
    if (!agent || ctx.agents.get(agent.id) !== agent) throw new Error('Team tools require an exact live agent session');
    exec.signal.throwIfAborted();
    return agent;
  };
  const captain = (exec: ToolRunContext) => {
    const agent = caller(exec);
    if (engine.identity(agent.id) || agent.session.header.origin === 'subagent') throw new Error('Only a top-level captain can manage a team');
    return agent;
  };
  const register = (suffix: string, description: string, parameters: ParameterSchemaSpec,
    execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<Team | null>) => {
    ctx.tools.register({
      name: `team_agents_${suffix}`, description, parameters: { ...parameterSchemaSpecToJsonSchema(parameters) },
      output: {
        schema: valueSchemaSpecToJsonSchema({ type: 'json' }),
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        const value = await execute(z.record(z.string(), z.unknown()).parse(args), exec);
        // Snapshot canonical plain JSON; never return a borrowed domain object.
        return JSON.parse(JSON.stringify(value));
      },
      presentCall: () => ({ card: 'generic', kind: 'other', title: `TeamAgents · ${suffix.replaceAll('_', ' ')}` }),
    });
  };
  register('create', 'Create a DRAFT team for this session; this does not call any model. Plan members and tasks, show the plan, then wait for explicit human approval in a later turn. Only use when the user wants TeamAgents collaboration.', {
    name: { ...str('Team name.'), required: true }, goal: { ...str('Concrete team objective.'), required: true },
    maxConcurrency: { type: 'integer', description: 'Maximum concurrent members, 1–8. Default 3.' },
  }, async (args, exec) => {
    const agent = captain(exec);
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('Captain session must belong to a workspace');
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd);
    if (!workspace) throw new Error('Captain workspace is not registered in DSH');
    exec.signal.throwIfAborted();
    return engine.create(agent.id, workspace.id, args);
  });
  register('add_member', 'Add a planning member. No model/session starts until an approved task is dispatched. Each member inherits the captain model and delegated permissions.', {
    name: { ...str('Unique lower-kebab-case name; captain is reserved.'), required: true },
    role: { ...str('Member responsibility.'), required: true }, instructions: str('Optional standing task instructions.'),
  }, async (args, exec) => engine.addMember(captain(exec).id, args));
  register('add_task', 'Add an assigned dependency task while stopped/draft. Dependencies must already exist. Use disjoint write scopes for parallel work. This never starts a model.', {
    id: { ...str('Unique task id chosen by you.'), required: true }, ...taskProperties,
    subject: { ...taskProperties.subject, required: true }, description: { ...taskProperties.description, required: true },
    assignee: { ...taskProperties.assignee, required: true },
  }, async (args, exec) => engine.addTask(captain(exec).id, args));
  register('update_task', 'Edit a never-started pending task while stopped/draft. Omitted fields remain unchanged. Re-approve after changing a plan.', {
    id: { ...str('Existing task id.'), required: true }, ...taskProperties,
  }, async (args, exec) => {
    const { id, ...patch } = args;
    return engine.updateTask(captain(exec).id, z.string().parse(id), patch);
  });
  register('start', 'Start/resume only AFTER the human explicitly approves the current plan in a later turn. Never call in the planning turn. Read status first and pass its revision; edits invalidate approval. Tasks run in background; yield instead of polling.', {
    expectedRevision: { type: 'integer', required: true, description: 'Revision of the plan the user approved.' },
    confirmation: { ...str('The human approval statement. Do not fabricate approval.'), required: true },
  }, async (args, exec) => {
    const parsed = z.strictObject({ expectedRevision: z.number().int().nonnegative(), confirmation: z.string().trim().min(1).max(2000) }).parse(args);
    return engine.start(captain(exec).id, parsed.expectedRevision);
  });
  register('status', 'Read the current team, task results, and mailbox. Members can read only their own team. Do not busy-poll; task completion delivers a captain notification.', {}, async (_args, exec) => {
    const agent = caller(exec); const member = engine.identity(agent.id);
    return engine.snapshot(member?.owner ?? agent.id);
  });
  register('message', 'Send attributed guidance within this team. A running recipient receives context at a later step; an idle member keeps a durable message for its next task. This does not start idle models.', {
    to: { ...str('Member name or captain.'), required: true }, text: { ...str('Message, at most 20,000 characters.'), required: true },
  }, async (args, exec) => {
    const parsed = z.strictObject({ to: z.string(), text: z.string().trim().min(1).max(20_000) }).parse(args);
    const agent = caller(exec); const member = engine.identity(agent.id);
    if (!member) captain(exec);
    return engine.message(member?.owner ?? agent.id, member?.member ?? 'captain', parsed.to, parsed.text);
  });
  register('stop', 'Stop this team and await cooperative child quiescence. Interrupted tasks fail; inspect partial file changes before retrying. Stopping is not a rollback.', {}, async (_args, exec) => engine.stop(captain(exec).id));
  register('retry_task', 'Prepare a FAILED task for a new attempt while the team is stopped. Does not execute it; get approval and call start again. Inspect partial effects first.', {
    id: { ...str('Failed task id.'), required: true },
  }, async (args, exec) => engine.retry(captain(exec).id, z.string().parse(args.id)));

  ctx.systemPrompt.context({
    name: 'dsh-team-agents:protocol', order: ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'), required: true, interpolate: false,
    text: ({ agent }) => {
      if (!agent || engine.identity(agent.id)) return '';
      return 'TeamAgents plugin uses team_agents_* tools (separate from any built-in AgentTeams). Use only when requested. First create a draft roster and dependency plan, show it, and end the turn for explicit human approval; never start during the planning turn. A non-empty confirmation argument is NOT proof of user consent: quote only real approval from a later human turn. Task edits/retries require fresh approval. The scheduler owns parallel work: yield while it runs, do not duplicate work or poll. Inspect every failed task and partial change before retry. Shared write scopes are advisory, not a security sandbox. Read status after result notifications and summarize when all required work is terminal.';
    },
  });
  ctx.on('agent/created', ({ agent }) => {
    const team = engine.snapshot(agent.id);
    if (team) publishSnapshot(agent.session, team);
    return undefined;
  });
  const stopIfRunning = (owner: string) => {
    if (engine.snapshot(owner)?.status === 'running') void engine.stop(owner).catch(report);
  };
  ctx.on('agent/disposed', ({ agent }) => stopIfRunning(agent.id));
  ctx.on('workspace/session-stop', ({ sessionId }) => stopIfRunning(sessionId));
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user') stopIfRunning(session.id);
  });
}
