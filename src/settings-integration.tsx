import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-api-remote-access/client';
import { TEAM_LIBRARY_REMOTE_ENDPOINTS } from './library-remote-contract.js';
import { AgentLibrarySchema, type AgentLibrary } from './library-model.js';
import type { TeamModelOption } from './model.js';
import type { AgentLibraryActions } from './settings-contract.js';
import { TeamSettingsPage } from './settings-page.js';
import { settingsLocales, type SettingsKey, type SettingsTranslate } from './settings-locales.js';

const BODY = 'team-agents.settings.body' as const;
const NAMESPACE = 'team-agents.settings' as const;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'team-agents.settings.body': { kind: 'single'; scope: 'root' }; }
  interface LocaleNamespaceMap { 'team-agents.settings': SettingsKey; }
}

export interface TeamSettingsBindingProps {
  canRead: boolean;
  canReadModels: boolean;
  canManage: boolean;
  remote: AgentLibraryActions;
  t: SettingsTranslate;
}

/** One host library, independent of selected conversation/workspace. No polling or Agent materialization. */
export function TeamSettingsBinding({ canRead, canReadModels, canManage, remote, t }: TeamSettingsBindingProps) {
  const [library, setLibrary] = useState<AgentLibrary | undefined>();
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<TeamModelOption[] | undefined>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | undefined>();
  const [catalogRevision, refreshModels] = useState(0);
  const translate = useRef(t); translate.current = t;
  const accept = useCallback((candidate: AgentLibrary) => {
    setLibrary(current => current && candidate.revision <= current.revision ? current : candidate);
  }, []);
  const actions = useMemo<AgentLibraryActions>(() => {
    async function observed(operation: Promise<AgentLibrary>, signal?: AbortSignal) {
      const result = AgentLibrarySchema.parse(await operation);
      signal?.throwIfAborted(); accept(result); setError(undefined);
      return result;
    }
    return {
      read: signal => observed(remote.read(signal), signal),
      models: signal => remote.models(signal),
      save: (agents, revision, signal) => observed(remote.save(agents, revision, signal), signal),
    };
  }, [remote, accept]);

  useEffect(() => {
    if (!canRead) { setLibrary(undefined); setLoading(false); setError(undefined); return; }
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    void remote.read(controller.signal).then(result => {
      if (!controller.signal.aborted) accept(result);
    }, failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : translate.current('error.unknown'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [remote, canRead, accept]);

  useEffect(() => {
    if (!canRead || !canReadModels) { setModelOptions(undefined); setModelsLoading(false); setModelsError(undefined); return; }
    const controller = new AbortController();
    setModelsLoading(true); setModelsError(undefined);
    void remote.models(controller.signal).then(options => {
      if (!controller.signal.aborted) setModelOptions(options);
    }, failure => {
      if (!controller.signal.aborted) setModelsError(failure instanceof Error ? failure.message : translate.current('error.unknown'));
    }).finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [remote, canRead, canReadModels, catalogRevision]);

  return <TeamSettingsPage key={canRead ? 'readable' : 'unavailable'} library={canRead ? library : undefined}
    canRead={canRead} canManage={canRead && canManage} loading={loading} unavailableReason={error}
    modelOptions={canRead && canReadModels ? modelOptions : undefined} modelsLoading={modelsLoading}
    modelsError={modelsError ?? (canRead && !canReadModels ? t('library.readonly') : undefined)}
    onRefreshModels={canRead && canReadModels ? () => refreshModels(value => value + 1) : undefined}
    actions={actions} t={t} />;
}

type SectionProps = PropsRuntime<'settings.section'> & PropsRenderSlots<typeof BODY> & PropsLocale<typeof NAMESPACE>;
type BodyProps = PropsRuntime<typeof BODY> & PropsLocale<typeof NAMESPACE>;
function SettingsSection({ renderSlot }: SectionProps) { return renderSlot(BODY, {}); }

/** Root-scoped configuration: no SessionProvider, session projection, or session-bound request. */
export function registerTeamSettings(ctx: Context, remote: AgentLibraryActions): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, settingsLocales));
  function SettingsBody({ useRemoteAccess, t }: BodyProps) {
    const read = useRemoteAccess(TEAM_LIBRARY_REMOTE_ENDPOINTS.read);
    const models = useRemoteAccess(TEAM_LIBRARY_REMOTE_ENDPOINTS.models);
    const save = useRemoteAccess(TEAM_LIBRARY_REMOTE_ENDPOINTS.save);
    return <TeamSettingsBinding canRead={read === true} canReadModels={models === true}
      canManage={save === true} remote={remote} t={t} />;
  }
  ctx.slots.inject(BODY, () => ctx.slots.register({ name: BODY, locale: NAMESPACE }, SettingsBody));
  ctx.slots.inject('settings.section', () => {
    const order = Math.max(1000, ...ctx.slots.entries('settings.section').map(entry => entry.options.order ?? 0)) + 1;
    return ctx.slots.register({ name: 'settings.section', id: 'dsh-team-agents', order,
      label: () => ctx.locale.bind(NAMESPACE)('label'), locale: NAMESPACE,
      children: { [BODY]: { kind: 'single', scope: 'root' } },
    }, SettingsSection);
  });
}
