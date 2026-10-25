import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import { SessionId, type Session, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-workspace';
import type { TeamEngine } from './engine.js';
import { activityText, MemberActivityFold } from './member-activity-fold.js';
import { MemberActivitySchema, MEMBER_ACTIVITY_FRAME_BYTES, MEMBER_ACTIVITY_TEXT_LIMIT, type MemberActivity } from './member-activity-contract.js';

interface LiveText { agent: Agent; attemptId: string; revision: number; nextIndex: number; text: string; partial: boolean; truncated: boolean; lastAt: number; }
interface Admission { owner: string; workspaceId: string; cwd: string; signal: AbortSignal; check(): void; }
const MAX_PENDING_EVENTS = 4096;
const timeOf = (value: string | undefined) => { const time = Date.parse(value ?? ''); return Number.isFinite(time) && time >= 0 ? time : null; };

/** Bounded ephemeral public-text cache, so opening a member mid-stream does not start at blank. */
export class MemberActivityReader {
  private liveText = new Map<string, LiveText>();
  private listeners = new Map<string, Set<() => void>>();
  private readonly lifetime = new AbortController();
  constructor(private ctx: Context, private engine: TeamEngine) {
    ctx.on('agent/assistant-stream', ({ agent, frame }) => this.stream(agent, frame), { global: true });
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.liveText.get(agent.id)?.agent === agent) this.liveText.delete(agent.id);
      this.notify(agent.id);
    }, { global: true });
    ctx.effect(() => () => { this.lifetime.abort(); this.liveText.clear(); this.listeners.clear(); });
  }
  private notify(id: string): void { for (const listener of this.listeners.get(id) ?? []) listener(); }
  private stream(agent: Agent, frame: AssistantStreamFrame): void {
    if (this.lifetime.signal.aborted || this.ctx.agents.get(agent.id) !== agent || !this.engine.identity(agent.id)) return;
    let value = this.liveText.get(agent.id);
    if (value && value.agent === agent && frame.revision < value.revision) return;
    if (frame.type === 'end') {
      if (value?.agent === agent && value.attemptId === frame.attemptId) this.liveText.delete(agent.id);
      this.notify(agent.id); return;
    }
    if (frame.type === 'start' || !value || value.agent !== agent || value.attemptId !== frame.attemptId) {
      value = { agent, attemptId: frame.attemptId, revision: frame.revision, nextIndex: 0, text: '', partial: frame.type !== 'start', truncated: false, lastAt: Date.now() };
      this.liveText.delete(agent.id); this.liveText.set(agent.id, value);
      // A process-wide cap bounds memory independently of the number of stored teams.
      while (this.liveText.size > 128) this.liveText.delete(this.liveText.keys().next().value!);
    }
    value.revision = Math.max(value.revision, frame.revision);
    if (frame.type === 'chunk' && frame.index >= value.nextIndex) {
      value.partial ||= frame.index !== value.nextIndex;
      value.nextIndex = frame.index + 1; value.lastAt = frame.time;
      if (frame.chunk.type === 'text-delta') {
        value.text += frame.chunk.text;
        if (value.text.length > MEMBER_ACTIVITY_TEXT_LIMIT) { value.text = value.text.slice(-MEMBER_ACTIVITY_TEXT_LIMIT); value.truncated = true; }
      }
      // Reasoning, request metadata, replay payloads, and tool argument deltas are never retained.
    }
    this.notify(agent.id);
  }

  async *watch(admission: Admission, memberName: string): AsyncGenerator<MemberActivity> {
    const active = AbortSignal.any([admission.signal, this.lifetime.signal]);
    let sequence = 0;
    const initial = this.engine.activityTarget(admission.owner, memberName);
    const fail = () => new RemoteError('team-agents/member-unavailable', 'The member session is unavailable or no longer belongs to this team. Reconnect to refresh its state.', {});
    if (!initial || initial.ownerSessionId !== admission.owner || initial.workspaceId !== admission.workspaceId) throw fail();
    const childId = initial.childSessionId ? SessionId(initial.childSessionId) : null;
    const target = () => {
      active.throwIfAborted(); admission.check();
      const current = this.engine.activityTarget(admission.owner, memberName);
      if (!current || current.teamId !== initial.teamId || current.childSessionId !== childId ||
        current.ownerSessionId !== admission.owner || current.workspaceId !== admission.workspaceId) throw fail();
      if (childId && this.ctx.workspaceRegistry.archivedSessionIds.includes(childId)) throw fail();
      return current;
    };
    const fold = new MemberActivityFold();
    let header: SessionHeader | undefined;
    let attached: Session | undefined;
    const checkChild = (candidate: SessionHeader) => {
      if (candidate.id !== childId || candidate.parentSession !== admission.owner || candidate.origin !== 'subagent' ||
        candidate.isSeeded || candidate.cwd !== admission.cwd ||
        (header && (candidate.createdAt !== header.createdAt || candidate.delegationDepth !== header.delegationDepth))) throw fail();
    };
    const checkAttachment = () => {
      if (!childId) return;
      const session = this.ctx.sessions.get(childId);
      const agent = this.ctx.agents.get(childId);
      if (attached && session !== attached) throw fail();
      if (session) { checkChild(session.header); attached = session; }
      const parent = this.ctx.agents.get(SessionId(admission.owner));
      if (agent && (!parent || agent.id !== childId || agent.session !== session || !this.ctx.agents.isOwnedBy(childId, parent))) {
        // A cold parent has no active child ownership. Historical reads have no Agent to validate.
        throw fail();
      }
    };
    const snapshot = (): MemberActivity => {
      const current = target(); checkAttachment();
      const now = Date.now();
      const agent = childId ? this.ctx.agents.get(childId) : undefined;
      const live = !!agent && agent.status === 'running';
      const cache = childId ? this.liveText.get(childId) : undefined;
      const text = cache && cache.agent === agent ? cache : undefined;
      let status: MemberActivity['status'] = !childId ? 'not-started' : live ? 'running' : fold.status;
      if (!live && current.task?.status === 'failed') status = 'failed';
      // An orphaned open turn is not proof that an evicted Agent is still running.
      if (!live && status === 'running') status = 'interrupted';
      const startedAt = fold.startedAt ?? timeOf(current.task?.startedAt);
      const endedAt = live ? null : fold.endedAt ?? timeOf(current.task?.endedAt);
      const times = [fold.lastActivityAt, text?.lastAt].filter((value): value is number => typeof value === 'number');
      const lastActivityAt = times.length ? Math.max(...times) : null;
      const elapsedEnd = endedAt ?? (live ? now : lastActivityAt);
      const entries = fold.view();
      const value: MemberActivity = {
        ownerSessionId: admission.owner, teamId: initial.teamId, member: memberName, childSessionId: childId,
        sequence: ++sequence, cursor: fold.cursor, observedAt: now, status,
        phase: live ? fold.phase === 'idle' ? 'preparing' : fold.phase : 'idle', live,
        startedAt, endedAt, elapsedMs: startedAt !== null && elapsedEnd !== null ? Math.max(0, elapsedEnd - startedAt) : null,
        lastActivityAt,
        task: current.task ? { id: current.task.id, subject: current.task.subject, status: current.task.status,
          ...(current.task.error ? { error: activityText(current.task.error) } : {}) } : null,
        entries, historyTruncated: fold.truncated, liveOutput: text ? activityText(text.text) : '',
        liveTruncated: text?.truncated ?? false, livePartial: text?.partial ?? false,
      };
      while (new TextEncoder().encode(JSON.stringify(value)).byteLength > MEMBER_ACTIVITY_FRAME_BYTES && value.entries.length) {
        value.entries.shift(); value.historyTruncated = true;
      }
      return MemberActivitySchema.parse(value);
    };
    if (!childId) { yield snapshot(); return; }

    let initialized = false;
    let pending: SessionEvent[] = [];
    let failure: unknown;
    let dirty = true;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      dirty = true;
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; const listener = wake; wake = undefined; listener?.(); }, 80);
    };
    const guarded = (action: () => void) => { try { target(); action(); } catch (error) { failure = error; } notify(); };
    const offEvent = this.ctx.on('session/event', (session, event) => {
      if (session.id === admission.owner) { notify(); return; }
      if (session.id !== childId) return;
      guarded(() => {
        checkChild(session.header);
        if (attached && attached !== session) throw fail(); attached = session;
        if (initialized) fold.push(event);
        else { pending.push(event); if (pending.length > MAX_PENDING_EVENTS) throw new Error('Member activity opening buffer exceeded; reconnect.'); }
      });
    }, { global: true });
    const offStatus = this.ctx.on('agent/status', ({ agent }) => { if (agent.id === childId) notify(); }, { global: true });
    const offDisposed = this.ctx.on('session/disposed', session => { if (session.id === childId) notify(); }, { global: true });
    const offCreated = this.ctx.on('session/created', session => { if (session.id === childId) guarded(() => {
      checkChild(session.header); if (attached && attached !== session) throw fail(); attached = session;
      // Reconnect on a cold-to-live transition: a fresh baseline owns any restored history.
      if (initialized) throw new Error('Member session became live; reconnect to load its current baseline.');
    }); }, { global: true });
    const subscribed = this.listeners.get(childId) ?? new Set(); subscribed.add(notify); this.listeners.set(childId, subscribed);
    // Recheck authorization while the stream is quiet. Do not resend unchanged history;
    // the native carrier owns network heartbeats and the Client animates elapsed time locally.
    const heartbeat = setInterval(() => {
      try { target(); checkAttachment(); } catch (error) { failure = error; notify(); }
    }, 2000); heartbeat.unref?.();
    const abort = () => { const listener = wake; wake = undefined; listener?.(); };
    active.addEventListener('abort', abort, { once: true });
    try {
      target(); checkAttachment();
      const inspection = await this.ctx.sessionController.inspect(childId, active);
      target(); checkChild(inspection.meta); header = inspection.meta; checkAttachment();
      if (inspection.inheritedEventCount !== 0) throw fail();
      for (const event of inspection.events) fold.push(event);
      for (const event of pending) fold.push(event); pending = []; initialized = true;
      if (failure) throw failure;
      while (!active.aborted) {
        if (failure) throw failure;
        if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
        if (active.aborted) break;
        if (failure) throw failure;
        dirty = false;
        yield snapshot();
      }
    } catch (error) {
      if (!active.aborted) {
        if (error instanceof RemoteError) throw error;
        throw new RemoteError('team-agents/member-unavailable', 'Member history or live stream could not be read. Reconnect to try again.', {}, { cause: error });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(heartbeat); active.removeEventListener('abort', abort);
      offEvent(); offStatus(); offDisposed(); offCreated();
      subscribed.delete(notify); if (!subscribed.size) this.listeners.delete(childId);
      pending = [];
    }
  }
}
