import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveTeamAgentOptions } from '../src/model-route.js';

type Route = { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number };
function resolve({ pending = null, header, defaults, options = {} }: {
  pending?: Route | null; header?: { config: Route; adapterDefaults?: { reasoningEffort?: boolean } }; defaults?: Route; options?: Route;
}) {
  const parent = { options: Object.freeze(options), session: { requestHeader: () => header } } as unknown as Agent;
  const ctx = { sessionProjections: { stateOf: () => ({ pending }) },
    ...(defaults ? { agentDefaultModel: { currentSelection: () => defaults } } : {}) } as unknown as Context;
  return resolveTeamAgentOptions(ctx, parent, 1);
}

describe('GUI route inheritance without a dummy model request', () => {
  it('uses pending model selection instead of the old request or constructor options', () => {
    expect(resolve({ pending: { provider: 'chosen', model: 'new' },
      header: { config: { provider: 'old', model: 'old', reasoningEffort: 'high' } },
      options: { provider: 'creation', model: 'creation', maxTokens: 4096 } })).toEqual({
      provider: 'chosen', model: 'new', maxTokens: 4096, subagentDepth: 1,
    });
  });
  it('honors the GUI default before the first request', () => {
    expect(resolve({ defaults: { provider: 'gui', model: 'selected', reasoningEffort: 'medium' },
      options: { provider: 'creation', model: 'stale', reasoningEffort: 'high' } })).toMatchObject({
      provider: 'gui', model: 'selected', reasoningEffort: 'medium', subagentDepth: 1,
    });
  });
  it('prefers a recorded request to a later unrelated default', () => {
    expect(resolve({ header: { config: { provider: 'used', model: 'used-model' } },
      defaults: { provider: 'default', model: 'default-model' } })).toMatchObject({ provider: 'used', model: 'used-model' });
  });
  it('does not carry stale effort into the same route when selection clears it', () => {
    const next = resolve({ pending: { provider: 'p', model: 'm' },
      header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } } });
    expect(next).not.toHaveProperty('reasoningEffort');
  });
  it('does not promote provider-supplied effort defaults to a new explicit selection', () => {
    const header = { config: { provider: 'p', model: 'm', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } };
    expect(resolve({ header })).not.toHaveProperty('reasoningEffort');
    expect(resolve({ header, pending: { provider: 'p', model: 'm', reasoningEffort: 'high' } })).toHaveProperty('reasoningEffort', 'high');
  });
  it('retains the official explicit-options fallback only when the default capability is absent', () => {
    expect(resolve({ options: { provider: 'fixture', model: 'explicit' } })).toMatchObject({ provider: 'fixture', model: 'explicit' });
    expect(resolve({})).toEqual({ subagentDepth: 1 });
    expect(resolve({ defaults: { provider: '', model: '' }, options: { provider: 'old', model: 'old' } })).toMatchObject({ provider: '', model: '' });
  });
});
