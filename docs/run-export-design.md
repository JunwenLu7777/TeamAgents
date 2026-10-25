# TeamAgents retained-run export — decision and integration contract

Baseline: main@44ac3a7, plugin 0.4.1, DSH SDK 0.2.1-rc.3. This document defines implementation boundaries, not permission to deploy, restart the host, or run real model work.

## Evidence and decision

- [model.ts](../src/model.ts) stores one Team with up to 12 members, 200 tasks and 500 mailbox messages. A task has one retained output/error/time set, not an attempt collection.
- [engine.ts](../src/engine.ts#L55-L58) returns a structured clone. Retry deletes prior output/error/attempt ID and times (lines 164–174); execution bounds output/error at 50,000 characters plus a marker (lines 33, 289–292); mailbox replacement discards delivered messages (lines 192–205). Therefore even “latest attempt” means only fields *still present*. After retry, attempt count can be nonzero while result/times are absent.
- [remote.ts](../src/remote.ts#L36-L103) already verifies the immutable native owner invocation, session resource, root/cold session, archive state and workspace ownership, including cancellation and identity rechecks. Its read path does not resolve an Agent or model.
- [conversation-view.tsx](../src/conversation-view.tsx) binds actions and projection to the displayed session; [dashboard.tsx](../src/dashboard.tsx) keys request ownership by session/team. Native `useAccess` is presentation gating, never authorization.
- [remote.test.ts](../tests/remote.test.ts), [host.test.ts](../tests/host.test.ts) and [dashboard.test.tsx](../tests/dashboard.test.tsx) supply native Gateway, isolated tool and DOM test patterns.

Chosen: a host-created, explicitly allowlisted immutable retained snapshot, serialized once per user request, returned over native Remote as bounded text. Browser only validates and downloads it. Chat reuses the same serializer under its own exact caller checks.

Rejected: exporting browser projection (possibly stale, no authoritative read); serializing all Team fields (instructions/session internals leak, future schema growth leaks); replaying session logs (different authorization/history scope); bare HTTP/download routes or arbitrary host output paths (unnecessary new attack surface). No audit-history database is introduced.

## Shared contract (implemented)

[run-export-contract.ts](../src/run-export-contract.ts) imports only Zod. Both faces may import it. It must not import Host Context, engine, Node, native Remote implementation, or filesystem APIs.

- `TeamRunExportFormat`: `'markdown' | 'json'`.
- `TeamRunExportOptionsSchema`: strict `{ format, includeMessages?: boolean }`, with `includeMessages=false` default. `TeamRunExportOptions` is its **input** type so callers can omit the flag.
- `TeamRunExportRequestSchema`: options plus required `sessionId`. No owner, principal, path, team selector, model, revision mutation, or other extra properties. `TeamRunExportRequest` is normalized output type.
- `TeamRunExportDocumentSchema` / `TeamRunExportDocument`: strict JSON file payload. Top level: `schemaVersion:1`, `kind:'team-agents/retained-run-snapshot'`, `teamId`, `ownerSessionId`, `sourceRevision`, `exportedAt` (UTC ISO), `includeMessages`, `limitations`, `team`, and optional `messages`.
- `team`: name, goal, status, maxConcurrency, createdAt, updatedAt, members, tasks. Members: name, role, `model:{provider,model}|null`; null means inherited, not a claim about the executed route. Tasks: id, subject, description, assignee, dependencies, writeScopes, status, attempt, and optional startedAt/endedAt/output/error. Missing retained fields remain absent; do not infer or manufacture timestamps. Scope paths are advisory metadata, not permissions.
- `messages` is absent when false, present (including `[]`) exactly when true. Only current Team mailbox, never session-event text. Include id/from/to/text/createdAt and optional deliveredAt.
- `TEAM_RUN_EXPORT_LIMITATIONS` supplies mandatory semantic notices for both formats; serializer copies all notices into document. Export schemas intentionally do not reuse full Team schemas or spread raw Team/member/task objects.
- `TeamRunExportResultSchema` / `TeamRunExportResult`: strict envelope `{schemaVersion, teamId, ownerSessionId, sourceRevision, exportedAt, format, includeMessages, filename, mimeType, content, byteLength}`. It contains no full duplicate document. `sourceRevision` is the saved Team revision, **not** schema version or expectedRevision. A running export may legitimately have a revision newer than the UI projection.
- MIME is exactly `TEAM_RUN_EXPORT_MIME[format]`: `text/markdown;charset=utf-8` or `application/json;charset=utf-8`. Content is plain UTF-8 text, not base64, HTML, URL or path. `byteLength` must equal `new TextEncoder().encode(content).byteLength`.
- File basename matches `^team-agents-[A-Za-z0-9_-]+\.(md|json)$`, at most 180 characters; use a bounded sanitized team-ID segment (fallback `team`), revision and UTC timestamp. Do not use raw team name/session ID, directory separators, colon, leading dot, control characters or Unicode directional marks. Suggested `team-agents-<safe-id>-r<revision>-<YYYYMMDDTHHMMSSmmmZ>.<ext>`.
- `TEAM_RUN_EXPORT_MAX_BYTES=8*1024*1024`. Final UTF-8 file exceeding this limit fails atomically; no partial download or silent new truncation. Optional messages can be unchecked to retry. Engine-retained truncation cannot be recovered. Large exports are in-memory; no streaming promise.

## Backend implementation agreement

Backend owns [run-export.ts](../src/run-export.ts) (new), [remote-contract.ts](../src/remote-contract.ts), [remote.ts](../src/remote.ts), [index.ts](../src/index.ts), [tsconfig.json](../tsconfig.json) and assigned backend tests.

Implement these public functions in `src/run-export.ts`:

```ts
buildTeamRunExport(
  team: Team | null,
  options: TeamRunExportOptions,
  exportedAt?: string, // default new Date().toISOString(); injectable deterministic clock
): TeamRunExportResult
```

Optional internal helpers `createTeamRunExportDocument`, `renderTeamRunExportMarkdown` may be private. The serializer is synchronous, pure with respect to its input, and does no I/O. Null team throws `TeamRunExportError(TEAM_RUN_EXPORT_ERROR_CODES.noTeam, safeMessage)`. Parse options, construct explicit allowlisted copies, validate document, render, enforce byte bound, validate envelope. Do not first stringify the entire Team: excluded instructions/messages must not enter intermediate export text. Preserve Unicode, arrays' retained order, multiline text and empty output strings. Unknown extra raw properties must never propagate. Invalid retained data produces a generic `export-invalid-snapshot` message, not raw Zod details containing data. Check oversized strings/bounded total construction before expensive final serialization where practical; do not misclassify oversize as a generic validation error.

JSON: `JSON.stringify(document, null, 2) + '\n'`; must parse with the document schema. Markdown: stable human-readable title and sections for metadata/notices, goal, members/models, tasks and optional messages, containing all document facts. Treat every user-controlled value as literal text, not Markdown. A robust approach is static headings/labels and indented code blocks for all dynamic multiline fields (indent every line, including blanks); or adaptive backtick fences longer than any embedded run. Do not place unescaped names in headings/tables or emit user HTML/images/links. Download is not a Markdown preview.

Remote action **`exportRun`**, endpoint **`teamAgents/exportRun`**:

1. Add endpoint/request/result descriptor and native typed map entry. Result codec must use `TeamRunExportResultSchema`, not TeamSchema. Keep strict real parser and session resource marker.
2. Parse request; call existing `captain('exportRun', sessionId, signal)`; `captain.check()`; take exactly one `engine.snapshot(captain.owner)` for serialization. Existing authorization checks may themselves inspect snapshots: “one” here means do not mix export fields from multiple reads.
3. Build result; check cancellation/lifetime/current identity again before return. No `resolveAgent`, model catalog/default lookup, save, engine mutation, projection publication, messaging or agent creation.
4. Map `TeamRunExportError.code` to native `RemoteError` with `{}` details and safe messages. Add three error-map declarations below. Preserve native authorization and cancellation errors. Existing `operation()` must not flatten these codes into operation-rejected.

Chat tool **`team_agents_export_run`** parameters exactly `{format, includeMessages?}`. No session/owner/path parameter. Obtain current exact live caller via `captain(exec)`, reject members/subagents and ambiguous non-seeded parent lineage, verify session header ID/agent ID and live session correspondence, resolve the caller's workspace from its cwd, then recheck caller identity, cancellation and unchanged cwd after await. Require snapshot.ownerSessionId === caller.id and snapshot.workspaceId === resolved workspace.id; honor archive state when available. Never select another team's owner via `engine.identity`. Return the same envelope; tool rendering exposes text/metadata only, does not write a host file. Tool invocation may be part of an existing agent turn; the export operation itself starts no extra model. Chat output is retained in the conversation, so privacy warning applies there too. No new network-origin header is invented: “same source” means trusted native exec/owner/session/workspace correspondence.

Errors:

| Condition | Contract |
| --- | --- |
| No Team exists | `team-agents/no-team` |
| File would exceed 8 MiB UTF-8 | `team-agents/export-too-large` |
| Invalid retained data/serialization failure | `team-agents/export-invalid-snapshot` (generic message, no content dump) |
| Not native owner / wrong invocation | existing `team-agents/owner-required` |
| Missing/archived/delegated/replaced session | existing `team-agents/session-unavailable` |
| Wrong/unregistered workspace or saved ownership | existing `team-agents/workspace-mismatch` |
| Invalid request, cancellation, denied access | existing strict codec/native Gateway error; do not wrap into successful envelope |

Chat uses the same domain error codes where relevant; does not fabricate a native Remote invocation. Empty Team with zero tasks is valid; null Team is not. Draft/running/paused/blocked/completed states all export without transitioning state.

## Frontend implementation agreement

Frontend owns [remote-client.ts](../src/remote-client.ts), [settings-contract.ts](../src/settings-contract.ts), [dashboard.tsx](../src/dashboard.tsx), [conversation-view.tsx](../src/conversation-view.tsx), locale/client-test files and new [run-export-download.ts](../src/run-export-download.ts).

- `TeamSettingsActions.exportRun(options: TeamRunExportOptions, signal?: AbortSignal): Promise<TeamRunExportResult>` is a required session action. Update mocks implementing the full interface. Add exportRun to generic call/required **exclusions** so export never parses as a Team. Bound closure sends `{sessionId:boundId,...normalizedOptions}`; parse result, verify exact ownerSessionId, format and includeMessages against request. Envelope schema validates revision bounds. For JSON additionally parse document schema and verify metadata matches envelope, including sourceRevision/teamId/exportedAt/options. Do not parse Markdown to reconstruct ownership.
- `TeamDashboardProps.canExport?: boolean`; actions supports optional exportRun in addition to existing Stop to retain compact/read-only consumers. Full native view supplies actions, passes `useAccess(TEAM_REMOTE_ENDPOINTS.exportRun) === true` separately from Stop. No Start or configuration-library changes.
- Page presentation provides labeled Markdown/JSON choice (default Markdown), unchecked include-messages checkbox, explicit Download button, retained-snapshot explanation and always-visible sensitive-content warning; when checked, clearly warn that mailbox text is included. No effect or mount-triggered export. No team/authority/actions => no enabled download control. Unknown access is denial until known.
- Own export AbortController, busy/ref reentry guard, error and option state separately from Stop. Session/team key unmount, authority loss, actions replacement or unmount aborts pending export. Use signal/request-generation checks after await before any Blob/anchor. Capture session/team/options on click. Check returned teamId equals captured team.id and sourceRevision >= captured team.revision (newer is normal); never overwrite projection with export response. Reset checkbox on session/team switch.
- Export helper suggestion `downloadTeamRunExport(result: TeamRunExportResult): () => void` creates Blob with validated MIME, ObjectURL, temporary `<a download=filename>`, clicks then removes anchor, returns idempotent cleanup that revokes URL; schedule revocation after click has been consumed, not before browser processes navigation, and invoke cleanup on disposal. Helper validates before allocation, cleans up if click throws; UI never calls it for stale/cancelled results. It uses browser download only, not host filesystem writes or `window.open`/HTML injection.
- Errors are accessible (`role=alert`), busy status announced, controls keyboard-operable and wrap on narrow viewports. No team view retains its current empty/loading state. Do not promise a browser saved file merely because an anchor was clicked.

## Tests and verification boundary

Backend must ensure [tsconfig.json](../tsconfig.json) includes its new serializer/tests and tester's `tests/run-export-acceptance.test.ts`; current `tests/*.test.ts` glob already covers new `.test.ts` files. Keep Host and Client face separation. Frontend owns client include/mocks. No dependency installation or version bump is needed.

Required deterministic fixtures/checks:

1. JSON parses with schema; both formats include correct revisions/time/goal/model/dependencies/status/retained outcome. Null Team errors; empty Team exports. Inherited model stays null without runtime model resolution.
2. Default messages absent; false and true are strict booleans (reject string coercion); true empty mailbox emits []; messages from other sessions never queried. Instructions/workspaceId/member sessionId/attemptId/global library/extra injected fields absent in both formats. Description/output can still contain secrets: no claim of redaction.
3. Retry-cleared fields absent, pre-truncated output marker retained, running/failed/paused/blocked states truthful; no invented history or completion.
4. Malicious filename/name, traversal, control/bidi characters, Unicode, CRLF, HTML/image/link syntax, long fence runs and multiline content stay inert in Markdown; JSON round-trips exact retained text.
5. Exact byte-bound edge, multibyte over-bound input, no silent truncation, mismatched MIME/extension/byteLength rejected. Invalid exported time/unknown format/extra selector rejected. Failure messages do not dump inputs.
6. Native owner success including cold root without Agent; guest, delegated, forged principal/direct service call, archive, owner/workspace mismatch, session replacement and cancellation fail. No model/default/catalog/resolveAgent calls or writes on export, including errors. Distinct owners get only their requested owned snapshots.
7. Chat exact caller only, no session override, changed cwd/actor during lookup and wrong saved ownership rejected; no state/model side effects. Null and empty team covered.
8. DOM: access false/unknown, no team, explicit click only, default checkbox, selected MIME, repeat click guard, error retry, pending cancellation/unmount/switch and permission change never download stale data; ObjectURL and anchor cleanup on success/failure. Stop still works.
9. Existing suite regression, `npm run check`; isolated existing layout fixture if available. Real host browser/native save dialog behavior is a separate unverified integration boundary unless explicitly exercised without restarting/replacing the user's DSH.

Architecture-phase validation (executed successfully): standalone `tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext src/run-export-contract.ts`; in-memory esbuild `platform:'browser'` bundle with input inspection confirming only this source module plus Zod; Node assertions against the browser bundle covering default false, invalid options/extra selectors, message presence coupling, strict field privacy, envelope MIME/extension/version/Unicode byte-length checks, exact 8 MiB and over-limit content. No generated files were written. These validate contract feasibility only, not later Remote/UI integration. Native transport maximum effective payload and memory overhead at 8 MiB remain integration assumptions to verify; if native Gateway has a tighter limit, lower the shared constant deliberately and update tests/documentation, never bypass native transport. No persistence migration: storage-domain version remains 1, export schema version is independent. Breaking document changes require a new export schemaVersion; old strict consumers reject unknown versions. No export import/restore support is implied.
