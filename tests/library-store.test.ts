import { describe, expect, it, vi } from 'vitest';
import { AgentLibraryStore, agentLibraryDomain, type AgentLibraryTable } from '../src/agent-library.js';
import type { AgentDefinition, AgentLibrary } from '../src/library-model.js';

const agents = (): AgentDefinition[] => [
  { name: 'researcher', role: 'Research', enabled: true, model: { provider: 'configured', model: 'selected' } },
  { name: 'reviewer', role: 'Review', enabled: false },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const rows = new Map<string, AgentLibrary>();
  const put = vi.fn(async (key: string, library: AgentLibrary) => { rows.set(key, structuredClone(library)); });
  const table: AgentLibraryTable = { get: key => rows.get(key), put };
  const store = new AgentLibraryStore(table);
  return { store, rows, put, table };
}

describe('standalone persistent Agent library store', () => {
  it('uses a separate domain and reads an empty revision without writing defaults', () => {
    const h = fixture();
    expect(agentLibraryDomain).toMatchObject({ name: 'dsh_team_agent_library', version: 1 });
    expect(Object.keys(agentLibraryDomain.tables)).toEqual(['libraries']);
    expect(h.store.read()).toEqual({ revision: 0, agents: [], updatedAt: null });
    expect(h.put).not.toHaveBeenCalled();
  });
  it('round-trips the default record across store recreation and deep-copies all public snapshots', async () => {
    const h = fixture(); const input = agents();
    const saved = await h.store.save(input, 0);
    expect(h.put).toHaveBeenCalledExactlyOnceWith('default', expect.objectContaining({ revision: 1 }));
    expect(saved.updatedAt).toEqual(expect.any(String));
    input[0]!.model!.model = 'mutated input'; saved.agents[0]!.model!.model = 'mutated reply';
    const copy = h.store.read(); copy.agents[0]!.model!.model = 'mutated read';
    expect(h.store.read().agents[0]!.model!.model).toBe('selected');
    await h.store.dispose();
    const reopened = new AgentLibraryStore(h.table);
    expect(reopened.read()).toEqual(h.rows.get('default'));
    expect(reopened.read().agents[1]!.enabled).toBe(false);
    await reopened.dispose();
  });
  it('serializes concurrent CAS saves and rejects a stale editor without lost writes', async () => {
    const h = fixture();
    const attempts = await Promise.allSettled([h.store.save(agents(), 0), h.store.save([{ ...agents()[0]!, role: 'Changed' }], 0)]);
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(h.store.read().revision).toBe(1); expect(h.put).toHaveBeenCalledOnce();
    await h.store.dispose();
  });
  it('snapshots input before waiting in the queue and checks cancellation/guard before queued writes', async () => {
    const h = fixture(); const gate = deferred<void>(); const entered = deferred<void>();
    h.put.mockImplementationOnce(async (key, value) => { entered.resolve(); await gate.promise; h.rows.set(key, structuredClone(value)); });
    const first = h.store.save(agents(), 0); await entered.promise;
    const input = agents(); const queued = h.store.save(input, 1);
    input[0]!.model!.model = 'changed while queued';
    const abort = new AbortController(); const cancelled = h.store.save(agents(), 2, abort.signal);
    const cancellation = expect(cancelled).rejects.toThrow('Discarded'); abort.abort(new Error('Discarded'));
    let authorized = true;
    const guarded = h.store.save(agents(), 2, undefined, () => { if (!authorized) throw new Error('Revoked'); });
    const revocation = expect(guarded).rejects.toThrow('Revoked'); authorized = false;
    gate.resolve(); await first; await queued; await cancellation; await revocation;
    expect(h.store.read().revision).toBe(2); expect(h.store.read().agents[0]!.model!.model).toBe('selected');
    expect(h.put).toHaveBeenCalledTimes(2); await h.store.dispose();
  });
  it('does not poison the queue after a rejected write or pre-aborted save', async () => {
    const h = fixture();
    const abort = new AbortController(); abort.abort(new Error('Cancelled'));
    await expect(h.store.save(agents(), 0, abort.signal)).rejects.toThrow('Cancelled');
    h.put.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(h.store.save(agents(), 0)).rejects.toThrow('Disk unavailable');
    expect(h.store.read().revision).toBe(0);
    expect((await h.store.save(agents(), 0)).revision).toBe(1);
    await h.store.dispose();
  });
  it('selects deep-copied enabled Members in caller order without enabled or runtime fields', async () => {
    const h = fixture(); const input = agents(); input[1]!.enabled = true;
    const saved = await h.store.save(input, 0);
    const selected = h.store.select(['reviewer', 'researcher'], saved.revision);
    expect(selected.map(member => member.name)).toEqual(['reviewer', 'researcher']);
    for (const member of selected) { expect(member).not.toHaveProperty('enabled'); expect(member).not.toHaveProperty('sessionId'); }
    selected[1]!.model!.model = 'mutated selection';
    expect(h.store.read().agents[0]!.model!.model).toBe('selected');
    expect(h.put).toHaveBeenCalledOnce(); await h.store.dispose();
  });
  it('rejects stale, disabled, missing, duplicate, and empty selections without writes', async () => {
    const h = fixture(); await h.store.save(agents(), 0);
    expect(() => h.store.select(['researcher'], 0)).toThrow('changed');
    expect(() => h.store.select(['reviewer'], 1)).toThrow('missing or disabled');
    expect(() => h.store.select(['missing'], 1)).toThrow('missing or disabled');
    expect(() => h.store.select(['researcher', 'researcher'], 1)).toThrow('unique');
    expect(() => h.store.select([], 1)).toThrow();
    expect(h.put).toHaveBeenCalledOnce(); await h.store.dispose();
  });
  it('disposal rejects new and queued saves while waiting for an admitted durable write', async () => {
    const h = fixture(); const gate = deferred<void>(); const entered = deferred<void>();
    h.put.mockImplementationOnce(async (key, value) => { entered.resolve(); await gate.promise; h.rows.set(key, structuredClone(value)); });
    const active = h.store.save(agents(), 0); await entered.promise;
    const queued = h.store.save(agents(), 1); const rejected = expect(queued).rejects.toThrow('shutting down');
    let settled = false; const closing = h.store.dispose().then(() => { settled = true; });
    await expect(h.store.save(agents(), 1)).rejects.toThrow('shutting down');
    await Promise.resolve(); expect(settled).toBe(false);
    gate.resolve(); await active; await rejected; await closing;
    expect(settled).toBe(true); expect(h.put).toHaveBeenCalledOnce();
  });
  it('refuses revision overflow without writing an unsafe persisted number', async () => {
    const h = fixture(); h.rows.set('default', { revision: Number.MAX_SAFE_INTEGER, agents: [], updatedAt: 'now' });
    await expect(h.store.save([], Number.MAX_SAFE_INTEGER)).rejects.toThrow('revision limit');
    expect(h.put).not.toHaveBeenCalled(); await h.store.dispose();
  });
});
