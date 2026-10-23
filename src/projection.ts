import type { Context } from '@deepseek-ai/cordis';
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';
import { TeamSchema, type Team } from './model.js';

import { PROJECTION, SNAPSHOT_RECORD } from './protocol.js';
export { PROJECTION, SNAPSHOT_RECORD } from './protocol.js';
const ProjectionStateSchema = z.object({ owner: z.string(), team: TeamSchema.nullable() });

export function publishSnapshot(session: Session, team: Team): void {
  if (session.id !== team.ownerSessionId) throw new Error('Snapshot session does not own this team');
  appendPluginRecord(session, SNAPSHOT_RECORD, team);
}

export function registerProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: PROJECTION, stateSchema: ProjectionStateSchema, stateVersion: 1,
    init: header => ({ owner: header.id, team: null }),
    apply: (state, event) => {
      const record = pluginRecordOf(event);
      if (record?.type !== SNAPSHOT_RECORD) return state;
      const parsed = TeamSchema.safeParse(record.data);
      // Forked captain history must never expose/control the original team's state.
      if (!parsed.success || parsed.data.ownerSessionId !== state.owner ||
        (state.team && parsed.data.revision <= state.team.revision)) return state;
      return { owner: state.owner, team: parsed.data };
    },
    wire: { viewSchema: TeamSchema.nullable(), view: state => state.team },
  });
}
