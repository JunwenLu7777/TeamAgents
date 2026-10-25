import { describe, expect, it } from 'vitest';
import { buildTeamRunExport } from '../src/run-export.js';
import { TeamSchema, type Team } from '../src/model.js';
import { TEAM_RUN_EXPORT_MAX_BYTES, TEAM_RUN_EXPORT_LIMITATIONS, TeamRunExportDocumentSchema, TeamRunExportResultSchema } from '../src/run-export-contract.js';

const instant = '2026-10-25T13:00:00.000Z';
function snapshot(): Team {
  return TeamSchema.parse({ id: 'team-one', ownerSessionId: 'captain', workspaceId: 'PRIVATE_WORKSPACE',
    name: '测试团队', goal: 'Inspect and report', revision: 42, status: 'blocked', createdAt: instant, updatedAt: instant,
    members: [{ name: 'reader', role: 'Read source', instructions: 'PRIVATE_INSTRUCTIONS', sessionId: 'PRIVATE_CHILD',
      model: { provider: 'configured', model: 'selected' } }, { name: 'reviewer', role: 'Review' }],
    tasks: [
      { id: 'read', subject: 'Read sources', description: 'Read only', assignee: 'reader', status: 'completed', attempt: 2,
        attemptId: 'PRIVATE_ATTEMPT', startedAt: instant, endedAt: instant, output: '保留输出\n[Output truncated at 50,000 characters]' },
      { id: 'review', subject: 'Review', description: 'Review findings', assignee: 'reviewer', dependencies: ['read'], writeScopes: ['docs'],
        status: 'failed', attempt: 1, error: 'Retained error' },
    ], messages: [{ id: 'm1', from: 'captain', to: 'reader', text: 'PRIVATE_MAILBOX', createdAt: instant }],
  });
}

describe('retained run export serializer', () => {
  it('exports an allowlisted versioned JSON snapshot without mutating the input', () => {
    const input = snapshot(); const before = structuredClone(input);
    const result = buildTeamRunExport(input, { format: 'json' }, instant);
    expect(TeamRunExportResultSchema.parse(result)).toEqual(result);
    const doc = TeamRunExportDocumentSchema.parse(JSON.parse(result.content));
    expect(doc).toMatchObject({ schemaVersion: 1, kind: 'team-agents/retained-run-snapshot', teamId: input.id,
      ownerSessionId: 'captain', sourceRevision: 42, exportedAt: instant, includeMessages: false,
      team: { name: input.name, status: 'blocked', tasks: [{ id: 'read', attempt: 2, output: input.tasks[0]!.output },
        { id: 'review', dependencies: ['read'], status: 'failed', error: 'Retained error' }] } });
    expect(doc.team.members[1]!.model).toBeNull();
    expect(doc.limitations).toEqual([...TEAM_RUN_EXPORT_LIMITATIONS]);
    expect(doc).not.toHaveProperty('messages');
    for (const secret of ['PRIVATE_WORKSPACE', 'PRIVATE_INSTRUCTIONS', 'PRIVATE_CHILD', 'PRIVATE_ATTEMPT', 'PRIVATE_MAILBOX']) expect(result.content).not.toContain(secret);
    expect(input).toEqual(before);
  });
  it.each(['markdown', 'json'] as const)('includes retained mailbox only on explicit %s opt-in', format => {
    const input = snapshot();
    expect(buildTeamRunExport(input, { format }, instant).content).not.toContain('PRIVATE_MAILBOX');
    expect(buildTeamRunExport(input, { format, includeMessages: true }, instant).content).toContain('PRIVATE_MAILBOX');
    input.messages = [];
    const result = buildTeamRunExport(input, { format: 'json', includeMessages: true }, instant);
    expect(JSON.parse(result.content).messages).toEqual([]);
  });
  it('does not even read excluded instructions, workspace or messages', () => {
    const input = snapshot();
    for (const key of ['messages', 'workspaceId']) Object.defineProperty(input, key, { get() { throw new Error('Should never read excluded data'); } });
    Object.defineProperty(input.members[0]!, 'instructions', { get() { throw new Error('Should never read instructions'); } });
    expect(buildTeamRunExport(input, { format: 'json' }, instant).includeMessages).toBe(false);
  });
  it.each(['draft', 'running', 'paused', 'blocked', 'completed'] as const)('truthfully exports %s without changing status or revision', status => {
    const input = snapshot(); input.status = status;
    const result = buildTeamRunExport(input, { format: 'json' }, instant);
    expect(JSON.parse(result.content).team.status).toBe(status);
    expect(input.revision).toBe(42); expect(input.status).toBe(status);
  });
  it('supports empty teams but rejects a missing team with a stable error code', () => {
    const input = snapshot(); input.members = []; input.tasks = []; input.messages = [];
    expect(JSON.parse(buildTeamRunExport(input, { format: 'json' }, instant).content).team.tasks).toEqual([]);
    expect(() => buildTeamRunExport(null, { format: 'json' })).toThrow(expect.objectContaining({ code: 'team-agents/no-team' }));
  });
  it('does not invent retry-cleared outcomes, timestamps or inherited models', () => {
    const input = snapshot();
    input.tasks[0] = { ...input.tasks[0]!, status: 'pending' };
    delete input.tasks[0].output; delete input.tasks[0].startedAt; delete input.tasks[0].endedAt;
    const doc = JSON.parse(buildTeamRunExport(input, { format: 'json' }, instant).content);
    expect(doc.team.tasks[0]).not.toHaveProperty('output'); expect(doc.team.tasks[0]).not.toHaveProperty('startedAt');
    expect(doc.team.tasks[0].attempt).toBe(2); expect(doc.team.members[1].model).toBeNull();
  });
  it('preserves empty strings and Unicode exactly in JSON', () => {
    const input = snapshot(); input.tasks[0]!.output = ''; input.goal = '中文😀\r\nnext\tline';
    const result = buildTeamRunExport(input, { format: 'json' }, instant);
    expect(JSON.parse(result.content).team.goal).toBe(input.goal);
    expect(JSON.parse(result.content).team.tasks[0].output).toBe('');
    expect(result.byteLength).toBe(new TextEncoder().encode(result.content).length);
  });
  it('renders untrusted Markdown, HTML, fences and CRLF as literal indented data', () => {
    const input = snapshot();
    input.goal = '# Injected heading\r<script>alert(1)</script>\r\n![image](https://example.invalid/x)\n```````\n[end](javascript:alert(1))';
    input.tasks[0]!.output = input.goal;
    const result = buildTeamRunExport(input, { format: 'markdown' }, instant);
    for (const line of input.goal.split(/\r\n|\r|\n/)) expect(result.content).toContain(`    ${line}`);
    expect(result.content).not.toMatch(/^<script|^# Injected|^!\[image\]|^`{7}/m);
    expect(result.content).toContain('not a complete attempt history');
    expect(result.content).toContain('Configured model: inherited');
  });
  it('uses a safe bounded filename unrelated to the user-controlled team name', () => {
    const input = snapshot(); input.id = '../../:中文\u202E?'; input.name = '../../evil.html';
    const result = buildTeamRunExport(input, { format: 'markdown' }, instant);
    expect(result.filename).toBe('team-agents-team-r42-20261025T130000000Z.md');
    expect(result.filename).not.toMatch(/[\\/\u202E]/);
  });
  it('does not spread newly-added fields into exported documents', () => {
    const input = snapshot();
    Object.assign(input, { apiKey: 'EXTRA_SECRET' }); Object.assign(input.members[0]!, { credential: 'EXTRA_SECRET' });
    Object.assign(input.tasks[0]!, { rawHistory: 'EXTRA_SECRET' });
    expect(buildTeamRunExport(input, { format: 'json', includeMessages: true }, instant).content).not.toContain('EXTRA_SECRET');
  });
  it('accepts the exact UTF-8 file bound and refuses one extra byte without truncation', () => {
    const input = snapshot(); input.tasks[0]!.output = '';
    const overhead = buildTeamRunExport(input, { format: 'json' }, instant).byteLength;
    input.tasks[0]!.output = 'x'.repeat(TEAM_RUN_EXPORT_MAX_BYTES - overhead);
    expect(buildTeamRunExport(input, { format: 'json' }, instant).byteLength).toBe(TEAM_RUN_EXPORT_MAX_BYTES);
    input.tasks[0]!.output += 'x';
    expect(() => buildTeamRunExport(input, { format: 'json' }, instant)).toThrow(expect.objectContaining({ code: 'team-agents/export-too-large' }));
    expect(input.tasks[0]!.output.length).toBe(TEAM_RUN_EXPORT_MAX_BYTES - overhead + 1);
  });
  it('bounds multibyte text and expanded Markdown rather than character count alone', () => {
    const input = snapshot(); input.tasks[0]!.output = '中'.repeat(Math.ceil(TEAM_RUN_EXPORT_MAX_BYTES / 3));
    expect(() => buildTeamRunExport(input, { format: 'json' }, instant)).toThrow(expect.objectContaining({ code: 'team-agents/export-too-large' }));
    input.tasks[0]!.output = '\n'.repeat(Math.floor(TEAM_RUN_EXPORT_MAX_BYTES / 4));
    expect(() => buildTeamRunExport(input, { format: 'markdown' }, instant)).toThrow(expect.objectContaining({ code: 'team-agents/export-too-large' }));
  });
  it('returns a generic invalid-snapshot error without leaking malformed values', () => {
    const input = snapshot(); Object.assign(input.tasks[0]!, { status: 'SECRET_INVALID_STATUS' });
    try { buildTeamRunExport(input, { format: 'json' }, instant); throw new Error('Expected validation error'); }
    catch (error) { expect(error).toMatchObject({ code: 'team-agents/export-invalid-snapshot' }); expect(String(error)).not.toContain('SECRET_INVALID_STATUS'); }
    expect(() => buildTeamRunExport(snapshot(), { format: 'json' }, 'not-a-date')).toThrow(expect.objectContaining({ code: 'team-agents/export-invalid-snapshot' }));
  });
  it('rejects unknown formats, coerced flags and arbitrary selectors', () => {
    for (const input of [{ format: 'html' }, { format: 'json', includeMessages: 'true' }, { format: 'json', sessionId: 'other' }]) {
      expect(() => buildTeamRunExport(snapshot(), input as never, instant)).toThrow();
    }
  });
});
