import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionLogOffset, appendPluginRecord } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { TeamSchema } from '../src/model.js';
import { publishSnapshot, registerProjection, SNAPSHOT_RECORD } from '../src/projection.js';

function team(owner = 'captain', revision = 1) {
  return TeamSchema.parse({ name: 'Test', goal: 'Test goal', id: 'team-1', ownerSessionId: owner,
    workspaceId: 'workspace', revision, status: 'draft', createdAt: 'now', updatedAt: 'now', members: [], tasks: [], messages: [] });
}
function definition() {
  let value!: ProjectionDefinition<'team-agents'>;
  registerProjection({ sessionProjections: { register: (next: typeof value) => { value = next; } } } as unknown as Context);
  return value;
}

describe('official session projection integration', () => {
  it('publishes ignorable records that replay using the real session SDK', () => {
    const session = Session.create(SessionId('captain'));
    const def = definition();
    publishSnapshot(session, team());
    // Test-only immutable log read validates persistence replay, not production polling.
    const events = session.snapshotEvents();
    expect(events[0]).toMatchObject({ type: SNAPSHOT_RECORD, ignorable: true });
    const restored = Session.create(session.id, events, session.header);
    let state = def.init(restored.header, SessionLogOffset(0));
    for (const event of events) state = def.apply(state, event);
    expect(def.wire!.view(state)).toEqual(team());
  });
  it('ignores inherited captain state in a fork', () => {
    const session = Session.create(SessionId('captain'));
    publishSnapshot(session, team());
    const def = definition();
    const state = def.init(Session.create(SessionId('fork')).header, SessionLogOffset(0));
    expect(def.apply(state, session.snapshotEvents()[0]!)).toBe(state);
  });
  it('does not regress to an older snapshot and ignores unrelated events', () => {
    const session = Session.create(SessionId('captain'));
    publishSnapshot(session, team('captain', 2));
    publishSnapshot(session, team('captain', 1));
    session.append('turn/start', { turn: 1 });
    const def = definition();
    const events = session.snapshotEvents();
    const latest = def.apply(def.init(session.header, SessionLogOffset(0)), events[0]!);
    expect(def.apply(latest, events[1]!)).toBe(latest);
    expect(def.apply(latest, events[2]!)).toBe(latest);
  });
  it('refuses publication to a different session and tolerates malformed plugin records', () => {
    const session = Session.create(SessionId('other'));
    expect(() => publishSnapshot(session, team())).toThrow('does not own');
    appendPluginRecord(session, SNAPSHOT_RECORD, { invalid: true } as unknown as ReturnType<typeof team>);
    const def = definition();
    const state = def.init(session.header, SessionLogOffset(0));
    expect(def.apply(state, session.snapshotEvents()[0]!)).toBe(state);
  });
});
