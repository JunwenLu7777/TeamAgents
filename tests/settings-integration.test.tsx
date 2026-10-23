// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Context } from '@deepseek-ai/cordis';
import { SlotCore, resolveSlotLabel, type PropsRenderSlots, type SlotMap } from '@deepseek-ai/dsh-client-ui-slots';
import { registerTeamSettings, TeamSettingsBinding } from '../src/settings-integration.js';
import { settingsEn, type SettingsTranslate } from '../src/settings-locales.js';
import { TeamSchema, type Team } from '../src/model.js';
import type { TeamSettingsActions } from '../src/settings-contract.js';
import type { MountedTeamRemote } from '../src/remote-client.js';

const t: SettingsTranslate = (key, params = {}) => settingsEn[key].replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function team(revision = 1, ownerSessionId = 'captain'): Team {
  return TeamSchema.parse({ id: `team-${ownerSessionId}`, name: `Saved ${revision}`, goal: 'Inspect the project',
    ownerSessionId, workspaceId: 'workspace', revision, status: 'draft', createdAt: 'now', updatedAt: 'now',
    members: [{ name: 'reader', role: 'Read the project' }],
    tasks: [{ id: 'read', subject: 'Read', description: 'Read sources only', assignee: 'reader', status: 'pending', attempt: 0 }],
    messages: [] });
}
function remote(initial: Team | null = null) {
  const actions: TeamSettingsActions = {
    read: vi.fn(async () => initial),
    save: vi.fn<TeamSettingsActions['save']>(async (plan, revision) => ({ ...team((revision ?? 0) + 1), ...plan,
      tasks: plan.tasks.map(task => ({ ...task, status: 'pending', attempt: 0 })) })),
    start: vi.fn<TeamSettingsActions['start']>(async () => ({ ...team(), status: 'running' })),
    stop: vi.fn<TeamSettingsActions['stop']>(async () => ({ ...team(), status: 'paused' })),
    retry: vi.fn(async () => team(2)),
  };
  const mounted: MountedTeamRemote = { forSession: vi.fn(() => actions) };
  return { actions, mounted };
}
function binding(mounted: MountedTeamRemote, overrides: Partial<Parameters<typeof TeamSettingsBinding>[0]> = {}) {
  return <TeamSettingsBinding key={overrides.sessionId ?? 'captain'} sessionId="captain" projectedTeam={undefined}
    canRead canManage remote={mounted} t={t} {...overrides} />;
}
afterEach(cleanup);

describe('settings current-session integration', () => {
  it('does not issue reads without a current session or native read permission', () => {
    const h = remote();
    const { rerender } = render(binding(h.mounted, { sessionId: undefined }));
    expect(h.mounted.forSession).not.toHaveBeenCalled();
    expect(screen.getByText(settingsEn['session.missing'])).toBeTruthy();
    rerender(binding(h.mounted, { canRead: false, canManage: false }));
    expect(h.actions.read).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: settingsEn['save.button'] }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('cold-reads once then edits a new draft without calling models or polling', async () => {
    const h = remote(); render(binding(h.mounted));
    await waitFor(() => expect((screen.getByLabelText(settingsEn['team.name']) as HTMLInputElement).disabled).toBe(false));
    expect(h.actions.read).toHaveBeenCalledOnce();
    expect(h.actions.start).not.toHaveBeenCalled();
    expect(h.actions.save).not.toHaveBeenCalled();
  });
  it('keeps a newer projection when a slower older cold read completes', async () => {
    const h = remote(); const read = deferred<Team | null>(); vi.mocked(h.actions.read).mockReturnValueOnce(read.promise);
    render(binding(h.mounted, { projectedTeam: team(3) }));
    await act(async () => { read.resolve(team(1)); await read.promise; });
    expect((screen.getByLabelText(settingsEn['team.name']) as HTMLInputElement).value).toBe('Saved 3');
    expect(screen.getAllByText('Saved revision 3').length).toBeGreaterThan(0);
  });
  it('rejects another session snapshot instead of rendering private team data', async () => {
    const h = remote(team(1, 'other')); render(binding(h.mounted));
    await waitFor(() => expect(screen.getByText(settingsEn['error.session'])).toBeTruthy());
    expect((screen.getByLabelText(settingsEn['team.name']) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Saved revision 1')).toBeNull();
  });
  it('aborts an old-session read and ignores its late response after switching', async () => {
    const one = remote(); const old = deferred<Team | null>(); vi.mocked(one.actions.read).mockReturnValue(old.promise);
    const two = remote(team(2, 'second'));
    const mounted: MountedTeamRemote = { forSession: id => id === 'captain' ? one.actions : two.actions };
    const view = render(binding(mounted));
    await waitFor(() => expect(one.actions.read).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(one.actions.read).mock.calls[0]![0]!;
    view.rerender(binding(mounted, { sessionId: 'second' }));
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect((screen.getByLabelText(settingsEn['team.name']) as HTMLInputElement).value).toBe('Saved 2'));
    await act(async () => { old.resolve(team(99)); await old.promise; });
    expect((screen.getByLabelText(settingsEn['team.name']) as HTMLInputElement).value).toBe('Saved 2');
  });
  it('does not erase a successful save when an older null projection arrives', async () => {
    const h = remote(team()); const view = render(binding(h.mounted));
    await waitFor(() => expect(screen.getAllByText('Saved revision 1').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText(settingsEn['team.name']), { target: { value: 'Edited team' } });
    fireEvent.click(screen.getByRole('button', { name: settingsEn['save.button'] }));
    await waitFor(() => expect(screen.getAllByText('Saved revision 2').length).toBeGreaterThan(0));
    view.rerender(binding(h.mounted, { projectedTeam: null }));
    expect((screen.getByLabelText(settingsEn['team.name']) as HTMLInputElement).value).toBe('Edited team');
    expect(h.actions.start).not.toHaveBeenCalled();
  });
  it('shows native read failures and never enables a save against unknown state', async () => {
    const h = remote(); vi.mocked(h.actions.read).mockRejectedValueOnce(new Error('Host owner required'));
    render(binding(h.mounted));
    await waitFor(() => expect(screen.getByText('Host owner required')).toBeTruthy());
    expect((screen.getByRole('button', { name: settingsEn['save.button'] }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('hides the saved state and aborts pending reads when native access is revoked', async () => {
    const h = remote(team()); const read = deferred<Team | null>(); vi.mocked(h.actions.read).mockReturnValue(read.promise);
    const view = render(binding(h.mounted, { projectedTeam: team() }));
    await waitFor(() => expect(h.actions.read).toHaveBeenCalledOnce());
    const signal = vi.mocked(h.actions.read).mock.calls[0]![0]!;
    view.rerender(binding(h.mounted, { canRead: false, canManage: false }));
    expect(signal.aborted).toBe(true);
    await act(async () => { read.resolve(team()); await read.promise; });
    expect((screen.getByRole('button', { name: settingsEn['save.button'] }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('settings navigation uses actual SDK SlotCore declarations', () => {
  it('appends a distinct page after marketplace, declares current-session content, and cleans up', () => {
    const core = new SlotCore();
    function Root({ renderSlot }: PropsRenderSlots<'settings.section'>) { return renderSlot('settings.section', { close: () => {} }); }
    const removeRoot = core.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, Root);
    core.register({ name: 'settings.section', id: 'general', order: 10, label: 'General' }, () => null);
    core.register({ name: 'settings.section', id: 'marketplace', order: 5000, label: 'Plugin marketplace' }, () => null);
    const cleanups: Array<() => void> = [];
    const pending = new Map<string, { setup: () => () => void; dispose?: () => void }>();
    const register = (...args: Parameters<SlotCore['register']>) => {
      const cleanup = core.register(...args);
      for (const key of Object.keys(args[0].children ?? {})) {
        const entry = pending.get(key);
        if (entry && !entry.dispose && core.specDynamic(key)) entry.dispose = entry.setup();
      }
      return cleanup;
    };
    const unregisterLocale = vi.fn();
    const context = {
      effect: (setup: () => () => void) => { cleanups.push(setup()); },
      locale: { register: vi.fn(() => unregisterLocale), bind: () => t },
      slots: {
        entries: (key: string) => core.entries(key), register,
        inject: (key: keyof SlotMap & string, setup: () => () => void) => {
          const entry = { setup, dispose: undefined as (() => void) | undefined };
          pending.set(key, entry);
          if (core.specDynamic(key)) entry.dispose = setup();
          const dispose = () => { entry.dispose?.(); pending.delete(key); };
          cleanups.push(dispose); return dispose;
        },
      },
    } as unknown as Context;
    const h = remote();
    registerTeamSettings(context, h.mounted);
    const pages = core.entries('settings.section');
    expect(pages.map(page => page.options.id)).toEqual(['general', 'marketplace', 'dsh-team-agents']);
    expect(resolveSlotLabel(pages[2]!.options.label)).toBe('TeamAgents');
    expect(pages[2]!.options.order).toBe(5001);
    expect(core.spec('team-agents.settings.body')?.scope).toBe('session-maybe');
    expect(core.entries('team-agents.settings.body')).toHaveLength(1);
    expect(h.mounted.forSession).not.toHaveBeenCalled();
    for (const dispose of cleanups.reverse()) dispose();
    expect(core.entries('settings.section').map(page => page.options.id)).toEqual(['general', 'marketplace']);
    expect(core.spec('team-agents.settings.body')).toBeUndefined();
    expect(unregisterLocale).toHaveBeenCalledOnce();
    removeRoot();
  });
});
