import type { Task, Team } from './model.js';
import type { TeamTranslate } from './locales.js';

export interface TeamDashboardProps {
  team: Team | null | undefined;
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
.dsh-team-agents summary:focus-visible, .dsh-team-agents [tabindex]:focus-visible {
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
@media (max-width: 420px) {
  .dsh-team-agents .dta-summary { padding: 8px 10px; gap: 4px; }
  .dsh-team-agents .dta-body { padding: 10px; }
  .dsh-team-agents .dta-facts { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .dsh-team-agents .dta-facts dd { margin-bottom: 5px; }
}
`;

function Badge({ status, t }: { status: Team['status'] | Task['status']; t: TeamTranslate }) {
  return <span className="dta-badge" data-status={status}>{t(`status.${status}`)}</span>;
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

export function TeamDashboard({ team, t }: TeamDashboardProps) {
  if (!team) return null;

  const tasksById = new Map(team.tasks.map(task => [task.id, task]));
  const active = team.tasks.filter(task => task.status === 'running');
  const completed = team.tasks.filter(task => task.status === 'completed').length;
  const failed = team.tasks.filter(task => task.status === 'failed').length;
  const pending = team.tasks.filter(task => task.status === 'pending').length;
  // Snapshots preserve append order; show the most recent six without mutating it.
  const messages = team.messages.slice(-6).reverse();

  return <>
    <style>{styles}</style>
    <details className="dsh-team-agents" aria-label={t('panel.label', { name: team.name })}>
      <summary className="dta-summary">
        <span className="dta-identity">
          <svg className="dta-symbol" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
            <circle cx="10" cy="4" r="2.3" /><circle cx="4" cy="15" r="2.3" /><circle cx="16" cy="15" r="2.3" />
            <path d="M9 6 5 13M11 6l4 7M6.3 15h7.4" />
          </svg>
          <span className="dta-name" title={team.name}>{team.name}</span>
          <Badge status={team.status} t={t} />
        </span>
        <span className="dta-meta">
          <span className="dta-revision">{t('team.revision', { revision: team.revision })}</span>
          <span className="dta-progress-label">{t('progress.compact', { completed, total: team.tasks.length })}</span>
          <svg className="dta-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" /></svg>
        </span>
      </summary>
      <div className="dta-body" role="region" aria-label={t('panel.details')} tabIndex={0}>
        <progress className="dta-progress" value={completed} max={Math.max(1, team.tasks.length)} aria-label={t('progress.label', { completed, total: team.tasks.length })} />
        <div className="dta-counts">
          <span>{t('progress.running', { count: active.length })}</span>
          <span>{t('progress.pending', { count: pending })}</span>
          <span>{t('progress.failed', { count: failed })}</span>
        </div>
        <details className="dta-goal"><summary>{t('team.goal')}</summary><p className="dta-prose">{team.goal}</p></details>

        <section className="dta-section" aria-label={t('members.heading')}>
          <div className="dta-heading"><h3>{t('members.heading')}</h3><span className="dta-muted">{team.members.length}</span></div>
          {team.members.length ? <ul className="dta-members">{team.members.map(member => {
            const working = active.filter(task => task.assignee === member.name);
            return <li className="dta-member" key={member.name}>
              <div className="dta-member-line">
                <span className="dta-member-name">{member.name}</span>
                <span className="dta-badge" data-status={working.length ? 'active' : 'idle'}>{t(working.length ? 'member.active' : 'member.idle')}</span>
              </div>
              <p className="dta-member-role">{member.role}</p>
              {working.length > 0 && <p className="dta-member-role">{t('member.tasks', { ids: working.map(task => task.id).join(', ') })}</p>}
            </li>;
          })}</ul> : <p className="dta-empty">{t('members.empty')}</p>}
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
      <div className="dta-footer"><p className="dta-hint">{t('team.chatHint')}</p></div>
    </details>
  </>;
}
