import { z } from 'zod';

/** Browser-safe wire/document vocabulary. No host, filesystem, or runtime imports. */
export const TEAM_RUN_EXPORT_SCHEMA_VERSION = 1 as const;
export const TEAM_RUN_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export const TEAM_RUN_EXPORT_MIME = {
  markdown: 'text/markdown;charset=utf-8',
  json: 'application/json;charset=utf-8',
} as const;
export const TEAM_RUN_EXPORT_LIMITATIONS = [
  'This is the currently retained team snapshot, not a complete attempt history or token-by-token conversation log.',
  'Retry clears previous attempt results and timestamps; retained task output/error may already be truncated by the engine.',
  'Messages, when included, are only the retained team mailbox (at most 500), not session conversations.',
  'Task descriptions, outputs, errors and optional messages may contain sensitive information. Review before sharing.',
  'Member models describe configured routes only; an inherited route is not a verified execution-time model.',
] as const;

export const TeamRunExportFormatSchema = z.enum(['markdown', 'json']);
export type TeamRunExportFormat = z.infer<typeof TeamRunExportFormatSchema>;
export const TeamRunExportOptionsSchema = z.strictObject({
  format: TeamRunExportFormatSchema,
  includeMessages: z.boolean().default(false),
});
/** Callers may omit includeMessages; parsers normalize it to false. */
export type TeamRunExportOptions = z.input<typeof TeamRunExportOptionsSchema>;
export const TeamRunExportRequestSchema = TeamRunExportOptionsSchema.extend({
  sessionId: z.string().min(1).max(200).regex(/^\S+$/),
});
export type TeamRunExportRequest = z.infer<typeof TeamRunExportRequestSchema>;

const identifier = z.string().min(1).max(1024);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Existing durable timestamps are strings, not necessarily normalized ISO values.
const retainedTime = z.string().max(200);
const exportedAt = z.iso.datetime();
const text = z.string().max(TEAM_RUN_EXPORT_MAX_BYTES);
const route = z.strictObject({ provider: identifier, model: identifier });
export const TeamRunExportMemberSchema = z.strictObject({
  name: z.string().max(40), role: z.string().max(20_000),
  // null means inherited; do not resolve a catalog or expose captain configuration.
  model: route.nullable(),
});
export const TeamRunExportTaskSchema = z.strictObject({
  id: z.string().max(80), subject: z.string().max(200), description: z.string().max(20_000),
  assignee: z.string().max(40), dependencies: z.array(z.string().max(80)).max(100),
  writeScopes: z.array(z.string().max(300)).max(30),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  attempt: revision,
  startedAt: retainedTime.optional(), endedAt: retainedTime.optional(),
  output: text.optional(), error: text.optional(),
});
export const TeamRunExportMessageSchema = z.strictObject({
  id: identifier, from: z.string().max(40), to: z.string().max(40),
  text: z.string().max(20_000), createdAt: retainedTime, deliveredAt: retainedTime.optional(),
});
const source = {
  teamId: identifier,
  ownerSessionId: z.string().min(1).max(200).regex(/^\S+$/),
  sourceRevision: revision,
};

/** JSON file payload; Markdown must render the same allowlisted information. */
export const TeamRunExportDocumentSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_RUN_EXPORT_SCHEMA_VERSION),
  kind: z.literal('team-agents/retained-run-snapshot'),
  ...source,
  exportedAt,
  includeMessages: z.boolean(),
  limitations: z.array(z.string().max(2000)).min(1).max(20),
  team: z.strictObject({
    name: z.string().max(100), goal: z.string().max(20_000),
    status: z.enum(['draft', 'running', 'paused', 'blocked', 'completed']),
    maxConcurrency: z.number().int().min(1).max(8),
    createdAt: retainedTime, updatedAt: retainedTime,
    members: z.array(TeamRunExportMemberSchema).max(12),
    tasks: z.array(TeamRunExportTaskSchema).max(200),
  }),
  messages: z.array(TeamRunExportMessageSchema).max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.includeMessages !== (value.messages !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Messages must be present exactly when explicitly included.' });
  }
});
export type TeamRunExportDocument = z.infer<typeof TeamRunExportDocumentSchema>;

/** Text download envelope, not a path or a URL. No second copy of the full document. */
export const TeamRunExportResultSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_RUN_EXPORT_SCHEMA_VERSION),
  ...source,
  exportedAt,
  format: TeamRunExportFormatSchema,
  includeMessages: z.boolean(),
  filename: z.string().min(1).max(180).regex(/^team-agents-[A-Za-z0-9_-]+\.(md|json)$/),
  mimeType: z.enum([TEAM_RUN_EXPORT_MIME.markdown, TEAM_RUN_EXPORT_MIME.json]),
  content: z.string().min(1).max(TEAM_RUN_EXPORT_MAX_BYTES),
  byteLength: z.number().int().min(1).max(TEAM_RUN_EXPORT_MAX_BYTES),
}).superRefine((value, ctx) => {
  if (value.mimeType !== TEAM_RUN_EXPORT_MIME[value.format] ||
    !value.filename.endsWith(value.format === 'json' ? '.json' : '.md')) {
    ctx.addIssue({ code: 'custom', message: 'Export format, MIME type and filename extension must agree.' });
  }
  const bytes = new TextEncoder().encode(value.content).byteLength;
  if (bytes !== value.byteLength || bytes > TEAM_RUN_EXPORT_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['byteLength'], message: 'Invalid export UTF-8 byte length or export too large.' });
  }
});
export type TeamRunExportResult = z.infer<typeof TeamRunExportResultSchema>;

/** Shared domain failure codes; transport wraps these in native RemoteError. */
export const TEAM_RUN_EXPORT_ERROR_CODES = {
  noTeam: 'team-agents/no-team',
  tooLarge: 'team-agents/export-too-large',
  invalidSnapshot: 'team-agents/export-invalid-snapshot',
} as const;
export type TeamRunExportErrorCode = (typeof TEAM_RUN_EXPORT_ERROR_CODES)[keyof typeof TEAM_RUN_EXPORT_ERROR_CODES];
export class TeamRunExportError extends Error {
  constructor(public readonly code: TeamRunExportErrorCode, message: string) {
    super(message);
    this.name = 'TeamRunExportError';
  }
}
