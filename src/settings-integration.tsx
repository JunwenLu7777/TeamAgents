import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from './protocol.js';
import { TEAM_REMOTE_ENDPOINTS } from './remote-contract.js';
import type { MountedTeamRemote } from './remote-client.js';
import type { TeamSettingsActions } from './settings-contract.js';
import type { Team } from './model.js';
import { TeamSettingsPage } from './settings-page.js';
import { settingsLocales, type SettingsKey, type SettingsTranslate } from './settings-locales.js';

const BODY = 'team-agents.settings.body' as const;
const NAMESPACE = 'team-agents.settings' as const;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'team-agents.settings.body': { kind: 'single'; scope: 'session-maybe' };
  }
  interface LocaleNamespaceMap { 'team-agents.settings': SettingsKey; }
}

export interface TeamSettingsBindingProps {
  sessionId?: string;
  projectedTeam: Team | null | undefined;
  canRead: boolean;
  canManage: boolean;
  remote: MountedTeamRemote;
  t: SettingsTranslate;
}

/** No polling: one cold-safe read establishes state; existing session projections carry updates. */
export function TeamSettingsBinding({ sessionId, projectedTeam, canRead, canManage, remote, t }: TeamSettingsBindingProps) {
  const [team, setTeam] = useState<Team | null | undefined>(undefined);
  const [loading, setLoading] = useState(!!sessionId && canRead);
  const [error, setError] = useState<string | undefined>();
  const base = useMemo(() => sessionId ? remote.forSession(sessionId) : undefined, [remote, sessionId]);
  const accept = useCallback((candidate: Team | null | undefined) => {
    if (candidate === undefined) return;
    if (candidate && candidate.ownerSessionId !== sessionId) {
      setError(t('error.session'));
      return;
    }
    setTeam(current => {
      // Save can finish before an older baseline/read. There is no delete API, so
      // a null or lower-revision snapshot must not erase a successfully saved plan.
      if (current && (!candidate || (candidate.id === current.id && candidate.revision <= current.revision))) return current;
      return candidate;
    });
  }, [sessionId, t]);
  const actions = useMemo<TeamSettingsActions>(() => {
    const required = () => {
      if (!base || !sessionId) throw new Error(t('session.missing'));
      return base;
    };
    async function observed<T extends Team | null>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
      const result = await operation;
      signal?.throwIfAborted();
      if (result && result.ownerSessionId !== sessionId) throw new Error(t('error.session'));
      accept(result); setError(undefined);
      return result;
    }
    return {
      read: signal => observed(required().read(signal), signal),
      save: (plan, revision, signal) => observed(required().save(plan, revision, signal), signal),
      start: (revision, signal) => observed(required().start(revision, signal), signal),
      stop: signal => observed(required().stop(signal), signal),
      retry: (id, revision, signal) => observed(required().retry(id, revision, signal), signal),
    };
  }, [base, sessionId, t, accept]);

  useEffect(() => {
    if (canRead) accept(projectedTeam);
  }, [projectedTeam, canRead, accept]);
  useEffect(() => {
    if (!base || !canRead) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    void base.read(controller.signal).then(result => {
      if (!controller.signal.aborted) accept(result);
    }, failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, canRead, accept]);

  return <TeamSettingsPage sessionId={sessionId} team={canRead ? team : undefined}
    loading={loading} canManage={canRead && canManage}
    unavailableReason={error ?? (sessionId && !canRead ? t('session.readonly') : undefined)}
    actions={actions} t={t} />;
}

type SectionProps = PropsRuntime<'settings.section'> & PropsRenderSlots<typeof BODY> & PropsLocale<typeof NAMESPACE>;
type BodyProps = PropsRuntime<typeof BODY> & PropsLocale<typeof NAMESPACE>;

function SettingsSection({ SessionProvider, renderSlot, t }: SectionProps) {
  return <SessionProvider empty={() => <section style={{ padding: 24 }}>
    <h2>{t('page.title')}</h2><p>{t('session.missing')}</p>
  </section>}>{renderSlot(BODY, {})}</SessionProvider>;
}

/** Additive settings entry: the shell owns navigation, modal chrome, and current-session binding. */
export function registerTeamSettings(ctx: Context, remote: MountedTeamRemote): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, settingsLocales));
  function SettingsBody({ sessionId, useProjection, useAccess, t }: BodyProps) {
    const projected = useProjection('team-agents');
    const read = useAccess(TEAM_REMOTE_ENDPOINTS.read);
    // Hooks are always called in the same order, including absent Session bindings.
    const save = useAccess(TEAM_REMOTE_ENDPOINTS.save);
    const start = useAccess(TEAM_REMOTE_ENDPOINTS.start);
    const stop = useAccess(TEAM_REMOTE_ENDPOINTS.stop);
    const retry = useAccess(TEAM_REMOTE_ENDPOINTS.retry);
    return <TeamSettingsBinding key={sessionId ?? 'absent'} sessionId={sessionId}
      projectedTeam={projected} canRead={read === true}
      canManage={save === true && start === true && stop === true && retry === true}
      remote={remote} t={t} />;
  }
  ctx.slots.inject(BODY, () => ctx.slots.register({ name: BODY, locale: NAMESPACE }, SettingsBody));
  ctx.slots.inject('settings.section', () => {
    // Append after currently declared settings pages (the marked location), without
    // reading or rewriting another plugin's DOM or replacing the settings shell.
    const order = Math.max(1000, ...ctx.slots.entries('settings.section').map(entry => entry.options.order ?? 0)) + 1;
    return ctx.slots.register({
      name: 'settings.section', id: 'dsh-team-agents', order,
      label: () => ctx.locale.bind(NAMESPACE)('label'), locale: NAMESPACE,
      children: { [BODY]: { kind: 'single', scope: 'session-maybe' } },
    }, SettingsSection);
  });
}
