import { describe, expect, it, vi } from 'vitest';
import { TeamEngine, type TeamDriver } from '../src/engine.js';
import { TeamSchema, type Team } from '../src/model.js';
import { buildTeamRunExport } from '../src/run-export.js';
import { validateTeamRunExportResult } from '../src/remote-client.js';

function fixture() {
  const rows = new Map<string, Team>();
  const put = vi.fn(async (id: string, value: Team) => { rows.set(id, structuredClone(value)); });
  const onChange = vi.fn();
  const driver: TeamDriver = { run: vi.fn(async () => { throw new Error('No model calls in acceptance tests'); }),
    deliver: vi.fn(async () => false), dispose: vi.fn(async () => {}) };
  const engine = new TeamEngine({ get: id => rows.get(id), entries: () => rows.entries(), put }, driver, { onChange });
  return { engine, rows, put, onChange, driver };
}
const instant = '2026-10-25T13:00:00.000Z';

describe('run export acceptance across retained storage, serializer and client validator', () => {
  it('downloads the same retained revision in both formats without changing execution or configuration', async () => {
    const h = fixture();
    try {
      await h.engine.savePlan('captain', 'workspace', null, { name: '项目只读审查', goal: 'Read the project', maxConcurrency: 2,
        members: [{ name: 'reader', role: 'Research', instructions: 'EXCLUDED_INSTRUCTIONS' }],
        tasks: [{ id: 'inspect', subject: 'Read', description: 'Inspect source', assignee: 'reader' }],
      });
      await h.engine.message('captain', 'captain', 'reader', 'OPTIONAL_PRIVATE_MESSAGE');
      await h.engine.create('other', 'other-workspace', { name: 'OTHER_SESSION_TEAM', goal: 'Unrelated work' });
      const before = structuredClone([...h.rows]); h.put.mockClear(); h.onChange.mockClear();
      for (const format of ['markdown', 'json'] as const) {
        const captured = h.engine.snapshot('captain')!;
        const envelope = buildTeamRunExport(captured, { format }, instant);
        const wire = JSON.parse(JSON.stringify(envelope));
        const download = validateTeamRunExportResult(wire, { sessionId: 'captain', format });
        expect(download).toMatchObject({ ownerSessionId: 'captain', sourceRevision: captured.revision, includeMessages: false, exportedAt: instant });
        expect(download.content).toContain('项目只读审查');
        for (const value of ['EXCLUDED_INSTRUCTIONS', 'OPTIONAL_PRIVATE_MESSAGE', 'OTHER_SESSION_TEAM']) expect(download.content).not.toContain(value);
      }
      const explicit = buildTeamRunExport(h.engine.snapshot('captain'), { format: 'json', includeMessages: true }, instant);
      expect(validateTeamRunExportResult(explicit, { sessionId: 'captain', format: 'json', includeMessages: true }).content).toContain('OPTIONAL_PRIVATE_MESSAGE');
      expect([...h.rows]).toEqual(before); expect(h.put).not.toHaveBeenCalled(); expect(h.onChange).not.toHaveBeenCalled();
      expect(h.driver.run).not.toHaveBeenCalled(); expect(h.driver.deliver).not.toHaveBeenCalled();
    } finally { await h.engine.dispose(); }
  });
  it('after an actual fixture retry, exports only remaining fields instead of resurrecting a failed attempt', async () => {
    const h = fixture();
    try {
      h.rows.set('captain', TeamSchema.parse({ id: 'team', name: 'Failed attempt', goal: 'Retry test', ownerSessionId: 'captain',
        workspaceId: 'workspace', revision: 7, status: 'paused', createdAt: instant, updatedAt: instant,
        members: [{ name: 'reader', role: 'Read' }], messages: [], tasks: [{ id: 'inspect', subject: 'Read', description: 'Read only',
          assignee: 'reader', status: 'failed', attempt: 1, attemptId: 'old-attempt', startedAt: instant, endedAt: instant,
          output: 'PREVIOUS_ATTEMPT_OUTPUT', error: 'PREVIOUS_ATTEMPT_ERROR' }],
      }));
      await h.engine.retry('captain', 'inspect', 7);
      const envelope = buildTeamRunExport(h.engine.snapshot('captain'), { format: 'json' }, instant);
      const doc = JSON.parse(validateTeamRunExportResult(envelope, { sessionId: 'captain', format: 'json' }).content);
      expect(doc.sourceRevision).toBe(8);
      expect(doc.team.tasks[0]).toMatchObject({ status: 'pending', attempt: 1 });
      for (const key of ['output', 'error', 'startedAt', 'endedAt', 'attemptId']) expect(doc.team.tasks[0]).not.toHaveProperty(key);
      expect(envelope.content).not.toContain('PREVIOUS_ATTEMPT'); expect(h.driver.run).not.toHaveBeenCalled();
    } finally { await h.engine.dispose(); }
  });
  it('the client refuses another session even when the export itself is well-formed', async () => {
    const h = fixture();
    try {
      await h.engine.create('other', 'workspace', { name: 'Other', goal: 'Other work' });
      const envelope = buildTeamRunExport(h.engine.snapshot('other'), { format: 'json' }, instant);
      expect(() => validateTeamRunExportResult(envelope, { sessionId: 'captain', format: 'json' })).toThrow('another captain');
    } finally { await h.engine.dispose(); }
  });
});
