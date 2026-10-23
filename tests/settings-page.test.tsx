// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, Team } from '../src/model.js';
import type { TeamSettingsActions } from '../src/settings-contract.js';
import { settingsEn, settingsLocales, settingsZh, type SettingsTranslate } from '../src/settings-locales.js';
import { TeamSettingsPage, type TeamSettingsPageProps } from '../src/settings-page.js';

afterEach(cleanup);

function translator(language: 'en' | 'zh' = 'en'): SettingsTranslate {
  return (key, params = {}) => settingsLocales[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'inspect', subject: 'Inspect the plan', description: 'Read and report findings only.', assignee: 'observer', dependencies: [], writeScopes: [], status: 'pending', attempt: 0, ...overrides };
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1', ownerSessionId: 'captain-session', workspaceId: 'workspace-1',
    name: 'Planning team', goal: 'Review a plan without changing files.', maxConcurrency: 3,
    revision: 7, status: 'draft', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z',
    members: [{ name: 'observer', role: 'Read-only analysis' }], tasks: [task()], messages: [], ...overrides,
  };
}

function mockActions(snapshot: Team | null = team()) {
  return {
    read: vi.fn<TeamSettingsActions['read']>().mockResolvedValue(snapshot),
    save: vi.fn<TeamSettingsActions['save']>().mockImplementation(async (plan, revision) => ({
      ...team(), ...plan, revision: (revision ?? 0) + 1,
      tasks: plan.tasks.map(value => ({ ...value, status: 'pending' as const, attempt: 0 })),
    })),
    start: vi.fn<TeamSettingsActions['start']>().mockResolvedValue(team({ revision: 8, status: 'running', tasks: [task({ status: 'running', attempt: 1 })] })),
    stop: vi.fn<TeamSettingsActions['stop']>().mockResolvedValue(team({ revision: 8, status: 'paused', tasks: [task({ status: 'failed', attempt: 1, error: 'Stopped by user.' })] })),
    retry: vi.fn<TeamSettingsActions['retry']>().mockResolvedValue(team({ revision: 8, tasks: [task({ attempt: 1 })] })),
  };
}

function props(overrides: Partial<TeamSettingsPageProps> = {}): TeamSettingsPageProps {
  return { sessionId: 'captain-session', canManage: true, team: team(), actions: mockActions(), t: translator(), ...overrides };
}

function field(name: string) {
  return screen.getByLabelText(name, { exact: true }) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}
function button(name: string) {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}
function change(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function confirmation(revision = 7) {
  return screen.getByRole('checkbox', { name: `I approve saved revision ${revision} and its model-call costs.` }) as HTMLInputElement;
}

function enterSmallPlan() {
  change('Team name', 'A new team');
  change('Goal', 'Read the plan and report findings.');
  change('Maximum concurrency', '2');
  fireEvent.click(button('Add member'));
  change('Member 1 · Name', 'reader');
  change('Member 1 · Role', 'Read-only review');
  change('Member 1 · Instructions (optional)', 'Do not modify files.');
  fireEvent.click(button('Add task'));
  change('Task 1 · ID', 'read-plan');
  change('Task 1 · Title', 'Read the plan');
  change('Task 1 · Description', 'Return a brief report.');
  change('Task 1 · Write scopes (advisory)', 'src/ui\ntests');
}

describe('TeamSettingsPage server rendering', () => {
  it('renders a real editable empty form without loading an example or calling actions', () => {
    const actions = mockActions(null);
    const html = renderToStaticMarkup(<TeamSettingsPage {...props({ team: null, actions })} />);
    expect(html).toContain('<form');
    expect(html).toContain('TeamAgents');
    expect(html).toContain('No members yet.');
    expect(html).toContain('Load read-only example');
    expect(html).not.toContain('Read-only workspace review');
    expect(html).not.toContain('per-member model overrides</option>');
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it('provides bilingual dictionaries with identical keys and placeholders', () => {
    expect(Object.keys(settingsZh).sort()).toEqual(Object.keys(settingsEn).sort());
    for (const key of Object.keys(settingsEn) as Array<keyof typeof settingsEn>) {
      expect((settingsZh[key].match(/\{\w+\}/g) ?? []).sort()).toEqual((settingsEn[key].match(/\{\w+\}/g) ?? []).sort());
    }
    const html = renderToStaticMarkup(<TeamSettingsPage {...props({ t: translator('zh') })} />);
    expect(html).toContain('团队配置');
    expect(html).toContain('已保存版本 7');
    expect(html).toContain('继承当前对话');
    expect(html).toContain('模型调用费用');
    expect(settingsLocales.zh.label).toBe('TeamAgents');
  });

  it('escapes projected content and scopes every stylesheet rule to the component', () => {
    const unsafe = '<script>alert("settings")</script>';
    const html = renderToStaticMarkup(<TeamSettingsPage {...props({ team: team({ name: unsafe, tasks: [task({ status: 'failed', attempt: 1, error: unsafe, output: unsafe })] }) })} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(css).toContain('@media');
    expect(css).not.toMatch(/(?:^|})\s*(?:body|html|:root|input|button)\b/);
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('draft editing and explicit execution approval', () => {
  it('saves a new plan with a null expected revision, then requires approval of its saved revision before Start', async () => {
    const actions = mockActions(null);
    render(<TeamSettingsPage {...props({ team: null, actions })} />);
    expect(button('Start').disabled).toBe(true);
    enterSmallPlan();
    expect(button('Start').disabled).toBe(true);
    fireEvent.click(button('Save plan'));
    await waitFor(() => expect(actions.save).toHaveBeenCalledOnce());
    expect(actions.save).toHaveBeenCalledWith({
      name: 'A new team', goal: 'Read the plan and report findings.', maxConcurrency: 2,
      members: [{ name: 'reader', role: 'Read-only review', instructions: 'Do not modify files.' }],
      tasks: [{ id: 'read-plan', subject: 'Read the plan', description: 'Return a brief report.', assignee: 'reader', dependencies: [], writeScopes: ['src/ui', 'tests'] }],
    }, null, expect.any(AbortSignal));
    await screen.findByText('Saved revision 1. No agents were started.');
    expect(actions.start).not.toHaveBeenCalled();
    expect(button('Save plan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);
    expect(confirmation(1).checked).toBe(false);
    fireEvent.click(confirmation(1));
    expect(button('Start').disabled).toBe(false);
    fireEvent.click(button('Start'));
    await waitFor(() => expect(actions.start).toHaveBeenCalledWith(1, expect.any(AbortSignal)));
    await screen.findByText('Execution requested for the approved revision.');
    expect((field('Team name') as HTMLInputElement).readOnly).toBe(true);
  });

  it('loads an editable three-member read-only example only on an explicit click', () => {
    const actions = mockActions(null);
    render(<TeamSettingsPage {...props({ team: null, actions })} />);
    expect(screen.queryByLabelText('Member 1 · Name')).toBeNull();
    fireEvent.click(button('Load read-only example'));
    expect(field('Team name').value).toBe('Read-only workspace review');
    expect(field('Member 1 · Name').value).toBe('observer');
    expect(field('Member 2 · Name').value).toBe('reviewer');
    expect(field('Member 3 · Name').value).toBe('summarizer');
    expect(field('Task 2 · Dependencies').value).toBe('');
    expect(field('Task 3 · Dependencies').value).toBe('inspect, review');
    expect(field('Task 1 · Description').value).toContain('current workspace');
    expect(field('Task 2 · Description').value).toContain('Independently read');
    expect(field('Task 1 · Write scopes (advisory)').value).toBe('');
    expect(field('Member 1 · Instructions (optional)').value).toContain('Do not modify files');
    change('Team name', 'Edited example');
    expect(field('Team name').value).toBe('Edited example');
    expect(button('Start').disabled).toBe(true);
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it('preserves assignment and dependency references when names or task IDs are edited and saves the current revision', async () => {
    const initial = team({ tasks: [task(), task({ id: 'review', subject: 'Review findings', dependencies: ['inspect'] })] });
    const actions = mockActions(initial);
    render(<TeamSettingsPage {...props({ team: initial, actions })} />);
    change('Member 1 · Name', 'reader');
    expect(field('Task 1 · Assignee').value).toBe('reader');
    expect(field('Task 2 · Assignee').value).toBe('reader');
    change('Task 1 · ID', 'read');
    expect(field('Task 2 · Dependencies').value).toBe('read');
    change('Task 2 · Dependencies', 'read\n');
    fireEvent.click(button('Save plan'));
    await screen.findByText('Saved revision 8. No agents were started.');
    expect(actions.save.mock.calls[0]?.[1]).toBe(7);
    expect(actions.save.mock.calls[0]?.[0].tasks[1]?.dependencies).toEqual(['read']);
    expect(actions.save.mock.calls[0]?.[0].members[0]).not.toHaveProperty('instructions');
  });

  it('adds and removes members and tasks, while keeping orphaned references visible for repair', () => {
    render(<TeamSettingsPage {...props()} />);
    fireEvent.click(button('Add member'));
    change('Member 2 · Name', 'reviewer');
    change('Member 2 · Role', 'Review');
    change('Task 1 · Assignee', 'reviewer');
    fireEvent.click(button('Remove member 2'));
    expect(field('Task 1 · Assignee').value).toBe('reviewer');
    expect(screen.getByRole('option', { name: 'Missing member: reviewer' })).toBeTruthy();
    fireEvent.click(button('Add task'));
    expect(screen.getByLabelText('Task 2 · ID')).toBeTruthy();
    fireEvent.click(button('Remove task 2'));
    expect(screen.queryByLabelText('Task 2 · ID')).toBeNull();
    fireEvent.click(button('Save plan'));
    expect(screen.getByRole('alert').textContent).toContain('Unknown member: reviewer');
  });

  it('invalidates an existing approval as soon as the draft is changed, even if the field is reverted', () => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ actions })} />);
    fireEvent.click(confirmation());
    expect(button('Start').disabled).toBe(false);
    change('Goal', 'Different goal');
    expect(confirmation().checked).toBe(false);
    expect(confirmation().disabled).toBe(true);
    change('Goal', 'Review a plan without changing files.');
    expect(button('Save plan').disabled).toBe(true);
    expect(confirmation().disabled).toBe(false);
    expect(button('Start').disabled).toBe(true);
    expect(actions.start).not.toHaveBeenCalled();
  });
});

describe('validation and access states', () => {
  it.each(['', '0', '9', '1.5'])('rejects invalid concurrency %s with an accessible form error', value => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ actions })} />);
    change('Maximum concurrency', value);
    fireEvent.click(button('Save plan'));
    expect(screen.getByRole('alert').textContent).toContain('whole number from 1 to 8');
    expect(field('Maximum concurrency').getAttribute('aria-invalid')).toBe('true');
    expect(field('Maximum concurrency').getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(actions.save).not.toHaveBeenCalled();
  });

  it('rejects empty required fields, reserved names, invalid IDs and unsafe scope paths', () => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ team: null, actions })} />);
    fireEvent.click(button('Add member'));
    change('Member 1 · Name', 'captain');
    fireEvent.click(button('Add task'));
    change('Task 1 · ID', '../escape');
    change('Task 1 · Write scopes (advisory)', '../outside\n/absolute');
    fireEvent.click(button('Save plan'));
    const error = screen.getByRole('alert').textContent;
    expect(error).toContain('Enter a team name');
    expect(error).toContain('Enter a goal');
    expect(error).toContain('other than captain');
    expect(error).toContain('Enter a role');
    expect(error).toContain('Use a unique ID');
    expect(error).toContain('normalized workspace-relative paths');
    expect(actions.save).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 'Unknown dependency: missing'],
    ['inspect', 'Task dependency cycle at inspect'],
  ])('rejects invalid dependency graph %s', (dependency, message) => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ actions })} />);
    change('Task 1 · Dependencies', dependency);
    fireEvent.click(button('Save plan'));
    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(actions.save).not.toHaveBeenCalled();
  });

  it('rejects duplicate member names and then duplicate task IDs', () => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ actions })} />);
    fireEvent.click(button('Add member'));
    change('Member 2 · Name', 'observer');
    change('Member 2 · Role', 'Second role');
    fireEvent.click(button('Save plan'));
    expect(screen.getByRole('alert').textContent).toContain('Member names must be unique');
    fireEvent.click(button('Remove member 2'));
    fireEvent.click(button('Add task'));
    change('Task 2 · ID', 'inspect');
    change('Task 2 · Title', 'Second task');
    change('Task 2 · Description', 'Second task description');
    fireEvent.click(button('Save plan'));
    expect(screen.getByRole('alert').textContent).toContain('Task IDs must be unique');
    expect(actions.save).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('does not expose mutations when canManage is %s', canManage => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ canManage, actions })} />);
    expect((field('Team name') as HTMLInputElement).readOnly).toBe(true);
    expect(button('Add member').matches(':disabled')).toBe(true);
    expect(button('Save plan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);
    expect(button('Stop team').disabled).toBe(true);
    expect(screen.getByText(/not authorized in this conversation/)).toBeTruthy();
    fireEvent.click(button('Add member'));
    expect(screen.queryByLabelText('Member 2 · Name')).toBeNull();
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it('distinguishes unresolved, unavailable, and no-session states from an empty draft', () => {
    const view = render(<TeamSettingsPage {...props({ team: undefined })} />);
    expect(screen.getByText('Loading the saved team…')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'TeamAgents' }).getAttribute('aria-busy')).toBe('true');
    expect(button('Add member').matches(':disabled')).toBe(true);
    expect(screen.queryByText('Load read-only example')).toBeNull();
    view.rerender(<TeamSettingsPage {...props({ team: null, unavailableReason: 'Plugin is unavailable.' })} />);
    expect(screen.getByRole('alert').textContent).toContain('Plugin is unavailable');
    expect(button('Save plan').disabled).toBe(true);
    view.rerender(<TeamSettingsPage {...props({ sessionId: undefined, team: null })} />);
    expect(screen.getByText('Select a conversation to configure its team.')).toBeTruthy();
    expect(button('Reload saved state').disabled).toBe(true);
    expect(button('Add member').matches(':disabled')).toBe(true);
  });

  it('keeps Start disabled for an empty saved team or only failed tasks', () => {
    const view = render(<TeamSettingsPage {...props({ team: team({ members: [], tasks: [] }) })} />);
    expect(button('Start').disabled).toBe(true);
    expect(confirmation().disabled).toBe(true);
    view.rerender(<TeamSettingsPage {...props({ team: team({ revision: 8, status: 'blocked', tasks: [task({ status: 'failed', attempt: 1 })] }) })} />);
    expect(button('Start').disabled).toBe(true);
    expect(confirmation(8).disabled).toBe(true);
    expect(screen.getByText(/No ready pending tasks/)).toBeTruthy();
  });
});

describe('snapshot conflicts and revision safety', () => {
  it('preserves dirty input when a newer snapshot arrives and explicitly discards it only after successful reload', async () => {
    const actions = mockActions();
    const initial = props({ actions });
    const view = render(<TeamSettingsPage {...initial} />);
    change('Team name', 'My unsaved title');
    const incoming = team({ name: 'Remote title', revision: 8 });
    actions.read.mockResolvedValue(incoming);
    view.rerender(<TeamSettingsPage {...initial} team={incoming} />);
    expect(field('Team name').value).toBe('My unsaved title');
    expect(screen.getByRole('alert').textContent).toContain('Your changes are preserved');
    expect(button('Save plan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);
    expect(actions.read).not.toHaveBeenCalled();
    fireEvent.click(button('Discard changes & reload'));
    await screen.findByText('Loaded the current saved state.');
    expect(actions.read).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(field('Team name').value).toBe('Remote title');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(confirmation(8).checked).toBe(false);
  });

  it('also protects a new unsaved team when a team is created elsewhere', () => {
    const initial = props({ team: null });
    const view = render(<TeamSettingsPage {...initial} />);
    change('Team name', 'Local draft');
    view.rerender(<TeamSettingsPage {...initial} team={team()} />);
    expect(field('Team name').value).toBe('Local draft');
    expect(button('Save plan').disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('saved team changed');
  });

  it('adopts clean incoming snapshots and clears approval; ignores older projections after a successful save', async () => {
    const actions = mockActions();
    const initial = props({ actions });
    const view = render(<TeamSettingsPage {...initial} />);
    fireEvent.click(confirmation());
    view.rerender(<TeamSettingsPage {...initial} team={team({ revision: 8, name: 'Remote title' })} />);
    expect(field('Team name').value).toBe('Remote title');
    expect(confirmation(8).checked).toBe(false);
    change('Team name', 'Saved locally');
    fireEvent.click(button('Save plan'));
    await screen.findByText('Saved revision 9. No agents were started.');
    view.rerender(<TeamSettingsPage {...initial} team={team({ revision: 8, name: 'Delayed projection' })} />);
    expect(field('Team name').value).toBe('Saved locally');
    expect(confirmation(9).checked).toBe(false);
  });

  it('does not let a stale save response overwrite a newer remote snapshot or the local draft', async () => {
    const delayed = deferred<Team>();
    const actions = mockActions();
    actions.save.mockReturnValue(delayed.promise);
    const initial = props({ actions });
    const view = render(<TeamSettingsPage {...initial} />);
    change('Team name', 'Local request');
    fireEvent.click(button('Save plan'));
    view.rerender(<TeamSettingsPage {...initial} team={team({ revision: 9, name: 'Newer remote plan' })} />);
    await act(async () => delayed.resolve(team({ revision: 8, name: 'Local request' })));
    expect(field('Team name').value).toBe('Local request');
    expect(screen.getByRole('alert').textContent).toContain('Your changes are preserved');
    expect(button('Save plan').disabled).toBe(true);
    expect(confirmation(9).disabled).toBe(true);
  });

  it('keeps the newer projection if a reload response is stale', async () => {
    const delayed = deferred<Team | null>();
    const actions = mockActions();
    actions.read.mockReturnValue(delayed.promise);
    const initial = props({ actions });
    const view = render(<TeamSettingsPage {...initial} />);
    fireEvent.click(button('Reload saved state'));
    view.rerender(<TeamSettingsPage {...initial} team={team({ revision: 9, name: 'Newest snapshot' })} />);
    await act(async () => delayed.resolve(team({ revision: 8, name: 'Old read response' })));
    expect(field('Team name').value).toBe('Newest snapshot');
    expect(confirmation(9).checked).toBe(false);
  });

  it('preserves the draft if a discard-and-reload request fails', async () => {
    const actions = mockActions();
    actions.read.mockRejectedValue(new Error('Read unavailable'));
    render(<TeamSettingsPage {...props({ actions })} />);
    change('Team name', 'Keep my edits');
    fireEvent.click(button('Discard changes & reload'));
    await screen.findByText('Action failed: Read unavailable');
    expect(field('Team name').value).toBe('Keep my edits');
    expect(button('Discard changes & reload').disabled).toBe(false);
  });
});

describe('async lifecycles and failure handling', () => {
  it('serializes saves, exposes busy state and preserves input when saving fails', async () => {
    const delayed = deferred<Team>();
    const actions = mockActions();
    actions.save.mockReturnValue(delayed.promise);
    render(<TeamSettingsPage {...props({ actions })} />);
    change('Team name', 'Unsaved request');
    fireEvent.click(button('Save plan'));
    fireEvent.click(button('Save plan'));
    expect(actions.save).toHaveBeenCalledOnce();
    expect(button('Save plan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);
    expect(confirmation().disabled).toBe(true);
    expect(screen.getByRole('region', { name: 'TeamAgents' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Saving plan…')).toBeTruthy();
    await act(async () => delayed.reject(new Error('Revision changed')));
    expect(screen.getByRole('alert').textContent).toContain('Revision changed');
    expect(field('Team name').value).toBe('Unsaved request');
    expect(button('Save plan').disabled).toBe(false);
  });

  it('aborts pending saves on session switch and ignores late responses even when the action ignores its signal', async () => {
    const delayed = deferred<Team>();
    const actions = mockActions();
    actions.save.mockReturnValue(delayed.promise);
    const initial = props({ actions });
    const view = render(<TeamSettingsPage {...initial} />);
    change('Team name', 'Old session draft');
    fireEvent.click(button('Save plan'));
    const signal = actions.save.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    const other = team({ id: 'other-team', ownerSessionId: 'other-session', name: 'Other conversation', revision: 2 });
    const otherActions = mockActions(other);
    view.rerender(<TeamSettingsPage {...props({ sessionId: 'other-session', team: other, actions: otherActions })} />);
    expect(signal?.aborted).toBe(true);
    expect(field('Team name').value).toBe('Other conversation');
    await act(async () => delayed.resolve(team({ name: 'Old session response', revision: 8 })));
    expect(field('Team name').value).toBe('Other conversation');
    expect(confirmation(2).checked).toBe(false);
    expect(screen.queryByText('Saved revision 8. No agents were started.')).toBeNull();
    for (const action of Object.values(otherActions)) expect(action).not.toHaveBeenCalled();
  });

  it('aborts pending reads on unmount and consumes late rejections without rendering stale errors', async () => {
    const delayed = deferred<Team | null>();
    const actions = mockActions();
    actions.read.mockReturnValue(delayed.promise);
    const view = render(<TeamSettingsPage {...props({ actions })} />);
    fireEvent.click(button('Reload saved state'));
    const signal = actions.read.mock.calls[0]?.[0];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => delayed.reject(new Error('Late aborted read')));
    expect(screen.queryByText(/Late aborted read/)).toBeNull();
  });

  it('rejects action results from another conversation without adopting their configuration', async () => {
    const actions = mockActions();
    actions.save.mockResolvedValue(team({ ownerSessionId: 'other-session', name: 'Wrong conversation', revision: 8 }));
    render(<TeamSettingsPage {...props({ actions })} />);
    change('Team name', 'My draft');
    fireEvent.click(button('Save plan'));
    await screen.findByText('Action failed: The response belongs to another conversation. Reload before continuing.');
    expect(field('Team name').value).toBe('My draft');
    expect(button('Start').disabled).toBe(true);
  });
});

describe('execution history, stop and retry', () => {
  it.each([
    team({ status: 'running' }),
    team({ tasks: [task({ attempt: 1, status: 'failed' })] }),
    team({ members: [{ name: 'observer', role: 'Review', sessionId: 'member-session' }] }),
  ])('makes configuration read-only after execution or session binding', snapshot => {
    render(<TeamSettingsPage {...props({ team: snapshot })} />);
    expect((field('Team name') as HTMLInputElement).readOnly).toBe(true);
    expect((field('Member 1 · Name') as HTMLInputElement).readOnly).toBe(true);
    expect(field('Task 1 · Assignee').matches(':disabled')).toBe(true);
    expect(button('Add task').matches(':disabled')).toBe(true);
    expect(button('Save plan').disabled).toBe(true);
    expect(screen.getByText(/Start a new conversation to replan/)).toBeTruthy();
  });

  it('stops a running team without editing its plan', async () => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ actions, team: team({ status: 'running', tasks: [task({ status: 'running', attempt: 1 })] }) })} />);
    expect(button('Stop team').disabled).toBe(false);
    fireEvent.click(button('Stop team'));
    await screen.findByText('Team stopped. Inspect partial changes before preparing retries.');
    expect(actions.stop).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(actions.save).not.toHaveBeenCalled();
    expect(button('Stop team').disabled).toBe(true);
    expect(button('Prepare retry: inspect').disabled).toBe(false);
    expect((field('Team name') as HTMLInputElement).readOnly).toBe(true);
  });

  it('prepares a failed retry with its expected revision, then requires a fresh cost confirmation and Start', async () => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ actions, team: team({ status: 'blocked', tasks: [task({ status: 'failed', attempt: 1, error: 'First attempt failed.' })] }) })} />);
    expect(button('Start').disabled).toBe(true);
    fireEvent.click(button('Prepare retry: inspect'));
    await screen.findByText('Retry prepared. Review the saved revision and approve Start to execute it.');
    expect(actions.retry).toHaveBeenCalledWith('inspect', 7, expect.any(AbortSignal));
    expect(actions.start).not.toHaveBeenCalled();
    expect(confirmation(8).checked).toBe(false);
    expect(confirmation(8).disabled).toBe(false);
    expect(button('Start').disabled).toBe(true);
    expect((field('Team name') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(confirmation(8));
    fireEvent.click(button('Start'));
    await waitFor(() => expect(actions.start).toHaveBeenCalledWith(8, expect.any(AbortSignal)));
  });

  it('shows pending dependencies, ready work and failed errors independently of the configuration', () => {
    const snapshot = team({ tasks: [task(), task({ id: 'review', dependencies: ['inspect'] }), task({ id: 'failed', status: 'failed', attempt: 1, error: 'Tool denied.' })] });
    render(<TeamSettingsPage {...props({ team: snapshot })} />);
    expect(screen.getByText('2 pending · 1 ready · 1 failed')).toBeTruthy();
    expect(screen.getByText('Ready after explicit Start approval')).toBeTruthy();
    expect(screen.getByText('Waiting for: inspect')).toBeTruthy();
    expect(screen.getByText('Tool denied.')).toBeTruthy();
    expect(button('Prepare retry: failed').disabled).toBe(false);
  });

  it.each([
    ['Member is busy', task({ id: 'waiting' }), 3],
    ['Overlapping write scope', task({ id: 'waiting', assignee: 'reviewer', writeScopes: ['src/ui'] }), 3],
    ['Concurrency limit reached', task({ id: 'waiting', assignee: 'reviewer' }), 1],
  ] as const)('does not count a pending task as ready when blocked by %s', (reason, pending, maxConcurrency) => {
    const snapshot = team({
      status: 'running', maxConcurrency,
      members: [{ name: 'observer', role: 'Inspect' }, { name: 'reviewer', role: 'Review' }],
      tasks: [task({ status: 'running', attempt: 1, writeScopes: ['src'] }), pending],
    });
    render(<TeamSettingsPage {...props({ team: snapshot })} />);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText('1 pending · 0 ready · 0 failed')).toBeTruthy();
  });

  it('keeps stop available when an external execution conflicts with an unsaved draft', async () => {
    const actions = mockActions();
    const initial = props({ actions });
    const view = render(<TeamSettingsPage {...initial} />);
    change('Team name', 'Unsaved local change');
    view.rerender(<TeamSettingsPage {...initial} team={team({ status: 'running', revision: 8, tasks: [task({ status: 'running', attempt: 1 })] })} />);
    expect(field('Team name').value).toBe('Unsaved local change');
    expect((field('Team name') as HTMLInputElement).readOnly).toBe(true);
    expect(button('Save plan').disabled).toBe(true);
    expect(button('Stop team').disabled).toBe(false);
    actions.stop.mockResolvedValue(team({ revision: 9, status: 'paused', tasks: [task({ status: 'failed', attempt: 1 })] }));
    fireEvent.click(button('Stop team'));
    await screen.findByText('Team stopped. Inspect partial changes before preparing retries.');
    expect(field('Team name').value).toBe('Unsaved local change');
    expect(screen.getByRole('alert').textContent).toContain('Your changes are preserved');
  });
});
