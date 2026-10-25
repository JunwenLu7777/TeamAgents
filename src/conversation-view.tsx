import { useMemo } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from './protocol.js';
import { TeamDashboard } from './dashboard.js';
import { TEAM_REMOTE_ENDPOINTS } from './remote-contract.js';
import type { MountedTeamRemote } from './remote-client.js';

export const TEAM_CONVERSATION_VIEW_ID = 'dsh-team-agents';
type TeamViewProps = PropsRuntime<'conversation.view'> & PropsLocale<'team-agents'>;
const styles = `
.dsh-team-view { box-sizing: border-box; width: 100%; min-width: 0; max-width: 72rem; margin-inline: auto; padding: 20px clamp(12px, 3vw, 28px) 28px; color: inherit; font: inherit; overflow-wrap: anywhere; }
.dsh-team-view .dtv-empty { box-sizing: border-box; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; padding: 24px; }
.dsh-team-view .dtv-empty h2 { margin: 0 0 12px; font-size: 1.1rem; }
.dsh-team-view .dtv-empty p { margin: 8px 0 0; line-height: 1.6; font-size: .85rem; }
.dsh-team-view .dtv-hint { opacity: .7; }
`;

/** The host owns tab selection, persistence and the conversation scrollport. */
export function TeamConversationView({ sessionId, useProjection, useAccess, t, remote }: TeamViewProps & { remote: MountedTeamRemote }) {
  const projected = useProjection('team-agents');
  const canStop = useAccess(TEAM_REMOTE_ENDPOINTS.stop);
  // Export authority is independent of Stop; unknown access is a denial.
  const canExport = useAccess(TEAM_REMOTE_ENDPOINTS.exportRun);
  const canInspect = useAccess(TEAM_REMOTE_ENDPOINTS.watchMember);
  const actions = useMemo(() => remote.forSession(sessionId), [remote, sessionId]);
  // A projection from a previous/forked session must never bleed into this tab.
  const team = projected?.ownerSessionId === sessionId ? projected : undefined;
  return <section className="dsh-team-view" aria-label={t('view.label')}>
    <style>{styles}</style>
    {team ? <TeamDashboard key={`${sessionId}:${team.id}`} presentation="page" sessionId={sessionId}
      team={team} canStop={canStop === true} canExport={canExport === true} canInspect={canInspect === true} actions={actions} t={t} />
      : <div className="dtv-empty" role="status"><h2>{t('view.label')}</h2>
        <p>{t(projected === undefined ? 'view.loading' : projected === null ? 'view.empty' : 'view.unavailable')}</p>
        <p className="dtv-hint">{t('view.chatHint')}</p>
      </div>}
  </section>;
}

/** A real conversation.view entry produces the native top tab; no DOM/CSS relocation. */
export function registerTeamConversationView(ctx: Context, remote: MountedTeamRemote): void {
  ctx.slots.inject('conversation.view', () => {
    const order = Math.max(1000, ...ctx.slots.entries('conversation.view').map(entry => entry.options.order ?? 0)) + 1;
    return ctx.slots.register({ name: 'conversation.view', id: TEAM_CONVERSATION_VIEW_ID,
      label: 'TeamAgents', order, locale: 'team-agents',
    }, (props: TeamViewProps) => <TeamConversationView {...props} remote={remote} />);
  });
}
