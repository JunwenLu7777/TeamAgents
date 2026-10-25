// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { SlotCore, resolveSlotLabel, type PropsRenderSlots, type SlotMap } from '@deepseek-ai/dsh-client-ui-slots';
import { registerTeamSettings, TeamSettingsBinding } from '../src/settings-integration.js';
import { settingsEn, type SettingsTranslate } from '../src/settings-locales.js';
import type { AgentLibrary, AgentDefinition } from '../src/library-model.js';
import type { TeamModelOption } from '../src/model.js';
import type { AgentLibraryActions } from '../src/settings-contract.js';
import { TEAM_LIBRARY_REMOTE_ENDPOINTS } from '../src/library-remote-contract.js';

const t: SettingsTranslate = (key, params = {}) => settingsEn[key].replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
const agent: AgentDefinition = { name: 'architect', role: 'Architecture review', enabled: true };
const library = (revision = 1): AgentLibrary => ({ revision, agents: [structuredClone(agent)], updatedAt: '2026-01-01T00:00:00.000Z' });
const options: TeamModelOption[] = [{ provider: 'configured', model: 'fast', providerLabel: 'Configured', modelLabel: 'Fast model' }];
function remote(snapshot = library()) {
  return {
    read: vi.fn<AgentLibraryActions['read']>().mockResolvedValue(snapshot),
    models: vi.fn<AgentLibraryActions['models']>().mockResolvedValue(options),
    save: vi.fn<AgentLibraryActions['save']>().mockImplementation(async (agents, revision) => ({ ...library(revision + 1), agents })),
  };
}
function binding(actions: AgentLibraryActions, overrides: Partial<Parameters<typeof TeamSettingsBinding>[0]> = {}) {
  return <TeamSettingsBinding canRead canReadModels canManage remote={actions} t={t} {...overrides} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(cleanup);

describe('session-independent agent library integration', () => {
  it('loads the host library and model directory once without requiring a session', async () => {
    const actions = remote(); render(binding(actions));
    await waitFor(() => expect((screen.getByLabelText('Agent 1 · Name') as HTMLInputElement).value).toBe('architect'));
    expect(actions.read).toHaveBeenCalledOnce(); expect(actions.read.mock.calls[0]).toEqual([expect.any(AbortSignal)]);
    expect(actions.models).toHaveBeenCalledOnce(); expect(actions.save).not.toHaveBeenCalled();
    expect(screen.queryByText(/Select a conversation/)).toBeNull();
  });

  it('does not read anything without library read permission', () => {
    const actions = remote(); render(binding(actions, { canRead: false, canReadModels: false, canManage: false }));
    expect(actions.read).not.toHaveBeenCalled(); expect(actions.models).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save agents' })).toBeNull();
  });

  it('reads the library without model catalog permission but never requests the forbidden catalog', async () => {
    const actions = remote(); render(binding(actions, { canReadModels: false }));
    await screen.findByLabelText('Agent 1 · Name');
    expect(actions.read).toHaveBeenCalledOnce(); expect(actions.models).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Refresh models' })).toBeNull();
  });

  it('treats revision-zero empty library as configured state rather than requiring a conversation', async () => {
    const actions = remote({ revision: 0, agents: [], updatedAt: null }); render(binding(actions));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add Architect' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add Architect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save agents' }));
    await waitFor(() => expect(actions.save).toHaveBeenCalledOnce());
    expect(actions.save.mock.calls[0]?.[1]).toBe(0);
    expect(actions.save.mock.calls[0]?.[0][0]?.name).toBe('architect');
  });

  it('refreshes models explicitly and preserves unsaved edits when refresh fails', async () => {
    const actions = remote(); render(binding(actions)); await screen.findByLabelText('Agent 1 · Role');
    fireEvent.change(screen.getByLabelText('Agent 1 · Role'), { target: { value: 'Keep my edits' } });
    actions.models.mockRejectedValueOnce(new Error('Catalog unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await screen.findByText('Could not load configured models: Catalog unavailable');
    expect((screen.getByLabelText('Agent 1 · Role') as HTMLInputElement).value).toBe('Keep my edits');
    actions.models.mockResolvedValue(options);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await waitFor(() => expect(screen.queryByText('Could not load configured models: Catalog unavailable')).toBeNull());
    expect(actions.read).toHaveBeenCalledOnce(); expect(actions.save).not.toHaveBeenCalled();
  });

  it('does not refetch or reset drafts on unrelated rerenders such as conversation selection', async () => {
    const actions = remote(); const view = render(binding(actions)); await screen.findByLabelText('Agent 1 · Role');
    fireEvent.change(screen.getByLabelText('Agent 1 · Role'), { target: { value: 'Reusable role' } });
    view.rerender(binding(actions, { t: (key, params) => t(key, params) }));
    expect(actions.read).toHaveBeenCalledOnce(); expect(actions.models).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Agent 1 · Role') as HTMLInputElement).value).toBe('Reusable role');
  });

  it('preserves pending writes and adopts the saved revision through the shared library state', async () => {
    const actions = remote(); render(binding(actions)); await screen.findByLabelText('Agent 1 · Role');
    fireEvent.change(screen.getByLabelText('Agent 1 · Role'), { target: { value: 'New reusable role' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agents' }));
    await screen.findByText('Saved library revision 2. Use these agents from a conversation.');
    expect((screen.getByLabelText('Agent 1 · Role') as HTMLInputElement).value).toBe('New reusable role');
    expect((screen.getByRole('button', { name: 'Save agents' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('aborts pending catalog/library reads and hides all private data on revocation', async () => {
    const pendingModels = deferred<TeamModelOption[]>(); const actions = remote(); actions.models.mockReturnValue(pendingModels.promise);
    const view = render(binding(actions)); await screen.findByLabelText('Agent 1 · Name');
    const readSignal = actions.read.mock.calls[0]![0]!; const catalogSignal = actions.models.mock.calls[0]![0]!;
    fireEvent.change(screen.getByLabelText('Agent 1 · Role'), { target: { value: 'PRIVATE DRAFT' } });
    view.rerender(binding(actions, { canRead: false, canReadModels: false, canManage: false }));
    expect(readSignal.aborted).toBe(true); expect(catalogSignal.aborted).toBe(true);
    expect(screen.queryByDisplayValue('PRIVATE DRAFT')).toBeNull(); expect(screen.queryByLabelText('Agent 1 · Name')).toBeNull();
    await act(async () => pendingModels.resolve(options)); expect(screen.queryByRole('option', { name: 'Fast model' })).toBeNull();
  });

  it('distinguishes a failed library read from an empty writable library and permits retry', async () => {
    const actions = remote(); actions.read.mockRejectedValueOnce(new Error('Library unavailable'));
    render(binding(actions)); await screen.findByText('Library unavailable');
    expect((screen.getByRole('button', { name: 'Add Architect' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload library' }));
    await screen.findByLabelText('Agent 1 · Name');
    expect((screen.getByRole('button', { name: 'Add Architect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('aborts pending reads on unmount and consumes late rejections', async () => {
    const pending = deferred<AgentLibrary>(); const actions = remote(); actions.read.mockReturnValue(pending.promise);
    const view = render(binding(actions)); await waitFor(() => expect(actions.read).toHaveBeenCalledOnce());
    const signal = actions.read.mock.calls[0]![0]!; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new Error('Late read')));
    expect(screen.queryByText('Late read')).toBeNull();
  });
});

describe('root-scoped settings contribution', () => {
  it('renders the registered section without ever touching SessionProvider or projection hooks', async () => {
    const components = new Map<string, ComponentType<any>>();
    const declarations = new Map<string, any>();
    const ctx = { effect: (setup: () => unknown) => setup(), locale: { register: () => () => {}, bind: () => t },
      slots: { entries: () => [], inject: (_name: string, setup: () => unknown) => setup(),
        register: (spec: { name: string }, component: ComponentType<any>) => { components.set(spec.name, component); declarations.set(spec.name, spec); return () => {}; } } } as unknown as Context;
    const actions = remote(); registerTeamSettings(ctx, actions);
    const Section = components.get('settings.section')!, Body = components.get('team-agents.settings.body')!;
    const forbiddenSession = vi.fn(() => { throw new Error('Settings must not use a session'); });
    const access = vi.fn(() => true);
    render(<Section SessionProvider={forbiddenSession} t={t} renderSlot={() => <Body useRemoteAccess={access} useAccess={forbiddenSession} useProjection={forbiddenSession} t={t} />} />);
    await screen.findByLabelText('Agent 1 · Name');
    expect(forbiddenSession).not.toHaveBeenCalled();
    expect(declarations.get('settings.section').children['team-agents.settings.body'].scope).toBe('root');
    expect(new Set(access.mock.calls.map(call => (call as unknown[])[0]))).toEqual(new Set(Object.values(TEAM_LIBRARY_REMOTE_ENDPOINTS)));
    expect(actions.read).toHaveBeenCalledOnce();
  });

  it('appends one distinct settings page using actual SlotCore and cleans up its declarations', () => {
    const core = new SlotCore();
    function Root({ renderSlot }: PropsRenderSlots<'settings.section'>) { return renderSlot('settings.section', { close: () => {} }); }
    const removeRoot = core.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, Root);
    core.register({ name: 'settings.section', id: 'general', order: 10, label: 'General' }, () => null);
    core.register({ name: 'settings.section', id: 'marketplace', order: 5000, label: 'Plugin marketplace' }, () => null);
    const cleanups: Array<() => void> = []; const pending = new Map<string, { setup: () => () => void; dispose?: () => void }>();
    const register = (...args: Parameters<SlotCore['register']>) => {
      const cleanup = core.register(...args);
      for (const key of Object.keys(args[0].children ?? {})) { const item = pending.get(key); if (item && !item.dispose && core.specDynamic(key)) item.dispose = item.setup(); }
      return cleanup;
    };
    const ctx = { effect: (setup: () => () => void) => cleanups.push(setup()), locale: { register: () => () => {}, bind: () => t },
      slots: { entries: (key: string) => core.entries(key), register,
        inject: (key: keyof SlotMap & string, setup: () => () => void) => {
          const item = { setup, dispose: undefined as (() => void) | undefined }; pending.set(key, item);
          if (core.specDynamic(key)) item.dispose = setup();
          const dispose = () => { item.dispose?.(); pending.delete(key); }; cleanups.push(dispose); return dispose;
        } } } as unknown as Context;
    registerTeamSettings(ctx, remote());
    const pages = core.entries('settings.section');
    expect(pages.map(page => page.options.id)).toEqual(['general', 'marketplace', 'dsh-team-agents']);
    expect(resolveSlotLabel(pages[2]!.options.label)).toBe('TeamAgents'); expect(pages[2]!.options.order).toBe(5001);
    expect(core.spec('team-agents.settings.body')?.scope).toBe('root');
    for (const cleanup of cleanups.reverse()) cleanup();
    expect(core.entries('settings.section').map(page => page.options.id)).toEqual(['general', 'marketplace']);
    expect(core.spec('team-agents.settings.body')).toBeUndefined(); removeRoot();
  });
});
