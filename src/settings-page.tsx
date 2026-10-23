import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { planOf, scopesOverlap, TeamPlanSchema, type Task, type Team, type TeamPlan } from './model.js';
import type { TeamSettingsActions, TeamSettingsData } from './settings-contract.js';
import type { SettingsKey, SettingsTranslate } from './settings-locales.js';

export interface TeamSettingsPageProps extends TeamSettingsData {
  actions: TeamSettingsActions;
  t: SettingsTranslate;
}

type DraftMember = { name: string; role: string; instructions: string };
type DraftTask = Omit<TeamPlan['tasks'][number], 'dependencies' | 'writeScopes'> & { dependencies: string; writeScopes: string };
type Draft = { name: string; goal: string; maxConcurrency: string; members: DraftMember[]; tasks: DraftTask[] };
type Operation = 'read' | 'save' | 'start' | 'stop' | 'retry';
type Notice = { key: SettingsKey; params?: Record<string, string | number> };
type EditorState = {
  base: Team | null | undefined;
  latest: Team | null | undefined;
  draft: Draft;
  dirty: boolean;
  conflict: boolean;
  approved: string | null;
  submitted: boolean;
  error: string | null;
  notice: Notice | null;
};

const styles = `
.dsh-team-settings { --dts-border: color-mix(in srgb, currentColor 18%, transparent); --dts-fill: color-mix(in srgb, currentColor 4%, transparent); color: inherit; font: inherit; line-height: 1.5; width: 100%; max-width: 72rem; min-width: 0; margin-inline: auto; padding: clamp(12px, 3vw, 28px); }
.dsh-team-settings *, .dsh-team-settings *::before, .dsh-team-settings *::after { box-sizing: border-box; }
.dsh-team-settings h2, .dsh-team-settings h3, .dsh-team-settings h4, .dsh-team-settings p { margin: 0; }
.dsh-team-settings h2 { font-size: 1.35rem; font-weight: 650; }
.dsh-team-settings h3 { font-size: 1rem; font-weight: 650; }
.dsh-team-settings h4 { font-size: .9rem; font-weight: 600; }
.dsh-team-settings .dts-heading, .dsh-team-settings .dts-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.dsh-team-settings .dts-heading { justify-content: space-between; margin-bottom: 12px; }
.dsh-team-settings .dts-stack { display: grid; gap: 14px; min-width: 0; }
.dsh-team-settings .dts-card { border: 1px solid var(--dts-border); border-radius: 12px; padding: 16px; min-width: 0; background: transparent; }
.dsh-team-settings .dts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: 12px; min-width: 0; }
.dsh-team-settings .dts-field { display: grid; align-content: start; gap: 5px; min-width: 0; font-size: .875rem; }
.dsh-team-settings .dts-hint { font-size: .8rem; opacity: .75; overflow-wrap: anywhere; }
.dsh-team-settings input:not([type='checkbox']), .dsh-team-settings textarea, .dsh-team-settings select { display: block; width: 100%; min-width: 0; border: 1px solid var(--dts-border); border-radius: 7px; padding: 8px 10px; background: var(--dts-fill); color: inherit; font: inherit; line-height: 1.5; }
.dsh-team-settings textarea { resize: vertical; }
.dsh-team-settings option { background: Canvas; color: CanvasText; }
.dsh-team-settings input[readonly], .dsh-team-settings textarea[readonly], .dsh-team-settings select:disabled { opacity: .8; }
.dsh-team-settings [aria-invalid='true'] { border-style: dashed; border-width: 2px; }
.dsh-team-settings fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.dsh-team-settings fieldset > legend { font-size: 1rem; font-weight: 650; padding: 0; margin-bottom: 12px; }
.dsh-team-settings button { font: inherit; font-size: .85rem; color: inherit; background: var(--dts-fill); border: 1px solid var(--dts-border); border-radius: 7px; min-height: 36px; padding: 7px 12px; cursor: pointer; }
.dsh-team-settings button:disabled { cursor: not-allowed; opacity: .45; }
.dsh-team-settings .dts-primary { border-color: currentColor; font-weight: 600; }
.dsh-team-settings :is(button, input, textarea, select, summary):focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.dsh-team-settings .dts-banner { border: 1px solid var(--dts-border); border-inline-start: 3px solid currentColor; border-radius: 8px; padding: 12px; overflow-wrap: anywhere; }
.dsh-team-settings .dts-banner ul { margin: 6px 0 0; padding-inline-start: 22px; }
.dsh-team-settings .dts-badge { display: inline-block; font-size: .75rem; border: 1px solid var(--dts-border); border-radius: 999px; padding: 2px 8px; }
.dsh-team-settings .dts-confirm { display: flex; align-items: flex-start; gap: 9px; font-size: .875rem; }
.dsh-team-settings .dts-confirm input { flex: 0 0 auto; margin-top: .3em; accent-color: currentColor; }
.dsh-team-settings .dts-runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.dsh-team-settings .dts-run { border-top: 1px solid var(--dts-border); padding-top: 12px; min-width: 0; }
.dsh-team-settings code { font-size: .8rem; overflow-wrap: anywhere; }
.dsh-team-settings details { margin-top: 8px; }
.dsh-team-settings summary { cursor: pointer; }
.dsh-team-settings pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14rem; overflow: auto; font: inherit; font-size: .8rem; }
@media (max-width: 480px) { .dsh-team-settings .dts-card { padding: 12px; } .dsh-team-settings .dts-actions > button { flex: 1 1 auto; } }
`;

function emptyDraft(): Draft {
  return { name: '', goal: '', maxConcurrency: '3', members: [], tasks: [] };
}

function draftOf(team: Team | null | undefined): Draft {
  if (!team) return emptyDraft();
  const plan = planOf(team);
  return {
    ...plan,
    maxConcurrency: String(plan.maxConcurrency),
    members: plan.members.map(member => ({ ...member, instructions: member.instructions ?? '' })),
    tasks: plan.tasks.map(task => ({ ...task, dependencies: task.dependencies.join(', '), writeScopes: task.writeScopes.join('\n') })),
  };
}

function initialState(team: Team | null | undefined): EditorState {
  return { base: team, latest: team, draft: draftOf(team), dirty: false, conflict: false, approved: null, submitted: false, error: null, notice: null };
}

function snapshotKey(team: Team | null | undefined): string {
  return team ? `${team.id}:${team.revision}` : team === null ? 'empty' : 'unresolved';
}

function olderThan(candidate: Team | null | undefined, current: Team | null | undefined): boolean {
  return !!candidate && !!current && candidate.id === current.id && candidate.revision < current.revision;
}

function configurationEditable(team: Team | null | undefined): boolean {
  return team === null || (!!team && team.status !== 'running' && team.tasks.every(task => task.attempt === 0) && team.members.every(member => !member.sessionId));
}

function reconcileSnapshot(state: EditorState, incoming: Team | null): EditorState {
  if (olderThan(incoming, state.latest) || snapshotKey(incoming) === snapshotKey(state.latest)) return state;
  if (state.dirty || state.conflict) {
    return { ...state, latest: incoming, conflict: true, approved: null, notice: null };
  }
  return initialState(incoming);
}

function exampleDraft(t: SettingsTranslate): Draft {
  const instructions = t('example.instructions');
  return {
    name: t('example.name'), goal: t('example.goal'), maxConcurrency: '3',
    members: [
      { name: 'observer', role: t('example.observerRole'), instructions },
      { name: 'reviewer', role: t('example.reviewerRole'), instructions },
      { name: 'summarizer', role: t('example.writerRole'), instructions },
    ],
    tasks: [
      { id: 'inspect', subject: t('example.inspectTitle'), description: t('example.inspectDescription'), assignee: 'observer', dependencies: '', writeScopes: '' },
      { id: 'review', subject: t('example.reviewTitle'), description: t('example.reviewDescription'), assignee: 'reviewer', dependencies: '', writeScopes: '' },
      { id: 'summarize', subject: t('example.summaryTitle'), description: t('example.summaryDescription'), assignee: 'summarizer', dependencies: 'inspect, review', writeScopes: '' },
    ],
  };
}

type FormError = { path: string; message: string };
function validateDraft(draft: Draft, t: SettingsTranslate): { plan?: TeamPlan; errors: FormError[] } {
  const parsed = TeamPlanSchema.safeParse({
    ...draft,
    maxConcurrency: draft.maxConcurrency.trim() ? Number(draft.maxConcurrency) : Number.NaN,
    members: draft.members.map(({ name, role, instructions }) => ({ name, role, ...(instructions.trim() ? { instructions } : {}) })),
    tasks: draft.tasks.map(task => ({
      ...task,
      dependencies: task.dependencies.split(/[,\n]/).map(value => value.trim()).filter(Boolean),
      writeScopes: task.writeScopes.split('\n').map(value => value.trim()).filter(Boolean),
    })),
  });
  const errors: FormError[] = [];
  const fieldKeys: Record<string, SettingsKey> = {
    name: 'validation.name', goal: 'validation.goal', maxConcurrency: 'validation.concurrency',
    members: 'validation.members', tasks: 'validation.tasks', role: 'validation.role', instructions: 'validation.instructions',
    id: 'validation.taskId', subject: 'validation.title', description: 'validation.description', assignee: 'validation.assignee',
    dependencies: 'validation.dependencies', writeScopes: 'validation.scopes',
  };
  if (!parsed.success) for (const issue of parsed.error.issues) {
    const path = issue.path.join('.');
    const field = String(issue.path[2] ?? issue.path[0] ?? '');
    let message: string;
    if (!path) {
      if (issue.message === 'Duplicate member name') message = t('validation.duplicateMember');
      else if (issue.message === 'Duplicate task id') message = t('validation.duplicateTask');
      else if (issue.message.startsWith('Task dependency cycle at ')) message = t('validation.cycle', { id: issue.message.slice('Task dependency cycle at '.length) });
      else if (issue.message.startsWith('Unknown dependency: ')) message = t('validation.missingDependency', { id: issue.message.slice('Unknown dependency: '.length) });
      else if (issue.message.startsWith('Unknown member: ')) message = t('validation.missingMember', { name: issue.message.slice('Unknown member: '.length) });
      else message = t('validation.graph');
    } else {
      const key = issue.path[0] === 'members' && field === 'name' ? 'validation.memberName' : fieldKeys[field] ?? 'validation.graph';
      const prefix = issue.path[0] === 'members' && typeof issue.path[1] === 'number'
        ? `${t('member.heading', { number: issue.path[1] + 1 })}: `
        : issue.path[0] === 'tasks' && typeof issue.path[1] === 'number'
          ? `${t('task.heading', { number: issue.path[1] + 1 })}: ` : '';
      message = prefix + t(key);
    }
    if (!errors.some(error => error.path === path && error.message === message)) errors.push({ path, message });
  }
  // The public model accepts legacy names containing consecutive hyphens; new
  // settings edits use the lower-kebab-case convention shown by this form.
  draft.members.forEach((member, index) => {
    const path = `members.${index}.name`;
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(member.name) && !errors.some(error => error.path === path)) {
      errors.push({ path, message: `${t('member.heading', { number: index + 1 })}: ${t('validation.memberName')}` });
    }
  });
  return { ...(parsed.success && !errors.length ? { plan: parsed.data } : {}), errors };
}

function dependencyReady(team: Team, task: Task): boolean {
  return task.status === 'pending' && task.dependencies.every(id => team.tasks.some(other => other.id === id && other.status === 'completed'));
}

function taskReady(team: Team, task: Task): boolean {
  if (!dependencyReady(team, task)) return false;
  const running = team.tasks.filter(other => other.status === 'running');
  return running.length < team.maxConcurrency
    && !running.some(other => other.assignee === task.assignee || scopesOverlap(other.writeScopes, task.writeScopes));
}

function pendingReason(team: Team, task: Task, t: SettingsTranslate): string {
  const missing = task.dependencies.filter(id => !team.tasks.some(other => other.id === id && other.status === 'completed'));
  if (missing.length) return t('pending.dependencies', { ids: missing.join(', ') });
  const running = team.tasks.filter(other => other.status === 'running');
  if (running.some(other => other.assignee === task.assignee)) return t('pending.member');
  if (running.some(other => scopesOverlap(other.writeScopes, task.writeScopes))) return t('pending.scope');
  if (running.length >= team.maxConcurrency) return t('pending.capacity');
  return t(team.status === 'running' ? 'pending.ready' : 'pending.approval');
}

/** No SDK context or routing: the parent supplies session-scoped, authorized actions. */
export function TeamSettingsPage(props: TeamSettingsPageProps) {
  // Also defend against non-keyed consumers: old requests and drafts cannot move
  // between conversations, even if an action ignores its AbortSignal.
  return <TeamSettingsEditor key={props.sessionId ?? '__no_session__'} {...props} />;
}

function TeamSettingsEditor({ sessionId, team, loading = false, unavailableReason, canManage, actions, t }: TeamSettingsPageProps) {
  const [state, setState] = useState(() => initialState(team));
  const [busy, setBusy] = useState<Operation | null>(null);
  const mounted = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const formId = useId();
  const validation = useMemo(() => validateDraft(state.draft, t), [state.draft, t]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);
  useEffect(() => {
    if (team !== undefined) setState(previous => reconcileSnapshot(previous, team));
  }, [team]);

  const waiting = loading || state.latest === undefined;
  const authorized = !!sessionId && canManage === true && !unavailableReason;
  const writable = configurationEditable(state.latest);
  const canEdit = authorized && !waiting && !busy && writable;
  const canSave = canEdit && state.dirty && !state.conflict;
  const saved = state.latest;
  const ready = saved?.tasks.filter(task => taskReady(saved, task)).length ?? 0;
  const canStart = authorized && !waiting && !busy && !!saved && saved.status !== 'running'
    && !state.dirty && !state.conflict && ready > 0 && !!validation.plan;
  const canRetry = authorized && !waiting && !busy && !!saved && saved.status !== 'running' && !state.dirty && !state.conflict;
  const canStop = authorized && !waiting && !busy && saved?.status === 'running';
  const canRead = !!sessionId && !unavailableReason && !busy;
  const approvalKey = saved ? snapshotKey(saved) : null;
  const approved = approvalKey !== null && state.approved === approvalKey;

  function changeDraft(change: (previous: Draft) => Draft) {
    if (!canEdit || activeRequest.current) return;
    setState(previous => {
      const draft = change(previous.draft);
      return { ...previous, draft, dirty: JSON.stringify(draft) !== JSON.stringify(draftOf(previous.base)), approved: null, error: null, notice: null };
    });
  }

  function updateMember(index: number, field: keyof DraftMember, value: string) {
    changeDraft(previous => {
      const oldName = previous.members[index]?.name;
      return {
        ...previous,
        members: previous.members.map((member, position) => position === index ? { ...member, [field]: value } : member),
        tasks: field === 'name' && oldName && previous.members.filter(member => member.name === oldName).length === 1
          ? previous.tasks.map(task => task.assignee === oldName ? { ...task, assignee: value } : task) : previous.tasks,
      };
    });
  }

  function updateTask(index: number, field: keyof DraftTask, value: string) {
    changeDraft(previous => {
      const oldId = previous.tasks[index]?.id;
      const rename = field === 'id' && oldId && previous.tasks.filter(task => task.id === oldId).length === 1;
      return {
        ...previous,
        tasks: previous.tasks.map((task, position) => {
          let updated = position === index ? { ...task, [field]: value } : task;
          if (rename) updated = { ...updated, dependencies: updated.dependencies.split(/([,\n])/).map(part => part.trim() === oldId ? part.replace(oldId, value) : part).join('') };
          return updated;
        }),
      };
    });
  }

  async function perform(operation: Operation, request: (signal: AbortSignal) => Promise<Team | null>) {
    if (!mounted.current || activeRequest.current) return;
    const controller = new AbortController();
    const startedKey = snapshotKey(state.latest);
    activeRequest.current = controller;
    setBusy(operation);
    setState(previous => ({ ...previous, error: null, notice: null, approved: null }));
    try {
      const result = await request(controller.signal);
      if (!mounted.current || controller.signal.aborted || activeRequest.current !== controller) return;
      if (result && result.ownerSessionId !== sessionId) throw new Error(t('error.session'));
      if (operation !== 'read' && !result) throw new Error(t('error.unknown'));
      setState(previous => {
        const advanced = snapshotKey(previous.latest) !== startedKey;
        const obsolete = olderThan(result, previous.latest)
          || (advanced && result?.id !== previous.latest?.id);
        if (operation === 'read') {
          const current = obsolete ? previous.latest : result;
          return { ...initialState(current), notice: { key: 'reload.success' } };
        }
        if (obsolete) return { ...previous, approved: null, conflict: previous.dirty || previous.conflict };
        if (operation === 'save') return { ...initialState(result), notice: { key: 'save.success', params: { revision: result!.revision } } };
        const noticeKeys = { start: 'execution.started', stop: 'execution.stopped', retry: 'execution.prepared' } as const;
        return { ...reconcileSnapshot(previous, result!), approved: null, notice: { key: noticeKeys[operation] } };
      });
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && activeRequest.current === controller) {
        setState(previous => ({ ...previous, approved: null, error: error instanceof Error ? error.message : t('error.unknown') }));
      }
    } finally {
      if (mounted.current && activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(null);
      }
    }
  }

  function savePlan() {
    if (!canSave || activeRequest.current) return;
    setState(previous => ({ ...previous, submitted: true }));
    if (!validation.plan) return;
    void perform('save', signal => actions.save(validation.plan!, state.base?.revision ?? null, signal));
  }

  function fieldAccessibility(path: string) {
    const invalid = state.submitted && validation.errors.some(error => error.path === path || error.path.startsWith(`${path}.`));
    return { 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? `${formId}-errors` : undefined };
  }

  return <section className="dsh-team-settings dts-stack" aria-label={t('page.title')} aria-busy={!!busy || waiting}>
    <style>{styles}</style>
    <header className="dts-stack">
      <div className="dts-heading">
        <h2>{t('page.title')}</h2>
        <div className="dts-actions">
          <span className="dts-badge">{state.dirty ? t('team.unsaved') : saved ? t('team.revision', { revision: saved.revision }) : t('team.notSaved')}</span>
          {saved && <span className="dts-badge" data-status={saved.status}>{t(`status.${saved.status}`)}</span>}
          <button type="button" disabled={!canRead} onClick={() => { if (canRead) void perform('read', signal => actions.read(signal)); }}>{t(state.dirty || state.conflict ? 'reload.discard' : 'reload.button')}</button>
        </div>
      </div>
      <p className="dts-hint">{t('page.description')}</p>
    </header>

    {!sessionId && <p className="dts-banner" role="status">{t('session.missing')}</p>}
    {waiting && <p className="dts-banner" role="status">{t('session.loading')}</p>}
    {unavailableReason && <p className="dts-banner" role="alert">{unavailableReason}</p>}
    {sessionId && canManage !== true && <p className="dts-banner" role="status">{t('session.readonly')}</p>}
    {saved && !writable && <p className="dts-banner">{t('team.locked')}</p>}
    {state.conflict && <p className="dts-banner" role="alert">{t('team.conflict')}</p>}
    {state.error && <p className="dts-banner" role="alert">{t('error.action', { message: state.error })}</p>}
    {busy && <p role="status">{t(`busy.${busy}`)}</p>}
    {state.notice && <p className="dts-banner" role="status">{t(state.notice.key, state.notice.params)}</p>}

    <form className="dts-stack" noValidate onSubmit={event => { event.preventDefault(); savePlan(); }}>
      {state.submitted && validation.errors.length > 0 && <div className="dts-banner" role="alert" id={`${formId}-errors`}>
        <p>{t('validation.heading')}</p>
        <ul>{validation.errors.map((error, index) => <li key={`${error.path}:${index}`}>{error.message}</li>)}</ul>
      </div>}
      <fieldset disabled={!canEdit}>
        <legend>{t('team.configuration')}</legend>
        <div className="dts-stack">
          <div className="dts-card dts-stack">
            <label className="dts-field">{t('team.name')}<input value={state.draft.name} maxLength={100} readOnly={!canEdit} {...fieldAccessibility('name')} onChange={event => changeDraft(previous => ({ ...previous, name: event.target.value }))} /></label>
            <label className="dts-field">{t('team.goal')}<textarea value={state.draft.goal} rows={3} maxLength={20_000} readOnly={!canEdit} {...fieldAccessibility('goal')} onChange={event => changeDraft(previous => ({ ...previous, goal: event.target.value }))} /></label>
            <label className="dts-field">{t('team.concurrency')}<input type="number" min={1} max={8} step={1} value={state.draft.maxConcurrency} readOnly={!canEdit} {...fieldAccessibility('maxConcurrency')} onChange={event => changeDraft(previous => ({ ...previous, maxConcurrency: event.target.value }))} /></label>
            <p className="dts-hint">{t('team.concurrencyHint')}</p>
          </div>

          {state.base === null && !state.dirty && <div className="dts-card dts-stack">
            <p className="dts-hint">{t('example.hint')}</p>
            <div><button type="button" onClick={() => changeDraft(() => exampleDraft(t))}>{t('example.load')}</button></div>
          </div>}

          <section className="dts-stack" aria-label={t('members.heading')}>
            <div className="dts-heading"><h3>{t('members.heading')} · {state.draft.members.length}/12</h3><button type="button" disabled={!canEdit || state.draft.members.length >= 12} onClick={() => changeDraft(previous => ({ ...previous, members: [...previous.members, { name: '', role: '', instructions: '' }] }))}>{t('member.add')}</button></div>
            <p className="dts-hint">{t('member.nameHint')}</p>
            {!state.draft.members.length && <p className="dts-hint">{t('members.empty')}</p>}
            <div className="dts-grid">{state.draft.members.map((member, index) => <article className="dts-card dts-stack" key={index}>
              <div className="dts-heading"><h4>{t('member.heading', { number: index + 1 })}</h4><button type="button" aria-label={t('member.remove', { number: index + 1 })} onClick={() => changeDraft(previous => ({ ...previous, members: previous.members.filter((_, position) => position !== index) }))}>{t('member.remove', { number: index + 1 })}</button></div>
              <label className="dts-field">{t('member.name')}<input value={member.name} maxLength={40} readOnly={!canEdit} aria-label={t('member.field', { number: index + 1, field: t('member.name') })} {...fieldAccessibility(`members.${index}.name`)} onChange={event => updateMember(index, 'name', event.target.value)} /></label>
              <label className="dts-field">{t('member.role')}<input value={member.role} maxLength={20_000} readOnly={!canEdit} aria-label={t('member.field', { number: index + 1, field: t('member.role') })} {...fieldAccessibility(`members.${index}.role`)} onChange={event => updateMember(index, 'role', event.target.value)} /></label>
              <label className="dts-field">{t('member.instructions')}<textarea value={member.instructions} rows={3} maxLength={20_000} readOnly={!canEdit} aria-label={t('member.field', { number: index + 1, field: t('member.instructions') })} {...fieldAccessibility(`members.${index}.instructions`)} onChange={event => updateMember(index, 'instructions', event.target.value)} /></label>
              <p className="dts-hint">{t('team.model')}</p>
            </article>)}</div>
          </section>

          <section className="dts-stack" aria-label={t('tasks.heading')}>
            <div className="dts-heading"><h3>{t('tasks.heading')} · {state.draft.tasks.length}/200</h3><button type="button" disabled={!canEdit || state.draft.tasks.length >= 200} onClick={() => changeDraft(previous => ({ ...previous, tasks: [...previous.tasks, { id: '', subject: '', description: '', assignee: previous.members[0]?.name ?? '', dependencies: '', writeScopes: '' }] }))}>{t('task.add')}</button></div>
            <p className="dts-hint">{t('team.referenceHint')}</p>
            {!state.draft.tasks.length && <p className="dts-hint">{t('tasks.empty')}</p>}
            <div className="dts-grid">{state.draft.tasks.map((task, index) => <article className="dts-card dts-stack" key={index}>
              <div className="dts-heading"><h4>{t('task.heading', { number: index + 1 })}</h4><button type="button" aria-label={t('task.remove', { number: index + 1 })} onClick={() => changeDraft(previous => ({ ...previous, tasks: previous.tasks.filter((_, position) => position !== index) }))}>{t('task.remove', { number: index + 1 })}</button></div>
              <label className="dts-field">{t('task.id')}<input value={task.id} maxLength={80} readOnly={!canEdit} aria-label={t('task.field', { number: index + 1, field: t('task.id') })} {...fieldAccessibility(`tasks.${index}.id`)} onChange={event => updateTask(index, 'id', event.target.value)} /></label>
              <label className="dts-field">{t('task.title')}<input value={task.subject} maxLength={200} readOnly={!canEdit} aria-label={t('task.field', { number: index + 1, field: t('task.title') })} {...fieldAccessibility(`tasks.${index}.subject`)} onChange={event => updateTask(index, 'subject', event.target.value)} /></label>
              <label className="dts-field">{t('task.description')}<textarea value={task.description} rows={3} maxLength={20_000} readOnly={!canEdit} aria-label={t('task.field', { number: index + 1, field: t('task.description') })} {...fieldAccessibility(`tasks.${index}.description`)} onChange={event => updateTask(index, 'description', event.target.value)} /></label>
              <label className="dts-field">{t('task.assignee')}<select value={task.assignee} aria-label={t('task.field', { number: index + 1, field: t('task.assignee') })} {...fieldAccessibility(`tasks.${index}.assignee`)} onChange={event => updateTask(index, 'assignee', event.target.value)}>
                <option value="">{t('task.chooseMember')}</option>
                {task.assignee && !state.draft.members.some(member => member.name === task.assignee) && <option value={task.assignee}>{t('task.missingMember', { name: task.assignee })}</option>}
                {state.draft.members.map((member, memberIndex) => member.name && <option key={memberIndex} value={member.name}>{member.name}</option>)}
              </select></label>
              <label className="dts-field">{t('task.dependencies')}<textarea value={task.dependencies} rows={2} aria-label={t('task.field', { number: index + 1, field: t('task.dependencies') })} readOnly={!canEdit} {...fieldAccessibility(`tasks.${index}.dependencies`)} onChange={event => updateTask(index, 'dependencies', event.target.value)} /></label>
              <p className="dts-hint">{t('task.dependenciesHint')}</p>
              <label className="dts-field">{t('task.writeScopes')}<textarea value={task.writeScopes} rows={2} aria-label={t('task.field', { number: index + 1, field: t('task.writeScopes') })} readOnly={!canEdit} {...fieldAccessibility(`tasks.${index}.writeScopes`)} onChange={event => updateTask(index, 'writeScopes', event.target.value)} /></label>
              <p className="dts-hint">{t('task.scopesHint')}</p>
            </article>)}</div>
          </section>
        </div>
      </fieldset>
      <div className="dts-actions"><button type="submit" className="dts-primary" disabled={!canSave}>{t('save.button')}</button></div>
    </form>

    <section className="dts-card dts-stack" aria-label={t('execution.heading')}>
      <div className="dts-heading"><h3>{t('execution.heading')}</h3>{saved && <span className="dts-hint">{t('team.revision', { revision: saved.revision })}</span>}</div>
      <p className="dts-hint">{t('execution.cost')}</p>
      {saved && <p className="dts-hint">{t('execution.counts', { pending: saved.tasks.filter(task => task.status === 'pending').length, ready, failed: saved.tasks.filter(task => task.status === 'failed').length })}</p>}
      {state.dirty && <p className="dts-hint">{t('execution.saveFirst')}</p>}
      {!ready && saved?.status !== 'running' && <p className="dts-hint">{t('execution.noPending')}</p>}
      {saved && <label className="dts-confirm"><input type="checkbox" checked={approved} disabled={!canStart} onChange={event => { if (canStart) setState(previous => ({ ...previous, approved: event.target.checked ? approvalKey : null })); }} />{t('execution.confirm', { revision: saved.revision })}</label>}
      <div className="dts-actions">
        <button type="button" className="dts-primary" disabled={!canStart || !approved} onClick={() => { if (canStart && approved && saved) void perform('start', signal => actions.start(saved.revision, signal)); }}>{t('execution.start')}</button>
        <button type="button" disabled={!canStop} onClick={() => { if (canStop) void perform('stop', signal => actions.stop(signal)); }}>{t('execution.stop')}</button>
      </div>
      {!!saved?.tasks.some(task => task.status === 'failed') && <p className="dts-hint">{t('execution.retryHint')}</p>}
      {saved && <ul className="dts-runs">{saved.tasks.map(task => <li className="dts-run" key={task.id}>
        <div className="dts-heading"><div className="dts-actions"><code>{task.id}</code><span>{task.subject}</span><span className="dts-badge" data-status={task.status}>{t(`status.${task.status}`)}</span><span className="dts-hint">{t('task.attempt', { attempt: task.attempt })}</span></div>
          {task.status === 'failed' && <button type="button" disabled={!canRetry} onClick={() => { if (canRetry) void perform('retry', signal => actions.retry(task.id, saved.revision, signal)); }}>{t('execution.retry', { id: task.id })}</button>}
        </div>
        {task.status === 'pending' && <p className="dts-hint">{pendingReason(saved, task, t)}</p>}
        {task.status === 'failed' && <details><summary>{t('task.error')}</summary><pre>{task.error || t('task.noError')}</pre></details>}
        {task.output && <details><summary>{t('task.output')}</summary><pre>{task.output}</pre></details>}
      </li>)}</ul>}
    </section>
  </section>;
}
