import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { activityArguments, activityText, MemberActivityFold } from '../src/member-activity-fold.js';
import { MEMBER_ACTIVITY_MAX_ITEMS, MEMBER_ACTIVITY_TEXT_BUDGET, MemberActivityRequestSchema } from '../src/member-activity-contract.js';
const event = (seq: number, type: string, data: unknown, time = seq * 1000): SessionEvent => ({ seq, type, data, time }) as SessionEvent;

describe('public member activity folding', () => {
  it('pairs tools with results and exposes neither hidden blocks nor opaque metadata', () => {
    const fold = new MemberActivityFold();
    fold.push(event(0, 'turn/start', { turn: 1 })); fold.push(event(1, 'step/start', { turn: 1, step: 1 }));
    fold.push(event(2, 'tool/call', { callId: 'call', name: 'read', arguments: JSON.stringify({ file_path: 'README.md', apiKey: 'PRIVATE_KEY' }) }));
    expect(fold.phase).toBe('tool');
    fold.push(event(3, 'tool/result', { message: { source: { kind: 'tool', callId: 'call' }, isError: false, content: [{ type: 'text', text: 'Public result' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }] }, meta: { token: 'PRIVATE_META' } }));
    const tool = fold.view().find(item => item.kind === 'tool')!;
    expect(tool).toMatchObject({ label: 'read', status: 'completed', endedAt: 3000, text: 'Public result' });
    expect(tool.arguments).toContain('README.md');
    const wire = JSON.stringify(fold.view());
    for (const secret of ['PRIVATE_KEY', 'PRIVATE_REASONING', 'PRIVATE_META']) expect(wire).not.toContain(secret);
    expect(fold.lastActivityAt).toBe(3000); expect(fold.phase).toBe('preparing');
  });
  it('shows real nested PTC tool steps instead of only the run_code wrapper', () => {
    const fold = new MemberActivityFold();
    fold.push(event(0, 'tool/ptc-dispatch-start', { subCallId: 'sub', name: 'edit', arguments: { file_path: 'src/a.ts', password: 'PRIVATE' } }));
    fold.push(event(1, 'tool/ptc-dispatch', { subCallId: 'sub', name: 'edit', isError: true, content: [{ type: 'text', text: 'Rejected' }] }));
    expect(fold.view()).toHaveLength(1); expect(fold.view()[0]).toMatchObject({ label: 'edit', status: 'failed', text: 'Rejected' });
    expect(JSON.stringify(fold.view())).not.toContain('PRIVATE');
  });
  it('filters request headers, user/system/developer prompts and private reasoning', () => {
    const fold = new MemberActivityFold();
    for (const [seq, type] of ['request/header', 'request/context', 'system/message', 'developer/message', 'user/message'].entries()) fold.push(event(seq, type, { text: 'PRIVATE' }));
    fold.push(event(5, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: 'Visible' }] }, stream: [] }));
    expect(fold.view()).toHaveLength(1); expect(fold.view()[0]!.text).toBe('Visible'); expect(JSON.stringify(fold.view())).not.toContain('PRIVATE');
  });
  it.each([
    ['completed', 'completed'], ['aborted', 'cancelled'], ['interrupted', 'interrupted'], ['blocked', 'failed'], ['max-tokens', 'failed'], ['error', 'failed'],
  ] as const)('records %s honestly with a frozen ending time', (kind, status) => {
    const fold = new MemberActivityFold();
    fold.push(event(0, 'turn/start', { turn: 1 })); fold.push(event(1, 'tool/call', { callId: 'call', name: 'bash', arguments: '{}' }));
    fold.push(event(2, 'turn/end', { reason: { kind, error: { message: 'Failed Authorization: Bearer PRIVATE_CREDENTIAL' } } }));
    expect(fold.status).toBe(status); expect(fold.phase).toBe('idle'); expect(fold.endedAt).toBe(2000);
    expect(fold.view().find(item => item.kind === 'tool')?.status).toBe('cancelled');
    expect(JSON.stringify(fold.view())).not.toContain('PRIVATE_CREDENTIAL');
  });
  it('ignores replayed duplicate events and resets turn timing for the next attempt', () => {
    const fold = new MemberActivityFold(); const start = event(0, 'turn/start', { turn: 1 });
    fold.push(start); fold.push(start); expect(fold.view()).toHaveLength(1);
    fold.push(event(1, 'turn/end', { reason: { kind: 'completed' } }));
    fold.push(event(2, 'turn/start', { turn: 2 }));
    expect(fold.status).toBe('running'); expect(fold.startedAt).toBe(2000); expect(fold.endedAt).toBeNull();
  });
  it('bounds old history and visible text while declaring truncation', () => {
    const fold = new MemberActivityFold();
    for (let seq = 0; seq < 500; seq++) fold.push(event(seq, 'assistant/message', { message: { content: [{ type: 'text', text: '中'.repeat(10000) }] }, stream: [] }));
    const view = fold.view(); expect(view.length).toBeLessThanOrEqual(MEMBER_ACTIVITY_MAX_ITEMS);
    expect(view.reduce((sum, item) => sum + item.text.length + (item.arguments?.length ?? 0), 0)).toBeLessThanOrEqual(MEMBER_ACTIVITY_TEXT_BUDGET);
    expect(fold.truncated).toBe(true); expect(view.at(-1)!.seq).toBe(499); expect(view.at(-1)!.truncated).toBe(true);
  });
  it('does not turn a malformed tool argument fragment into a credential leak', () => {
    expect(activityArguments('Authorization: Bearer SECRET')).not.toContain('SECRET');
    expect(activityArguments('x'.repeat(100000))).toContain('preview limit');
    expect(activityArguments({ headers: { Authorization: 'SECRET' }, nested: { accessToken: 'SECRET' }, path: 'safe.ts' })).not.toContain('SECRET');
    expect(activityText('OPENAI_API_KEY=abc123 password="with spaces" Bearer tok123 sk-12345')).not.toMatch(/abc123|with spaces|tok123|sk-12345/);
  });
  it('accepts only a parent address and member name, never an arbitrary child selector', () => {
    expect(MemberActivityRequestSchema.parse({ sessionId: 'captain', member: 'reader' }).member).toBe('reader');
    for (const extra of [{ childSessionId: 'other' }, { principal: { kind: 'owner' } }, { path: '/private' }]) {
      expect(() => MemberActivityRequestSchema.parse({ sessionId: 'captain', member: 'reader', ...extra })).toThrow();
    }
  });
});
