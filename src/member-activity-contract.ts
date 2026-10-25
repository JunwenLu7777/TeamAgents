import { z } from 'zod';
import { memberName } from './model.js';

export const MEMBER_ACTIVITY_MAX_ITEMS = 80;
export const MEMBER_ACTIVITY_TEXT_LIMIT = 6000;
export const MEMBER_ACTIVITY_TEXT_BUDGET = 18000;
export const MEMBER_ACTIVITY_FRAME_BYTES = 192 * 1024;
const timestamp = z.number().int().nonnegative();
const text = z.string().max(MEMBER_ACTIVITY_TEXT_LIMIT);
export const MemberActivityRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(200).regex(/^\S+$/), member: memberName,
});
export const ActivityEntrySchema = z.strictObject({
  id: z.string().max(240), seq: z.number().int().nonnegative(), time: timestamp,
  kind: z.enum(['output', 'tool', 'error', 'turn']), label: z.string().max(160),
  text, arguments: text.optional(), truncated: z.boolean(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']).optional(), endedAt: timestamp.optional(),
});
export const MemberActivitySchema = z.strictObject({
  ownerSessionId: z.string().min(1).max(200), teamId: z.string().min(1).max(1024), member: memberName,
  childSessionId: z.string().max(200).nullable(), sequence: z.number().int().positive(),
  cursor: z.number().int().min(-1), observedAt: timestamp,
  status: z.enum(['not-started', 'running', 'idle', 'completed', 'failed', 'cancelled', 'interrupted']),
  phase: z.enum(['idle', 'preparing', 'model', 'tool']), live: z.boolean(),
  startedAt: timestamp.nullable(), endedAt: timestamp.nullable(), elapsedMs: timestamp.nullable(), lastActivityAt: timestamp.nullable(),
  task: z.strictObject({ id: z.string().max(80), subject: z.string().max(200), status: z.enum(['pending', 'running', 'completed', 'failed']),
    error: text.optional() }).nullable(),
  entries: z.array(ActivityEntrySchema).max(MEMBER_ACTIVITY_MAX_ITEMS),
  historyTruncated: z.boolean(), liveOutput: text, liveTruncated: z.boolean(), livePartial: z.boolean(),
});
export type MemberActivityRequest = z.infer<typeof MemberActivityRequestSchema>;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type MemberActivity = z.infer<typeof MemberActivitySchema>;
