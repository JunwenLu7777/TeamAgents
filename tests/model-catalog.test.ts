import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import { listTeamModels, validateTeamModels } from '../src/model-catalog.js';

function fixture() {
  const listProviders = vi.fn((): LlmProviderInfo[] => [
    { id: 'p', name: 'Configured provider', apiKey: 'never-copy', baseURL: 'https://private.invalid' } as LlmProviderInfo,
  ]);
  const listModels = vi.fn(async (provider: string): Promise<LlmModelInfo[]> => [
    { provider, id: 'm', name: 'Configured model', description: 'private diagnostic', credentials: { key: 'never-copy' } } as LlmModelInfo,
  ]);
  const forbidden = vi.fn(() => { throw new Error('No credentials, settings, discovery, or model execution allowed'); });
  const ctx = { llm: { listProviders, listModels, listConfigurableProviders: forbidden, discoverModels: forbidden,
    resolveModelInfo: forbidden, resolveCallConfig: forbidden, prepareCall: forbidden, stream: forbidden },
    settings: { get: forbidden }, credentials: { get: forbidden } } as unknown as Context;
  return { ctx, listProviders, listModels, forbidden };
}

const selected = [{ model: { provider: 'p', model: 'm' } }];
describe('configured host catalog with a strict public projection', () => {
  it('projects only four public fields, stays detached, and never reads configuration or credentials', async () => {
    const h = fixture();
    const result = await listTeamModels(h.ctx);
    expect(result).toEqual([{ provider: 'p', model: 'm', providerLabel: 'Configured provider', modelLabel: 'Configured model' }]);
    result[0]!.modelLabel = 'changed by caller';
    expect((await listTeamModels(h.ctx))[0]!.modelLabel).toBe('Configured model');
    expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('returns an empty list when no provider is mounted and does not activate dormant providers', async () => {
    const h = fixture(); h.listProviders.mockReturnValue([]);
    expect(await listTeamModels(h.ctx)).toEqual([]);
    expect(h.listModels).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('keeps old/inherited members compatible without requiring a catalog', async () => {
    const h = fixture(); await validateTeamModels(h.ctx, [{}, {}]);
    expect(h.listProviders).not.toHaveBeenCalled(); expect(h.listModels).not.toHaveBeenCalled();
  });
  it('validates the complete pair and rereads deleted models rather than trusting cached options', async () => {
    const h = fixture(); await validateTeamModels(h.ctx, selected);
    h.listModels.mockResolvedValue([]);
    await expect(validateTeamModels(h.ctx, selected)).rejects.toMatchObject({ code: 'team-agents/model-unavailable' });
    h.listProviders.mockReturnValue([]);
    await expect(validateTeamModels(h.ctx, selected)).rejects.toMatchObject({ code: 'team-agents/model-unavailable' });
    expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('queries only explicitly selected providers and rejects unknown ids instead of falling back', async () => {
    const h = fixture();
    h.listProviders.mockReturnValue([{ id: 'p', name: 'P' }, { id: 'other', name: 'Other' }]);
    await validateTeamModels(h.ctx, [...selected, ...selected, {}]);
    expect(h.listModels).toHaveBeenCalledExactlyOnceWith('p');
    await expect(validateTeamModels(h.ctx, [{ model: { provider: 'missing', model: 'm' } }])).rejects.toMatchObject({ code: 'team-agents/model-unavailable' });
    expect(h.listModels).toHaveBeenCalledTimes(1);
  });
  it('does not propagate adapter exception text or nested causes to a caller', async () => {
    const h = fixture(); h.listModels.mockRejectedValue(new Error('apiKey=SECRET endpoint=PRIVATE'));
    try { await listTeamModels(h.ctx); throw new Error('Expected refusal'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'team-agents/model-catalog-unavailable' });
      expect(String(error)).not.toMatch(/SECRET|PRIVATE/);
      expect(error).not.toHaveProperty('cause');
    }
  });
  it.each([
    { models: [{ provider: 'wrong', id: 'm', name: 'M' }] },
    { models: [{ provider: 'p', id: 'm', name: 'M' }, { provider: 'p', id: 'm', name: 'Duplicate' }] },
    { models: [{ provider: 'p', id: '', name: 'M' }] },
  ])('fails closed on malformed or ambiguous adapter metadata %#', async ({ models }) => {
    const h = fixture(); h.listModels.mockResolvedValue(models);
    await expect(listTeamModels(h.ctx)).rejects.toMatchObject({ code: 'team-agents/model-catalog-unavailable' });
  });
  it('cancels before lookup and during the SDK non-cancellable catalog promise', async () => {
    const h = fixture(); const before = new AbortController(); before.abort(new Error('Cancelled before lookup'));
    await expect(listTeamModels(h.ctx, before.signal)).rejects.toThrow('Cancelled before lookup');
    expect(h.listProviders).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    h.listModels.mockImplementation(() => new Promise((_resolve, no) => { reject = no; }));
    const during = new AbortController();
    const pending = listTeamModels(h.ctx, during.signal);
    const rejected = expect(pending).rejects.toThrow('Cancelled catalog wait');
    during.abort(new Error('Cancelled catalog wait'));
    await rejected;
    // An adapter can still settle later; the listener observes rather than leaks its rejection.
    reject(new Error('late provider error'));
    await Promise.resolve();
    expect(h.forbidden).not.toHaveBeenCalled();
  });
});
