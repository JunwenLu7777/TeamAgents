// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render as renderDom, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../src/client.js';
import { TeamDashboard } from '../src/dashboard.js';
import { en, locales, zh, type TeamTranslate } from '../src/locales.js';
import type { Task, Team } from '../src/model.js';
import type { TeamSettingsActions } from '../src/settings-contract.js';
import { mountTeamRemote } from '../src/remote-client.js';
import { mountAgentLibraryRemote } from '../src/library-remote-client.js';
import { registerTeamSettings } from '../src/settings-integration.js';

// View glue stays independently testable; separate suites exercise real settings and Gateway wiring.
vi.mock('../src/remote-client.js', () => ({ mountTeamRemote: vi.fn(async () => ({ forSession: vi.fn(() => ({ stop: vi.fn() })) })) }));
vi.mock('../src/library-remote-client.js', () => ({ mountAgentLibraryRemote: vi.fn(async () => ({ read: vi.fn(), models: vi.fn(), save: vi.fn() })) }));
vi.mock('../src/settings-integration.js', () => ({ registerTeamSettings: vi.fn() }));

afterEach(cleanup);

function translator(language: 'en' | 'zh' = 'en'): TeamTranslate {
  return (key, params = {}) => locales[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'design', subject: 'Design the interface', description: 'Document the layout.',
    assignee: 'designer', dependencies: [], writeScopes: ['src/ui'],
    status: 'pending', attempt: 0, ...overrides,
  };
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1', ownerSessionId: 'captain-session', workspaceId: 'workspace-1',
    name: 'Release crew', goal: 'Ship a clear, usable release.', maxConcurrency: 3,
    revision: 7, status: 'running', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z',
    members: [{ name: 'designer', role: 'Interface design' }, { name: 'tester', role: 'Verification' }],
    tasks: [
      task({ id: 'plan', status: 'completed', output: 'Plan agreed.', writeScopes: [] }),
      task({ status: 'running', attempt: 1, dependencies: ['plan'] }),
      task({ id: 'verify', subject: 'Verify the release', assignee: 'tester', dependencies: ['design'], writeScopes: ['tests'] }),
      task({ id: 'preview', subject: 'Preview the release', assignee: 'tester', status: 'failed', error: 'Preview failed.', attempt: 1, writeScopes: [] }),
    ],
    messages: [], ...overrides,
  };
}

function render(value: Team | null | undefined, language: 'en' | 'zh' = 'en') {
  return renderToStaticMarkup(<TeamDashboard team={value} t={translator(language)} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function showPanel() {
  const panel = document.querySelector<HTMLDetailsElement>('details.dsh-team-agents');
  if (panel) panel.open = true;
}

function stopActions() {
  return { stop: vi.fn<TeamSettingsActions['stop']>().mockResolvedValue(team({ status: 'paused', revision: 8 })) };
}

describe('TeamDashboard', () => {
  it.each([null, undefined])('does not occupy the composer without a projection (%s)', value => {
    expect(render(value)).toBe('');
  });

  it('shows snapshot progress, member activity, dependency IDs, and advisory scopes', () => {
    const html = render(team());
    expect(html).toContain('Release crew');
    expect(html).toContain('Revision 7');
    expect(html).toContain('1/4 done');
    expect(html).toContain('value="1" max="4"');
    expect(html).toContain('aria-label="1 of 4 tasks completed"');
    expect(html).toContain('1 running');
    expect(html).toContain('1 pending');
    expect(html).toContain('1 failed');
    expect(html).toMatch(/data-status="active">Active/);
    expect(html).toMatch(/data-status="idle">Idle/);
    expect(html).toContain('Working on design');
    expect(html).toContain('<code class="dta-tag">plan</code>');
    expect(html).toContain('Waiting for: design');
    expect(html).toContain('Write scopes · advisory');
    expect(html).toContain('<code class="dta-tag">src/ui</code>');
    expect(html).toContain('not filesystem permissions');
  });

  it('starts collapsed, uses native disclosures for results, and is read-only without stop authority', () => {
    const html = render(team());
    const disclosures = html.match(/<details\b[^>]*>/g) ?? [];
    expect(disclosures.length).toBeGreaterThan(3);
    expect(disclosures.every(tag => !/\bopen(?:\s|=|>)/.test(tag))).toBe(true);
    expect(html).toMatch(/<details class="dta-result"><summary>Output<\/summary><pre[^>]*>Plan agreed\.<\/pre>/);
    expect(html).toMatch(/<details class="dta-result"><summary>Error<\/summary><pre[^>]*>Preview failed\.<\/pre>/);
    expect(html).toContain('Manage this team in chat.');
    expect(html).not.toMatch(/<(?:button|input|form|script|iframe)\b/);
  });

  it('handles an empty draft with determinate zero progress', () => {
    const html = render(team({ status: 'draft', tasks: [], members: [] }));
    expect(html).toContain('Draft');
    expect(html).toContain('0/0 done');
    expect(html).toContain('value="0" max="1"');
    expect(html).toContain('No members yet.');
    expect(html).toContain('No tasks yet. Plan the work in chat.');
    expect(html).toContain('No team messages yet.');
    expect(html).not.toContain('NaN');
  });

  it.each(['draft', 'running', 'paused', 'blocked', 'completed'] as const)('translates the %s team status', status => {
    expect(render(team({ status }))).toContain(`data-status="${status}">${en[`status.${status}`]}`);
    expect(render(team({ status }), 'zh')).toContain(`data-status="${status}">${zh[`status.${status}`]}`);
  });

  it('uses bilingual copy with matching dictionary keys and interpolation parameters', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect((zh[key].match(/\{\w+\}/g) ?? []).sort()).toEqual((en[key].match(/\{\w+\}/g) ?? []).sort());
    }
    const html = render(team(), 'zh');
    expect(html).toContain('版本 7');
    expect(html).toContain('已完成 1/4');
    expect(html).toContain('工作中');
    expect(html).toContain('空闲');
    expect(html).toContain('等待前置任务：design');
    expect(html).toContain('写入范围 · 约定');
    expect(html).toContain('在对话中管理团队。');
    expect(html).not.toContain('Manage this team');
  });

  it('escapes all projected text, including failed errors and completed outputs', () => {
    const unsafe = '<script>alert("team")</script><img src=x onerror=alert(1)>';
    const html = render(team({
      name: unsafe, goal: unsafe,
      members: [{ name: 'designer', role: unsafe }],
      tasks: [task({ subject: unsafe, description: unsafe, status: 'failed', error: unsafe }), task({ id: 'done', status: 'completed', output: unsafe })],
      messages: [{ id: 'message', from: unsafe, to: 'designer', text: unsafe, createdAt: '2026-10-23T01:00:00.000Z' }],
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;team&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows at most six recent messages, newest first, without mutating the snapshot', () => {
    const snapshot = team({ messages: Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index}`, from: 'captain', to: 'designer', text: `Message text ${index}`,
      createdAt: '2026-10-23T01:00:00.000Z', deliveredAt: index === 7 ? '2026-10-23T01:01:00.000Z' : undefined,
    })) });
    const before = structuredClone(snapshot);
    const html = render(snapshot);
    expect(html).toContain('Latest 6 of 8');
    expect(html).not.toContain('Message text 0');
    expect(html).not.toContain('Message text 1');
    expect(html.indexOf('Message text 7')).toBeLessThan(html.indexOf('Message text 6'));
    expect(html).toContain('Delivered');
    expect(html).toContain('Queued');
    expect(html).toContain('dateTime="2026-10-23T01:00:00.000Z"');
    expect(snapshot).toEqual(before);
  });

  it('shows explicit empty results when the host recorded no error or output text', () => {
    const html = render(team({ tasks: [task({ status: 'failed' }), task({ id: 'done', status: 'completed', output: '' })] }));
    expect(html).toContain('No error details recorded.');
    expect(html).toContain('No output recorded.');
  });
});

describe('conversation-only explicit Stop', () => {
  it('shows selected model routes and inherited routes from this session snapshot', () => {
    const snapshot = team({ members: [
      { name: 'designer', role: 'Design', model: { provider: 'saved-provider', model: 'saved-model' } },
      { name: 'tester', role: 'Test' },
    ] });
    expect(render(snapshot)).toContain('Ship a clear, usable release.');
    expect(render(snapshot)).toContain('Model: saved-provider / saved-model');
    expect(render(snapshot)).toContain('Model: inherit captain');
    expect(render(snapshot, 'zh')).toContain('模型：saved-provider / saved-model');
    expect(render(snapshot, 'zh')).toContain('模型：继承主会话');
  });

  it.each(['draft', 'paused', 'blocked', 'completed'] as const)('never offers Stop or Start for a %s team', status => {
    const actions = stopActions();
    const html = renderToStaticMarkup(<TeamDashboard sessionId="captain-session" team={team({ status })} canStop actions={actions} t={translator()} />);
    expect(html).not.toContain('<button'); expect(actions.stop).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('requires affirmative host access before showing Stop (%s)', canStop => {
    const actions = stopActions();
    const html = renderToStaticMarkup(<TeamDashboard sessionId="captain-session" team={team()} canStop={canStop} actions={actions} t={translator()} />);
    expect(html).not.toContain('<button'); expect(actions.stop).not.toHaveBeenCalled();
  });

  it('requires the matching owner session and does not display foreign projected state', () => {
    const actions = stopActions();
    expect(renderToStaticMarkup(<TeamDashboard team={team()} canStop actions={actions} t={translator()} />)).not.toContain('<button');
    expect(renderToStaticMarkup(<TeamDashboard sessionId="other-session" team={team()} canStop actions={actions} t={translator()} />)).toBe('');
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it('calls only Stop on an explicit click, blocks duplicate clicks, and accepts the returned paused snapshot', async () => {
    const pending = deferred<Team>();
    const actions = { stop: vi.fn<TeamSettingsActions['stop']>().mockReturnValue(pending.promise) };
    const snapshot = team();
    const view = renderDom(<TeamDashboard sessionId="captain-session" team={snapshot} canStop actions={actions} t={translator()} />);
    showPanel();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(actions.stop).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Stop team' }) as HTMLButtonElement;
    fireEvent.click(button); fireEvent.click(button);
    expect(actions.stop).toHaveBeenCalledOnce();
    expect(actions.stop).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(button.disabled).toBe(true); expect(button.textContent).toBe('Stopping…');
    await act(async () => pending.resolve(team({ status: 'paused', revision: 8 })));
    expect(document.querySelector('.dta-identity [data-status="paused"]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(<TeamDashboard sessionId="captain-session" team={{ ...snapshot }} canStop actions={actions} t={translator()} />);
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(<TeamDashboard sessionId="captain-session" team={team({ revision: 9 })} canStop actions={actions} t={translator()} />);
    expect(screen.getByRole('button', { name: 'Stop team' })).not.toBeNull();
  });

  it('shows a safe error and allows another explicit Stop after a failed request', async () => {
    const actions = stopActions();
    actions.stop.mockRejectedValueOnce(new Error('<img src=x onerror=alert(1)>'));
    renderDom(<TeamDashboard sessionId="captain-session" team={team()} canStop actions={actions} t={translator()} />);
    showPanel(); fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect((screen.getByRole('button', { name: 'Stop team' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(actions.stop).toHaveBeenCalledTimes(2);
  });

  it('rejects a stop response for another team without replacing the visible plan', async () => {
    const actions = stopActions();
    actions.stop.mockResolvedValue(team({ id: 'foreign-team', name: 'Foreign name', status: 'paused', revision: 100 }));
    renderDom(<TeamDashboard sessionId="captain-session" team={team()} canStop actions={actions} t={translator()} />);
    showPanel(); fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('does not match this team');
    expect(screen.queryByText('Foreign name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop team' })).not.toBeNull();
  });

  it.each(['unmount', 'switch', 'revoke', 'remove'] as const)('cancels an in-flight request on %s and ignores late completion', async transition => {
    const pending = deferred<Team>();
    const actions = { stop: vi.fn<TeamSettingsActions['stop']>().mockReturnValue(pending.promise) };
    const view = renderDom(<TeamDashboard sessionId="captain-session" team={team()} canStop actions={actions} t={translator()} />);
    showPanel(); fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    const signal = actions.stop.mock.calls[0]![0]!;
    if (transition === 'unmount') view.unmount();
    else if (transition === 'switch') view.rerender(<TeamDashboard sessionId="other-session"
      team={team({ id: 'other-team', ownerSessionId: 'other-session', name: 'Other crew' })} canStop actions={stopActions()} t={translator()} />);
    else if (transition === 'revoke') view.rerender(<TeamDashboard sessionId="captain-session" team={team()} canStop={false} actions={actions} t={translator()} />);
    else view.rerender(<TeamDashboard sessionId="captain-session" team={null} canStop actions={actions} t={translator()} />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(team({ name: 'Late response', status: 'paused', revision: 100 })));
    expect(screen.queryByText('Late response')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    if (transition === 'switch') expect(screen.getByText('Other crew')).not.toBeNull();
  });

  it('translates Stop without introducing a Start or configuration form', () => {
    const actions = stopActions();
    const html = renderToStaticMarkup(<TeamDashboard sessionId="captain-session" team={team()} canStop actions={actions} t={translator('zh')} />);
    expect(html).toContain('停止团队');
    expect(html).not.toMatch(/<(?:form|input|select|textarea)\b/);
    expect(html).not.toContain('Start'); expect(actions.stop).not.toHaveBeenCalled();
  });
});

describe('pending explanations', () => {
  const running = task({ id: 'active', status: 'running', assignee: 'tester', writeScopes: ['src'] });

  it('prioritizes unfinished and missing dependencies over other blockers', () => {
    const html = render(team({ maxConcurrency: 1, tasks: [running, task({ dependencies: ['active', 'missing'] })] }));
    expect(html).toContain('Waiting for: active, missing');
    expect(html).not.toContain('Overlapping write scope</dd>');
  });

  it('waits for a member before considering scope or capacity conflicts', () => {
    const html = render(team({ maxConcurrency: 1, tasks: [running, task({ assignee: 'tester' })] }));
    expect(html).toContain('Member is busy');
    expect(html).not.toContain('Concurrency limit reached</dd>');
  });

  it.each([
    ['src', 'src/ui'], ['src/ui', 'src'], ['src', 'src'], ['.', 'docs'], ['docs', '.'],
  ])('explains overlapping scope %s and %s', (left, right) => {
    expect(render(team({ tasks: [{ ...running, writeScopes: [left] }, task({ writeScopes: [right] })] }))).toContain('Overlapping write scope');
  });

  it('treats sibling path prefixes as distinct scopes', () => {
    const html = render(team({ tasks: [{ ...running, writeScopes: ['src/ui'] }, task({ writeScopes: ['src/ui-kit'] })] }));
    expect(html).toContain('Ready; waiting for the scheduler');
    expect(html).not.toContain('Overlapping write scope</dd>');
  });

  it('explains the concurrency limit for otherwise independent tasks', () => {
    expect(render(team({ maxConcurrency: 1, tasks: [running, task({ writeScopes: ['docs'] })] }))).toContain('Concurrency limit reached');
  });

  it.each(['draft', 'paused', 'blocked', 'completed'] as const)('does not describe a %s team as ready to run', status => {
    expect(render(team({ status, tasks: [task()] }))).toContain('Team is not running');
  });

  it('does not block on completed dependencies or empty scope declarations', () => {
    const html = render(team({ tasks: [running, task({ id: 'done', status: 'completed' }), task({ dependencies: ['done'], writeScopes: [] })] }));
    expect(html).toContain('Ready; waiting for the scheduler');
    expect(html).toContain('No scopes declared');
  });
});

describe('current DSH client integration', () => {
  it('waits for the native conversation view and uses its projection and locale seats', async () => {
    const disposeLocale = vi.fn();
    const disposeSlot = vi.fn();
    const effects: Array<() => void> = [];
    let install: (() => () => void) | undefined;
    const register = vi.fn((_options: unknown, _component: unknown) => disposeSlot);
    const registerLocale = vi.fn(() => disposeLocale);
    const context = {
      effect(setup: () => () => void) { effects.push(setup()); },
      locale: { register: registerLocale },
      slots: {
        entries: vi.fn(() => [{ options: { id: 'agent-team', order: 40 } }]),
        inject: vi.fn((_key: string, callback: () => () => void) => { install = callback; return () => {}; }),
        register,
      },
    };
    await apply(context as unknown as Context);
    expect(inject).toEqual(expect.arrayContaining(['slots', 'locale', 'uiSession']));
    expect(registerLocale).toHaveBeenCalledWith('team-agents', locales);
    expect(context.slots.inject).toHaveBeenCalledWith('conversation.view', expect.any(Function));
    expect(register).not.toHaveBeenCalled();

    const dispose = install!();
    expect(register).toHaveBeenCalledWith({ name: 'conversation.view', id: 'dsh-team-agents', label: 'TeamAgents', order: 1001, locale: 'team-agents' }, expect.any(Function));
    const Slot = register.mock.calls[0]![1] as ComponentType<{ sessionId: string; useAccess: (endpoint: string) => boolean; useProjection: (key: 'team-agents') => Team | null | undefined; t: TeamTranslate }>;
    const projection = vi.fn((_key: 'team-agents'): Team | null | undefined => team());
    const useAccess = vi.fn((_endpoint: string) => false);
    expect(renderToStaticMarkup(<Slot sessionId="captain-session" useAccess={useAccess} useProjection={projection} t={translator()} />)).toContain('Release crew');
    expect(projection).toHaveBeenCalledWith('team-agents');
    expect(useAccess).toHaveBeenCalledWith('teamAgents/stop');
    expect(mountTeamRemote).toHaveBeenCalledWith(context);
    expect(mountAgentLibraryRemote).toHaveBeenCalledWith(context);
    const library = await vi.mocked(mountAgentLibraryRemote).mock.results.at(-1)!.value;
    expect(registerTeamSettings).toHaveBeenCalledWith(context, library);
    projection.mockReturnValue(null);
    expect(renderToStaticMarkup(<Slot sessionId="captain-session" useAccess={useAccess} useProjection={projection} t={translator()} />)).toContain('No TeamAgents team has been created');
    dispose();
    for (const cleanup of effects) cleanup();
    expect(disposeSlot).toHaveBeenCalledOnce();
    expect(disposeLocale).toHaveBeenCalledOnce();
  });

  it('binds only Stop to the active session and the native stop ACL, not to global library settings', async () => {
    const stop = vi.fn(async (_sessionId: string, _signal?: AbortSignal) => team({ status: 'paused', revision: 8 }));
    const otherActions = {
      read: vi.fn<TeamSettingsActions['read']>(), models: vi.fn<TeamSettingsActions['models']>(),
      save: vi.fn<TeamSettingsActions['save']>(), start: vi.fn<TeamSettingsActions['start']>(), retry: vi.fn<TeamSettingsActions['retry']>(),
    };
    const forSession = vi.fn((sessionId: string): TeamSettingsActions => ({
      ...otherActions, stop: signal => stop(sessionId, signal),
    }));
    vi.mocked(mountTeamRemote).mockResolvedValueOnce({ forSession });
    let install!: () => unknown;
    const register = vi.fn((_options: unknown, _component: unknown) => () => {});
    const ctx = { effect: (setup: () => () => void) => setup(), locale: { register: vi.fn(() => () => {}) },
      slots: { entries: () => [], inject: vi.fn((_key: string, callback: () => unknown) => { install = callback; }), register } };
    await apply(ctx as unknown as Context); install();
    const Slot = register.mock.calls[0]![1] as ComponentType<{ sessionId: string; useAccess: (endpoint: string) => boolean;
      useProjection: (key: 'team-agents') => Team; t: TeamTranslate }>;
    const useAccess = vi.fn((_endpoint: string) => false);
    const useProjection = vi.fn(() => team());
    const view = renderDom(<Slot sessionId="captain-session" useAccess={useAccess} useProjection={useProjection} t={translator()} />);
    showPanel(); expect(screen.queryByRole('button')).toBeNull();
    expect(forSession).toHaveBeenCalledWith('captain-session'); expect(stop).not.toHaveBeenCalled();
    useAccess.mockReturnValue(true);
    view.rerender(<Slot sessionId="captain-session" useAccess={useAccess} useProjection={useProjection} t={translator()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith('captain-session', expect.any(AbortSignal)));
    expect(useAccess.mock.calls.every(([endpoint]) => endpoint === 'teamAgents/stop')).toBe(true);
    expect(forSession).toHaveBeenCalledOnce();
    for (const action of Object.values(otherActions)) expect(action).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });
});
