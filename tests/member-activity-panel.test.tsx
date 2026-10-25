// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TeamDashboard } from '../src/dashboard.js';
import { MemberActivityPanel, activityDuration } from '../src/member-activity-panel.js';
import { TeamSchema } from '../src/model.js';
import type { MemberActivity } from '../src/member-activity-contract.js';
import { en, zh, type TeamTranslate } from '../src/locales.js';
const t: TeamTranslate = (key, params = {}) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
function frame(overrides: Partial<MemberActivity> = {}): MemberActivity {
  return { ownerSessionId: 'captain', teamId: 'team', member: 'reader', childSessionId: 'child', sequence: 1,
    cursor: 3, observedAt: Date.now(), status: 'running', phase: 'tool', live: true, startedAt: Date.now() - 1500,
    endedAt: null, elapsedMs: 1500, lastActivityAt: Date.now(), task: { id: 'read', subject: 'Read sources', status: 'running' },
    entries: [{ id: 'event-3', seq: 3, time: Date.now(), kind: 'tool', label: 'read', text: '', arguments: '{"file_path":"README.md"}', truncated: false, status: 'running' }],
    historyTruncated: false, liveOutput: 'Inspecting the code…', liveTruncated: false, livePartial: false, ...overrides };
}
function fixture() {
  const subscriptions: Array<{ signal?: AbortSignal; push(value: MemberActivity): void; fail(error: Error): void }> = [];
  const closed = vi.fn();
  const watch = vi.fn(async function* (_member: string, signal?: AbortSignal) {
    const queue: MemberActivity[] = [];
    let wake: (() => void) | undefined; let failure: Error | undefined;
    const notify = () => { const fn = wake; wake = undefined; fn?.(); };
    subscriptions.push({ signal, push(value) { queue.push(value); notify(); }, fail(error) { failure = error; notify(); } });
    signal?.addEventListener('abort', notify, { once: true });
    try {
      while (!signal?.aborted) {
        if (!queue.length && !failure) await new Promise<void>(resolve => { wake = resolve; });
        if (signal?.aborted) return;
        if (failure) throw failure;
        const next = queue.shift(); if (next) yield next;
      }
    } finally { signal?.removeEventListener('abort', notify); closed(); }
  });
  const stop = vi.fn();
  const team = TeamSchema.parse({ id: 'team', ownerSessionId: 'captain', workspaceId: 'workspace', revision: 1,
    name: 'Activity team', goal: 'Inspect', status: 'running', createdAt: 'now', updatedAt: 'now',
    members: [{ name: 'reader', role: 'Read source', sessionId: 'child' }, { name: 'tester', role: 'Test', sessionId: 'other-child' }],
    tasks: [{ id: 'read', subject: 'Read sources', description: 'Inspect', assignee: 'reader', status: 'running', attempt: 1 }], messages: [],
  });
  const actions = { stop, watchMember: watch };
  return { team, watch, stop, actions, subscriptions, closed };
}
afterEach(cleanup);

describe('member activity detail UI', () => {
  it('requires explicit selection and affirmative authority, without starting or stopping any work', async () => {
    const h = fixture();
    const view = render(<TeamDashboard team={h.team} sessionId="captain" presentation="page" actions={h.actions} canInspect={false} t={t} />);
    expect(screen.queryByRole('button', { name: 'View activity: reader' })).toBeNull(); expect(h.watch).not.toHaveBeenCalled();
    view.rerender(<TeamDashboard team={h.team} sessionId="captain" presentation="page" actions={h.actions} canInspect t={t} />);
    expect(h.watch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View activity: reader' }));
    expect(h.watch).toHaveBeenCalledWith('reader', expect.any(AbortSignal));
    await act(async () => h.subscriptions[0]!.push(frame()));
    expect(screen.getByText('Inspecting the code…')).toBeTruthy(); expect(screen.getByText(/Tool: read/)).toBeTruthy();
    expect(screen.getByText('{"file_path":"README.md"}')).toBeTruthy(); expect(screen.getByText('00:01')).toBeTruthy();
    expect(h.stop).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close member details' }));
    expect(h.subscriptions[0]!.signal?.aborted).toBe(true); await waitFor(() => expect(h.closed).toHaveBeenCalledOnce());
  });
  it('renders new stream frames and the concrete failure reason, not an endless running spinner', async () => {
    const h = fixture(); render(<MemberActivityPanel ownerSessionId="captain" teamId="team" member={h.team.members[0]!} watch={h.watch} t={t} onClose={vi.fn()} />);
    await act(async () => h.subscriptions[0]!.push(frame()));
    await act(async () => h.subscriptions[0]!.push(frame({ sequence: 2, live: false, status: 'failed', phase: 'idle', elapsedMs: 1200000,
      task: { id: 'read', subject: 'Read sources', status: 'failed', error: 'Task deadline exceeded' },
      entries: [{ id: 'event-4', seq: 4, time: Date.now(), kind: 'error', label: 'turn/error', text: 'Provider failed', truncated: false }] })));
    expect(screen.getByText('Task deadline exceeded')).toBeTruthy(); expect(screen.getByText('Provider failed')).toBeTruthy();
    expect(screen.getByText('20:00')).toBeTruthy(); expect(screen.queryByRole('heading', { name: 'Live public output' })).toBeNull();
  });
  it('exposes an explicit reconnect on transport failure, without retry loops', async () => {
    const h = fixture(); render(<MemberActivityPanel ownerSessionId="captain" teamId="team" member={h.team.members[0]!} watch={h.watch} t={t} onClose={vi.fn()} />);
    await act(async () => h.subscriptions[0]!.fail(new Error('Connection lost')));
    expect(screen.getByRole('alert').textContent).toContain('Connection lost'); expect(h.watch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(h.watch).toHaveBeenCalledTimes(2); expect(h.subscriptions[0]!.signal?.aborted).toBe(true);
    await act(async () => h.subscriptions[1]!.push(frame()));
    expect(screen.getByRole('status').textContent).toContain('Connected'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('labels a disconnected running snapshot as stale instead of claiming continued execution', async () => {
    const h = fixture(); render(<MemberActivityPanel ownerSessionId="captain" teamId="team" member={h.team.members[0]!} watch={h.watch} t={t} onClose={vi.fn()} />);
    await act(async () => h.subscriptions[0]!.push(frame()));
    await act(async () => h.subscriptions[0]!.fail(new Error('Transport disconnected')));
    expect(screen.getByText(/last observed state, not confirmation/)).toBeTruthy();
    expect(h.watch).toHaveBeenCalledOnce();
  });
  it.each(['member', 'session', 'revoke', 'unmount'] as const)('cancels and isolates old data after %s changes', async transition => {
    const h = fixture(); const view = render(<TeamDashboard team={h.team} sessionId="captain" presentation="page" actions={h.actions} canInspect t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'View activity: reader' }));
    await act(async () => h.subscriptions[0]!.push(frame()));
    if (transition === 'member') fireEvent.click(screen.getByRole('button', { name: 'View activity: tester' }));
    if (transition === 'session') view.rerender(<TeamDashboard team={{ ...h.team, id: 'new-team', ownerSessionId: 'new-captain' }} sessionId="new-captain" presentation="page" actions={h.actions} canInspect t={t} />);
    if (transition === 'revoke') view.rerender(<TeamDashboard team={h.team} sessionId="captain" presentation="page" actions={h.actions} canInspect={false} t={t} />);
    if (transition === 'unmount') view.unmount();
    expect(h.subscriptions[0]!.signal?.aborted).toBe(true);
    await act(async () => h.subscriptions[0]!.push(frame({ sequence: 2, liveOutput: 'LATE_PRIVATE_TEXT' })));
    expect(screen.queryByText('LATE_PRIVATE_TEXT')).toBeNull(); expect(h.stop).not.toHaveBeenCalled();
  });
  it.each([{ ownerSessionId: 'other' }, { teamId: 'other' }, { member: 'tester' }, { childSessionId: 'other' }])('rejects a mismatched activity snapshot %j', async mismatch => {
    const h = fixture(); render(<MemberActivityPanel ownerSessionId="captain" teamId="team" member={h.team.members[0]!} watch={h.watch} t={t} onClose={vi.fn()} />);
    await act(async () => h.subscriptions[0]!.push(frame({ ...mismatch, liveOutput: 'FOREIGN_TEXT' })));
    expect(screen.getByRole('alert').textContent).toContain('does not belong'); expect(screen.queryByText('FOREIGN_TEXT')).toBeNull();
    expect(h.closed).toHaveBeenCalledOnce();
  });
  it('shows bounded-preview warnings and renders output only as inert text', async () => {
    const h = fixture(); render(<MemberActivityPanel ownerSessionId="captain" teamId="team" member={h.team.members[0]!} watch={h.watch} t={t} onClose={vi.fn()} />);
    const html = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    await act(async () => h.subscriptions[0]!.push(frame({ historyTruncated: true, livePartial: true, liveOutput: html })));
    expect(screen.getByText(html)).toBeTruthy(); expect(screen.getByText(/older records or long text/)).toBeTruthy();
    expect(screen.getByText(/Only part of this live output/)).toBeTruthy();
    expect(document.querySelector('img,script,iframe')).toBeNull();
  });
  it('has labelled keyboard controls and Chinese localization', async () => {
    const h = fixture(); const chinese: TeamTranslate = (key, params = {}) => zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
    render(<MemberActivityPanel ownerSessionId="captain" teamId="team" member={h.team.members[0]!} watch={h.watch} t={chinese} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: '关闭成员详情' }).getAttribute('type')).toBe('button');
    await act(async () => h.subscriptions[0]!.push(frame({ status: 'not-started', live: false, phase: 'idle', childSessionId: 'child', entries: [] })));
    expect(screen.getByText('尚未创建成员会话')).toBeTruthy(); expect(screen.getByText('暂无可展示的执行记录。')).toBeTruthy();
  });
  it.each([[null, '—'], [0, '00:00'], [61234, '01:01'], [3661000, '1:01:01']] as const)('formats %s without inventing duration', (value, expected) => {
    expect(activityDuration(value)).toBe(expected);
  });
});
