import type { Context } from '@deepseek-ai/cordis';
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import {
  TeamModelOptionSchema, TeamModelSelectionSchema, type Member, type TeamModelOption,
} from './model.js';

export class TeamModelError extends Error {
  constructor(readonly code: 'team-agents/model-unavailable' | 'team-agents/model-catalog-unavailable' | 'team-agents/model-required', message: string) {
    super(message); this.name = 'TeamModelError';
  }
}

/** listModels has no cancellation argument in this SDK. Stop waiting, but observe late rejections. */
function cancellable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function optionsFor(ctx: Context, providers: readonly LlmProviderInfo[], signal?: AbortSignal): Promise<TeamModelOption[]> {
  const options: TeamModelOption[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    signal?.throwIfAborted();
    const models = await cancellable(ctx.llm.listModels(provider.id), signal);
    signal?.throwIfAborted();
    for (const model of models) {
      if (model.provider !== provider.id) throw new Error('Mismatched provider metadata');
      // Deliberate allowlist: never spread adapter metadata, endpoints, configuration, or credentials.
      const option = TeamModelOptionSchema.parse({
        provider: provider.id, model: model.id, providerLabel: provider.name, modelLabel: model.name,
      });
      const key = JSON.stringify([option.provider, option.model]);
      if (seen.has(key)) throw new Error('Duplicate catalog route');
      seen.add(key); options.push(option);
    }
  }
  return options;
}

async function catalog<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  try { const value = await read(); signal?.throwIfAborted(); return value; }
  catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TeamModelError) throw error;
    // Adapter exceptions can contain connection facts; never send their text or cause to the browser.
    throw new TeamModelError('team-agents/model-catalog-unavailable', 'The Harness model catalog is unavailable. Refresh it or check the host model settings.');
  }
}

/** Read only the mounted LLM registry, never settings, credentials, endpoint discovery, or a model call. */
export function listTeamModels(ctx: Context, signal?: AbortSignal): Promise<TeamModelOption[]> {
  return catalog(signal, async () => optionsFor(ctx, ctx.llm.listProviders(), signal));
}

/** Validate explicit selections at save/start/dispatch, without tightening legacy inherited routes. */
export async function validateTeamModels(ctx: Context, members: readonly Pick<Member, 'model'>[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const selections = members.flatMap(member => member.model ? [TeamModelSelectionSchema.parse(member.model)] : []);
  if (!selections.length) return;
  await catalog(signal, async () => {
    const ids = new Set(selections.map(selection => selection.provider));
    const providers = ctx.llm.listProviders().filter(provider => ids.has(provider.id));
    const options = await optionsFor(ctx, providers, signal);
    signal?.throwIfAborted();
    if (selections.some(selection => !options.some(option => option.provider === selection.provider && option.model === selection.model))) {
      throw new TeamModelError('team-agents/model-unavailable', 'A selected member model is no longer in the Harness catalog. Refresh the models and select an available route. Executed plans require a new captain session to change members.');
    }
  });
}
