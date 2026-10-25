import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { Team, TeamModelSelection } from './model.js';
import { TeamModelError } from './model-catalog.js';

/** Honor a pending GUI selection even before the captain has made its first model request. */
export function resolveTeamAgentOptions(ctx: Context, parent: Agent, depth: number, selected?: TeamModelSelection): AgentOptions {
  const options = resolveChildAgentOptions(parent, undefined, depth);
  if (selected) {
    // A member-selected model owns its defaults, even when it equals the captain route.
    delete options.reasoningEffort;
    return { ...options, provider: selected.provider, model: selected.model };
  }
  const pending = ctx.sessionProjections?.stateOf(parent.session, 'modelSelection')?.pending;
  const header = parent.session.requestHeader();
  const route = pending ?? header?.config ?? ctx.agentDefaultModel?.currentSelection() ?? parent.options;
  // A newly selected/default model must not inherit stale route-specific reasoning effort.
  delete options.provider;
  delete options.model;
  delete options.reasoningEffort;
  if (route.provider !== undefined) options.provider = route.provider;
  if (route.model !== undefined) options.model = route.model;
  const inheritedAdapterDefault = !pending && header?.adapterDefaults?.reasoningEffort === true;
  if (route.reasoningEffort !== undefined && !inheritedAdapterDefault) {
    options.reasoningEffort = ReasoningEffortId(route.reasoningEffort);
  }
  return options;
}

/** Explicit members do not need a captain model; only pending inherited work does. */
export function requireInheritedTeamModel(ctx: Context, parent: Agent, team: Team): void {
  const inherited = team.members.some(member => !member.model && team.tasks.some(task => task.assignee === member.name && task.status === 'pending'));
  if (!inherited) return;
  const route = resolveTeamAgentOptions(ctx, parent, 1);
  if (!route.provider?.trim() || !route.model?.trim()) {
    throw new TeamModelError('team-agents/model-required', 'An inheriting member has no resolved captain model. Select a model in the captain conversation settings or choose a model for every pending member. No message is required.');
  }
}
