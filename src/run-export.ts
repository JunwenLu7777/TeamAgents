import {
  TEAM_RUN_EXPORT_ERROR_CODES, TEAM_RUN_EXPORT_LIMITATIONS, TEAM_RUN_EXPORT_MAX_BYTES,
  TEAM_RUN_EXPORT_MIME, TEAM_RUN_EXPORT_SCHEMA_VERSION, TeamRunExportDocumentSchema,
  TeamRunExportError, TeamRunExportOptionsSchema, TeamRunExportResultSchema,
  type TeamRunExportDocument, type TeamRunExportOptions, type TeamRunExportResult,
} from './run-export-contract.js';
import type { Team } from './model.js';

/**
 * Pure, read-only retained-snapshot serialization. It never reads the global
 * library, resolves a model, inspects another session, or writes anywhere.
 * Every exported field is copied through an explicit allowlist; spreading a
 * raw Team (now or after a future schema addition) would leak new fields.
 */
const encoder = new TextEncoder();
const utf8Bytes = (value: string) => encoder.encode(value).byteLength;

function invalidSnapshot(): TeamRunExportError {
  // Deliberately generic: Zod details can echo ids, task text, mailbox text or
  // adapter data. Callers get a stable code instead of a content dump.
  return new TeamRunExportError(
    TEAM_RUN_EXPORT_ERROR_CODES.invalidSnapshot,
    'The retained team snapshot is invalid and could not be exported safely. Reload the team status and try again.',
  );
}
function exportTooLarge(): TeamRunExportError {
  return new TeamRunExportError(
    TEAM_RUN_EXPORT_ERROR_CODES.tooLarge,
    'The retained team snapshot exceeds the 8 MiB UTF-8 export limit. Exclude team messages or export a smaller retained snapshot; nothing was truncated or written.',
  );
}

/** Allowlisted copy only. Missing optional fields stay missing; nothing is inferred. */
function createDocument(team: Team, options: { format: 'markdown' | 'json'; includeMessages: boolean }, exportedAt: string): TeamRunExportDocument {
  if (typeof team.id !== 'string' || typeof team.ownerSessionId !== 'string') throw invalidSnapshot();
  if (!Array.isArray(team.members) || !Array.isArray(team.tasks)) throw invalidSnapshot();
  const members = team.members.map(member => ({
    name: member.name,
    role: member.role,
    // null means inherited configuration, never a claim about the route used.
    model: member.model ? { provider: member.model.provider, model: member.model.model } : null,
  }));
  const tasks = team.tasks.map(task => ({
    id: task.id, subject: task.subject, description: task.description, assignee: task.assignee,
    dependencies: [...task.dependencies], writeScopes: [...task.writeScopes],
    status: task.status, attempt: task.attempt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
    ...(task.output === undefined ? {} : { output: task.output }),
    ...(task.error === undefined ? {} : { error: task.error }),
  }));
  let messages: TeamRunExportDocument['messages'];
  if (options.includeMessages) {
    if (!Array.isArray(team.messages)) throw invalidSnapshot();
    // Current team mailbox only; never session events, other sessions, or the
    // global Agent library. deliveredAt is retained only when still present.
    messages = team.messages.map(message => ({
      id: message.id, from: message.from, to: message.to, text: message.text,
      createdAt: message.createdAt,
      ...(message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt }),
    }));
  }
  return {
    schemaVersion: TEAM_RUN_EXPORT_SCHEMA_VERSION,
    kind: 'team-agents/retained-run-snapshot',
    teamId: team.id,
    ownerSessionId: team.ownerSessionId,
    sourceRevision: team.revision,
    exportedAt,
    includeMessages: options.includeMessages,
    limitations: [...TEAM_RUN_EXPORT_LIMITATIONS],
    team: {
      name: team.name, goal: team.goal, status: team.status, maxConcurrency: team.maxConcurrency,
      createdAt: team.createdAt, updatedAt: team.updatedAt, members, tasks,
    },
    ...(messages === undefined ? {} : { messages }),
  };
}

/** Conservative lower bound for the final serialized size: every retained string. */
function retainedTextBytes(value: unknown): number {
  if (typeof value === 'string') return utf8Bytes(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += retainedTextBytes(item);
    return total;
  }
  if (value !== null && typeof value === 'object') {
    let total = 0;
    for (const item of Object.values(value)) total += retainedTextBytes(item);
    return total;
  }
  return 0;
}

/**
 * Every dynamic line is indented four spaces, so user Markdown/HTML is inert.
 * CR/CRLF inside retained text must not start an unindented line either, so
 * every Markdown-recognized line ending is treated as one line break. The
 * exported JSON still carries the exact retained text; only this rendering
 * normalizes line endings.
 */
function literal(value: string): string {
  return value.split(/\r\n|\r|\n/).map(line => `    ${line}`).join('\n');
}
function block(lines: string[], label: string, value: string): void {
  lines.push(`${label}:`, '', literal(value), '');
}
function retained(lines: string[], label: string, value: string | undefined): void {
  if (value === undefined) lines.push(`${label}: not retained`, '');
  else block(lines, label, value);
}

function renderMarkdown(document: TeamRunExportDocument): string {
  const lines: string[] = ['# TeamAgents retained run snapshot', '', '## Document', ''];
  lines.push(`Schema version: ${document.schemaVersion}`, '');
  block(lines, 'Kind', document.kind);
  block(lines, 'Team ID', document.teamId);
  block(lines, 'Owner session ID', document.ownerSessionId);
  lines.push(`Source revision: ${document.sourceRevision}`, '');
  block(lines, 'Exported at', document.exportedAt);
  lines.push(`Messages included: ${document.includeMessages ? 'yes' : 'no'}`, '');

  lines.push('## Notices', '');
  for (const limitation of document.limitations) lines.push(`- ${limitation}`);
  lines.push('');

  lines.push('## Team', '');
  block(lines, 'Team name', document.team.name);
  block(lines, 'Goal', document.team.goal);
  lines.push(`Status: ${document.team.status}`, '');
  lines.push(`Max concurrency: ${document.team.maxConcurrency}`, '');
  block(lines, 'Created at', document.team.createdAt);
  block(lines, 'Updated at', document.team.updatedAt);

  lines.push(`### Members (${document.team.members.length})`, '');
  document.team.members.forEach((member, index) => {
    lines.push(`#### Member ${index + 1}`, '');
    block(lines, 'Name', member.name);
    block(lines, 'Role', member.role);
    if (member.model === null) lines.push('Configured model: inherited (null; not resolved at export time)', '');
    else {
      block(lines, 'Configured model provider', member.model.provider);
      block(lines, 'Configured model id', member.model.model);
    }
  });

  lines.push(`### Tasks (${document.team.tasks.length})`, '');
  document.team.tasks.forEach((task, index) => {
    lines.push(`#### Task ${index + 1}`, '');
    block(lines, 'Task ID', task.id);
    block(lines, 'Subject', task.subject);
    block(lines, 'Description', task.description);
    block(lines, 'Assignee', task.assignee);
    lines.push(`Status: ${task.status}`, '');
    lines.push(`Attempt: ${task.attempt}`, '');
    if (task.dependencies.length === 0) lines.push('Dependencies: none retained', '');
    else {
      lines.push(`Dependencies (${task.dependencies.length}):`, '');
      task.dependencies.forEach((dependency, dependencyIndex) => block(lines, `Dependency ${dependencyIndex + 1}`, dependency));
    }
    if (task.writeScopes.length === 0) lines.push('Write scopes: none retained', '');
    else {
      lines.push(`Write scopes (${task.writeScopes.length}):`, '');
      task.writeScopes.forEach((scope, scopeIndex) => block(lines, `Write scope ${scopeIndex + 1}`, scope));
    }
    retained(lines, 'Started at', task.startedAt);
    retained(lines, 'Ended at', task.endedAt);
    retained(lines, 'Retained output', task.output);
    retained(lines, 'Retained error', task.error);
  });

  lines.push('## Messages', '');
  if (document.messages === undefined) lines.push('Team messages were not included in this export.', '');
  else if (document.messages.length === 0) lines.push('No team messages are currently retained.', '');
  else {
    document.messages.forEach((message, index) => {
      lines.push(`### Message ${index + 1}`, '');
      block(lines, 'ID', message.id);
      block(lines, 'From', message.from);
      block(lines, 'To', message.to);
      block(lines, 'Created at', message.createdAt);
      retained(lines, 'Delivered at', message.deliveredAt);
      block(lines, 'Text', message.text);
    });
  }
  lines.push('End of retained snapshot.', '');
  return lines.join('\n');
}

function safeTeamId(value: string): string {
  // Filenames may contain only ASCII letters, digits, underscore and hyphen.
  // Team names/session ids and Unicode direction marks never enter a filename.
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return safe.length === 0 ? 'team' : safe;
}
function timestampOf(exportedAt: string): string {
  const date = new Date(exportedAt);
  if (Number.isNaN(date.getTime())) throw invalidSnapshot();
  return date.toISOString().replace(/[-:.]/g, '');
}

/**
 * Serialize one already-retained Team snapshot. Synchronous and I/O-free.
 * `team === null` is a domain error, while an empty retained Team is valid.
 */
export function buildTeamRunExport(
  team: Team | null,
  options: TeamRunExportOptions,
  exportedAt: string = new Date().toISOString(),
): TeamRunExportResult {
  const normalized = TeamRunExportOptionsSchema.parse(options);
  if (team === null) {
    throw new TeamRunExportError(TEAM_RUN_EXPORT_ERROR_CODES.noTeam, 'No team exists in this captain session. Create a team before exporting.');
  }
  let document: TeamRunExportDocument;
  try { document = createDocument(team, normalized, exportedAt); }
  catch (error) {
    if (error instanceof TeamRunExportError) throw error;
    throw invalidSnapshot();
  }
  // Reject an oversized retained snapshot before Zod traversal and formatting.
  // The bound is a lower bound for both formats, so this cannot hide a real
  // final-size overflow; the exact byte check below still decides.
  if (retainedTextBytes(document) > TEAM_RUN_EXPORT_MAX_BYTES) throw exportTooLarge();
  try { TeamRunExportDocumentSchema.parse(document); }
  catch { throw invalidSnapshot(); }

  let content: string;
  try { content = normalized.format === 'json' ? `${JSON.stringify(document, null, 2)}\n` : renderMarkdown(document); }
  catch { throw invalidSnapshot(); }
  const byteLength = utf8Bytes(content);
  // No silent truncation: an oversized file fails atomically with a retry hint.
  if (byteLength > TEAM_RUN_EXPORT_MAX_BYTES) throw exportTooLarge();

  let filename: string;
  try {
    const extension = normalized.format === 'json' ? 'json' : 'md';
    filename = `team-agents-${safeTeamId(document.teamId)}-r${document.sourceRevision}-${timestampOf(document.exportedAt)}.${extension}`;
  } catch (error) {
    if (error instanceof TeamRunExportError) throw error;
    throw invalidSnapshot();
  }
  const result: TeamRunExportResult = {
    schemaVersion: TEAM_RUN_EXPORT_SCHEMA_VERSION,
    teamId: document.teamId,
    ownerSessionId: document.ownerSessionId,
    sourceRevision: document.sourceRevision,
    exportedAt: document.exportedAt,
    format: normalized.format,
    includeMessages: document.includeMessages,
    filename,
    mimeType: TEAM_RUN_EXPORT_MIME[normalized.format],
    content,
    byteLength,
  };
  const validated = TeamRunExportResultSchema.safeParse(result);
  if (!validated.success) throw invalidSnapshot();
  return validated.data;
}