import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-workspace';
import { z } from 'zod';
import { TeamEngine } from './engine.js';
import { TeamSchema, createInput, memberInput, memberName, type Team } from './model.js';
import { AgentLibraryStore, agentLibraryDomain } from './agent-library.js';
import { registerAgentLibraryRemote } from './library-remote.js';
import { validateTeamModels } from './model-catalog.js';
import { requireInheritedTeamModel } from './model-route.js';
import { DshTeamDriver } from './runtime.js';
import { publishSnapshot, registerProjection } from './projection.js';
import { registerTeamRemote } from './remote.js';
import { buildTeamRunExport } from './run-export.js';
import { TeamRunExportOptionsSchema } from './run-export-contract.js';

export const name = 'team-agents';
export const inject = [
  'tools', 'agents', 'sessions', 'sessionPersistence', 'systemPrompt', 'storageDomain',
  'sessionProjections', 'workspaceRegistry', 'workingDirectory', 'sessionController',
  'agentDefaultModel', 'llm', 'typert', 'typertGateway', 'remoteAccess',
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

const libraryCreateInput = createInput.extend({
  agents: z.array(memberName).min(1).max(12).optional(),
  libraryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).superRefine((input, context) => {
  if ((input.agents === undefined) !== (input.libraryRevision === undefined)) {
    context.addIssue({ code: 'custom', message: 'agents and libraryRevision must be supplied together' });
  }
});

export async function apply(ctx: Context): Promise<void> {
  // The global library is an additive domain; existing version-1 teams are not migrated or rewritten.
  const domain = await ctx.storageDomain.open(teamDomain);
  const libraryDomain = await ctx.storageDomain.open(agentLibraryDomain).catch(async error => {
    await domain.close(); throw error;
  });
  const library = new AgentLibraryStore(libraryDomain.table('libraries'));
  const driver = new DshTeamDriver(ctx);
  const report = (error: unknown) => console.error('[dsh-team-agents]', error);
  const engine = new TeamEngine(domain.table('teams'), driver, {
    onError: report,
    onChange: team => {
      const session = ctx.sessions.get(SessionId(team.ownerSessionId));
      if (session) publishSnapshot(session, team);
    },
  });
  // One disposer owns ordering, including failure paths: quiesce writers before closing either domain.
  ctx.effect(() => async () => {
    try { await engine.dispose(); }
    finally {
      try { await library.dispose(); }
      finally { try { await libraryDomain.close(); } finally { await domain.close(); } }
    }
  });
  registerProjection(ctx);
  await engine.recover();
  for (const [, team] of domain.table('teams').entries()) {
    const session = ctx.sessions.get(SessionId(team.ownerSessionId));
    if (session) publishSnapshot(session, team);
  }
  driver.onMailboxDelivered = (owner, ids) => engine.markDelivered(owner, ids);
  registerTeamRemote(ctx, engine);
  registerAgentLibraryRemote(ctx, library);

  const caller = (exec: ToolRunContext) => {
    const agent = exec.agent;
    if (!agent || ctx.agents.get(agent.id) !== agent) throw new Error('Team tools require an exact live agent session');
    exec.signal.throwIfAborted();
    return agent;
  };
  const captain = (exec: ToolRunContext) => {
    const agent = caller(exec);
    if (engine.identity(agent.id) || agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) !== 0) {
      throw new Error('Only a top-level captain can manage a team');
    }
    return agent;
  };
  const register = <T>(suffix: string, description: string, parameters: ParameterSchemaSpec,
    execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<T>) => {
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
  register('list_agents', 'Read the saved global Agent configuration library and its revision; this does not create a team, session, or model call. Only a top-level captain may read it. Select enabled agent names and pass the returned revision as libraryRevision to create.', {}, async (args, exec) => {
    captain(exec);
    z.strictObject({}).parse(args);
    return library.read();
  });
  register('create', 'Create a DRAFT team for this session from a goal supplied in the human conversation; this does not call any model. Prefer list_agents, then pass enabled agents and its revision as libraryRevision together to atomically copy the saved roster. Omit both for a legacy empty roster. Plan tasks, show the plan, and wait for explicit human approval in a later turn before start.', {
    name: { ...str('Team name.'), required: true }, goal: { ...str('Concrete team objective from the user conversation.'), required: true },
    maxConcurrency: { type: 'integer', description: 'Maximum concurrent members, 1–8. Default 3.' },
    agents: strings('One to twelve unique enabled agent names from list_agents. Requires libraryRevision; all are copied atomically or none are saved.'),
    libraryRevision: { type: 'integer', description: 'The exact revision returned by list_agents; required together with agents. Stale revisions are rejected.' },
  }, async (args, exec) => {
    const agent = captain(exec);
    const { agents, libraryRevision, ...plan } = libraryCreateInput.parse(args);
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('Captain session must belong to a workspace');
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd);
    if (!workspace) throw new Error('Captain workspace is not registered in DSH');
    captain(exec);
    if (agent.session.header.cwd !== cwd) throw new Error('Captain workspace changed during the request');
    if (agents === undefined || libraryRevision === undefined) return engine.create(agent.id, workspace.id, plan);
    const members = library.select(agents, libraryRevision);
    await validateTeamModels(ctx, members, exec.signal);
    captain(exec);
    if (agent.session.header.cwd !== cwd) throw new Error('Captain workspace changed during the request');
    // Catalog lookups can outlive an edit/disable in Settings. Reject a changed library before admission.
    library.select(agents, libraryRevision);
    return engine.savePlan(agent.id, workspace.id, null, { ...plan, members, tasks: [] });
  });
  register('add_member', 'Add a planning member. No model/session starts until an approved task is dispatched. An omitted model inherits the captain model; an explicit model must be in the Harness configured catalog. Delegated permissions are always inherited.', {
    name: { ...str('Unique lower-kebab-case name; captain is reserved.'), required: true },
    role: { ...str('Member responsibility.'), required: true }, instructions: str('Optional standing task instructions.'),
    model: { type: 'object', additionalProperties: false, description: 'Optional exact provider/model from the Harness configured model catalog. Omit to inherit the captain route.',
      properties: { provider: { ...str('Registered provider route.'), required: true }, model: { ...str('Advertised model id.'), required: true } } },
  }, async (args, exec) => {
    const agent = captain(exec);
    const member = memberInput.parse(args);
    await validateTeamModels(ctx, [member], exec.signal);
    captain(exec);
    return engine.addMember(agent.id, member);
  });
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
    const agent = captain(exec);
    const team = engine.snapshot(agent.id);
    if (!team || team.revision !== parsed.expectedRevision) throw new Error('Plan changed. Read status and approve the current revision.');
    await validateTeamModels(ctx, team.members, exec.signal);
    captain(exec);
    requireInheritedTeamModel(ctx, agent, team);
    return engine.start(agent.id, parsed.expectedRevision);
  });
  register('status', 'Read the current team, task results, and mailbox. Members can read only their own team. Do not busy-poll; task completion delivers a captain notification.', {}, async (_args, exec) => {
    const agent = caller(exec); const member = engine.identity(agent.id);
    return engine.snapshot(member?.owner ?? agent.id);
  });
  register('export_run', 'Export this captain session’s currently retained run snapshot as Markdown or JSON text. Read-only: no team/model execution or host file writes. Not full attempt history or session transcripts. Messages are excluded unless explicitly requested; outputs and optional messages may contain sensitive data. Returns a filename, MIME type and content for the user to save.', {
    format: { type: 'string', enum: ['markdown', 'json'], required: true, description: 'Download document format.' },
    includeMessages: { type: 'boolean', description: 'Explicitly include the retained team mailbox. Default false; may contain sensitive data.' },
  }, async (args, exec) => {
    const options = TeamRunExportOptionsSchema.parse(args);
    const agent = captain(exec);
    const session = agent.session;
    const cwd = session.header.cwd;
    const check = () => {
      if (captain(exec) !== agent || agent.session !== session || session.header.id !== agent.id ||
        ctx.sessions.get(agent.id) !== session || !ctx.agents.roots().includes(agent) ||
        (session.header.parentSession !== undefined && !session.header.isSeeded)) {
        throw new Error('Export requires the exact current root captain session');
      }
      if (session.header.cwd !== cwd || !cwd) throw new Error('Captain workspace changed or is unavailable');
      if (ctx.workspaceRegistry.archivedSessionIds.includes(agent.id)) throw new Error('Archived sessions cannot export team records');
    };
    check();
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd!);
    check();
    if (!workspace || ctx.workspaceRegistry.get(workspace.id) !== workspace) throw new Error('Captain workspace is not registered');
    const snapshot = engine.snapshot(agent.id);
    if (snapshot && (snapshot.ownerSessionId !== agent.id || snapshot.workspaceId !== workspace.id)) {
      throw new Error('Saved team does not belong to this captain and workspace');
    }
    const result = buildTeamRunExport(snapshot, options);
    check();
    return result;
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
      if (!agent || engine.identity(agent.id) || agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) !== 0) return '';
      return 'TeamAgents plugin uses team_agents_* tools (separate from any built-in AgentTeams). Use only when the human requests team collaboration. Settings only saves the global Agent configuration library: it does not set goals or tasks and never starts execution. The goal must come from the human conversation, not from library instructions. First call team_agents_list_agents, select enabled names for the requested goal, then call create with agents and the returned revision as libraryRevision; the selected configurations are copied atomically into this session and later library edits do not change them. If the library is empty, explain how to save Agent configurations in Settings or explicitly plan compatible ad-hoc members. Add a dependency task plan with disjoint write scopes, show the selected members/models and tasks, then END the turn for explicit human approval; never start during the planning turn or because a library was saved. A non-empty confirmation argument is NOT proof of user consent: quote only real approval from a later human turn, read status, and pass its current revision to start. Task edits/retries require fresh approval. The conversation panel only shows this plan/status and permits the user to stop; it has no Start button. The scheduler owns parallel work: yield while it runs, do not duplicate work or poll. Inspect every failed task and partial change before retry. Shared write scopes are advisory, not a security sandbox. Read status after result notifications and summarize when all required work is terminal.';
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
