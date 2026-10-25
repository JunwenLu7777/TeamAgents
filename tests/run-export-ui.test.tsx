// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import { TeamDashboard } from '../src/dashboard.js';
import {
  TEAM_RUN_EXPORT_MIME, type TeamRunExportFormat, type TeamRunExportResult,
} from '../src/run-export-contract.js';
import {
  downloadTeamRunExport,
  type TeamRunExportDownloadEnvironment,
} from '../src/run-export-download.js';
import { mountTeamRemote } from '../src/remote-client.js';
import { mountAgentLibraryRemote } from '../src/library-remote-client.js';
import { registerTeamSettings } from '../src/settings-integration.js';
import { apply } from '../src/client.js';
import { en, locales, type TeamTranslate } from '../src/locales.js';
import type { Task, Team } from '../src/model.js';
import type { TeamSettingsActions } from '../src/settings-contract.js';
import { TEAM_REMOTE_ENDPOINTS } from '../src/remote-contract.js';
import { validateTeamRunExportResult } from '../src/remote-client.js';

vi.mock('../src/library-remote-client.js', () => ({ mountAgentLibraryRemote: vi.fn(async () => ({ read: vi.fn(), models: vi.fn(), save: vi.fn() })) }));
vi.mock('../src/settings-integration.js', () => ({ registerTeamSettings: vi.fn() }));
// Keep the real pure envelope validator; only stub the native mount.
vi.mock('../src/remote-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/remote-client.js')>(),
  mountTeamRemote: vi.fn(async () => ({ forSession: vi.fn(() => ({})) })),
}));
// Component tests assert the negotiated envelope and click semantics only; the
// real Blob/ObjectURL/anchor lifecycle is exercised separately below with an
// injected environment, so no real browser download or host file is involved.
vi.mock('../src/run-export-download.js', () => ({ downloadTeamRunExport: vi.fn(() => () => {}) }));
const realDownload = await vi.importActual<typeof import('../src/run-export-download.js')>('../src/run-export-download.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const t: TeamTranslate = (key, params = {}) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
const encoder = new TextEncoder();

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'pending', subject: 'Pending work', description: 'Do the work.', assignee: 'designer',
    dependencies: [], writeScopes: [], status: 'pending', attempt: 0, ...overrides };
}

function team(overrides: Partial<Team> = {}): Team {
  return { id: 'team-1', ownerSessionId: 'captain-session', workspaceId: 'workspace', name: 'Release crew',
    goal: 'Ship it.', maxConcurrency: 2, revision: 4, status: 'running',
    createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z',
    members: [{ name: 'designer', role: 'Design' }], tasks: [task()], messages: [], ...overrides };
}

function result(overrides: Partial<TeamRunExportResult> = {}): TeamRunExportResult {
  const format = (overrides.format ?? 'markdown') as TeamRunExportFormat;
  const content = overrides.content ?? '# Team run export\n\nRetained snapshot only.\n';
  return {
    schemaVersion: 1, teamId: 'team-1', ownerSessionId: 'captain-session', sourceRevision: 4,
    exportedAt: '2026-10-25T12:00:00.000Z', format,
    includeMessages: overrides.includeMessages ?? false,
    filename: `team-agents-team-1-r4-20261025T120000000Z.${format === 'json' ? 'json' : 'md'}`,
    mimeType: TEAM_RUN_EXPORT_MIME[format], content, byteLength: encoder.encode(content).byteLength,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function environment() {
  const urls: string[] = [];
  const revoked: string[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const scheduled: Array<() => void> = [];
  const cancelled: number[] = [];
  let sequence = 0;
  const env: TeamRunExportDownloadEnvironment = {
    createObjectURL: () => { const url = `blob:fixture/${++sequence}`; urls.push(url); return url; },
    revokeObjectURL: url => { revoked.push(url); },
    createAnchor: () => { const anchor = document.createElement('a'); anchor.addEventListener('click', event => event.preventDefault()); anchors.push(anchor); return anchor; },
    schedule: callback => { scheduled.push(callback); return scheduled.length - 1; },
    cancelScheduled: handle => { cancelled.push(handle as number); scheduled[handle as number] = () => {}; },
    mount: anchor => { document.body.appendChild(anchor); },
    unmount: anchor => { anchor.remove(); },
  };
  return { env, urls, revoked, anchors, scheduled, cancelled };
}

function exportActions(impl: TeamSettingsActions['exportRun'] = async () => result()) {
  return {
    stop: vi.fn<TeamSettingsActions['stop']>(),
    exportRun: vi.fn<TeamSettingsActions['exportRun']>(impl),
  };
}

describe('downloadTeamRunExport resource lifecycle', () => {
  it('allocates one object URL and clicks one temporary anchor with the validated filename', () => {
    const h = environment();
    const cleanup = realDownload.downloadTeamRunExport(result(), h.env);
    expect(h.urls).toHaveLength(1); expect(h.anchors).toHaveLength(1);
    const anchor = h.anchors[0]!;
    expect(anchor.download).toBe('team-agents-team-1-r4-20261025T120000000Z.md');
    expect(anchor.getAttribute('href')).toBe(h.urls[0]);
    expect(anchor.isConnected).toBe(false);
    // Revocation is deferred so the browser can consume the click.
    expect(h.revoked).toEqual([]);
    h.scheduled[0]!();
    expect(h.revoked).toEqual(h.urls);
    cleanup();
    expect(h.revoked).toEqual(h.urls);
  });

  it('is idempotent and cancels the scheduled revocation when cleaned up first', () => {
    const h = environment();
    const cleanup = realDownload.downloadTeamRunExport(result({ format: 'json' }), h.env);
    cleanup(); cleanup();
    expect(h.cancelled).toHaveLength(1);
    expect(h.revoked).toEqual(h.urls);
    h.scheduled[0]!();
    expect(h.revoked).toEqual(h.urls);
  });

  it('rejects an invalid envelope before allocating any browser resource', () => {
    const h = environment();
    expect(() => realDownload.downloadTeamRunExport(result({ byteLength: 1 }), h.env)).toThrow();
    expect([h.urls, h.anchors, h.revoked]).toEqual([[], [], []]);
  });

  it('rejects a format/MIME mismatch instead of downloading a mislabelled file', () => {
    const h = environment();
    expect(() => realDownload.downloadTeamRunExport(result({ mimeType: TEAM_RUN_EXPORT_MIME.json }), h.env)).toThrow();
    expect(h.urls).toEqual([]);
  });

  it('also cleans up if scheduling revocation fails after the click', () => {
    const h = environment(); h.env.schedule = () => { throw new Error('Timer unavailable'); };
    expect(() => realDownload.downloadTeamRunExport(result(), h.env)).toThrow('Timer unavailable');
    expect(h.revoked).toEqual(h.urls); expect(h.anchors[0]!.isConnected).toBe(false);
  });

  it('revokes the URL and removes the anchor when the click throws', () => {
    const h = environment();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(() => realDownload.downloadTeamRunExport(result(), h.env)).toThrow('blocked');
    expect(h.revoked).toEqual(h.urls);
    expect(document.querySelector('a')).toBeNull();
    click.mockRestore();
  });
});

describe('client-side export envelope validation', () => {
  it('treats an omitted message flag as false at the public validator boundary', () => {
    expect(validateTeamRunExportResult(result(), { sessionId: 'captain-session', format: 'markdown' }).includeMessages).toBe(false);
  });
  it('accepts a matching envelope for the bound session and request', () => {
    expect(validateTeamRunExportResult(result(), { sessionId: 'captain-session', format: 'markdown', includeMessages: false }))
      .toMatchObject({ teamId: 'team-1', ownerSessionId: 'captain-session', format: 'markdown' });
  });

  it('rejects another session even when every other field is valid', () => {
    expect(() => validateTeamRunExportResult(result({ ownerSessionId: 'other-session' }),
      { sessionId: 'captain-session', format: 'markdown', includeMessages: false })).toThrow(/another captain session/);
  });

  it('rejects a format or message scope that differs from the request', () => {
    expect(() => validateTeamRunExportResult(result(), { sessionId: 'captain-session', format: 'json', includeMessages: false }))
      .toThrow(/does not match the requested format/);
    expect(() => validateTeamRunExportResult(result({ includeMessages: true }), { sessionId: 'captain-session', format: 'markdown', includeMessages: false }))
      .toThrow(/does not match the requested format/);
  });

  it('rejects a malformed or over-claimed envelope before the UI sees it', () => {
    const expected = { sessionId: 'captain-session', format: 'markdown' as const, includeMessages: false };
    expect(() => validateTeamRunExportResult(result({ byteLength: 999 }), expected)).toThrow();
    expect(() => validateTeamRunExportResult(result({ sourceRevision: -1 }), expected)).toThrow();
    expect(() => validateTeamRunExportResult({ ...result(), extra: 'field' }, expected)).toThrow();
  });

  it('cross-checks JSON metadata against the envelope instead of trusting the text', () => {
    const document = {
      schemaVersion: 1, kind: 'team-agents/retained-run-snapshot', teamId: 'team-1', ownerSessionId: 'captain-session',
      sourceRevision: 4, exportedAt: '2026-10-25T12:00:00.000Z', includeMessages: false,
      limitations: ['Retained snapshot only.'], team: { name: 'Release crew', goal: 'Ship it.', status: 'running',
        maxConcurrency: 2, createdAt: 'now', updatedAt: 'now', members: [], tasks: [] },
    } as const;
    const expected = { sessionId: 'captain-session', format: 'json' as const, includeMessages: false };
    const good = result({ format: 'json', content: JSON.stringify(document) });
    expect(validateTeamRunExportResult(good, expected).teamId).toBe('team-1');
    // A different revision inside the file must not be presented as this envelope's snapshot.
    const mismatched = result({ format: 'json', content: JSON.stringify({ ...document, sourceRevision: 99 }) });
    expect(() => validateTeamRunExportResult(mismatched, expected)).toThrow(/metadata does not match/);
    // A different session inside the file is rejected too.
    const foreign = result({ format: 'json', content: JSON.stringify({ ...document, ownerSessionId: 'other-session' }) });
    expect(() => validateTeamRunExportResult(foreign, expected)).toThrow(/metadata does not match/);
    // Unparseable content never becomes a download.
    expect(() => validateTeamRunExportResult(result({ format: 'json', content: 'not json' }), expected))
      .toThrow(/unreadable JSON snapshot/);
  });
});

describe('explicit retained-snapshot export', () => {
  it('defaults to Markdown with messages unchecked and downloads only on an explicit click', async () => {
    const actions = exportActions();
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={actions} t={t} />);
    expect(actions.exportRun).not.toHaveBeenCalled();
    expect(actions.stop).not.toHaveBeenCalled();
    expect((screen.getByRole('radio', { name: 'Markdown' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'JSON' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Include retained team messages' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/not a complete attempt history/i)).toBeTruthy();
    expect(screen.getByText(/may contain sensitive information/i)).toBeTruthy();
    expect(screen.getByText(/mailbox text will be written/i)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    await waitFor(() => expect(actions.exportRun).toHaveBeenCalledOnce());
    expect(actions.exportRun).toHaveBeenCalledWith({ format: 'markdown', includeMessages: false }, expect.any(AbortSignal));
    expect(downloadTeamRunExport).toHaveBeenCalledOnce();
    await screen.findByText('Download ready: team-agents-team-1-r4-20261025T120000000Z.md');
  });

  it('sends the selected JSON format with explicit message inclusion and warns first', async () => {
    const real = environment();
    vi.mocked(downloadTeamRunExport).mockImplementationOnce((value: TeamRunExportResult) => realDownload.downloadTeamRunExport(value, real.env));
    const actions = exportActions(async () => result({ format: 'json', includeMessages: true }));
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={actions} t={t} />);
    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include retained team messages' }));
    expect(screen.getByRole('note').textContent).toMatch(/may be sensitive/i);
    expect(actions.exportRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    await waitFor(() => expect(actions.exportRun).toHaveBeenCalledWith({ format: 'json', includeMessages: true }, expect.any(AbortSignal)));
    await waitFor(() => expect(downloadTeamRunExport).toHaveBeenCalledOnce());
    expect(real.anchors).toHaveLength(1);
    expect(real.anchors[0]!.download).toBe('team-agents-team-1-r4-20261025T120000000Z.json');
    expect(real.urls).toHaveLength(1);
  });

  it('offers no export control without affirmative authority, a bound session or the action', () => {
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport={false} actions={exportActions()} t={t} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    cleanup();

    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={{ stop: vi.fn() }} t={t} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    // A foreign projected snapshot is not rendered at all, so no session tab leaks.
    const foreign = exportActions();
    const view = render(<TeamDashboard sessionId="other-session" team={team()} canExport actions={foreign} t={t} />);
    expect(view.container.innerHTML).toBe('');
    expect(foreign.exportRun).not.toHaveBeenCalled();
  });

  it('keeps Stop independent: clicking Stop never calls export and no Start appears', async () => {
    const actions = { stop: vi.fn<TeamSettingsActions['stop']>().mockResolvedValue(team({ status: 'paused', revision: 5 })),
      exportRun: vi.fn<TeamSettingsActions['exportRun']>() };
    render(<TeamDashboard sessionId="captain-session" team={team()} canStop canExport actions={actions} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop team' }));
    await waitFor(() => expect(actions.stop).toHaveBeenCalledOnce());
    expect(actions.exportRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Start/i })).toBeNull();
  });

  it('blocks repeated clicks while one export is pending and announces busy state', async () => {
    const pending = deferred<TeamRunExportResult>();
    const actions = exportActions(() => pending.promise);
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={actions} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preparing download…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preparing download…' }));
    expect(actions.exportRun).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Preparing download…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Preparing download');
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    await act(async () => pending.resolve(result()));
    await screen.findByText(/Download ready/);
    expect(downloadTeamRunExport).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Download export' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows an accessible error, never downloads, and allows an explicit retry', async () => {
    const exportRun = vi.fn<TeamSettingsActions['exportRun']>()
      .mockRejectedValueOnce(new Error('<img src=x onerror=alert(1)>'))
      .mockResolvedValueOnce(result());
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={{ stop: vi.fn(), exportRun }} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(downloadTeamRunExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    await waitFor(() => expect(downloadTeamRunExport).toHaveBeenCalledOnce());
    expect(exportRun).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another session', { ownerSessionId: 'other-session' }],
    ['another team', { teamId: 'other-team' }],
    ['an older revision', { sourceRevision: 3 }],
    ['a different format', { format: 'json' as const }],
    ['a different message scope', { includeMessages: true }],
  ])('refuses to download a result for %s', async (_label, overrides) => {
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport
      actions={{ stop: vi.fn(), exportRun: vi.fn(async () => result(overrides)) }} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('does not match this team');
    expect(downloadTeamRunExport).not.toHaveBeenCalled();
  });

  it('accepts a newer retained revision without overwriting the visible projection', async () => {
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport
      actions={{ stop: vi.fn(), exportRun: vi.fn(async () => result({ sourceRevision: 9 })) }} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    await screen.findByText(/Download ready/);
    expect(downloadTeamRunExport).toHaveBeenCalledOnce();
    expect(document.querySelector('.dta-revision')!.textContent).toContain('4');
  });

  it.each(['unmount', 'switch', 'revoke', 'replace'] as const)('aborts a pending export on %s and never downloads late data', async transition => {
    const pending = deferred<TeamRunExportResult>();
    const actions = exportActions(() => pending.promise);
    const view = render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={actions} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    const signal = actions.exportRun.mock.calls[0]![1]!;
    if (transition === 'unmount') view.unmount();
    else if (transition === 'switch') view.rerender(<TeamDashboard sessionId="other-session"
      team={team({ id: 'other-team', ownerSessionId: 'other-session', name: 'Other crew' })} canExport actions={actions} t={t} />);
    else if (transition === 'revoke') view.rerender(<TeamDashboard sessionId="captain-session" team={team()} canExport={false} actions={actions} t={t} />);
    else view.rerender(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={{ ...actions }} t={t} />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(result({ teamId: 'foreign', content: 'LATE SECRET' })));
    expect(downloadTeamRunExport).not.toHaveBeenCalled();
    expect(screen.queryByText(/LATE SECRET/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    if (transition === 'switch') expect(screen.getByText('Other crew')).not.toBeNull();
    if (transition === 'replace') expect((screen.getByRole('button', { name: 'Download export' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('never exports on mount or projection change, and resets options on a team switch', () => {
    const actions = exportActions();
    const view = render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={actions} t={t} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include retained team messages' }));
    expect(screen.getByRole('note')).toBeTruthy();
    view.rerender(<TeamDashboard sessionId="captain-session" team={team({ revision: 6 })} canExport actions={actions} t={t} />);
    expect(actions.exportRun).not.toHaveBeenCalled();
    // A revision bump is still the same team: the operator's choice is preserved.
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    view.rerender(<TeamDashboard sessionId="captain-session" team={team({ id: 'team-2', revision: 1 })} canExport actions={actions} t={t} />);
    expect(actions.exportRun).not.toHaveBeenCalled();
    expect((screen.getByRole('radio', { name: 'Markdown' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('uses a native button and labelled inputs so every control is keyboard reachable', () => {
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={exportActions()} t={t} />);
    const button = screen.getByRole('button', { name: 'Download export' });
    expect(button.getAttribute('type')).toBe('button');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    for (const control of [...screen.getAllByRole('radio'), screen.getByRole('checkbox')]) {
      expect((control as HTMLInputElement).disabled).toBe(false);
      expect((control as HTMLInputElement).closest('label')).not.toBeNull();
    }
    expect(screen.getByText('File format')).toBeTruthy();
  });

  it('renders the localized panel, including the message-inclusion warning', () => {
    const zhT: TeamTranslate = (key, params = {}) => locales.zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
    render(<TeamDashboard sessionId="captain-session" team={team()} canExport actions={exportActions()} t={zhT} />);
    expect(screen.getByRole('button', { name: '下载导出文件' })).toBeTruthy();
    expect(screen.getByText(/可能包含敏感信息/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '包含已保留的团队消息' }));
    expect(screen.getByRole('note').textContent).toContain('已选择包含消息');
  });
});

describe('native conversation-view export authority', () => {
  async function mountView() {
    let install!: () => unknown;
    const register = vi.fn((_options: unknown, _component: unknown) => () => {});
    const ctx = { effect: (setup: () => () => void) => setup(), locale: { register: vi.fn(() => () => {}) },
      slots: { entries: () => [], inject: vi.fn((_key: string, callback: () => unknown) => { install = callback; }), register } };
    await apply(ctx as unknown as Context);
    install();
    return register.mock.calls[0]![1] as ComponentType<{ sessionId: string; useAccess: (endpoint: string) => boolean;
      useProjection: (key: 'team-agents') => Team; t: TeamTranslate }>;
  }

  it('reads export access separately from Stop and downloads on an explicit click', async () => {
    const stop = vi.fn<TeamSettingsActions['stop']>();
    const exportRun = vi.fn<TeamSettingsActions['exportRun']>(async () => result());
    const actions: TeamSettingsActions = { read: vi.fn(), models: vi.fn(), save: vi.fn(), start: vi.fn(), stop,
      retry: vi.fn(), exportRun };
    vi.mocked(mountTeamRemote).mockResolvedValueOnce({ forSession: () => actions });
    const Slot = await mountView();
    const endpoints: string[] = [];
    const access = (endpoint: string) => { endpoints.push(endpoint); return endpoint === 'teamAgents/exportRun'; };
    render(<Slot sessionId="captain-session" useAccess={access} useProjection={() => team()} t={t} />);
    const exportEndpoint = (TEAM_REMOTE_ENDPOINTS as Record<string, string>).exportRun;
    expect(exportEndpoint).toBe('teamAgents/exportRun');
    expect(endpoints).toEqual(expect.arrayContaining(['teamAgents/stop', exportEndpoint]));
    expect(screen.getByRole('button', { name: 'Download export' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop team' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
    await waitFor(() => expect(exportRun).toHaveBeenCalledOnce());
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('treats unknown or denied export access as no control (%s)', async granted => {
    const actions: TeamSettingsActions = { read: vi.fn(), models: vi.fn(), save: vi.fn(), start: vi.fn(),
      stop: vi.fn(), retry: vi.fn(), exportRun: vi.fn() };
    vi.mocked(mountTeamRemote).mockResolvedValueOnce({ forSession: () => actions });
    const Slot = await mountView();
    render(<Slot sessionId="captain-session" useAccess={() => granted as boolean} useProjection={() => team()} t={t} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(actions.exportRun).not.toHaveBeenCalled();
  });

  it('shows the empty/loading states without any export control', async () => {
    vi.mocked(mountTeamRemote).mockResolvedValueOnce({ forSession: () => ({}) as TeamSettingsActions });
    const Slot = await mountView();
    render(<Slot sessionId="captain-session" useAccess={() => true} useProjection={() => null as unknown as Team} t={t} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});