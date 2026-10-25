import { useEffect, useId, useRef, useState } from 'react';
import type { Task, Team } from './model.js';
import type { TeamTranslate } from './locales.js';
import type { TeamSettingsActions } from './settings-contract.js';
import type { TeamRunExportFormat } from './run-export-contract.js';
import { downloadTeamRunExport } from './run-export-download.js';
import { MemberActivityPanel } from './member-activity-panel.js';

export interface TeamDashboardProps {
  team: Team | null | undefined;
  sessionId?: string;
  canStop?: boolean;
  /** Affirmative export authority only; unknown remains denied and shows no download control. */
  canExport?: boolean;
  canInspect?: boolean;
  /** The native conversation tab uses an expanded normal-flow page, not a composer disclosure. */
  presentation?: 'compact' | 'page';
  /** Stop stays required for existing consumers; export is optional read-only authority. */
  actions?: Pick<TeamSettingsActions, 'stop'> & Partial<Pick<TeamSettingsActions, 'exportRun' | 'watchMember'>>;
  t: TeamTranslate;
}

// All selectors stay inside the slot. React removes this style with the panel.
const styles = `
.dsh-team-agents {
  --dta-border: color-mix(in srgb, currentColor 16%, transparent);
  --dta-fill: color-mix(in srgb, currentColor 4%, transparent);
  box-sizing: border-box; width: 100%; min-width: 0; margin-block: 6px 2px;
  border: 1px solid var(--dta-border); border-radius: 12px;
  color: inherit; background: transparent; font: inherit; font-size: 12px; line-height: 1.5;
}
.dsh-team-agents *, .dsh-team-agents *::before, .dsh-team-agents *::after { box-sizing: border-box; }
.dsh-team-agents summary { cursor: pointer; overflow-wrap: anywhere; }
.dsh-team-agents summary:focus-visible, .dsh-team-agents [tabindex]:focus-visible, .dsh-team-agents button:focus-visible {
  outline: 2px solid currentColor; outline-offset: -3px; border-radius: 8px;
}
.dsh-team-agents .dta-summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  min-height: 42px; padding: 9px 12px; list-style: none;
}
.dsh-team-agents .dta-summary::-webkit-details-marker { display: none; }
.dsh-team-agents .dta-summary::marker { content: ''; }
.dsh-team-agents .dta-identity { display: flex; flex: 1 1 13rem; align-items: center; gap: 8px; min-width: 0; }
.dsh-team-agents .dta-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dsh-team-agents .dta-symbol { flex: 0 0 auto; opacity: .65; }
.dsh-team-agents .dta-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-inline-start: auto; }
.dsh-team-agents .dta-revision { font-size: 11px; opacity: .72; }
.dsh-team-agents .dta-progress-label { font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-team-agents .dta-chevron { flex: 0 0 auto; }
.dsh-team-agents[open] > .dta-summary .dta-chevron { transform: rotate(90deg); }
.dsh-team-agents .dta-badge {
  display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto;
  padding: 1px 7px; border: 1px solid var(--dta-border); border-radius: 999px;
  font-size: 11px; font-weight: 500; white-space: nowrap;
}
.dsh-team-agents .dta-badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .5; }
.dsh-team-agents .dta-badge[data-status='running']::before,
.dsh-team-agents .dta-badge[data-status='active']::before { background: #4c8dff; opacity: 1; }
.dsh-team-agents .dta-badge[data-status='completed']::before { background: #2aa579; opacity: 1; }
.dsh-team-agents .dta-badge[data-status='failed']::before,
.dsh-team-agents .dta-badge[data-status='blocked']::before { background: #e47166; opacity: 1; }
.dsh-team-agents .dta-body { max-height: 22rem; max-height: min(22rem, 48dvh); overflow: auto; overscroll-behavior: contain; border-top: 1px solid var(--dta-border); padding: 12px; }
.dsh-team-agents .dta-progress { display: block; width: 100%; height: 5px; margin: 0; border: 0; border-radius: 999px; overflow: hidden; accent-color: currentColor; background: var(--dta-border); }
.dsh-team-agents .dta-progress::-webkit-progress-bar { background: var(--dta-border); border-radius: 999px; }
.dsh-team-agents .dta-progress::-webkit-progress-value { background: currentColor; border-radius: 999px; }
.dsh-team-agents .dta-progress::-moz-progress-bar { background: currentColor; border-radius: 999px; }
.dsh-team-agents .dta-counts { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 11px; opacity: .78; }
.dsh-team-agents .dta-section { margin-top: 16px; }
.dsh-team-agents .dta-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; margin-bottom: 7px; }
.dsh-team-agents h3 { margin: 0; font: inherit; font-size: 11px; font-weight: 650; }
.dsh-team-agents .dta-muted { opacity: .72; }
.dsh-team-agents .dta-empty, .dsh-team-agents .dta-hint { margin: 0; font-size: 11px; opacity: .72; }
.dsh-team-agents .dta-goal { margin-top: 10px; }
.dsh-team-agents .dta-goal > summary { padding-block: 4px; font-size: 11px; }
.dsh-team-agents .dta-members, .dsh-team-agents .dta-tasks, .dsh-team-agents .dta-messages { padding: 0; margin: 0; list-style: none; }
.dsh-team-agents .dta-members { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 6px; }
.dsh-team-agents .dta-member { padding: 8px 10px; min-width: 0; border-radius: 8px; background: var(--dta-fill); }
.dsh-team-agents .dta-member-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; }
.dsh-team-agents .dta-member-open { margin-top:8px; padding:5px 9px; font:inherit; font-size:11px; border:1px solid var(--dta-border); border-radius:6px; background:transparent; color:inherit; cursor:pointer; }
.dsh-team-agents .dta-member-open:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.dsh-team-agents .dta-member-name { font-weight: 550; overflow-wrap: anywhere; }
.dsh-team-agents .dta-member-role { margin: 3px 0 0; overflow-wrap: anywhere; font-size: 11px; opacity: .72; }
.dsh-team-agents .dta-task { border-top: 1px solid var(--dta-border); }
.dsh-team-agents .dta-task:last-child { border-bottom: 1px solid var(--dta-border); }
.dsh-team-agents .dta-task-summary { padding: 9px 0; }
.dsh-team-agents .dta-task-title { margin-inline: 5px 8px; font-weight: 500; }
.dsh-team-agents .dta-task-summary .dta-badge { vertical-align: middle; }
.dsh-team-agents code { font: inherit; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
.dsh-team-agents .dta-task-body { padding: 0 0 12px; }
.dsh-team-agents .dta-prose { margin: 6px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-team-agents .dta-facts { display: grid; grid-template-columns: minmax(0, 7rem) minmax(0, 1fr); gap: 6px 10px; margin: 8px 0; }
.dsh-team-agents .dta-facts dt { font-size: 11px; opacity: .72; }
.dsh-team-agents .dta-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dsh-team-agents .dta-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-team-agents .dta-tag { padding: 1px 6px; border: 1px solid var(--dta-border); border-radius: 5px; }
.dsh-team-agents .dta-result { margin-top: 8px; padding: 7px 9px; border: 1px solid var(--dta-border); border-radius: 8px; }
.dsh-team-agents .dta-result summary { font-size: 11px; font-weight: 550; }
.dsh-team-agents .dta-result pre { max-height: 12rem; overflow: auto; margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
.dsh-team-agents .dta-message { border-inline-start: 2px solid var(--dta-border); padding-inline-start: 9px; margin-top: 10px; min-width: 0; }
.dsh-team-agents .dta-message-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; font-size: 11px; overflow-wrap: anywhere; }
.dsh-team-agents .dta-message-header time { margin-inline-start: auto; opacity: .72; }
.dsh-team-agents .dta-message-text { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 7rem; overflow: auto; }
.dsh-team-agents .dta-footer { padding: 8px 12px; border-top: 1px solid var(--dta-border); }
.dsh-team-agents .dta-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-team-agents .dta-stop { min-height: 32px; padding: 4px 10px; border: 1px solid var(--dta-border); border-radius: 7px; background: var(--dta-fill); color: inherit; font: inherit; cursor: pointer; }
.dsh-team-agents .dta-stop:disabled { opacity: .6; cursor: wait; }
.dsh-team-agents .dta-error { margin: 8px 0 0; overflow-wrap: anywhere; }
.dsh-team-agents .dta-export { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dta-border); }
.dsh-team-agents .dta-export fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
.dsh-team-agents .dta-export legend { padding: 0; font-size: 11px; font-weight: 650; }
.dsh-team-agents .dta-export-hint, .dsh-team-agents .dta-export-privacy, .dsh-team-agents .dta-export-warning { margin: 6px 0 0; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.dsh-team-agents .dta-export-hint, .dsh-team-agents .dta-export-privacy { opacity: .78; }
.dsh-team-agents .dta-export-warning { padding: 6px 9px; border: 1px solid currentColor; border-radius: 8px; }
.dsh-team-agents .dta-export-sublabel { margin: 10px 0 0; font-size: 11px; font-weight: 600; }
.dsh-team-agents .dta-export-options { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 4px; }
.dsh-team-agents .dta-export-choice, .dsh-team-agents .dta-export-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; cursor: pointer; }
.dsh-team-agents .dta-export-divider { flex: 0 1 auto; width: 1px; align-self: stretch; min-height: 18px; background: var(--dta-border); }
.dsh-team-agents .dta-export input:focus-visible, .dsh-team-agents .dta-download:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.dsh-team-agents .dta-export input:disabled, .dsh-team-agents .dta-download:disabled { opacity: .6; cursor: not-allowed; }
.dsh-team-agents .dta-download { min-height: 32px; padding: 4px 10px; margin-top: 8px; border: 1px solid var(--dta-border); border-radius: 7px; background: var(--dta-fill); color: inherit; font: inherit; cursor: pointer; }
.dsh-team-agents .dta-download:disabled { cursor: wait; }
.dsh-team-agents .dta-export-status { margin: 6px 0 0; font-size: 11px; opacity: .85; overflow-wrap: anywhere; }
.dsh-team-agents .dta-export .dta-error { margin-top: 6px; }
.dsh-team-agents.dta-page { margin: 0; font-size: 13px; }
.dsh-team-agents.dta-page > .dta-summary { padding: 18px 20px; }
.dsh-team-agents.dta-page .dta-name { font-size: 1.05rem; white-space: normal; overflow: visible; overflow-wrap: anywhere; }
.dsh-team-agents.dta-page .dta-body { max-height: none; overflow: visible; overscroll-behavior: auto; padding: 20px; }
.dsh-team-agents.dta-page .dta-members { grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 10px; }
.dsh-team-agents.dta-page .dta-member { padding: 12px; }
.dsh-team-agents.dta-page .dta-section { margin-top: 24px; }
@media (max-width: 420px) {
  .dsh-team-agents.dta-page .dta-identity { flex-basis: 100%; }
  .dsh-team-agents.dta-page .dta-meta { margin-inline-start: 0; }
  .dsh-team-agents .dta-summary { padding: 8px 10px; gap: 4px; }
  .dsh-team-agents .dta-body { padding: 10px; }
  .dsh-team-agents .dta-facts { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .dsh-team-agents .dta-facts dd { margin-bottom: 5px; }
}
`;

function Badge({ status, t }: { status: Team['status'] | Task['status']; t: TeamTranslate }) {
  return <span className="dta-badge" data-status={status}>{t(`status.${status}`)}</span>;
}

const EXPORT_FORMATS: readonly TeamRunExportFormat[] = ['markdown', 'json'];

/**
 * Explicit, read-only export of the retained snapshot. It never runs on mount
 * and never mutates projection or team state; a click captures identity and
 * options, then downloads only a matching, non-stale, authorized envelope.
 */
function ExportPanel({ team, sessionId, actions, t }: {
  team: Team; sessionId: string;
  actions: NonNullable<TeamDashboardProps['actions']> & Required<Pick<TeamSettingsActions, 'exportRun'>>;
  t: TeamTranslate;
}) {
  const ids = useId();
  const request = useRef<AbortController | null>(null);
  const cleanupDownload = useRef<(() => void) | null>(null);
  const [format, setFormat] = useState<TeamRunExportFormat>('markdown');
  const [includeMessages, setIncludeMessages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    // A replacement binding cancels its predecessor and must also release the busy UI.
    setBusy(false); setError(null); setDone(null);
    // Unmount, a replaced actions binding or a lost authority cancels the request.
    return () => {
      request.current?.abort(new Error('Team export disposed')); request.current = null;
      cleanupDownload.current?.(); cleanupDownload.current = null;
    };
  }, [actions]);

  async function start() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null); setDone(null);
    // Capture the click-time team, session and options; late results cannot retarget.
    const captured = { teamId: team.id, revision: team.revision, format, includeMessages } as const;
    try {
      const result = await actions.exportRun({ format: captured.format, includeMessages: captured.includeMessages }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ownerSessionId !== sessionId || result.teamId !== captured.teamId ||
        result.format !== captured.format || result.includeMessages !== captured.includeMessages ||
        result.sourceRevision < captured.revision) throw new Error(t('export.mismatch'));
      // A completed envelope is the only thing that may allocate a browser
      // resource, and its cleanup is retained until the panel is disposed.
      cleanupDownload.current?.();
      cleanupDownload.current = downloadTeamRunExport(result);
      if (controller.signal.aborted) return;
      setDone(t('export.done', { filename: result.filename }));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('export.unknownError'));
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  return <section className="dta-export" aria-label={t('export.heading')}>
    <fieldset>
      <legend>{t('export.heading')}</legend>
      <p className="dta-export-hint">{t('export.hint')}</p>
      <p className="dta-export-sublabel" id={`${ids}-format`}>{t('export.format')}</p>
      <div className="dta-export-options" role="radiogroup" aria-labelledby={`${ids}-format`}>
        {EXPORT_FORMATS.map(value => <label className="dta-export-choice" key={value}>
          <input type="radio" name={`${ids}-format`} value={value} checked={format === value}
            disabled={busy} onChange={() => setFormat(value)} />
          <span>{t(value === 'json' ? 'export.formatJson' : 'export.formatMarkdown')}</span>
        </label>)}
        <span className="dta-export-divider" aria-hidden="true" />
        <label className="dta-export-toggle">
          <input type="checkbox" checked={includeMessages} disabled={busy}
            onChange={event => setIncludeMessages(event.currentTarget.checked)} />
          <span>{t('export.includeMessages')}</span>
        </label>
      </div>
      <p className="dta-export-hint">{t('export.includeMessagesHint')}</p>
      <p className="dta-export-privacy">{t('export.privacy')}</p>
      {includeMessages && <p className="dta-export-warning" role="note">{t('export.messagesWarning')}</p>}
      <button type="button" className="dta-download" disabled={busy} onClick={() => { void start(); }}>
        {t(busy ? 'export.downloading' : 'export.download')}
      </button>
      {busy && <p className="dta-export-status" role="status">{t('export.downloading')}</p>}
      {done && <p className="dta-export-status" role="status">{done}</p>}
      {error && <p className="dta-error" role="alert">{t('export.error', { message: error })}</p>}
    </fieldset>
  </section>;
}

// Display-only explanation of model.blockingReason's precedence. The host
// remains the scheduler; no client-side decision starts or changes a task.
function pendingReason(team: Team, task: Task, tasks: ReadonlyMap<string, Task>, active: Task[], t: TeamTranslate) {
  const waiting = task.dependencies.filter(id => tasks.get(id)?.status !== 'completed');
  if (waiting.length) return t('pending.dependencies', { ids: waiting.join(', ') });
  if (active.some(other => other.assignee === task.assignee)) return t('pending.member');
  if (active.some(other => other.writeScopes.some(left => task.writeScopes.some(right =>
    left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
  )))) return t('pending.scope');
  if (active.length >= team.maxConcurrency) return t('pending.capacity');
  if (team.status !== 'running') return t('pending.team');
  return t('pending.ready');
}

export function TeamDashboard(props: TeamDashboardProps) {
  const { team, sessionId } = props;
  if (!team || (sessionId !== undefined && team.ownerSessionId !== sessionId)) return null;
  // Switching sessions/teams unmounts the request owner even if a caller forgets a React key.
  return <TeamDashboardState key={`${sessionId ?? 'readonly'}:${team.id}`} {...props} team={team} />;
}

function TeamDashboardState({ team: projected, sessionId, canStop = false, canExport = false, canInspect = false, presentation = 'compact', actions, t }: TeamDashboardProps & { team: Team }) {
  const page = presentation === 'page';
  const Frame = page ? 'section' : 'details';
  const Header = page ? 'header' : 'summary';
  const request = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopResult, setStopResult] = useState<Team | null>(null);
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  // A completed Stop can precede its projection. An older projection must not restore a running button.
  const team = stopResult && stopResult.revision > projected.revision ? stopResult : projected;
  const canManage = canStop && sessionId === team.ownerSessionId && !!actions;
  // Export needs affirmative authority, a bound session and the read-only action.
  const canDownload = canExport && !!sessionId && sessionId === team.ownerSessionId && !!actions?.exportRun;
  const canViewMember = canInspect && !!sessionId && sessionId === team.ownerSessionId && !!actions?.watchMember;
  const selected = canViewMember ? team.members.find(member => member.name === selectedMember) : undefined;
  useEffect(() => { if (!canViewMember) setSelectedMember(null); }, [canViewMember]);
  useEffect(() => {
    setStopping(false); setError(null);
    return () => { request.current?.abort(); request.current = null; };
  }, [actions, canStop]);

  async function stop() {
    if (!canManage || team.status !== 'running' || !actions || request.current) return;
    const controller = new AbortController();
    request.current = controller; setStopping(true); setError(null);
    try {
      const result = await actions.stop(controller.signal);
      if (controller.signal.aborted) return;
      if (result.id !== team.id || result.ownerSessionId !== sessionId) throw new Error(t('team.stopMismatch'));
      setStopResult(current => current && current.revision > result.revision ? current : result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('team.stopUnknown'));
    } finally {
      if (request.current === controller) { request.current = null; setStopping(false); }
    }
  }

  const tasksById = new Map(team.tasks.map(task => [task.id, task]));
  const active = team.tasks.filter(task => task.status === 'running');
  const completed = team.tasks.filter(task => task.status === 'completed').length;
  const failed = team.tasks.filter(task => task.status === 'failed').length;
  const pending = team.tasks.filter(task => task.status === 'pending').length;
  // Snapshots preserve append order; show the most recent six without mutating it.
  const messages = team.messages.slice(-6).reverse();

  return <>
    <style>{styles}</style>
    <Frame className={`dsh-team-agents${page ? ' dta-page' : ''}`} aria-label={t('panel.label', { name: team.name })}
      onToggle={event => { if (!page && event.target === event.currentTarget && !(event.currentTarget as HTMLDetailsElement).open) setSelectedMember(null); }}>
      <Header className="dta-summary">
        <span className="dta-identity">
          <svg className="dta-symbol" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
            <circle cx="10" cy="4" r="2.3" /><circle cx="4" cy="15" r="2.3" /><circle cx="16" cy="15" r="2.3" />
            <path d="M9 6 5 13M11 6l4 7M6.3 15h7.4" />
          </svg>
          <span className="dta-name" title={team.name} role={page ? 'heading' : undefined} aria-level={page ? 2 : undefined}>{team.name}</span>
          <Badge status={team.status} t={t} />
        </span>
        <span className="dta-meta">
          <span className="dta-revision">{t('team.revision', { revision: team.revision })}</span>
          <span className="dta-progress-label">{t('progress.compact', { completed, total: team.tasks.length })}</span>
          {!page && <svg className="dta-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" /></svg>}
        </span>
      </Header>
      <div className="dta-body" role="region" aria-label={t('panel.details')} tabIndex={0}>
        <progress className="dta-progress" value={completed} max={Math.max(1, team.tasks.length)} aria-label={t('progress.label', { completed, total: team.tasks.length })} />
        <div className="dta-counts">
          <span>{t('progress.running', { count: active.length })}</span>
          <span>{t('progress.pending', { count: pending })}</span>
          <span>{t('progress.failed', { count: failed })}</span>
        </div>
        <details className="dta-goal" open={page || undefined}><summary>{t('team.goal')}</summary><p className="dta-prose">{team.goal}</p></details>

        <section className="dta-section" aria-label={t('members.heading')}>
          <div className="dta-heading"><h3>{t('members.heading')}</h3><span className="dta-muted">{team.members.length}</span></div>
          {team.members.length ? <ul className="dta-members">{team.members.map(member => {
            const working = active.filter(task => task.assignee === member.name);
            const last = team.tasks.filter(task => task.assignee === member.name && task.attempt > 0)
              .sort((a, b) => (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0))[0];
            const memberStatus = working.length ? 'active' : last?.status === 'failed' ? 'failed' : last?.status === 'completed' ? 'completed' : 'idle';
            return <li className="dta-member" key={member.name}>
              <div className="dta-member-line">
                <span className="dta-member-name">{member.name}</span>
                <span className="dta-badge" data-status={memberStatus}>{t(memberStatus === 'active' ? 'member.active' : memberStatus === 'idle' ? 'member.idle' : `status.${memberStatus}`)}</span>
              </div>
              <p className="dta-member-role">{member.role}</p>
              <p className="dta-member-role">{member.model ? t('member.model', member.model) : t('member.inheritedModel')}</p>
              {working.length > 0 && <p className="dta-member-role">{t('member.tasks', { ids: working.map(task => task.id).join(', ') })}</p>}
              {canViewMember && <button type="button" className="dta-member-open" aria-expanded={selectedMember === member.name}
                onClick={() => setSelectedMember(value => value === member.name ? null : member.name)}>{t('activity.inspect', { name: member.name })}</button>}
            </li>;
          })}</ul> : <p className="dta-empty">{t('members.empty')}</p>}
          {selected && sessionId && actions?.watchMember && <MemberActivityPanel ownerSessionId={sessionId} teamId={team.id}
            member={selected} watch={actions.watchMember} t={t} onClose={() => setSelectedMember(null)} />}
        </section>

        <section className="dta-section" aria-label={t('tasks.heading')}>
          <div className="dta-heading"><h3>{t('tasks.heading')}</h3><span className="dta-muted">{team.tasks.length}</span></div>
          {team.tasks.length ? <ul className="dta-tasks">{team.tasks.map(task => <li className="dta-task" key={task.id}>
            <details>
              <summary className="dta-task-summary"><code>{task.id}</code><span className="dta-task-title">{task.subject}</span><Badge status={task.status} t={t} /></summary>
              <div className="dta-task-body">
                <p className="dta-prose">{task.description}</p>
                <dl className="dta-facts">
                  <dt>{t('task.assignee')}</dt><dd>{task.assignee} <span className="dta-muted">{t('task.attempt', { attempt: task.attempt })}</span></dd>
                  <dt>{t('task.dependencies')}</dt><dd>{task.dependencies.length ? <span className="dta-tags">{task.dependencies.map(id => <code className="dta-tag" key={id}>{id}</code>)}</span> : t('task.noDependencies')}</dd>
                  {task.status === 'pending' && <><dt>{t('pending.label')}</dt><dd>{pendingReason(team, task, tasksById, active, t)}</dd></>}
                  <dt>{t('task.scopes')}</dt><dd>{task.writeScopes.length ? <span className="dta-tags">{task.writeScopes.map(scope => <code className="dta-tag" key={scope}>{scope}</code>)}</span> : t('task.noScopes')}</dd>
                </dl>
                <p className="dta-hint">{t('task.scopeHint')}</p>
                {task.status === 'failed' && <details className="dta-result"><summary>{t('task.error')}</summary><pre tabIndex={0}>{task.error || t('task.noError')}</pre></details>}
                {task.status === 'completed' && <details className="dta-result"><summary>{t('task.output')}</summary><pre tabIndex={0}>{task.output || t('task.noOutput')}</pre></details>}
              </div>
            </details>
          </li>)}</ul> : <p className="dta-empty">{t('tasks.empty')}</p>}
        </section>

        <section className="dta-section" aria-label={t('messages.heading')}>
          <div className="dta-heading"><h3>{t('messages.heading')}</h3>{messages.length > 0 && <span className="dta-hint">{t('messages.count', { shown: messages.length, total: team.messages.length })}</span>}</div>
          {messages.length ? <ol className="dta-messages">{messages.map(message => <li className="dta-message" key={message.id}>
            <div className="dta-message-header">
              <span>{t('message.route', { from: message.from, to: message.to })}</span>
              <span className="dta-muted">{t(message.deliveredAt ? 'message.delivered' : 'message.queued')}</span>
              <time dateTime={message.createdAt} aria-label={t('message.sentAt', { time: message.createdAt })}>{message.createdAt}</time>
            </div>
            <p className="dta-message-text" tabIndex={0}>{message.text}</p>
          </li>)}</ol> : <p className="dta-empty">{t('messages.empty')}</p>}
        </section>
      </div>
      <div className="dta-footer">
        {canDownload && <ExportPanel key={`${sessionId}:${team.id}`} team={team} sessionId={sessionId}
          actions={actions as NonNullable<TeamDashboardProps['actions']> & Required<Pick<TeamSettingsActions, 'exportRun'>>} t={t} />}
        <div className="dta-controls">
          <p className="dta-hint">{t('team.chatHint')}</p>
          {canManage && (team.status === 'running' || stopping) && <button type="button" className="dta-stop"
            disabled={stopping || team.status !== 'running'} onClick={() => { void stop(); }}>
            {t(stopping ? 'team.stopping' : 'team.stop')}
          </button>}
        </div>
        {error && <p className="dta-error" role="alert">{t('team.stopError', { message: error })}</p>}
      </div>
    </Frame>
  </>;
}
