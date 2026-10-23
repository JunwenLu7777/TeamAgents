import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-session-projection';

/** Honor a pending GUI selection even before the captain has made its first model request. */
export function resolveTeamAgentOptions(ctx: Context, parent: Agent, depth: number): AgentOptions {
  const pending = ctx.sessionProjections?.stateOf(parent.session, 'modelSelection')?.pending;
  const header = parent.session.requestHeader();
  const route = pending ?? header?.config ?? ctx.agentDefaultModel?.currentSelection() ?? parent.options;
  const options = resolveChildAgentOptions(parent, undefined, depth);
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
