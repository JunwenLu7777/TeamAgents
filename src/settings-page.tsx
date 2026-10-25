import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AgentLibrarySchema, MAX_LIBRARY_AGENTS, type AgentDefinition, type AgentLibrary } from './library-model.js';
import type { TeamModelOption } from './model.js';
import { createRoleMember, ROLE_TEMPLATES } from './role-templates.js';
import type { AgentLibraryActions, TeamSettingsData } from './settings-contract.js';
import type { SettingsKey, SettingsTranslate } from './settings-locales.js';

export interface TeamSettingsPageProps extends TeamSettingsData { actions: AgentLibraryActions; t: SettingsTranslate; }
type DraftAgent = Omit<AgentDefinition, 'instructions'> & { instructions: string };
type Operation = 'read' | 'save';
type Notice = { key: SettingsKey; params?: Record<string, string | number> };
type EditorState = {
  base: AgentLibrary | undefined; latest: AgentLibrary | undefined; draft: DraftAgent[];
  dirty: boolean; conflict: boolean; submitted: boolean; error: string | null; notice: Notice | null;
};
const modelValue = (route: { provider: string; model: string }) => JSON.stringify([route.provider, route.model]);

// Settings owns scrolling. This normal-flow section owns its own border-box reset,
// including the root, rather than changing host CSS or introducing an inner viewport.
const styles = `
.dsh-team-settings { --dts-accent: #4d6bfe; --dts-border: color-mix(in srgb, currentColor 12%, transparent); --dts-fill: color-mix(in srgb, currentColor 3%, transparent); --dts-muted: color-mix(in srgb, currentColor 68%, transparent); color: inherit; font: inherit; line-height: 1.6; width: 100%; max-width: 68rem; min-width: 0; margin-inline: auto; padding: 4px 4px 24px; overflow-wrap: anywhere; container: team-settings / inline-size; }
.dsh-team-settings, .dsh-team-settings::before, .dsh-team-settings::after, .dsh-team-settings *, .dsh-team-settings *::before, .dsh-team-settings *::after { box-sizing: border-box; }
.dsh-team-settings h2, .dsh-team-settings h3, .dsh-team-settings h4, .dsh-team-settings p { margin: 0; }
.dsh-team-settings h2 { font-size: 1.35rem; font-weight: 700; letter-spacing: -.025em; line-height: 1.3; }
.dsh-team-settings h3 { font-size: .95rem; font-weight: 650; }
.dsh-team-settings h4 { font-size: .875rem; font-weight: 650; }
.dsh-team-settings .dts-heading, .dsh-team-settings .dts-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; min-width: 0; }
.dsh-team-settings .dts-heading { justify-content: space-between; }
.dsh-team-settings .dts-heading > *, .dsh-team-settings .dts-actions > * { min-width: 0; max-width: 100%; }
.dsh-team-settings.dts-stack, .dsh-team-settings .dts-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; align-content: start; }
.dsh-team-settings .dts-hero { padding: 18px; border: 1px solid color-mix(in srgb, var(--dts-accent) 22%, transparent); border-radius: 14px; background: linear-gradient(125deg, color-mix(in srgb, var(--dts-accent) 9%, transparent), transparent 85%); }
.dsh-team-settings .dts-eyebrow { color: var(--dts-muted); font-size: .65rem; font-weight: 650; letter-spacing: .1em; margin-bottom: 6px; }
.dsh-team-settings .dts-hero .dts-hint { margin-top: 8px; max-width: 34rem; }
.dsh-team-settings .dts-stats { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dts-border); }
.dsh-team-settings .dts-card { border: 1px solid var(--dts-border); border-radius: 12px; padding: 16px; min-width: 0; background: transparent; }
.dsh-team-settings .dts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 12px; min-width: 0; }
.dsh-team-settings .dts-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 12px; min-width: 0; }
.dsh-team-settings .dts-field { display: grid; align-content: start; gap: 6px; min-width: 0; font-size: .8rem; font-weight: 500; }
.dsh-team-settings .dts-hint { font-size: .75rem; font-weight: 400; color: var(--dts-muted); overflow-wrap: anywhere; }
.dsh-team-settings input:not([type='checkbox']), .dsh-team-settings textarea, .dsh-team-settings select { display: block; width: 100%; max-width: 100%; min-width: 0; margin: 0; border: 1px solid var(--dts-border); border-radius: 8px; padding: 9px 11px; background: var(--dts-fill); color: inherit; font: inherit; font-weight: 400; line-height: 1.5; }
.dsh-team-settings textarea { resize: vertical; min-height: 80px; }
.dsh-team-settings select { text-overflow: ellipsis; }
.dsh-team-settings option, .dsh-team-settings optgroup { background: Canvas; color: CanvasText; }
.dsh-team-settings input[readonly], .dsh-team-settings textarea[readonly], .dsh-team-settings select:disabled { opacity: .7; }
.dsh-team-settings [aria-invalid='true'] { border-color: #e05454; }
.dsh-team-settings fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.dsh-team-settings .dts-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.dsh-team-settings button { font: inherit; font-size: .78rem; font-weight: 500; color: inherit; background: var(--dts-fill); border: 1px solid var(--dts-border); border-radius: 8px; min-height: 34px; max-width: 100%; padding: 7px 11px; cursor: pointer; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.dsh-team-settings button:hover:not(:disabled) { background: color-mix(in srgb, var(--dts-accent) 8%, transparent); border-color: color-mix(in srgb, var(--dts-accent) 45%, transparent); }
.dsh-team-settings button:disabled { cursor: not-allowed; opacity: .45; }
.dsh-team-settings .dts-primary { background: #3e58e8; border-color: #3e58e8; color: #fff; font-weight: 600; padding-inline: 20px; }
.dsh-team-settings .dts-primary:hover:not(:disabled) { background: #3047c8; border-color: #3047c8; }
.dsh-team-settings .dts-remove { background: transparent; color: var(--dts-muted); font-size: .7rem; padding: 4px 8px; min-height: 28px; }
.dsh-team-settings :is(button, input, textarea, select, summary):focus-visible { outline: 2px solid var(--dts-accent); outline-offset: 2px; }
.dsh-team-settings .dts-banner { border: 1px solid var(--dts-border); border-inline-start: 3px solid var(--dts-accent); border-radius: 8px; padding: 12px; font-size: .8rem; overflow-wrap: anywhere; }
.dsh-team-settings .dts-banner[role='alert'] { border-inline-start-color: #e49a35; }
.dsh-team-settings .dts-banner ul { margin: 6px 0 0; padding-inline-start: 22px; }
.dsh-team-settings .dts-badge { display: inline-block; font-size: .7rem; font-weight: 500; background: var(--dts-fill); border: 1px solid var(--dts-border); border-radius: 6px; padding: 3px 8px; }
.dsh-team-settings .dts-template-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.dsh-team-settings .dts-template { text-align: start; display: grid; gap: 4px; padding: 12px; background: transparent; }
.dsh-team-settings .dts-template strong { font-size: .8rem; font-weight: 600; }
.dsh-team-settings .dts-template .dts-hint { font-size: .7rem; line-height: 1.5; }
.dsh-team-settings .dts-agent { border-inline-start: 3px solid color-mix(in srgb, var(--dts-accent) 45%, transparent); }
.dsh-team-settings .dts-agent[data-enabled='false'] { border-inline-start-color: var(--dts-border); }
.dsh-team-settings .dts-avatar { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 28px; font-size: .7rem; font-weight: 600; color: var(--dts-accent); background: color-mix(in srgb, var(--dts-accent) 8%, transparent); border-radius: 50%; }
.dsh-team-settings .dts-agent-title { flex: 1; min-width: 0; }
.dsh-team-settings .dts-agent-title h4 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-team-settings .dts-enabled { display: flex; align-items: center; gap: 8px; font-size: .78rem; }
.dsh-team-settings .dts-enabled input { flex: 0 0 auto; width: 17px; height: 17px; margin: 0; accent-color: var(--dts-accent); }
.dsh-team-settings .dts-empty { text-align: center; border: 1px dashed var(--dts-border); border-radius: 10px; padding: 22px 14px; }
.dsh-team-settings .dts-savebar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 4px 0; }
.dsh-team-settings .dts-savebar .dts-hint { flex: 1 1 180px; }
.dsh-team-settings code { display: block; padding: 12px; border-radius: 8px; background: var(--dts-fill); font: inherit; font-size: .8rem; overflow-wrap: anywhere; }
.dsh-team-settings details { min-width: 0; }
.dsh-team-settings summary { cursor: pointer; font-size: .78rem; font-weight: 500; padding: 6px 2px; }
.dsh-team-settings details > .dts-stack { margin-top: 10px; }
@container team-settings (max-width: 380px) { .dsh-team-settings .dts-template-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dsh-team-settings .dts-card, .dsh-team-settings .dts-hero { padding: 14px; } }
@media (prefers-reduced-motion: no-preference) { .dsh-team-settings button { transition: background-color .15s, border-color .15s; } }
`;

function draftOf(library: AgentLibrary | undefined): DraftAgent[] {
  return (library?.agents ?? []).map(agent => ({ ...structuredClone(agent), instructions: agent.instructions ?? '' }));
}
function initialState(library: AgentLibrary | undefined): EditorState {
  return { base: library, latest: library, draft: draftOf(library), dirty: false, conflict: false, submitted: false, error: null, notice: null };
}
function reconcile(state: EditorState, library: AgentLibrary): EditorState {
  if (state.latest && library.revision <= state.latest.revision) return state;
  return state.dirty || state.conflict ? { ...state, latest: library, conflict: true, notice: null } : initialState(library);
}
type FormError = { path: string; message: string };
function validateDraft(draft: DraftAgent[], t: SettingsTranslate): { agents?: AgentDefinition[]; errors: FormError[] } {
  const parsed = AgentLibrarySchema.safeParse({ revision: 0, updatedAt: null,
    agents: draft.map(({ instructions, ...agent }) => ({ ...agent, ...(instructions.trim() ? { instructions } : {}) })) });
  const errors: FormError[] = [];
  const add = (path: string, message: string) => { if (!errors.some(error => error.path === path && error.message === message)) errors.push({ path, message }); };
  const fieldKeys: Record<string, SettingsKey> = { name: 'validation.name', role: 'validation.role', instructions: 'validation.instructions', model: 'validation.model' };
  if (!parsed.success) for (const issue of parsed.error.issues) {
    const field = String(issue.path[2] ?? '');
    const key = fieldKeys[field] ?? 'validation.library';
    const prefix = typeof issue.path[1] === 'number' ? `${t('agent.heading', { number: issue.path[1] + 1 })}: ` : '';
    add(issue.path.join('.'), prefix + t(key));
  }
  const names = new Set<string>();
  draft.forEach((agent, index) => {
    const path = `agents.${index}.name`;
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agent.name)) add(path, t('validation.name'));
    if (names.has(agent.name)) add(path, t('validation.duplicate'));
    names.add(agent.name);
  });
  return { ...(parsed.success && !errors.length ? { agents: parsed.data.agents } : {}), errors };
}

/** No Session provider or session id: this is reusable host configuration, not a run plan. */
export function TeamSettingsPage(props: TeamSettingsPageProps) {
  return <AgentLibraryEditor key={props.canRead === false ? 'unavailable' : 'readable'} {...props} />;
}
function AgentLibraryEditor({ library, loading = false, canRead = true, canManage = false, unavailableReason,
  actions, t, modelOptions, modelsLoading = false, modelsError, onRefreshModels }: TeamSettingsPageProps) {
  const [state, setState] = useState(() => initialState(canRead ? library : undefined));
  const [busy, setBusy] = useState<Operation | null>(null);
  const mounted = useRef(false);
  const active = useRef<AbortController | null>(null);
  const formId = useId();
  const validation = useMemo(() => validateDraft(state.draft, t), [state.draft, t]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); active.current = null; }; }, []);
  useEffect(() => { if (canRead && library) setState(previous => reconcile(previous, library)); }, [library, canRead]);
  const waiting = loading || state.latest === undefined;
  const canEdit = canRead && canManage && !waiting && !busy && !unavailableReason;
  const explicit = state.draft.filter(agent => agent.enabled && agent.model);
  const modelsValid = !explicit.length || (!modelsLoading && !modelsError && modelOptions !== undefined
    && explicit.every(agent => modelOptions.some(option => modelValue(option) === modelValue(agent.model!))));
  const canSave = canEdit && state.dirty && !state.conflict && modelsValid;
  const groups = new Map<string, TeamModelOption[]>();
  for (const option of modelOptions ?? []) {
    const group = groups.get(option.provider);
    if (group) group.push(option); else groups.set(option.provider, [option]);
  }
  function change(update: (draft: DraftAgent[]) => DraftAgent[]) {
    if (!canEdit || active.current) return;
    setState(previous => {
      const draft = update(previous.draft);
      return { ...previous, draft, dirty: JSON.stringify(draft) !== JSON.stringify(draftOf(previous.base)), error: null, notice: null };
    });
  }
  function patch(index: number, values: Partial<DraftAgent>) {
    change(draft => draft.map((agent, position) => position === index ? { ...agent, ...values } : agent));
  }
  function chooseModel(index: number, value: string) {
    const option = (modelOptions ?? []).find(candidate => modelValue(candidate) === value);
    if (value && !option) return;
    change(draft => draft.map((agent, position) => {
      if (position !== index) return agent;
      const { model: _model, ...rest } = agent;
      return option ? { ...rest, model: { provider: option.provider, model: option.model } } : rest;
    }));
  }
  function addRole(id: string) {
    if (state.draft.length >= MAX_LIBRARY_AGENTS) return;
    change(draft => [...draft, { ...createRoleMember(id, draft.map(agent => agent.name), t), enabled: true }]);
  }
  async function perform(operation: Operation, request: (signal: AbortSignal) => Promise<AgentLibrary>) {
    if (!mounted.current || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const baseRevision = state.base?.revision;
    setBusy(operation); setState(previous => ({ ...previous, error: null, notice: null }));
    try {
      const result = AgentLibrarySchema.parse(await request(controller.signal));
      if (!mounted.current || controller.signal.aborted || active.current !== controller) return;
      if (operation === 'save' && (baseRevision === undefined || result.revision <= baseRevision)) throw new Error(t('error.response'));
      setState(previous => {
        const obsolete = previous.latest && result.revision < previous.latest.revision;
        if (operation === 'save' && obsolete) return { ...previous, conflict: true };
        return { ...initialState(obsolete ? previous.latest : result), notice: operation === 'save'
          ? { key: 'save.success', params: { revision: result.revision } } : { key: 'reload.success' } };
      });
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && active.current === controller) {
        setState(previous => ({ ...previous, error: error instanceof Error ? error.message : t('error.unknown') }));
      }
    } finally {
      if (mounted.current && active.current === controller) { active.current = null; setBusy(null); }
    }
  }
  function save() {
    if (!canSave || !state.base || active.current) return;
    setState(previous => ({ ...previous, submitted: true }));
    if (validation.agents) void perform('save', signal => actions.save(validation.agents!, state.base!.revision, signal));
  }
  function fieldAccessibility(path: string) {
    const invalid = state.submitted && validation.errors.some(error => error.path === path || error.path.startsWith(`${path}.`));
    return { 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? `${formId}-errors` : undefined };
  }

  return <section className="dsh-team-settings dts-stack" aria-label={t('page.title')} aria-busy={canRead && (!!busy || waiting)}>
    <style>{styles}</style>
    <header className="dts-hero">
      <div className="dts-heading"><div><p className="dts-eyebrow">{t('page.eyebrow')}</p><h2>{t('page.title')}</h2></div>
        {canRead && state.latest && <span className="dts-badge">{t(state.dirty ? 'library.unsaved' : 'library.saved')}</span>}</div>
      <p className="dts-hint">{t('page.description')}</p>
      {canRead && <div className="dts-heading dts-stats">
        <div className="dts-actions"><span className="dts-badge">{t('page.count', { count: state.draft.length })}</span><span className="dts-badge">{t('page.enabled', { count: state.draft.filter(agent => agent.enabled).length })}</span>
          {state.latest && <span className="dts-hint">{t('library.revision', { revision: state.latest.revision })}</span>}</div>
        <div className="dts-actions"><button type="button" disabled={!!busy} onClick={() => { void perform('read', signal => actions.read(signal)); }}>{t(state.dirty || state.conflict ? 'reload.discard' : 'reload.button')}</button>
          {onRefreshModels && <button type="button" disabled={modelsLoading || !!busy} onClick={onRefreshModels}>{t('models.refresh')}</button>}</div>
      </div>}
    </header>
    {!canRead && <p className="dts-banner" role="status">{t('library.readonly')}</p>}
    {canRead && <>
      {waiting && !unavailableReason && <p className="dts-hint" role="status">{t('library.loading')}</p>}
      {unavailableReason && <p className="dts-banner" role="alert">{unavailableReason}</p>}
      {!canManage && <p className="dts-banner" role="status">{t('library.readonly')}</p>}
      {state.conflict && <p className="dts-banner" role="alert">{t('library.conflict')}</p>}
      {state.error && <p className="dts-banner" role="alert">{t('error.action', { message: state.error })}</p>}
      {busy && <p role="status">{t(`busy.${busy}`)}</p>}
      {state.notice && <p className="dts-banner" role="status">{t(state.notice.key, state.notice.params)}</p>}
      <form className="dts-stack" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
        {state.submitted && validation.errors.length > 0 && <div className="dts-banner" role="alert" id={`${formId}-errors`}><p>{t('validation.heading')}</p>
          <ul>{validation.errors.map((error, index) => <li key={`${error.path}:${index}`}>{error.message}</li>)}</ul></div>}
        <fieldset disabled={!canEdit}><legend className="dts-sr-only">{t('library.heading')}</legend><div className="dts-stack">
          <details className="dts-card dts-library" open><summary>{t('roles.heading')}</summary><div className="dts-stack">
            <p className="dts-hint">{t('roles.hint')}</p>
            <div className="dts-template-grid">{ROLE_TEMPLATES.map(template => <button key={template.id} type="button" className="dts-template"
              disabled={!canEdit || state.draft.length >= MAX_LIBRARY_AGENTS} aria-label={t('roles.add', { role: t(template.titleKey) })} onClick={() => addRole(template.id)}>
              <strong>{t(template.titleKey)}</strong><span className="dts-hint">{t(template.descriptionKey)}</span>
            </button>)}</div>
          </div></details>
          <div className="dts-heading"><div><h3>{t('library.heading')}</h3><p className="dts-hint">{t('library.limit', { count: MAX_LIBRARY_AGENTS })}</p></div>
            <button type="button" disabled={!canEdit || state.draft.length >= MAX_LIBRARY_AGENTS} onClick={() => change(draft => [...draft, { name: '', role: '', instructions: '', enabled: true }])}>{t('agent.add')}</button></div>
          <p className="dts-hint">{t('models.hint')}</p>
          {modelsLoading && <p className="dts-hint" role="status">{t('models.loading')}</p>}
          {modelsError && <p className="dts-banner" role="alert">{t('models.error', { message: modelsError })}</p>}
          {!modelsLoading && !modelsError && modelOptions?.length === 0 && <p className="dts-hint">{t('models.empty')}</p>}
          {!modelsValid && !modelsLoading && !modelsError && <p className="dts-banner" role="alert">{t('models.invalid')}</p>}
          {!state.draft.length && <p className="dts-empty dts-hint">{t('library.empty')}</p>}
          <div className="dts-grid">{state.draft.map((agent, index) => <article className="dts-card dts-stack dts-agent" key={index} data-enabled={agent.enabled}>
            <div className="dts-heading"><span className="dts-avatar" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div className="dts-agent-title"><h4 title={agent.role}>{agent.role || t('agent.custom')}</h4><p className="dts-hint">{t('agent.heading', { number: index + 1 })}</p></div>
              <button type="button" className="dts-remove" onClick={() => change(draft => draft.filter((_, position) => position !== index))}>{t('agent.remove', { number: index + 1 })}</button></div>
            <label className="dts-enabled"><input type="checkbox" role="switch" checked={agent.enabled} disabled={!canEdit}
              aria-label={t('agent.field', { number: index + 1, field: t('agent.enabled') })} onChange={event => patch(index, { enabled: event.target.checked })} />{t(agent.enabled ? 'agent.enabled' : 'agent.disabled')}</label>
            <div className="dts-fields">
              <label className="dts-field">{t('agent.name')}<input value={agent.name} maxLength={40} readOnly={!canEdit} aria-label={t('agent.field', { number: index + 1, field: t('agent.name') })} {...fieldAccessibility(`agents.${index}.name`)} onChange={event => patch(index, { name: event.target.value })} /></label>
              <label className="dts-field">{t('agent.model')}<select value={agent.model ? modelValue(agent.model) : ''} disabled={!canEdit || modelsLoading}
                aria-label={t('agent.field', { number: index + 1, field: t('agent.model') })}
                aria-invalid={agent.enabled && agent.model && modelOptions !== undefined && !modelOptions.some(option => modelValue(option) === modelValue(agent.model!)) || undefined}
                onChange={event => chooseModel(index, event.target.value)}>
                <option value="">{t('models.inherit')}</option>
                {agent.model && !modelOptions?.some(option => modelValue(option) === modelValue(agent.model!)) && <option value={modelValue(agent.model)} disabled>{t('models.unavailable', agent.model)}</option>}
                {[...groups].map(([provider, options]) => <optgroup key={provider} label={options[0]!.providerLabel}>{options.map(option => <option key={modelValue(option)} value={modelValue(option)}>{option.modelLabel}</option>)}</optgroup>)}
              </select></label>
            </div>
            <p className="dts-hint">{agent.model ? `${modelOptions?.find(option => modelValue(option) === modelValue(agent.model!))?.providerLabel ?? agent.model.provider} / ${agent.model.model}` : t('agent.inherited')}</p>
            <details><summary>{t('agent.details')}</summary><div className="dts-stack">
              <p className="dts-hint">{t('agent.nameHint')}</p>
              <label className="dts-field">{t('agent.role')}<input value={agent.role} maxLength={20_000} readOnly={!canEdit} aria-label={t('agent.field', { number: index + 1, field: t('agent.role') })} {...fieldAccessibility(`agents.${index}.role`)} onChange={event => patch(index, { role: event.target.value })} /></label>
              <label className="dts-field">{t('agent.instructions')}<textarea value={agent.instructions} rows={5} maxLength={20_000} readOnly={!canEdit} aria-label={t('agent.field', { number: index + 1, field: t('agent.instructions') })} {...fieldAccessibility(`agents.${index}.instructions`)} onChange={event => patch(index, { instructions: event.target.value })} /></label>
            </div></details>
          </article>)}</div>
          <p className="dts-hint">{t('library.snapshotHint')}</p>
        </div></fieldset>
        <div className="dts-savebar"><p className="dts-hint">{t('save.hint')}</p><button type="submit" className="dts-primary" disabled={!canSave}>{t('save.button')}</button></div>
      </form>
    </>}
    <section className="dts-card dts-stack" aria-label={t('usage.heading')}><h3>{t('usage.heading')}</h3><code>{t('usage.example')}</code><p className="dts-hint">{t('usage.hint')}</p></section>
  </section>;
}
