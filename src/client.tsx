import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import { locales } from './locales.js';
import { mountTeamRemote } from './remote-client.js';
import { mountAgentLibraryRemote } from './library-remote-client.js';
import { registerTeamSettings } from './settings-integration.js';
import { registerTeamConversationView } from './conversation-view.js';

export const inject = ['slots', 'locale', 'uiSession', 'remote'];

export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('team-agents', locales));
  const [remote, libraryActions] = await Promise.all([mountTeamRemote(ctx), mountAgentLibraryRemote(ctx)]);
  // Team status lives in a native conversation tab, never below the composer.
  registerTeamConversationView(ctx, remote);
  // Reusable configuration stays global and session-free.
  registerTeamSettings(ctx, libraryActions);
}
