import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { mountTeamRemote } from '../src/remote-client.js';
import type { MemberActivity } from '../src/member-activity-contract.js';

function frame(overrides: Partial<MemberActivity> = {}): MemberActivity {
  return { ownerSessionId: 'captain', teamId: 'team', member: 'reader', childSessionId: 'child', sequence: 1,
    cursor: 3, observedAt: 1000, status: 'idle', phase: 'idle', live: false, startedAt: null, endedAt: null,
    elapsedMs: null, lastActivityAt: null, task: null, entries: [], historyTruncated: false,
    liveOutput: '', liveTruncated: false, livePartial: false, ...overrides };
}
async function fixture(values: unknown[]) {
  const cleanups: Array<() => void> = [];
  const dispose = vi.fn();
  const watchMember = vi.fn((_request: unknown, _signal?: AbortSignal) => ({
    async *[Symbol.asyncIterator]() { for (const value of values) yield value; }, dispose, send: vi.fn(), end: vi.fn(),
  }));
  const remote = { $mount: vi.fn(async () => {}), teamAgents: { watchMember } };
  const effect = (install: () => () => void) => { cleanups.push(install()); };
  const ctx = { remote, effect, inject: async (_names: string[], apply: (scope: unknown) => unknown) => { await apply({ remote, effect }); } } as unknown as Context;
  const mounted = await mountTeamRemote(ctx);
  return { actions: mounted.forSession('captain'), watchMember, dispose, cleanup: () => { for (const cleanup of cleanups.reverse()) cleanup(); } };
}
describe('native member stream Client adapter', () => {
  it('opens lazily with a fixed parent/member address and disposes the native handle', async () => {
    const h = await fixture([frame(), frame({ sequence: 2 })]);
    const stream = h.actions.watchMember!('reader'); expect(h.watchMember).not.toHaveBeenCalled();
    const seen = []; for await (const value of stream) seen.push(value);
    expect(seen).toHaveLength(2);
    expect(h.watchMember).toHaveBeenCalledWith({ sessionId: 'captain', member: 'reader' }, expect.any(AbortSignal));
    expect(h.dispose).toHaveBeenCalled(); h.cleanup();
  });
  it.each([
    { ownerSessionId: 'other' }, { member: 'other' }, { sequence: 0 },
  ])('fails closed on a foreign or invalid activity frame %j', async bad => {
    const h = await fixture([frame(bad as Partial<MemberActivity>)]);
    await expect(h.actions.watchMember!('reader')[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(h.dispose).toHaveBeenCalled(); h.cleanup();
  });
  it('rejects repeated/out-of-order sequence numbers and releases the subscription', async () => {
    const h = await fixture([frame({ sequence: 2 }), frame({ sequence: 1 })]);
    const stream = h.actions.watchMember!('reader')[Symbol.asyncIterator]();
    expect((await stream.next()).value.sequence).toBe(2);
    await expect(stream.next()).rejects.toThrow('sequence'); expect(h.dispose).toHaveBeenCalled(); h.cleanup();
  });
  it('cancels the handle on caller abort, early return and plugin unload', async () => {
    const h = await fixture([frame(), frame({ sequence: 2 })]);
    const abort = new AbortController(); const stream = h.actions.watchMember!('reader', abort.signal)[Symbol.asyncIterator]();
    await stream.next(); abort.abort(); expect(h.dispose).toHaveBeenCalled();
    await expect(stream.next()).rejects.toThrow();
    const second = h.actions.watchMember!('reader')[Symbol.asyncIterator](); await second.next();
    const previous = h.dispose.mock.calls.length;
    await second.return?.(); expect(h.dispose.mock.calls.length).toBeGreaterThan(previous);
    const third = h.actions.watchMember!('reader')[Symbol.asyncIterator](); await third.next(); h.cleanup();
    await expect(third.next()).rejects.toThrow();
    await expect(h.actions.watchMember!('reader')[Symbol.asyncIterator]().next()).rejects.toThrow();
  });
});
