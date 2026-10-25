import { useEffect, useRef, useState } from 'react';
import { MemberActivitySchema, type MemberActivity } from './member-activity-contract.js';
import type { TeamSettingsActions } from './settings-contract.js';
import type { TeamTranslate } from './locales.js';
import type { Member } from './model.js';

type Watch = NonNullable<TeamSettingsActions['watchMember']>;
export interface MemberActivityPanelProps {
  ownerSessionId: string; teamId: string; member: Member; watch: Watch; t: TeamTranslate; onClose(): void;
}
export function activityDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
const styles = `
.dta-activity { margin-top: 14px; padding: 14px; border: 1px solid color-mix(in srgb,currentColor 22%,transparent); border-radius: 10px; min-width: 0; font: inherit; }
.dta-activity header, .dta-activity .activity-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; justify-content:space-between; }
.dta-activity h4 { margin:0; font-size:14px; }
.dta-activity button { border:1px solid color-mix(in srgb,currentColor 22%,transparent); background:transparent; color:inherit; border-radius:7px; padding:6px 10px; cursor:pointer; font:inherit; }
.dta-activity button:disabled { opacity:.5; cursor:not-allowed; }
.dta-activity button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.dta-activity .activity-note { font-size:11px; opacity:.75; overflow-wrap:anywhere; }
.dta-activity .activity-metrics { display:flex; flex-wrap:wrap; gap:8px 20px; padding:10px 0; }
.dta-activity .activity-error { border-left:3px solid #cf5f56; padding:8px; overflow-wrap:anywhere; white-space:pre-wrap; }
.dta-activity .activity-timeline { list-style:none; padding:0; margin:12px 0 0; }
.dta-activity .activity-timeline > li { border-top:1px solid color-mix(in srgb,currentColor 14%,transparent); padding:8px 0; }
.dta-activity summary { cursor:pointer; overflow-wrap:anywhere; }
.dta-activity pre { font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; max-height:22rem; overflow:auto; background:color-mix(in srgb,currentColor 4%,transparent); padding:10px; border-radius:6px; }
.dta-activity time { font-size:11px; opacity:.7; margin-inline-end:8px; }
`;

/** Exactly one selected, visible member owns a stream. Closing it cancels observation, never execution. */
export function MemberActivityPanel(props: MemberActivityPanelProps) {
  return <ActivityState key={`${props.ownerSessionId}:${props.teamId}:${props.member.name}:${props.member.sessionId ?? 'unstarted'}`} {...props} />;
}
function ActivityState({ ownerSessionId, teamId, member, watch, t, onClose }: MemberActivityPanelProps) {
  const [data, setData] = useState<MemberActivity | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'ended' | 'error'>('connecting');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [, tick] = useState(0);
  const receivedAt = useRef(0);
  const frozenDelta = useRef(0);
  const isConnected = connection === 'connected';
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setConnection('connecting'); setError('');
    void (async () => {
      let sequence = 0;
      try {
        for await (const raw of watch(member.name, controller.signal)) {
          if (controller.signal.aborted) return;
          const frame = MemberActivitySchema.parse(raw);
          if (frame.ownerSessionId !== ownerSessionId || frame.teamId !== teamId || frame.member !== member.name ||
            (member.sessionId && frame.childSessionId !== member.sessionId) || frame.sequence <= sequence) throw new Error(t('activity.mismatch'));
          sequence = frame.sequence; receivedAt.current = performance.now(); frozenDelta.current = 0; setData(frame); setConnection('connected');
        }
        if (!controller.signal.aborted) { frozenDelta.current = Math.max(0, performance.now() - receivedAt.current); setConnection('ended'); }
      } catch (failure) {
        if (!controller.signal.aborted) {
          frozenDelta.current = Math.max(0, performance.now() - receivedAt.current);
          setError(failure instanceof Error ? failure.message : t('activity.unknownError')); setConnection('error');
        }
      }
    })();
    return () => controller.abort();
  }, [ownerSessionId, teamId, member.name, member.sessionId, watch, retry, t]);
  useEffect(() => {
    if (!isConnected || !data?.live) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [isConnected, data?.live]);
  const elapsed = data?.elapsedMs === null || !data ? null : data.elapsedMs + (data.live ? isConnected ? Math.max(0, performance.now() - receivedAt.current) : frozenDelta.current : 0);
  const clock = (time: number) => new Date(time).toLocaleTimeString();
  return <section className="dta-activity" aria-label={t('activity.title', { name: member.name })}>
    <style>{styles}</style>
    <header><h4>{t('activity.title', { name: member.name })}</h4><div className="activity-controls">
      <button type="button" onClick={() => setRetry(value => value + 1)} disabled={connection === 'connecting'}>{t('activity.reconnect')}</button>
      <button type="button" onClick={onClose}>{t('activity.close')}</button>
    </div></header>
    <p className="activity-note">{member.role} · {member.model ? t('member.model', member.model) : t('member.inheritedModel')}</p>
    <p className="activity-note">{t('activity.readonly')}</p>
    <p role="status">{t(connection === 'connecting' ? 'activity.connecting' : connection === 'connected' ? 'activity.connected' : 'activity.ended')}</p>
    {connection === 'error' && <p className="activity-error" role="alert">{t('activity.failedConnection', { message: error })}</p>}
    {data && <>
      {!isConnected && <p className="activity-note">{t('activity.stale')}</p>}
      <div className="activity-metrics">
        <strong>{t(`activity.status.${data.status}`)}</strong>
        <span>{t(`activity.phase.${data.phase}`)}</span>
        <span>{t('activity.elapsed')}: <b>{activityDuration(elapsed)}</b></span>
        <span>{t('activity.lastSeen')}: {data.lastActivityAt === null ? t('activity.none') : <time dateTime={new Date(data.lastActivityAt).toISOString()}>{clock(data.lastActivityAt)}</time>}</span>
      </div>
      {data.task && <p>{t('activity.task')}: {data.task.id} · {data.task.subject} · {t(`status.${data.task.status}`)}</p>}
      {data.task?.error && <p className="activity-error" role="alert">{data.task.error}</p>}
      {data.live && <section aria-label={t('activity.liveOutput')}><h4>{t('activity.liveOutput')}</h4>
        {data.liveOutput ? <pre tabIndex={0}>{data.liveOutput}</pre> : <p className="activity-note">{t('activity.noText')}</p>}
        {(data.livePartial || data.liveTruncated) && <p className="activity-note">{t('activity.partial')}</p>}
      </section>}
      <h4>{t('activity.history')}</h4>
      {data.historyTruncated && <p className="activity-note">{t('activity.limit')}</p>}
      {!data.entries.length && <p className="activity-note">{t('activity.empty')}</p>}
      <ol className="activity-timeline">{data.entries.map(entry => <li key={entry.id}>
        <details open={entry.kind === 'output' || entry.kind === 'error' || undefined}>
          <summary><time dateTime={new Date(entry.time).toISOString()}>{clock(entry.time)}</time>
            {entry.kind === 'tool' ? t('activity.tool', { name: entry.label }) : entry.kind === 'output' ? t(entry.label === 'output/partial' ? 'activity.partialOutput' : 'activity.output') : t(entry.kind === 'error' ? 'activity.error' : 'activity.turn')}
            {entry.kind === 'turn' && ` · ${entry.label}`}
            {entry.status && ` · ${t(`activity.entry.${entry.status}`)}`}
            {entry.endedAt !== undefined && ` · ${activityDuration(Math.max(0, entry.endedAt - entry.time))}`}
          </summary>
          {entry.arguments && <details><summary>{t('activity.arguments')}</summary><pre tabIndex={0}>{entry.arguments}</pre></details>}
          {entry.text && <pre tabIndex={0} aria-label={t('activity.result')}>{entry.text}</pre>}
          {entry.truncated && <p className="activity-note">{t('activity.limit')}</p>}
        </details>
      </li>)}</ol>
    </>}
  </section>;
}
