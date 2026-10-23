import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from './protocol.js';
import { TeamDashboard } from './dashboard.js';
import { locales } from './locales.js';
import { mountTeamRemote } from './remote-client.js';
import { registerTeamSettings } from './settings-integration.js';

type TeamDockProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'team-agents'>;

function TeamDock({ useProjection, t }: TeamDockProps) {
  const team = useProjection('team-agents');
  return <TeamDashboard key={team?.id} team={team} t={t} />;
}

export const inject = ['slots', 'locale', 'uiSession', 'remote'];

export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('team-agents', locales));
  // inject follows the declaration lifetime, including conversation reloads.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'dsh-team-agents',
    order: 40,
    locale: 'team-agents',
  }, TeamDock));
  const remote = await mountTeamRemote(ctx);
  registerTeamSettings(ctx, remote);
}
