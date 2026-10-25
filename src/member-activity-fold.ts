import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm';
import { MEMBER_ACTIVITY_MAX_ITEMS, MEMBER_ACTIVITY_TEXT_LIMIT, MEMBER_ACTIVITY_TEXT_BUDGET, type ActivityEntry, type MemberActivity } from './member-activity-contract.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Best-effort credential masking, never a promise to redact arbitrary business secrets. */
export function activityText(value: string, limit = MEMBER_ACTIVITY_TEXT_LIMIT): string {
  return value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:[A-Z_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)|api[-_]?key|authorization|password|secret|cookie|token)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, '$1[REDACTED]')
    .slice(0, limit);
}
export function activityArguments(value: unknown): string {
  // Raw, partial or huge JSON is not safe to display as a fallback: it may contain keys we cannot mask.
  if (typeof value === 'string') {
    if (value.length > 65536) return '[Arguments exceed preview limit]';
    try { value = JSON.parse(value); } catch { return '[Arguments not available as structured JSON]'; }
  }
  const clean = (v: unknown, depth: number): unknown => {
    if (depth > 6) return '[Nested content omitted]';
    if (typeof v === 'string') return activityText(v, 2000);
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.slice(0, 30).map(item => clean(item, depth + 1));
    if (typeof v === 'object' && v) return Object.fromEntries(Object.entries(v).slice(0, 60).map(([key, item]) => [key,
      /key|token|password|secret|authorization|cookie|credential|header/i.test(key) ? '[REDACTED]' : clean(item, depth + 1)]));
    return '[Unsupported value]';
  };
  return activityText(JSON.stringify(clean(value, 0), null, 2) ?? '');
}
function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const result: string[] = []; let size = 0;
  for (const block of content) {
    const item = object(block);
    if (item.type !== 'text' || typeof item.text !== 'string') continue;
    const text = item.text.slice(0, MEMBER_ACTIVITY_TEXT_LIMIT + 1);
    result.push(text); size += text.length;
    if (size > MEMBER_ACTIVITY_TEXT_LIMIT) break;
  }
  return result.join('\n');
}

/** Only allowlisted public events enter the view. No requests, prompts, reasoning, or opaque meta. */
export class MemberActivityFold {
  cursor = -1;
  lastActivityAt: number | null = null;
  startedAt: number | null = null;
  endedAt: number | null = null;
  status: MemberActivity['status'] = 'idle';
  phase: MemberActivity['phase'] = 'idle';
  truncated = false;
  private entries: ActivityEntry[] = [];
  private calls = new Map<string, ActivityEntry>();
  private add(entry: ActivityEntry) {
    this.entries.push(entry);
    if (this.entries.length > MEMBER_ACTIVITY_MAX_ITEMS) {
      const removed = this.entries.shift()!; this.truncated = true;
      for (const [id, item] of this.calls) if (item === removed) this.calls.delete(id);
    }
  }
  private entry(event: SessionEvent, kind: ActivityEntry['kind'], label: string, raw = ''): ActivityEntry {
    return { id: `event-${event.seq}`, seq: event.seq, time: event.time, kind,
      label: activityText(label, 160), text: activityText(raw), truncated: raw.length > MEMBER_ACTIVITY_TEXT_LIMIT };
  }
  push(event: SessionEvent): void {
    if (event.seq <= this.cursor) return;
    this.cursor = event.seq;
    const data = object(event.data);
    if (event.type === 'turn/start') {
      this.startedAt = event.time; this.endedAt = null; this.status = 'running'; this.phase = 'preparing';
      this.add(this.entry(event, 'turn', 'turn/start'));
    } else if (event.type === 'step/start') {
      this.phase = 'model';
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      let text = visibleText(object(data.message).content);
      if (!text && event.type === 'assistant/attempt') {
        // SDK helper excludes reasoning and Tool-call deltas. Truncation is explicit in the view.
        try { text = joinAssistantStreamText(event.data.stream); } catch { text = ''; }
      }
      if (text) this.add(this.entry(event, 'output', event.type === 'assistant/attempt' ? 'output/partial' : 'output', text));
    } else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const id = String(data.callId ?? data.subCallId ?? event.seq);
      const entry = this.entry(event, 'tool', typeof data.name === 'string' ? data.name : 'tool');
      entry.arguments = activityArguments(data.arguments); entry.status = 'running';
      this.add(entry); this.calls.set(id, entry); this.phase = 'tool';
    } else if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const message = event.type === 'tool/result' ? object(data.message) : data;
      const source = object(message.source);
      const id = String(message.callId ?? message.toolCallId ?? source.callId ?? data.subCallId ?? event.seq);
      const content = visibleText(message.content);
      let entry = this.calls.get(id);
      if (!entry) { entry = this.entry(event, 'tool', typeof data.name === 'string' ? data.name : 'tool/result'); this.add(entry); }
      const raw = content || (typeof object(data.error).reason === 'string' ? String(object(data.error).reason) : '');
      entry.text = activityText(raw); entry.truncated ||= raw.length > MEMBER_ACTIVITY_TEXT_LIMIT;
      entry.status = message.isError === true ? 'failed' : 'completed'; entry.endedAt = event.time; this.calls.delete(id);
      if (!this.calls.size) this.phase = 'preparing';
    } else if (event.type === 'turn/end') {
      const reason = object(data.reason); const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown';
      this.status = kind === 'completed' ? 'completed' : kind === 'aborted' ? 'cancelled' : kind === 'interrupted' ? 'interrupted' : 'failed';
      this.endedAt = event.time; this.phase = 'idle';
      for (const entry of this.calls.values()) { entry.status = 'cancelled'; entry.endedAt = event.time; }
      this.calls.clear();
      const raw = typeof object(reason.error).message === 'string' ? String(object(reason.error).message) : '';
      this.add(this.entry(event, this.status === 'failed' ? 'error' : 'turn', `turn/${kind}`, raw));
    } else return;
    this.lastActivityAt = event.time;
  }
  view(): ActivityEntry[] {
    let remaining = MEMBER_ACTIVITY_TEXT_BUDGET;
    const output: ActivityEntry[] = [];
    for (const entry of [...this.entries].reverse()) {
      const size = entry.text.length + (entry.arguments?.length ?? 0);
      if (size > remaining && output.length) { this.truncated = true; break; }
      const copy = { ...entry };
      if (size > remaining) { copy.text = copy.text.slice(0, remaining); copy.arguments = ''; copy.truncated = true; this.truncated = true; }
      output.push(copy); remaining -= Math.min(size, remaining);
    }
    return output.reverse();
  }
}
