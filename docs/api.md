# REST API

This document is the contract of every HTTP endpoint the orchestrator serves: the conventions shared by
all routes (OpenAPI metadata, scopes, ownership, addressing, validation, errors, pagination, long-polling,
versioning), the representation of every resource, a complete route table grouped by tag, and full
request/response examples for the machine APIs used by the Go node daemon (`/api/node/*`, registry token)
and the Go runtime (`/api/runtime/*`). Persistent fields are defined in [data model](data-model.md); the
MCP layer built on top of this API is in [mcp](mcp.md); principals and credentials are in [auth](auth.md);
the system context is in [architecture](architecture.md).

## 1. Conventions

### 1.1 Routes and OpenAPI

- Every route is a Nitro file route under `orchestrator/server/api/` (one file per method). Its first
  statement is `defineRouteMeta({ openAPI: { … } })` with a static object literal (no imported constants).
  Nitro extracts it statically and silently drops every value that is not an object, array, string,
  number, boolean or `null` literal: negative numbers (write the bound in the description; zod enforces
  it), template literals, and strings that contain both `'` and `"` (esbuild prints those as template
  literals; use `’` for apostrophes). `test/api/route-meta.test.ts` enforces this.
- The OpenAPI 3.1 document is generated at runtime (`nitro.openAPI.production: "runtime"`) and served
  publicly at `GET /api/docs/openapi.json`; the Scalar UI is at `GET /api/docs`. Nitro lists every handler,
  including middleware and framework routes; `server/plugins/openapi.ts` serves only the operations that
  have an `operationId` (the API operations), which keeps the document valid OpenAPI.
- Every operation declares exactly one tag from §4, `summary`, a `description` written for an AI agent
  reader, `operationId`, parameters, request body, responses (errors reference `#/components/schemas/Error`)
  and these extensions:

| Extension | Type | Required | Meaning |
|---|---|---|---|
| `x-scantor-scope` | `owner`\|`admin`\|`public`\|`node`\|`worker`\|`setup`\|`tools` | yes | which principal the operation accepts (§1.2) |
| `x-mcp` | boolean | yes | `true` = exposed as an MCP tool named `snake_case(operationId)` |
| `x-admin-only` | boolean | when true | `true` iff `x-scantor-scope` is `admin`; hides the tool from non-admin MCP sessions and requires OAuth scope `scantor:admin` |
| `x-read-only` | boolean | when true | a non-GET operation without side effects (`queryAnalyses`, `aggregateAnalyses`, `estimateTemplate`); MCP marks it read-only and allows it with scope `scantor:read` |
| `x-session-only` | boolean | when true | only a browser session may call the operation; API keys (both configurations) and MCP get 403 `sessionRequired`. Enforced centrally by the auth middleware's operation registry ([auth](auth.md) §5.4). Set on `setAccountPassword`, `removeAccountPassword`, `createApiKey`, `createToolsSession` |
| `x-destructive` | boolean | when true | a non-`DELETE` operation that discards work or data or revokes access; MCP sets `destructiveHint` from it ([mcp](mcp.md) §4.2). Set on `cancelScan`, `cancelTestRun`, `banUser`, `rotateNodeToken` (`revokeNodeToken` is a `DELETE` and destructive by method) |

- `operationId`: camelCase, verb first (`list…`, `get…`, `create…`, `update…`, `delete…`, `start…`,
  `pause…`, …), unique across the document.
- Shared component schemas are declared once with `$global.components.schemas` in an anchor route of their
  tag and referenced with `$ref`. Schemas used across tags (`Error`, `JobRef`, `ScantorError`,
  `BuildError`, `FileRef`, `ScanSettings`, `Description`, plus `Health`) are declared in
  `server/api/health.get.ts`. Request and response schemas are separate (`StartScan` vs `Scan`).
- A generated test ([testing](testing.md)) fails when an operation lacks `x-scantor-scope` or `x-mcp`, when
  `x-admin-only` disagrees with the scope, when `x-session-only` appears with a scope other than `owner` or
  `admin`, when `x-destructive` appears on a `DELETE`, when an `operationId` is duplicated, or when more
  than 30 operations have `x-mcp: true`.

### 1.2 Principals and scopes

| Scope | Accepted principals | Notes |
|---|---|---|
| `public` | none needed | health, setup status, OpenAPI document |
| `owner` | user principal: session cookie, API key (`x-api-key` or `Authorization: Bearer sk_scantor_…`), MCP internal capability | addressed resources must be owned by the caller (admins pass, §1.3); operations with `x-session-only` reject API keys and MCP with 403 `sessionRequired` |
| `admin` | user principal with effective admin power: `role: "admin"`, and not via an `editor` API key, and not via MCP without `scantor:admin` ([auth](auth.md) §5.6) | others get 403 `adminRequired` (also admins using their `editor` key or a non-admin MCP grant) |
| `node` | `Authorization: Bearer snt_…`; on `/api/registry/token` Basic `node:snt_…` or the orchestrator registry credential | |
| `worker` | `Authorization: Bearer swt_<workerId>.<mac>` of a worker in an active state ([data model](data-model.md) §6.6) | scheduler routes also require `role: scheduler` and the current epoch |
| `setup` | header `X-Scantor-Setup-Token` while no user exists | constant-time compare |
| `tools` | cookie `scantor_tools` | forwardAuth only |

Route prefixes are bound to principal kinds. A credential of another kind on a prefix is ignored, which
yields 401 `unauthorized`:

| Prefix | Principal |
|---|---|
| `/api/node/*` | node |
| `/api/runtime/*` | worker |
| `/api/registry/token` | node or orchestrator registry credential (Basic) |
| `/api/setup/*` | setup token (`GET /api/setup/status` is public) |
| `/api/tools/forward-auth` | tools cookie (without a valid cookie: 302 for browser requests, otherwise 401, §4.18) |
| `/api/health`, `/api/docs`, `/api/docs/openapi.json` | public |
| `/api/auth/*` | better-auth's own handling (API-key credentials rejected with 401) |
| every other `/api/*` | user |
| `/mcp` (not under `/api`) | authenticates itself: MCP OAuth access tokens or API keys ([mcp](mcp.md) §3) |

Further rules of the global middleware ([auth](auth.md) §5):
- **Deny by default.** The middleware resolves every `/api/*` request against an operation registry built
  from the runtime OpenAPI document. A path that matches no operation (outside the public and
  `/api/auth/*` allowlist) is 404 `notFound`, so a route without OpenAPI metadata is unreachable; a
  matching path with another method is 405 `methodNotAllowed`.
- Precedence on user routes: internal capability, then API key, then session cookie; an explicit credential
  alone decides (an invalid one is 401, never a fallback to the cookie). MCP OAuth access tokens are never
  accepted on `/api/*` (a Bearer value that is not `sk_scantor_…` is 401); they are verified only on `/mcp`.
- Requests to `/api/auth/*` that carry `x-api-key` or `Authorization: Bearer sk_scantor_…` are rejected with
  401 `unauthorized` (scantor envelope), so an API key can never act as a better-auth session.
- Banned users are rejected for every user principal (403 `banned`); the user record is cached ≤ 30 s.
- CSRF: cookie-authenticated `POST`, `PUT`, `PATCH` and `DELETE` requests must carry an `Origin` equal to a
  trusted origin, else 403 `forbidden`. Trusted origins are the origin of `SCANTOR_PUBLIC_URL` plus, when
  its host is `localhost`, the `127.0.0.1` and `[::1]` aliases with the same scheme and port. The editor
  origin is never trusted. API keys, MCP capabilities and machine tokens are not ambient and are exempt.
- MCP-originated calls are additionally filtered by level: `GET` and `x-read-only` operations need
  `scantor:read`, other operations `scantor:write`, `x-admin-only` operations `scantor:admin`; else 403
  `forbidden`.
- A non-admin passing a `userId` filter other than their own on a list operation gets 403 `adminRequired`.

### 1.3 Ownership

- Order of checks: authenticate (401) → resource exists and is visible (404) → operation allowed (403).
- A resource owned by another user is **404 `notFound`** for non-admins, never 403. Admin-only operations
  are 403 `adminRequired` for non-admins.
- Admins pass ownership checks on every addressed resource (read and write), except the editor routes,
  which always act on the caller's own editor.
- Resources created under an addressed parent inherit the parent's owner: revisions, test runs and files
  of a task; restart clones and exports of a scan.
- Top-level creates (`createTask`, `importGitTask`, `uploadTask`, `startScan`, `createUpload`,
  `createCredential`, `createApiKey`) are owned by the caller and may reference only the caller's own
  resources (revision, uploads, credential); anything else is 404.
- List operations return the caller's resources; admins get everything and may filter with `userId`. The
  exceptions are `listCredentials` and `listUploads`, which return only the caller's own items, also to
  admins: credentials and uploads are inputs that only their owner can reference (`importGitTask`,
  `startScan`), and their representations carry no owner. Admins still reach another user's credential or
  upload by id (`updateCredential`, `deleteCredential`, `getUpload`, `deleteUpload`). The account lists (API
  keys, sessions, passkeys, OAuth apps) are the caller's own by definition.

### 1.4 Addressing

| Parameter | Accepted forms |
|---|---|
| `{task}` | task id (uuid) or task name (slug, looked up among the **caller's** tasks; admins use ids for other users' tasks). Reserved names that can never be task names: `upload`, `import-git`, `new`, `latest`. |
| `{revision}` | revision number (`3`), `latest` (highest-numbered `ready` revision) or revision id (uuid) |
| revision reference (body field `revision`, CLI, MCP) | `<task>@<N>`, `<task>@latest`, `<task>` (= `@latest`) or a revision id; a bare uuid is tried as a revision id first, then as a task id (`@latest`) |
| `{analysisId}` | `<scanId>-<seq>` |
| other `{…Id}` | uuid; a malformed id is 404 `notFound` |

### 1.5 Requests

- Bodies are `application/json` (UTF-8) unless the route says otherwise (task upload `application/gzip`,
  list upload `text/plain`/`application/octet-stream`, registry token POST form).
- Every body, query and path parameter is parsed with a strict zod schema (unknown keys rejected, ids with
  `z.uuid()`, strings length-bounded); failures are 400 `validationFailed` with
  `details.issues: [{path, message}]`. Request objects are never placed into MongoDB filters, except the
  query API's filter after its allowlist check (§5.2).
- Query parameters: booleans `true`/`false`, integers in decimal, lists comma-separated.
- Body caps: `SCANTOR_MAX_REQUEST_BYTES` for every JSON body (413 `payloadTooLarge`); streaming routes have
  their own cap (task upload `SCANTOR_TASK_MAX_PACK_BYTES`, list upload `SCANTOR_MAX_UPLOAD_BYTES`); machine
  routes: `/api/runtime/*` 1 MiB, `/api/node/status` and `/api/node/workers/*/logs` 2 MiB.
- Lifecycle actions are idempotent: requesting the state a resource is already in returns 200 with the
  unchanged resource; any other forbidden transition is 409 `invalidState`.

### 1.6 Responses

- JSON with camelCase fields; `id` instead of `_id`; timestamps as ISO 8601 UTC strings with milliseconds,
  except `serverTime` (epoch milliseconds, for clock math); durations in integer milliseconds (`…Ms`).
- Status codes: `200` read and action; `201` create (always, whether or not the new resource has settled);
  `202` accepted asynchronous work (body contains `job: JobRef`); `204` synchronous delete;
  `302` only where `redirect=true` is requested, for `createToolsSession`, and for `toolsForwardAuth` when a
  browser request has no valid tools cookie (§4.18).
- Secrets: `writeOnly` config values are `"***"` in every response (scans, test runs, analyses, exports);
  credentials and tokens are never returned after creation. `aggregateAnalyses` output is not maskable, so
  pipelines that reference a secret path are rejected (400 `queryRejected`).
- Every response carries `X-Request-Id` (also in logs); error bodies repeat it as `details.requestId` for
  500s.

### 1.7 Errors

```json
{ "error": { "code": "invalidState", "message": "scan is completed; pause requires running", "details": { "state": "completed", "allowed": ["running"] } } }
```

Exceptions to the envelope: `/api/auth/*` (better-auth format), `/api/registry/token` (registry format, §6),
`/api/tools/forward-auth` (302 or a 401 with a short `text/plain` body for Traefik, [auth](auth.md) §11),
`/api/metrics` (text), `/mcp` (JSON-RPC).

| Code | HTTP | Meaning |
|---|---|---|
| `validationFailed` | 400 | request body/query/params rejected by the zod schema; `details.issues` |
| `badRequest` | 400 | malformed JSON or contradictory parameters |
| `queryRejected` | 400 | forbidden operator or stage in a query, aggregation or export filter, or a sort that exceeds limits; `details.path` |
| `passkeysDisabled` | 400 | passkey flow requested while passkeys are disabled |
| `unauthorized` | 401 | missing or invalid credential, or a credential of the wrong kind for the prefix |
| `setupTokenInvalid` | 401 | setup token missing or wrong |
| `forbidden` | 403 | untrusted `Origin`, insufficient MCP level, worker role not allowed on the route, `editor` API key on `createEditorSession` |
| `adminRequired` | 403 | admin-only operation |
| `sessionRequired` | 403 | operation needs a browser session |
| `banned` | 403 | the user is banned |
| `privilegedNotAllowed` | 403 | privileged revision without `canRunPrivileged` |
| `quotaExceeded` | 403 | per-user storage quota reached |
| `notFound` | 404 | missing, deleted or not owned; an `/api/*` path that matches no operation |
| `methodNotAllowed` | 405 | the path matches an operation, the method does not |
| `invalidState` | 409 | transition not allowed; `details: {state, allowed}` |
| `alreadyExists` | 409 | unique name taken |
| `workspaceDirty` | 409 | workspace has unpublished changes; retry with `force=true` |
| `gitDiverged` | 409 | local changes since the last import/pull, or remote is not a fast-forward |
| `taskInUse` | 409 | a non-terminal scan uses the task |
| `uploadInUse` | 409 | a scan references the upload |
| `revisionNotReady` | 409 | revision is `queued`, `building` or `failed` |
| `revisionUnavailable` | 409 | the scan's revision no longer exists |
| `nothingToRetry` | 409 | retry-failed with no `failed` or `lost` analysis that has a stored config |
| `exportTooLarge` | 409 | inline export above `SCANTOR_EXPORT_INLINE_MAX`; use `exportScan` |
| `staleEpoch` | 409 | scheduler fenced by a newer epoch; `details.currentEpoch` |
| `nodeInstanceConflict` | 409 | another daemon instance holds the node lease |
| `builtInNode` | 409 | not allowed on the built-in node |
| `setupCompleted` | 409 | a user already exists |
| `lastCredential` | 409 | removing the last password/passkey |
| `payloadTooLarge` | 413 | body cap exceeded, or a workspace helper cap (files, bytes, workspace size); `details: {limit, actual?}` |
| `unsupportedMediaType` | 415 | |
| `configInvalid` | 422 | task/scan/analysis config rejected by the revision schema; `details.issues: [{path, message}]` (JSON pointers) |
| `confirmationRequired` | 422 | estimated analyses above `SCANTOR_SCAN_CONFIRM_THRESHOLD`; `details: {expectedTotal, threshold}`; retry with `confirm: true` |
| `scanTooLarge` | 422 | estimate above `SCANTOR_MAX_ANALYSES_PER_SCAN`; `details: {expectedTotal, max}` |
| `manifestInvalid` | 422 | uploaded or imported folder has no valid `scantor.yaml`; `details.errors: BuildError[]` |
| `invalidPath` | 422 | upload/write path rule violated; `details.path` |
| `gitFailed` | 422 | clone or fetch failed; `details.message` (credentials redacted) |
| `incompatibleVersion` | 426 | node daemon/runtime version outside the supported window; `details: {serverVersion, minVersion}` |
| `tooManyRequests` | 429 | concurrency caps (`SCANTOR_MAX_CONCURRENT_WAITS`, `SCANTOR_USER_MAX_CONCURRENT_QUERIES`, `SCANTOR_EDITOR_MAX_RUNNING`; `details.limit`) or auth rate limit |
| `internal` | 500 | unexpected error |
| `brokerAlarm` | 503 | RabbitMQ memory/disk alarm active; new scans refused |
| `unavailable` | 503 | the orchestrator is still booting ([architecture](architecture.md) §4.1), a dependency (MongoDB, RabbitMQ, S3, Docker) is unreachable, or no workspace helper slot became free within 30 s |
| `queryTimeout` | 504 | `SCANTOR_QUERY_MAX_TIME` exceeded |

### 1.8 Pagination

- `?limit=` (default 50, max 200) and `?cursor=` (opaque base64url). Responses are
  `{"items": [...], "nextCursor": "…" | null}`.
- Lists sort newest first (`createdAt` desc, then `_id` desc) unless stated. Bounded lists (API keys,
  credentials, nodes, conditions, templates) return `{"items": [...]}` without a cursor.
- Analyses sort by `seq` ascending; they accept `afterSeq` (integer) instead of `cursor` for resumable
  reads, and `nextCursor` is the decimal string of the last returned `seq`. `listAnalyses` allows
  `limit` up to 1000; `queryAnalyses` defaults to 20 and allows up to 1000.

### 1.9 Long-polling with `wait`

`wait` is an integer number of seconds (0–120, default 0) on the operations below. The handler returns
immediately when the resource is already settled; otherwise it holds the request until the resource
settles or `wait` elapses, then returns the current representation with the normal status code. The
response header `Scantor-Wait: settled|timeout` tells which. A client disconnect aborts the wait. Each user
may hold at most `SCANTOR_MAX_CONCURRENT_WAITS` waits (429 `tooManyRequests`). Implementations watch the
document with a change stream (fallback: 1 s polling).

| Operation | Settled when |
|---|---|
| `publishRevision`, `getRevision`, `uploadTask` (revision part) | revision `ready` or `failed` |
| `testTask`, `getTestRun` | test run `completed`, `failed` or `cancelled` |
| `getScan` | scan not in `creating` or `running` |
| `exportScan`, `getExport` | export `ready` or `failed` |
| `getJob` | job `succeeded`, `failed` or `cancelled` |
| `getWorkerLogs` (max 30) | a log tail newer than the request arrived |

MCP clamps `wait` to 50 s (the tool input schema has `maximum: 50`) because many MCP clients time out tool
calls at 60 s. The node long-poll (`GET /api/node/assignments`) uses its own `wait` (≤ 60, default 25).

### 1.10 Versioning

- No version in the path; OpenAPI `info.version` is the scantor version. The user API changes only
  additively within a major version.
- Machine clients send `User-Agent: scantor-node/<version>` or `scantor-runtime/<version>` and
  `X-Scantor-Version: <version>`. The orchestrator accepts its own and the previous minor version; others
  get 426 `incompatibleVersion`.

## 2. Resource representations

Representations follow the documents in [data model](data-model.md) with the mapping rules of §1.6. Only
additions and omissions are listed for brevity; the JSON examples are normative for field names.

| Schema | Source | Differences from the document |
|---|---|---|
| `Task` | `tasks` | + `workspace.dirty` (= `workspace.packSha256 != latestRevision.packSha256`; true without revisions); `workspace.lastSyncSha256` exposed; − `revisionSeq`, `deletingAt`; `revisionCount` = `revisionSeq` |
| `Revision` | `revisions` | − `snapshotKey`, `buildLogKey`, `jobId`; + `ref` (`"<taskName>@<number>"`) |
| `RevisionSummary` | `revisions` | `{id, number, ref, state, source.kind, source.packSha256, privileged, errorsCount, createdAt, finishedAt}` |
| `TestRun` | `testRuns` | − `secrets`, keys; + `analyses: TestRunAnalysis[]` (when requested) |
| `TestRunAnalysis` | `testRunAnalyses` | as `Analysis` without round/worker fields |
| `Scan` | `scans` | − `secrets`; + `progress {scheduled, terminal, total, percent, etaSeconds}`, `workers {desired, active, pending, byState}` |
| `ScanSummary` | `scans` | `{id, userId, name, task, revision {id, number, ref}, state, stateReason, settings.workers, settings.processes, progress, stats, conditionsCount, createdAt, completedAt}` (`userId` lets admin lists show the owner) |
| `Analysis` | `analyses` | `id` = `_id`; `files[].key` omitted; secrets masked |
| `Worker` | `workers` | − `spec.specHash`; + `node {id, name}`, + `scan {id, name}` |
| `Node` | `nodes` | − `tokenHash`, `instance.id`; + `activeWorkers` |
| `Export` | `exports` | − `key`; + `download {url, expiresAt}` when `ready` |
| `Upload`, `Credential`, `Event`, `Job`, `Condition` | same names | internal fields omitted |
| `JobRef` | `jobs` | `{id, kind, state}` |
| `User` | better-auth `user` | `{id, email, name, role, banned, banReason, canRunPrivileged, maxWorkers, createdAt, updatedAt, usage {activeWorkers, tasks, scans}}` |
| `ApiKey` | better-auth `apikey` | `{id, name, start, configId, enabled, createdAt, expiresAt, lastRequest}` |
| `FileDownload` | – | `{url, expiresAt, name, size, sha256, contentType, inline}` |
| `ScanSettings`, `ScantorError`, `FileRef`, `BuildError`, `Description` | [data model](data-model.md) §4 | identical |

`Task`:

```json
{
  "id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "name": "echo",
  "language": "python",
  "description": "Echo a greeting",
  "source": { "kind": "scaffold", "template": "single" },
  "workspace": { "packSha256": "a3f1…9c", "fileCount": 9, "bytes": 14336, "dirty": false, "lastSyncSha256": null, "checkedAt": "2026-10-21T09:00:00.000Z" },
  "revisionCount": 3,
  "latestRevision": { "id": "c1d2e3f4-…", "number": 3, "state": "ready", "packSha256": "a3f1…9c", "createdAt": "2026-10-21T09:01:00.000Z" },
  "latestReadyRevision": { "id": "c1d2e3f4-…", "number": 3, "state": "ready", "packSha256": "a3f1…9c", "createdAt": "2026-10-21T09:01:00.000Z" },
  "privileged": false,
  "createdAt": "2026-10-21T08:30:00.000Z",
  "updatedAt": "2026-10-21T09:02:10.000Z"
}
```

`Revision`:

```json
{
  "id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "taskId": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c",
  "taskName": "echo",
  "number": 3,
  "ref": "echo@3",
  "state": "ready",
  "message": "add greeting option",
  "source": { "kind": "workspace", "packSha256": "a3f1…9c", "packBytes": 4211, "fileCount": 9 },
  "manifest": { "scantor": 1, "name": "echo", "language": "python", "entry": "main.py", "defaults": { "processes": 2 } },
  "language": "python",
  "baseImage": { "ref": "ghcr.io/lonetis/scantor-base-python:1.4.0", "digest": "sha256:0d1e…" },
  "image": { "repository": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "tag": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "digest": "sha256:4e5f…", "bytes": 187654321, "platform": { "os": "linux", "arch": "amd64" } },
  "description": {
    "protocolVersion": 1,
    "connector": { "language": "python", "version": "1.4.0" },
    "schemas": {
      "taskConfig": { "type": "object", "properties": { "greeting": { "type": "string", "default": "Hello" } }, "additionalProperties": false },
      "scanConfig": { "type": "object", "properties": {}, "additionalProperties": false },
      "analysisConfig": { "type": "object", "properties": {}, "additionalProperties": false },
      "result": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"], "additionalProperties": false }
    },
    "schedule": { "kind": "template", "template": "single" },
    "secretPaths": { "taskConfig": [], "scanConfig": [], "analysisConfig": [], "result": [] },
    "uploadPaths": { "taskConfig": [], "scanConfig": [] },
    "fileRefPaths": [],
    "warnings": []
  },
  "settingsDefaults": { "workers": 1, "processes": 2, "timeoutMs": 300000, "maxAttempts": 3, "backoff": { "initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true }, "resources": { "cpus": 1, "memoryMiB": 512 }, "maxAnalysesPerProcess": 1000, "privileged": false },
  "privileged": false,
  "errors": [],
  "createdAt": "2026-10-21T09:01:00.000Z",
  "startedAt": "2026-10-21T09:01:01.000Z",
  "finishedAt": "2026-10-21T09:01:48.000Z",
  "updatedAt": "2026-10-21T09:01:48.000Z"
}
```

A failed revision has `"state": "failed"`, `"image": null` and for example
`"errors": [{"phase": "static", "file": "Dockerfile", "line": 3, "message": "COPY --from=localhost:5000/tasks/x is not allowed: image references must not point at the platform registry"}]`.

`TestRun`:

```json
{
  "id": "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "taskId": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c",
  "taskName": "echo",
  "state": "completed",
  "input": { "taskConfig": { "greeting": "Hi" }, "limit": 5, "maxAttempts": 1, "timeoutMs": 300000 },
  "packSha256": "b7c2…01",
  "draftImage": { "ref": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:draft-b7c2…01", "digest": "sha256:aa01…", "cached": true },
  "errors": [],
  "summary": { "analyses": 1, "succeeded": 1, "failed": 0 },
  "analyses": [
    { "id": "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d-0", "seq": 0, "status": "succeeded", "attempt": 1, "config": {}, "result": { "text": "Hi" }, "error": null, "attempts": [], "files": [], "logTail": "", "timings": { "scheduledAt": "2026-10-21T09:10:02.000Z", "startedAt": "2026-10-21T09:10:02.000Z", "finishedAt": "2026-10-21T09:10:02.040Z", "durationMs": 40 } }
  ],
  "createdAt": "2026-10-21T09:10:00.000Z",
  "startedAt": "2026-10-21T09:10:00.500Z",
  "finishedAt": "2026-10-21T09:10:02.100Z",
  "expiresAt": "2026-10-28T09:10:00.000Z"
}
```

`Scan`:

```json
{
  "id": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "name": "tranco top 100k",
  "task": { "id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "name": "origins" },
  "revision": { "id": "c1d2e3f4-…", "number": 3, "ref": "origins@3", "language": "typescript", "repository": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "digest": "sha256:4e5f…", "platform": { "os": "linux", "arch": "amd64" }, "privileged": false, "schedule": { "kind": "template", "template": "tranco" } },
  "state": "running",
  "stateReason": null,
  "taskConfig": { "expectedStatus": 200, "apiKey": "***" },
  "scanConfig": { "list": "latest", "subdomains": false, "offset": 0, "limit": 100000 },
  "secretPaths": { "taskConfig": ["/apiKey"], "scanConfig": [], "analysisConfig": [], "result": [] },
  "uploadIds": [],
  "settings": { "workers": 4, "processes": 2, "timeoutMs": 300000, "maxAttempts": 3, "backoff": { "initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true }, "resources": { "cpus": 1, "memoryMiB": 512 }, "maxAnalysesPerProcess": 1000, "nodeSelector": { "pool": "shared", "labels": {} }, "privileged": false },
  "round": 1,
  "scheduling": { "state": "running", "confirmed": 42000, "tailHash": "sha256:9b1c…", "epoch": 1, "restarts": 0, "resolved": { "schedule": { "template": "tranco", "scanConfig": { "list": "262W9", "subdomains": false, "offset": 0, "limit": 100000 }, "provenance": { "listId": "262W9", "date": "2026-10-20", "sourceUrl": "https://tranco-list.eu/download/262W9/100000", "sha256": "77aa…", "fetchedAt": "2026-10-21T10:00:03.120Z" }, "expectedTotal": 100000, "at": "2026-10-21T10:00:03.500Z" } }, "error": null, "startedAt": "2026-10-21T10:00:02.000Z", "checkpointAt": "2026-10-21T10:05:00.000Z", "doneAt": null },
  "stats": { "pending": 0, "retrying": 17, "succeeded": 39811, "failed": 102, "lost": 0, "cancelled": 0, "expectedTotal": 100000, "ratePerMin": 8100, "recountedAt": "2026-10-21T10:05:00.000Z" },
  "progress": { "scheduled": 42000, "terminal": 39913, "total": 100000, "percent": 39.9, "etaSeconds": 444 },
  "workers": { "desired": 5, "active": 5, "pending": 0, "byState": { "running": 5 } },
  "conditions": [],
  "breaker": null,
  "clonedFrom": null,
  "createdAt": "2026-10-21T10:00:00.000Z",
  "updatedAt": "2026-10-21T10:05:00.000Z",
  "startedAt": "2026-10-21T10:00:01.000Z",
  "pausedAt": null,
  "completedAt": null,
  "deletedAt": null
}
```

`progress.total` = `stats.expectedTotal` if known, else `scheduling.confirmed` once scheduling is `done`,
else null; `etaSeconds` = (total − terminal) / `ratePerMin` × 60, null when unknown.

`Analysis`: the document of [data model](data-model.md) §4.6 with `id`, ISO timestamps and `files[]`
without `key`.

## 3. Better-auth endpoints (not in OpenAPI)

better-auth is mounted at `/api/auth/*` (catch-all handler) with discovery at the origin root. Only these
endpoints are reachable over HTTP; every other better-auth endpoint answers 404 `notFound` (deny by default,
[auth](auth.md) §2.5):

| Endpoint | Used by |
|---|---|
| `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `GET\|POST /api/auth/get-session` | UI login/logout/session (the session refresh uses POST) |
| `POST /api/auth/update-user`, `POST /api/auth/change-password`, `POST /api/auth/change-email`, `GET /api/auth/list-sessions`, `POST /api/auth/revoke-session`, `POST /api/auth/revoke-sessions` | account page |
| `GET /api/auth/passkey/generate-register-options`, `POST /api/auth/passkey/verify-registration`, `GET /api/auth/passkey/generate-authenticate-options`, `POST /api/auth/passkey/verify-authentication`, `GET /api/auth/passkey/list-user-passkeys`, `POST /api/auth/passkey/update-passkey`, `POST /api/auth/passkey/delete-passkey` | passkeys (delete guarded: not the last credential) |
| `GET /api/auth/oauth2/authorize`, `POST /api/auth/oauth2/token`, `POST /api/auth/oauth2/register`, `POST /api/auth/oauth2/consent`, `POST /api/auth/oauth2/continue`, `GET /api/auth/oauth2/userinfo`, `GET /api/auth/oauth2/public-client`, `POST /api/auth/oauth2/public-client-prelogin`, `POST /api/auth/oauth2/revoke`, `POST /api/auth/oauth2/introspect`, `GET /api/auth/oauth2/end-session`, `GET /api/auth/jwks`, `GET /api/auth/error` (the page a failed authorization redirects to) | MCP OAuth ([mcp](mcp.md)) |
| `GET /.well-known/oauth-authorization-server/api/auth`, `GET /.well-known/openid-configuration/api/auth`, `GET /.well-known/oauth-protected-resource/mcp`; issuer-relative `GET /api/auth/.well-known/oauth-authorization-server`, `GET /api/auth/.well-known/openid-configuration` (also HEAD) | MCP discovery |

The allowlist applies to HTTP only; server-side `auth.api.*` calls still reach every endpoint. Unreachable are,
among others, `/sign-up/email`, `/token`, `/api-key/*`, every `/admin/…` endpoint, `/delete-user`, password reset,
email verification, social sign-in and account linking, `/list-accounts`, `/update-session`,
`/revoke-other-sessions`, `/verify-password` and better-auth's OAuth client and consent management. Users, API keys
and OAuth apps are managed through §4 routes. Methods and paths match exactly; the full list is in
[auth](auth.md) §2.5.

## 4. Route table

Columns: **Scope** per §1.2; **MCP** = `x-mcp`; request fields marked `?` are optional; `Page<T>` =
`{items: T[], nextCursor}`.

### 4.1 `health`, `docs`, `instance`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/health` | `getHealth` | public | no | – | `{status: "ok"\|"degraded", version, components: {mongo, rabbitmq, s3, registry}, alarms: string[]}` (each component `"ok"` or `"down"`); 503 when MongoDB is down |
| `GET /api/docs/openapi.json` | – (Nitro built-in) | public | no | – | OpenAPI 3.1 document |
| `GET /api/docs` | – (Nitro built-in) | public | no | – | Scalar UI |
| `GET /api/info` | `getInstanceInfo` | owner | no | – | `InstanceInfo` (below) |

`InstanceInfo`:

| Field | Type | Meaning |
|---|---|---|
| `version` | string | orchestrator version |
| `publicUrl`, `editorUrl`, `mcpUrl` | string; `mcpUrl` null when MCP is disabled | `SCANTOR_PUBLIC_URL`, `SCANTOR_EDITOR_URL`, `<public>/mcp` |
| `registryPublicHost` | string | `SCANTOR_REGISTRY_PUBLIC_HOST` |
| `cliImage` | string | `<SCANTOR_IMAGE_PREFIX>scantor:<image tag>`, the image of the UI's CLI alias snippet; the image tag is the orchestrator version when it is a release version (`X.Y.Z`), otherwise `SCANTOR_IMAGE_TAG` (builds from `main` and dev builds have no version tag); same rule as `NodeJoin` (§4.17) |
| `features` | `{passkeys, mcp, mcpOAuth, editor}` booleans | `mcpOAuth` is false when `SCANTOR_MCP_ENABLED=false` or when `SCANTOR_PUBLIC_URL` is plain http on a non-loopback host; `/mcp` then accepts API keys only ([mcp](mcp.md) §3.8) |
| `limits` | `{maxWorkersPerScan, maxProcessesPerWorker, maxResultBytes, maxFileBytes, scanConfirmThreshold, waitMaxSeconds: 120}` | |
| `user` | `{id, role}` | the caller |
| `adminTools` | `{enabled, items: [{target: "rabbitmq"\|"mongo-express"\|"rustfs"\|"traefik", title, url}]}`; present only for callers with effective admin power | `enabled` = Traefik with forwardAuth is configured (`SCANTOR_DOMAIN` not empty); `url` is the tool URL of [auth](auth.md) §11 when enabled, else null (the UI then shows the `SCANTOR_ADMIN_BIND_ADDRESS` hint). Used by `/admin/tools` |

### 4.2 `setup`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/setup/status` | `getSetupStatus` | public | no | – | `{needsSetup, passkeysEnabled, mcpUrl: string\|null}` |
| `POST /api/setup/admin` | `createSetupAdmin` | setup | no | `{email, name, password}` (password 8–128 chars) | 201 `User`; 409 `setupCompleted`; 401 `setupTokenInvalid` |
| `POST /api/setup/admin-passkey-token` | `createSetupPasskeyToken` | setup | no | `{email, name}` | 201 `{token, expiresIn: 300}` (passkey-first admin, consumed by passkey registration); 400 `passkeysDisabled` |

### 4.3 `account` and `api-keys`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/account` | `getAccount` | owner | no | – | `{id, email, name, role, canRunPrivileged, maxWorkers, credentials: {hasPassword, passkeyCount}, createdAt}` |
| `PATCH /api/account` | `updateAccount` | owner | no | `{name}` | account |
| `POST /api/account/password` | `setAccountPassword` | owner (`x-session-only`) | no | `{newPassword}` — only when no password exists (otherwise use `/api/auth/change-password`) | 204; 409 `alreadyExists` |
| `DELETE /api/account/password` | `removeAccountPassword` | owner (`x-session-only`) | no | – | 204; 409 `lastCredential` |
| `GET /api/account/oauth-apps` | `listOAuthApps` | owner | no | – | `{items: [{clientId, name, uri, scopes, createdAt}]}` |
| `DELETE /api/account/oauth-apps/{clientId}` | `revokeOAuthApp` | owner | no | – | 204 (deletes consent and tokens) |
| `GET /api/account/api-keys` | `listApiKeys` | owner | no | `?configId=default\|editor` | `{items: ApiKey[]}` |
| `POST /api/account/api-keys` | `createApiKey` | owner (`x-session-only`) | no | `{name (1–32), expiresInDays? (1–365, default 90)}` | 201 `{apiKey: ApiKey, key: "sk_scantor_…"}` (key shown once) |
| `DELETE /api/account/api-keys/{keyId}` | `deleteApiKey` | owner | no | – | 204 |

### 4.4 `users` (admin)

All operations: scope admin, `x-admin-only: true`, MCP no.

| Operation | operationId | Request | Response |
|---|---|---|---|
| `GET /api/users` | `listUsers` | `?q, cursor, limit` | `Page<User>` |
| `POST /api/users` | `createUser` | `{email, name, password?, role? ("user"), canRunPrivileged? (false), maxWorkers?}` | 201 `User`; 409 `alreadyExists` |
| `GET /api/users/{userId}` | `getUser` | – | `User` |
| `PATCH /api/users/{userId}` | `updateUser` | `{name?, email?, role?, canRunPrivileged?, maxWorkers?}` | `User`; 400 `badRequest` when demoting yourself; 409 `invalidState` while the user is being deleted |
| `PUT /api/users/{userId}/password` | `setUserPassword` | `{password}` | 204; 400 for yourself; 409 `invalidState` while the user is being deleted |
| `POST /api/users/{userId}/ban` | `banUser` (`x-destructive`) | `{reason?, cancelScans? (false)}` | `User` (sessions revoked, API keys and OAuth tokens/consents deleted, editor stopped; every user-bound principal of the user is rejected from then on, but worker tokens of the user's running scans stay valid unless `cancelScans` cancels those scans); 400 for yourself; 409 `invalidState` while the user is being deleted |
| `POST /api/users/{userId}/unban` | `unbanUser` | – | `User`; 409 `invalidState` while the user is being deleted |
| `DELETE /api/users/{userId}` | `deleteUser` | – | 202 `{job: JobRef}` (`userPurge`); 400 for yourself |

"Being deleted" means a `userPurge` job for the user is active: the account is locked out and is neither
changed nor unbanned until the job has removed it.

### 4.5 `credentials`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/credentials` | `listCredentials` | owner | no | – | `{items: Credential[]}` (`{id, kind, name, host, username, last4, lastUsedAt, createdAt, updatedAt}`) |
| `POST /api/credentials` | `createCredential` | owner | no | `{kind: "gitToken", name, host, username? ("x-access-token"), token}` | 201 `Credential`; 409 `alreadyExists` |
| `PATCH /api/credentials/{credentialId}` | `updateCredential` | owner | no | `{name?, host?, username?, token?}` | `Credential` |
| `DELETE /api/credentials/{credentialId}` | `deleteCredential` | owner | no | – | 204 |

### 4.6 `tasks`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/tasks` | `listTasks` | owner | **yes** | `?q, language, cursor, limit, userId` | `Page<Task>` |
| `POST /api/tasks` | `createTask` | owner | **yes** | `{name, language, template? ("single"; a template name or "custom"), description?}` — scaffolds the workspace | 201 `Task`; 409 `alreadyExists`; 400 `validationFailed` (unknown language/template, reserved name) |
| `GET /api/tasks/{task}` | `getTask` | owner | **yes** | – | `Task` (cached workspace status) |
| `DELETE /api/tasks/{task}` | `deleteTask` | owner | no | – | 202 `{job: JobRef}` (`taskDelete`: workspace folder, revisions, snapshots, task images, test runs); 409 `taskInUse` |
| `POST /api/tasks/upload` | `uploadTask` | owner | no | body `application/gzip` (tar.gz of a task folder); `?publish (true), force (false), message?, wait?` | 201 `{task: Task, revision: Revision\|null, created: boolean}`; 409 `workspaceDirty` (§5.3); 409 `alreadyExists` while the caller's task of that name is being deleted (retry when the deletion finished); 413 `payloadTooLarge`; 422 `manifestInvalid`, `invalidPath` |
| `GET /api/tasks/{task}/workspace` | `getTaskWorkspace` | owner | no | – | `{packSha256, fileCount, bytes, dirty, latestRevisionPackSha256, lastSyncSha256, checkedAt}` (computed fresh by helper `snapshot --hash-only`; also refreshes `tasks.workspace`) |
| `GET /api/tasks/{task}/workspace/archive` | `downloadTaskWorkspace` | owner | no | – | `application/gzip` (deterministic pack of the workspace) |

### 4.7 `task-files`

Paths are relative to the task folder, `/`-separated, without `..`, absolute paths, NUL or backslashes, and
not empty (422 `invalidPath`, also for a `writeTaskFiles` key); only `listTaskFiles` takes `""` for the task root.

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/tasks/{task}/files` | `listTaskFiles` | owner | **yes** | `?path ("" = root), recursive (true), revision?` (read a revision snapshot instead of the workspace) | `{entries: [{path, type: "file"\|"dir"\|"symlink", size, mode}], truncated}` (≤ 5000 entries) |
| `GET /api/tasks/{task}/files/content` | `readTaskFile` | owner | **yes** | `?path, revision?` | `{path, size, sha256, encoding: "utf8"\|"base64", content, truncated}` (content ≤ 1 MiB) |
| `PUT /api/tasks/{task}/files` | `writeTaskFiles` | owner | **yes** | `{files: {"<path>": "<utf-8 text>" \| {"base64": "<data>"}}}` (≤ 200 files) | `{written: string[], workspace: {packSha256, dirty}}` |
| `DELETE /api/tasks/{task}/files` | `deleteTaskFile` | owner | **yes** | `?path, recursive (false)` | `{deleted: string[], workspace: {packSha256, dirty}}` |

With `revision`, the S3 snapshot is streamed into a `list --archive` / `read --archive` workspace helper
(no volume mounted); it is never parsed in the orchestrator process ([editor](editor.md) §9.9).

### 4.8 `git`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `POST /api/tasks/import-git` | `importGitTask` | owner | no | `{url (https), ref? ("HEAD"), path? ("."), credentialId?, select?: string[]}` | 201 `{imported: Task[], candidates: [{path, name, language, exists}]}` when something was imported; 200 with `imported: []` when several manifests exist and `select` is missing; 400 `badRequest` when `select` names a path without a candidate or two selected folders share a task name; 409 `alreadyExists`; 413 `payloadTooLarge` (a folder over the task caps); 422 `gitFailed`, `invalidPath` (a symlink, special file or path-rule violation in the folder; `details.path`), `manifestInvalid` |
| `POST /api/tasks/{task}/git/pull` | `pullGitTask` | owner | no | `{force? (false)}` | `{task: Task, previousCommit, commit, changed}` (sets `source.git.{commit, packSha256, pulledAt}` and `workspace.lastSyncSha256`; never publishes); 409 `gitDiverged`; 409 `invalidState` (task not from git); 413 `payloadTooLarge`; 422 `gitFailed`, `invalidPath`, `manifestInvalid` |

### 4.9 `uploads`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `POST /api/uploads` | `createUpload` | owner | no | raw body (`text/plain` or `application/octet-stream`); `?name, kind ("list")` | 201 `Upload` (200 with the existing upload when the content hash already exists) |
| `GET /api/uploads` | `listUploads` | owner | no | `?cursor, limit` | `Page<Upload>` (`{id, kind, name, contentType, bytes, sha256, lines, lastUsedAt, createdAt}`) |
| `GET /api/uploads/{uploadId}` | `getUpload` | owner | no | – | `Upload` |
| `DELETE /api/uploads/{uploadId}` | `deleteUpload` | owner | no | – | 204; 409 `uploadInUse` |

### 4.10 `revisions`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/tasks/{task}/revisions` | `listRevisions` | owner | no | `?state, cursor, limit` (sorted by number desc) | `Page<RevisionSummary>` |
| `POST /api/tasks/{task}/revisions` | `publishRevision` | owner | **yes** | `{message?}`; `?wait` | 201 `Revision`. The request snapshots the workspace synchronously into S3 and only then inserts the revision `queued` with its pack hash; the `revisionBuild` job builds that stored snapshot, never the live workspace ([architecture](architecture.md) §11.1 step 6). A `queued`/`building`/`ready` revision with the same pack hash is returned instead of building again |
| `GET /api/tasks/{task}/revisions/{revision}` | `getRevision` | owner | **yes** | `?wait` | `Revision` |
| `GET /api/tasks/{task}/revisions/{revision}/logs` | `getRevisionBuildLog` | owner | no | `?afterLine (0), limit (1000, max 5000)` | `{lines: [{line, at, phase, type: "log"\|"error"\|"result", stream?, level?, text?, error?, result?}], nextLine, complete}`: one entry per task-pipeline event ([tasks](tasks.md) §9.8), `line` = event `seq` + 1; `stream` (`pipeline`\|`build`\|`stdout`\|`stderr`\|`check`), `level` (`info`\|`warning`, default `info`) and `text` only for `log`; `error` (BuildError) only for `error`; `result` (BuildResult) only for `result`, always the last line |
| `GET /api/tasks/{task}/revisions/{revision}/source` | `downloadRevisionSource` | owner | no | `?redirect (true)` | 302 to a presigned GET of the snapshot, or `{url, expiresAt}` |

### 4.11 `test-runs`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `POST /api/tasks/{task}/test-runs` | `testTask` | owner | **yes** | `{taskConfig?, scanConfig?, analysisConfig?, limit? (5, 1–50), maxAttempts? (1, 1–5), timeoutMs? (per analysis; default from the manifest)}`; `?wait`. The whole test run is bounded by `SCANTOR_TEST_RUN_TIMEOUT`. With `analysisConfig`, `run` is called once and `schedule` is skipped. | 201 `TestRun` |
| `GET /api/tasks/{task}/test-runs` | `listTestRuns` | owner | no | `?cursor, limit` | `Page<TestRun>` without `analyses` |
| `GET /api/test-runs/{testRunId}` | `getTestRun` | owner | **yes** | `?wait, analyses (true)` | `TestRun` |
| `GET /api/test-runs/{testRunId}/stream` | `streamTestRun` | owner | no | – | `text/event-stream` with events `state` `{state}`, `log` `{seq\|null, stream: "stdout"\|"stderr"\|"build", text, at}`, `analysis` `TestRunAnalysis`, `error` `BuildError`, `end` `TestRun` (without `analyses`) |
| `POST /api/test-runs/{testRunId}/cancel` | `cancelTestRun` (`x-destructive`) | owner | no | – | `TestRun` |
| `GET /api/test-runs/{testRunId}/files/{fileId}` | `getTestRunFileDownload` | owner | no | `?redirect (false)` | `FileDownload` or 302 |

### 4.12 `catalog` (languages, templates, scaffolds, guides)

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/languages` | `listLanguages` | owner | no | – | `{items: [{language, title, base, baseImage, entry, extensions}]}` (from `schemas/languages.json`) |
| `GET /api/templates` | `listTemplates` | owner | **yes** | – | `{items: [{name, title, description, scanConfigSchema, analysisConfigSchema, example: {scanConfig, analysisConfig}, resolves: boolean}]}` (from `schemas/templates/*.json`) |
| `GET /api/templates/{template}` | `getTemplate` | owner | no | – | one template |
| `POST /api/templates/{template}/estimate` | `estimateTemplate` | owner | no (`x-read-only`) | `{scanConfig}` | `{expectedTotal: int\|null, exact: boolean, confirmationRequired: boolean, tooLarge: boolean}`; 422 `configInvalid` with `details.issues` when the template schema or its semantic validation rejects the scan config (§5.1 step 9) |
| `GET /api/scaffolds` | `listScaffolds` | owner | no | – | `{items: [{language, templates: string[]}]}` (`templates` includes `"custom"`) |
| `GET /api/guides/authoring/{language}` | `getAuthoringGuide` | owner | **yes** | – | `text/markdown` (embedded `docs/guide/authoring-<language>.md`) |
| `GET /api/guides/{guide}` | `getGuide` | owner | no | – | `text/markdown` (`templates`, `manifest`, `errors-and-retries`, `cli`, `mcp`, `remote-nodes`) |

### 4.13 `scans`

`StartScan` body:

| Field | Type | Meaning |
|---|---|---|
| `revision` | revision reference | required (§1.4) |
| `name` | string ≤ 100 | optional label |
| `taskConfig`, `scanConfig` | object | validated with defaults against the revision schemas (422 `configInvalid`) |
| `settings` | partial `ScanSettings` without `privileged` | merged over the revision's `settingsDefaults` |
| `confirm` | boolean | required `true` when the estimate exceeds `SCANTOR_SCAN_CONFIRM_THRESHOLD` |

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/scans` | `listScans` | owner | **yes** | `?state (list), task, cursor, limit, userId` (excludes `deleting`/`deleted` unless `state` names them) | `Page<ScanSummary>` |
| `POST /api/scans` | `startScan` | owner | **yes** | `StartScan` | 201 `Scan` (`creating`); 404 revision; 409 `revisionNotReady`; 403 `privilegedNotAllowed`; 422 `configInvalid`, `confirmationRequired`, `scanTooLarge`; 503 `brokerAlarm` |
| `GET /api/scans/{scanId}` | `getScan` | owner | **yes** | `?wait` | `Scan` (tombstones are returned with `state: "deleted"` until purged) |
| `POST /api/scans/{scanId}/pause` | `pauseScan` | owner | **yes** | – | `Scan`; 409 `invalidState` |
| `POST /api/scans/{scanId}/resume` | `resumeScan` | owner | **yes** | – | `Scan`; 403 `privilegedNotAllowed`; 409 `invalidState`, `revisionUnavailable` |
| `POST /api/scans/{scanId}/scale` | `scaleScan` | owner | **yes** | `{workers?, processes?}` (at least one) | `Scan`; 409 `invalidState` (allowed in `creating`, `running`, `paused`) |
| `POST /api/scans/{scanId}/cancel` | `cancelScan` (`x-destructive`) | owner | **yes** | – | `Scan` (`cancelled`); 409 `invalidState` |
| `POST /api/scans/{scanId}/retry-failed` | `retryFailedAnalyses` | owner | **yes** | – | 202 `{scan: Scan, job: JobRef}`: re-runs every `failed` or `lost` analysis that has a stored config in round R+1 (never `cancelled` ones; allowed in `running`, `completed`, `failed`, `cancelled` once `scheduling.state` is `done` or `failed` and no retry job is active, [architecture](architecture.md) §11.3); 403 `privilegedNotAllowed`; 409 `invalidState`, `nothingToRetry`, `revisionUnavailable` |
| `POST /api/scans/{scanId}/restart` | `restartScan` | owner | **yes** | `{name?, settings?: {workers?, processes?}}` | 201 `Scan` (the new clone); 403 `privilegedNotAllowed`; 409 `revisionUnavailable`, `invalidState` (`deleting`/`deleted`) |
| `DELETE /api/scans/{scanId}` | `deleteScan` | owner | **yes** | – | 202 `{scan: Scan, job: JobRef}`; 409 `invalidState` (not terminal) |
| `GET /api/scans/{scanId}/inflight` | `listInflightAnalyses` | owner | no | – | `{items: [{analysisId, seq, round, attempt, startedAt, workerId, nodeId, progress}], updatedAt}` (in-memory from state polls) |
| `GET /api/scans/{scanId}/conditions` | `listScanConditions` | owner | no | – | `{items: Condition[]}` |
| `GET /api/scans/{scanId}/events` | `listScanEvents` | owner | no | `?type, cursor, limit` | `Page<Event>` |
| `GET /api/scans/{scanId}/workers` | `listScanWorkers` | owner | no | `?state (list), cursor, limit` | `Page<Worker>` |
| `GET /api/scans/{scanId}/workers/{workerId}/logs` | `getWorkerLogs` | owner | no | `?wait (≤ 30), tailBytes (65536, max 262144)` — requests a fresh tail from the node | `{text, collectedAt, requestedAt, pending, truncated}` |

### 4.14 `analyses`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/scans/{scanId}/analyses` | `listAnalyses` | owner | no | `?status (list), afterSeq, limit (50, max 1000), fields (list of dot paths)` | `Page<Analysis>` sorted by `seq` |
| `GET /api/analyses/{analysisId}` | `getAnalysis` | owner | **yes** | – | `Analysis` |
| `POST /api/scans/{scanId}/analyses/query` | `queryAnalyses` | owner | **yes** (`x-read-only`) | `{filter: object, projection?: object, sort?: object, limit? (20, max 1000), afterSeq?: int}` | `{items: object[], nextCursor}` (`nextCursor` null when `sort` is given) |
| `POST /api/scans/{scanId}/analyses/aggregate` | `aggregateAnalyses` | owner | **yes** (`x-read-only`) | `{pipeline: object[], limit? (≤ SCANTOR_QUERY_MAX_DOCS)}` | `{items: object[], truncated: boolean}` |

Query rules are in §5.2.

### 4.15 `exports` and `files`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/scans/{scanId}/export` | `exportScanInline` | owner | no | `?format (jsonl\|csv), status, filter (URL-encoded JSON), fields, afterSeq` | streamed `application/x-ndjson` or `text/csv` sorted by seq; 409 `exportTooLarge` |
| `POST /api/scans/{scanId}/exports` | `exportScan` | owner | **yes** | `{format: "jsonl"\|"csv", filter?, fields?, afterSeq?}`; `?wait` | 201 `Export` (`download` set when `ready`) |
| `GET /api/exports` | `listExports` | owner | no | `?scanId, cursor, limit` | `Page<Export>` |
| `GET /api/exports/{exportId}` | `getExport` | owner | **yes** | `?wait` | `Export` |
| `DELETE /api/exports/{exportId}` | `deleteExport` | owner | no | – | 204 |
| `GET /api/analyses/{analysisId}/files/{fileId}` | `getFileDownload` | owner | no | `?redirect (false)` | `FileDownload` or 302 |

Exports: JSONL rows are whole analysis documents (or the `fields` projection), masked. CSV columns are
`fields` (default `id, seq, status, attempt, round, error.type, error.message, timings.durationMs, config,
result`); nested values are JSON-encoded; any cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed
with `'`. Download URLs are presigned GETs of `SCANTOR_S3_PUBLIC_URL` valid for 10 minutes with
`Content-Disposition: attachment`. File downloads follow [architecture](architecture.md) §11.5.

### 4.16 `jobs`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/jobs` | `listJobs` | owner | no | `?kind, state, cursor, limit, userId` | `Page<Job>` (`{id, kind, subject, state, progress, attempts, error, createdAt, startedAt, finishedAt}`) |
| `GET /api/jobs/{jobId}` | `getJob` | owner | no | `?wait` | `Job` |

### 4.17 `nodes` (admin)

All operations: scope admin, `x-admin-only: true`.

| Operation | operationId | MCP | Request | Response |
|---|---|---|---|---|
| `GET /api/nodes` | `listNodes` | **yes** | `?state, pool` | `{items: Node[]}` |
| `POST /api/nodes` | `createNode` | no | `{name, pool? ("shared"), labels?, maxWorkers?}` | 201 `{node: Node, token: "snt_…", join: NodeJoin}`; 409 `alreadyExists`; 400 `validationFailed` for the name `builtin` (reserved for the built-in node) |
| `GET /api/nodes/{nodeId}` | `getNode` | no | – | `Node` |
| `PATCH /api/nodes/{nodeId}` | `updateNode` | no | `{name?, pool?, labels?, maxWorkers?: int\|null, cordoned?}` | `Node`; 409 `alreadyExists` (name taken); 409 `builtInNode` when renaming the built-in node; 400 `validationFailed` for the reserved name `builtin` |
| `DELETE /api/nodes/{nodeId}` | `deleteNode` | no | – | 204 (workers become `lost`); 409 `builtInNode` |
| `POST /api/nodes/{nodeId}/token` | `rotateNodeToken` (`x-destructive`) | no | – | `{node, token, join}`; 409 `builtInNode` |
| `DELETE /api/nodes/{nodeId}/token` | `revokeNodeToken` | no | – | `Node` (`revoked`); 409 `builtInNode` |
| `GET /api/nodes/{nodeId}/join` | `getNodeJoin` | no | – | `NodeJoin` with the token replaced by `${SCANTOR_NODE_TOKEN}` |
| `GET /api/nodes/{nodeId}/workers` | `listNodeWorkers` | no | `?state (list), cursor, limit` | `Page<Worker>` (with `scan {id, name}`) of workers whose `nodeId` is this node; index `{nodeId: 1, state: 1}` |
| `GET /api/nodes/{nodeId}/events` | `listNodeEvents` | no | `?type, cursor, limit` | `Page<Event>` with this `nodeId`, newest first; index `{nodeId: 1, at: -1}` |

`NodeJoin`: `{dockerRun: string, compose: string, env: {SCANTOR_URL, SCANTOR_NODE_TOKEN}}` where
`dockerRun` is `docker run -d --name scantor-node --restart unless-stopped -v
/var/run/docker.sock:/var/run/docker.sock -e SCANTOR_URL=<SCANTOR_PUBLIC_URL> -e SCANTOR_NODE_TOKEN=<token>
<SCANTOR_IMAGE_PREFIX>scantor:<image tag> node` (one line; image tag rule as for `cliImage`, §4.1; exact
strings in [nodes](nodes.md) §4).

### 4.18 `metrics`, `editor`, `tools`

| Operation | operationId | Scope | MCP | Request | Response |
|---|---|---|---|---|---|
| `GET /api/metrics` | `getMetrics` | admin | no | – | `text/plain; version=0.0.4` (Prometheus) |
| `POST /api/editor/session` | `createEditorSession` | owner (session or `default` API key) | no | `{open?: string}`: a task name (validated slug of a task owned by the caller) that selects the folder to open; absent = the workspace root | 201 `{url: "<SCANTOR_EDITOR_URL>/_auth?code=sec_…", expiresAt (60 s), editor: {state: "starting"\|"running", startedAt, lastActivityAt}}`; starts the editor in the background if needed (the response does not wait for readiness); 403 `forbidden` for the `editor` API key; 404 unknown task; 409 `invalidState` when the editor is still `stopping` after the request waited up to 15 s; 429 `tooManyRequests` (`details.limit`) when `SCANTOR_EDITOR_MAX_RUNNING` editors are starting or running |
| `GET /api/editor` | `getEditor` | owner | no | – | `{state, startedAt, lastActivityAt, idleTimeoutMs, error: string \| null}`; `error` is `editors.error`, the message of the last failed start (cleared when a new start begins, [data model](data-model.md) §4.15) |
| `DELETE /api/editor` | `stopEditor` | owner | no | – | 204 (container removed, editor API key deleted) |
| `GET /api/tools/session` | `createToolsSession` | admin (`x-session-only`) | no | `?target=rabbitmq\|mongo-express\|rustfs\|traefik` | 302 to the tool URL with `Set-Cookie: scantor_tools=…; Domain=<SCANTOR_DOMAIN>; Path=/; Secure; HttpOnly; SameSite=Lax` (8 h); 404 `notFound` when `SCANTOR_DOMAIN` is empty (no Traefik) |
| `GET /api/tools/forward-auth` | `toolsForwardAuth` | tools | no | Traefik forwardAuth headers (`X-Forwarded-Host`, `X-Forwarded-Uri`, `X-Forwarded-Method`) and the client's `Accept` | 200 with `X-Scantor-User: <userId>`. When `X-Forwarded-Host` is not one of the tool hosts `traefik.`, `rabbitmq.`, `mongo-express.`, `rustfs.<SCANTOR_DOMAIN>`: always 401 with a short `text/plain` body. When the cookie is missing, invalid, expired or not an admin's: a browser request (`Accept` contains `text/html`) gets 302 to `<SCANTOR_PUBLIC_URL>/api/tools/session?target=<target of X-Forwarded-Host>`, which mints a fresh cookie for admins; any other request gets 401 with a short `text/plain` body ([auth](auth.md) §11); this route never uses the §1.7 envelope |

## 5. Behaviour of selected user routes

### 5.1 Scan start validation order

1. Body schema (400) → 2. revision reference resolves among the caller's revisions (404) → 3. revision
`ready` (409 `revisionNotReady`) → 4. privileged check (403) → 5. broker alarm (503) → 6. configs with ajv
`useDefaults` against `description.schemas` (422 `configInvalid`) → 7. settings within bounds (400
`validationFailed`; the per-user worker cap is enforced by placement, not here) → 8. upload references exist and are owned (404)
→ 9. estimate (template schedules only) → 10. insert scan `creating`, event `scan.created` → 201.

Step 9 runs `scantor templates estimate <name> --config - [--upload <id>=<lines>]…` as a subprocess (no
network; the effective scan config on stdin, one `--upload` per referenced upload with its line count). Exit
0 prints `{expectedTotal, exact}`; exit 2 prints `{issues: [{path, message}]}` for semantic template
validation that JSON Schema cannot express (for example `cidr` `/maxAnalyses`, `range` `/step`, the
`tranco` `/limit` window), which becomes 422 `configInvalid` with `details.issues` (JSON pointers). Then
`scanTooLarge` (estimate above `SCANTOR_MAX_ANALYSES_PER_SCAN`) and `confirmationRequired` (above
`SCANTOR_SCAN_CONFIRM_THRESHOLD` without `confirm: true`), both 422. `estimateTemplate` runs the same
command and returns the same 422 ([templates](templates.md) §2).

### 5.2 Query and aggregation rules

- Filters are always combined as `{$and: [{scanId}, {userId: <scan owner>}, <user filter>]}`; pipelines
  always start with that `$match`. Never object spread.
- Allowed aggregation stages (recursively, including inside `$facet`): `$match`, `$project`, `$addFields`,
  `$set`, `$unset`, `$group`, `$sort`, `$limit`, `$skip`, `$count`, `$unwind`, `$bucket`, `$bucketAuto`,
  `$sortByCount`, `$facet`, `$replaceRoot`, `$replaceWith`, `$sample` (size ≤ 10 000).
- Rejected anywhere (keys at any depth in filter, projection, sort or pipeline): `$where`, `$function`,
  `$accumulator`, `$lookup`, `$graphLookup`, `$unionWith`, `$out`, `$merge`, `$documents`, `$collStats`,
  `$indexStats`, `$currentOp`, `$listSessions`, `$planCacheStats`, `$changeStream`, `$search`,
  `$vectorSearch` → 400 `queryRejected` with `details.path`. A `$facet` inside a `$facet` sub-pipeline is
  rejected (as MongoDB itself refuses it); nesting depth and sort keys are bounded.
- Secret paths: pipelines, and also filters, sorts and projection expressions, that reference a
  `writeOnly` path of the scan are rejected (400 `queryRejected`), so a filter cannot work as an oracle;
  plain projections of secret paths are allowed and their values masked.
- Execution on the `scantor_query` client (role `read` on the app database), `maxTimeMS` =
  `SCANTOR_QUERY_MAX_TIME` (a duration; 504 `queryTimeout`), `allowDiskUse: false`, a final `$limit` of
  `SCANTOR_QUERY_MAX_DOCS`, a streamed byte cap, and at most `SCANTOR_USER_MAX_CONCURRENT_QUERIES`
  concurrent queries/exports per user (429). MongoDB runs with `--noscripting`.

### 5.3 Task upload and workspace conflicts

The current workspace pack hash is computed by a helper before the decision ([tasks](tasks.md) §13):

| Operation | No conflict when | Otherwise |
|---|---|---|
| `uploadTask` | the task or its workspace folder does not exist; or the workspace hash equals the uploaded hash (nothing changes), `latestRevision.packSha256` (any revision state: the content is published and its snapshot stored) or `tasks.workspace.lastSyncSha256` (unchanged since the last upload, git import or pull) | 409 `workspaceDirty` unless `force=true` |
| `pullGitTask` | the workspace hash equals `source.git.packSha256` and the remote is a fast-forward of `source.git.commit` | 409 `gitDiverged` unless `force=true` |

After a successful upload the folder is replaced atomically by helper `commit`, which re-checks the
expected current hash so a concurrent edit still fails, and `workspace.lastSyncSha256` becomes the uploaded
hash. Git import and pull set it too; editor and file-route writes never do. Repeated `scantor push
--no-publish` / `scantor dev run --remote` cycles from the same folder therefore never conflict.

## 6. Registry token (`/api/registry/token`)

Registry configuration: realm `${SCANTOR_PUBLIC_URL}/api/registry/token`, service `scantor-registry`, issuer
`scantor`. The realm is called by Docker daemons (host network namespace of each node, including the
master), never by containers, so it must be reachable from every daemon. Tokens are ES256 JWTs (header `{"alg": "ES256", "typ": "JWT", "kid": "<jwks kid>"}`), valid 300 s.
Granted access is the intersection of requested and allowed actions:

| Credential (Basic) | Allowed |
|---|---|
| `node:<snt_ token>` | `pull` on `tasks/<taskId>` for every task of a worker currently assigned to that node (states `assigned` … `draining`); nothing else |
| `orchestrator:<HKDF "registry-push">` | `pull`, `push`, `delete` on `tasks/*` (the `taskDelete` job deletes manifests through the registry API, which requires `delete`); `registry:catalog:*` |
| invalid / revoked | 401 |

The two flows are the operations `getRegistryToken` (GET) and `createRegistryToken` (POST), tag `node`,
MCP no. Errors use the registry format `{"errors": [{"code": "UNAUTHORIZED", "message": "…"}]}`, never the
§1.7 envelope: 401 `UNAUTHORIZED` for an invalid or revoked credential; 400 `DENIED` for an unknown
`service`, `UNSUPPORTED` for a `grant_type` other than `password`, `SIZE_INVALID` for a POST form over
64 KiB. A scope that is not allowed is not an error: the token simply omits it and the registry answers
`insufficient_scope`.

GET flow (docker login, Engine API `/auth`, legacy pulls):

```http
GET /api/registry/token?service=scantor-registry&scope=repository:tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:pull&account=node&client_id=docker&offline_token=true HTTP/1.1
Host: scantor.example.com
Authorization: Basic bm9kZTpzbnRfM3E4Wm…
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InNjYW50b3ItOWYxYzJlNGE3YjNkNWU2ZiJ9.eyJ…",
  "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InNjYW50b3ItOWYxYzJlNGE3YjNkNWU2ZiJ9.eyJ…",
  "expires_in": 300,
  "issued_at": "2026-10-21T10:00:00Z"
}
```

POST flow (containerd, Docker 29 image store):

```http
POST /api/registry/token HTTP/1.1
Host: scantor.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=password&service=scantor-registry&client_id=containerd-client&username=node&password=snt_3q8Zk…&scope=repository%3Atasks%2F7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c%3Apull
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "access_token": "eyJhbGciOiJFUzI1NiIs…", "expires_in": 300, "issued_at": "2026-10-21T10:00:00Z" }
```

JWT claims (node pulling one repository):

```json
{
  "iss": "scantor",
  "sub": "node:2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "aud": "scantor-registry",
  "iat": 1761040800,
  "nbf": 1761040790,
  "exp": 1761041100,
  "jti": "8c1f6d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
  "access": [ { "type": "repository", "name": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "actions": ["pull"] } ]
}
```

A login request without `scope` gets a token with `"access": []`. `sub` is `orchestrator` for the push
credential. No `refresh_token` is issued.

## 7. Node API (`/api/node/*`, tag `node`, scope node, MCP no)

Every request carries `Authorization: Bearer snt_…`, `User-Agent: scantor-node/<version>`,
`X-Scantor-Version: <version>` and (after hello) `X-Scantor-Instance-Id: <instanceId>`. Responses carry
`serverTime` (epoch ms); the daemon keeps `clockOffsetMs = serverTime + rtt/2 − localNow`.
Error responses use the §1.7 envelope.

| Operation | operationId | Purpose |
|---|---|---|
| `POST /api/node/hello` | `nodeHello` | register the instance, report info, receive node identity and intervals |
| `GET /api/node/assignments` | `getNodeAssignments` | long-poll the desired worker set |
| `POST /api/node/status` | `postNodeStatus` | heartbeat + actual container state every 10 s |
| `POST /api/node/workers/{workerId}/logs` | `postWorkerLogs` | answer an on-demand log request |

### 7.1 `POST /api/node/hello`

```http
POST /api/node/hello HTTP/1.1
Host: scantor.example.com
Authorization: Bearer snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9
User-Agent: scantor-node/1.4.0
X-Scantor-Version: 1.4.0
Content-Type: application/json
```

```json
{
  "instanceId": "4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e",
  "version": "1.4.0",
  "info": {
    "hostname": "scan-eu-1",
    "os": "linux",
    "arch": "amd64",
    "kernel": "6.8.0-48-generic",
    "dockerVersion": "29.9.2",
    "cpus": 16,
    "memoryBytes": 68719476736,
    "diskFreeBytes": 412316860416,
    "dindMode": "disabled",
    "maxWorkers": 8,
    "egressDenyApplied": true
  },
  "containers": [
    { "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "containerId": "f1e2d3c4b5a6", "state": "running", "specHash": "sha256:5d41…" }
  ]
}
```

`instanceId` = Docker engine ID + ":" + a random nonce generated at daemon start. `containers` lists the
managed containers found at start (for adoption).

```json
{
  "serverTime": 1761040800123,
  "node": {
    "id": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
    "name": "scan-eu-1",
    "builtIn": false,
    "endpointProfile": "public",
    "pool": "shared",
    "labels": { "region": "eu" }
  },
  "config": {
    "statusIntervalMs": 10000,
    "assignmentsWaitSeconds": 25,
    "offlineAfterMs": 60000,
    "drainGraceMs": 30000,
    "registry": { "host": "registry.example.com", "username": "node" },
    "minFreeDiskBytes": 10737418240
  }
}
```

`config.minFreeDiskBytes` comes from `SCANTOR_NODE_MIN_FREE_DISK`: placement excludes nodes below it
(`diskLow`) and the daemon runs an emergency image GC when its free disk drops below it
([nodes](nodes.md) §8).

Errors: 401 `unauthorized` (unknown or revoked token), 409 `nodeInstanceConflict` (a live lease of a
**different** Docker engine; `details.retryAfterMs`; a hello whose `instanceId` has the same engine ID as
the lease holder takes the lease over at once, [nodes](nodes.md) §5.2), 426 `incompatibleVersion`. Effects: node `online`, `instance` and `info`
stored, `lastSeenAt` updated, event `node.online`.

### 7.2 `GET /api/node/assignments`

```http
GET /api/node/assignments?rev=41&wait=25 HTTP/1.1
Host: scantor.example.com
Authorization: Bearer snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9
X-Scantor-Instance-Id: 4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e
X-Scantor-Version: 1.4.0
```

Returns immediately when `nodes.assignmentsRev > rev`, otherwise after `wait` seconds (≤ 60) with the
current set. The response always contains the complete desired set; any managed container not listed must
be stopped (grace `drainGraceMs` + 5 s) and removed.

```json
{
  "serverTime": 1761040812456,
  "rev": 42,
  "workers": [
    {
      "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
      "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
      "role": "runner",
      "specHash": "sha256:5d41402abc4b2a76b9719d911017c592",
      "image": "registry.example.com/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c@sha256:4e5f6a7b…",
      "baseImage": "ghcr.io/lonetis/scantor-base-js@sha256:0d1e2f3a…",
      "processes": 2,
      "resources": { "nanoCpus": 2000000000, "memoryBytes": 1342177280 },
      "privileged": false,
      "dindMode": null,
      "capAdd": ["NET_BIND_SERVICE", "NET_RAW"],
      "env": {
        "SCANTOR_URL": "https://scantor.example.com",
        "SCANTOR_WORKER_TOKEN": "swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o"
      }
    }
  ],
  "logRequests": [
    { "requestId": "61c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b", "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "tailBytes": 65536 }
  ]
}
```

- `resources.memoryBytes = processes × memoryMiB × 1048576 + 268435456`; `nanoCpus = processes × cpus ×
  10^9`. `processes` is `workers.processes.assigned` (the higher of desired and running while scaling
  down, [architecture](architecture.md) §11.3).
- `specHash` covers image, privileged/DinD mode and capabilities; a change means recreate. A change of only
  `processes`/`resources` is applied live with `ContainerUpdate`.
- `baseImage` is null when the base image is not pullable from a registry (dev builds); pulling it is only
  an optimisation.
- The daemon adds its own managed labels, network (`scantor-sandbox` on the built-in node,
  `scantor-workers` otherwise), hardening, `SCANTOR_CA_CERT` / `SCANTOR_ALLOW_INSECURE_TRANSPORT`
  passthrough, and `SCANTOR_DIND=1` in workers whose `dindMode` is not null (privileged revisions on
  `sysbox`/`privileged` nodes), so the runtime starts the inner `dockerd` ([nodes](nodes.md) §6.9,
  [runtime](runtime.md) §4.4). The assignment `env` never contains it: it holds only `SCANTOR_URL` and
  `SCANTOR_WORKER_TOKEN` ([nodes](nodes.md) §6.10).

### 7.3 `POST /api/node/status`

```json
{
  "instanceId": "4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e",
  "appliedRev": 42,
  "clockOffsetMs": -8,
  "info": {
    "version": "1.4.0",
    "cpus": 16,
    "memoryBytes": 68719476736,
    "diskFreeBytes": 409600000000,
    "dindMode": "disabled",
    "maxWorkers": 8,
    "egressDenyApplied": true
  },
  "workers": [
    {
      "workerId": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "state": "running",
      "containerId": "f1e2d3c4b5a6",
      "startedAt": "2026-10-21T10:00:20.000Z",
      "restarts": 0,
      "applied": { "processes": 2, "nanoCpus": 2000000000, "memoryBytes": 1342177280 }
    },
    {
      "workerId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "state": "backoff",
      "containerId": "a9b8c7d6e5f4",
      "restarts": 3,
      "lastExit": { "exitCode": 137, "oomKilled": true, "at": "2026-10-21T10:04:58.000Z", "logTail": "…last 4 KiB of container output…" },
      "nextRestartAt": "2026-10-21T10:05:38.000Z"
    },
    {
      "workerId": "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
      "state": "pulling",
      "pull": { "image": "registry.example.com/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c@sha256:4e5f6a7b…", "startedAt": "2026-10-21T10:05:01.000Z" }
    },
    {
      "workerId": "2d3e4f5a-6b7c-4d8e-8f9a-0b1c2d3e4f5a",
      "state": "error",
      "error": { "code": "imagePullFailed", "message": "manifest unknown" }
    },
    {
      "workerId": "3e4f5a6b-7c8d-4e9f-9a0b-1c2d3e4f5a6b",
      "state": "removed"
    }
  ]
}
```

Reported worker states: `pulling`, `starting`, `running`, `backoff`, `stopping`, `removed`, `error`
(`error.code`: `imagePullFailed`, `createFailed`, `platformMismatch`). `workers` is a **complete
snapshot**: every worker in the daemon's desired set plus every managed worker container that still exists.
A removed worker is repeated as `removed` in three consecutive reports; a `draining` worker that is absent
from two consecutive reports is treated as `stopped`. A node may only report workers assigned to it; other
entries are ignored and logged. `logTail` ≤ 4 KiB. Worker events (crash with exit code, OOM kill, pull or
create failure) travel inside these entries; the orchestrator derives `worker.*` events and scan conditions
from changes between reports: a new `lastExit.at` with `exitCode ≠ 0` or `oomKilled` raises
`worker.crashed` and `crashLoop`; exit code 0 never does.

```json
{ "serverTime": 1761040815002, "rev": 43, "nextStatusMs": 10000 }
```

`nextStatusMs` is the daemon's next report interval ([nodes](nodes.md) §7.1).

Effects: `lastSeenAt`, `info`, worker states and `processes.applied` updated ([data model](data-model.md)
§6.6), crash events and conditions raised. A `rev` greater than `appliedRev` tells the daemon to poll
assignments now. 409 `nodeInstanceConflict` when the instance id is not the lease holder.

### 7.4 `POST /api/node/workers/{workerId}/logs`

```json
{
  "requestId": "61c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
  "text": "{\"level\":\"info\",\"msg\":\"consuming\",\"scanId\":\"5e1f…\"}\n…",
  "bytes": 65536,
  "truncated": true,
  "collectedAt": "2026-10-21T10:06:00.000Z"
}
```

Response 204. 404 when the worker is not assigned to this node or the request id is unknown.

## 8. Runtime API (`/api/runtime/*`, tag `runtime`, scope worker, MCP no)

Every request carries `Authorization: Bearer swt_<workerId>.<mac>`, `User-Agent: scantor-runtime/<version>`
and `X-Scantor-Version`. Identity (scan, worker, role, node) comes only from the token. A token of a worker
in a terminal state is 401: the runtime treats 401 like `action: "stop"`. Scheduler-only routes reject
runners with 403 `forbidden`.

| Operation | operationId | Role | Purpose |
|---|---|---|---|
| `GET /api/runtime/bootstrap` | `runtimeBootstrap` | any | configuration and credentials |
| `POST /api/runtime/state` | `runtimeState` | any | heartbeat with `busy[]`; desired action and processes |
| `POST /api/runtime/uploads/presign` | `runtimePresignUploads` | runner | presigned PUT URLs for files |
| `POST /api/runtime/analyses/status` | `runtimeAnalysesStatus` | runner | status of redelivered analyses |
| `POST /api/runtime/scheduler/resolved` | `schedulerResolved` | scheduler | record a template resolution |
| `POST /api/runtime/scheduler/checkpoint` | `schedulerCheckpoint` | scheduler | store the contiguous confirmed prefix |
| `POST /api/runtime/scheduler/done` | `schedulerDone` | scheduler | report the end of scheduling |
| `POST /api/runtime/errors` | `runtimeReportError` | any | report a worker-level error |

### 8.1 `GET /api/runtime/bootstrap`

```http
GET /api/runtime/bootstrap HTTP/1.1
Host: orchestrator:3000
Authorization: Bearer swt_7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f.Qm9vZ2xlU2NoZWR1bGVyVG9rZW5NYWNWYWx1ZTEyMwA
User-Agent: scantor-runtime/1.4.0
X-Scantor-Version: 1.4.0
```

Scheduler response:

```json
{
  "serverTime": 1761040805123,
  "action": "run",
  "worker": {
    "id": "7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f",
    "role": "scheduler",
    "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "nodeId": "8e7f6a5b-4c3d-4b2a-9f1e-0d9c8b7a6f5e",
    "epoch": 1
  },
  "scan": {
    "id": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "state": "running",
    "round": 1,
    "taskConfig": { "expectedStatus": 200, "apiKey": "real-secret-value" },
    "scanConfig": { "list": "latest", "subdomains": false, "offset": 0, "limit": 100000 },
    "settings": {
      "processes": 1,
      "timeoutMs": 300000,
      "maxAttempts": 3,
      "backoff": { "initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true },
      "resources": { "cpus": 1, "memoryMiB": 512 },
      "maxAnalysesPerProcess": 1000
    }
  },
  "revision": {
    "id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    "number": 3,
    "entry": "main.ts",
    "protocolVersion": 1,
    "schedule": { "kind": "template", "template": "tranco" }
  },
  "amqp": {
    "url": "amqp://rabbitmq:5672",
    "vhost": "scantor",
    "username": "scan-5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "password": "pW3n9Xq0vK2mB7cR5tY8uZ1aS4dF6gH",
    "queue": "scantor.scan.5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "analysesExchange": "scantor.analyses",
    "resultsExchange": "scantor.results",
    "routingKey": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "heartbeatSeconds": 30,
    "consumerTimeoutMs": 1500000
  },
  "uploads": { "mode": "presigned", "maxFileBytes": 1073741824, "maxFilesPerAnalysis": 100, "timeoutMs": 900000 },
  "limits": {
    "maxAnalysisConfigBytes": 65536,
    "maxResultBytes": 1048576,
    "maxResultMessageBytes": 2097152,
    "logTailBytes": 32768,
    "logTailEarlierBytes": 4096,
    "stackBytes": 16384,
    "maxAnalysesPerScan": 20000000,
    "maxProcessesPerWorker": 64,
    "minFreeTmpBytes": 1073741824
  },
  "intervals": {
    "statePollMs": 5000,
    "statePollJitter": 0.2,
    "checkpointMs": 5000,
    "checkpointItems": 1000,
    "drainGraceMs": 30000,
    "backpressureWaitMs": 2000
  },
  "scheduler": {
    "restarts": 0,
    "checkpoint": { "confirmed": 0, "tailHash": null },
    "resolved": {},
    "uploads": {},
    "dataSources": {
      "tranco": "https://tranco-list.eu",
      "crux": "https://raw.githubusercontent.com/zakird/crux-top-lists/main"
    }
  }
}
```

Runner differences: `worker.role` is `runner`, `worker.epoch` 0, `scan.scanConfig` is absent,
`scan.settings.processes` is the worker's current allowed processes, `scheduler` is `null`. For the
scheduler, `scan.settings.processes` is always 1: it runs at most one connector process
([data model](data-model.md) §4.7).

| Field | Meaning |
|---|---|
| `revision.entry` | the revision's normalised manifest `entry` (the manifest value, or the language default from `schemas/languages.json`, for example `"main.py"` or `"/task/task"`); the runtime substitutes it for `{entry}` in `SCANTOR_CONNECTOR_CMD` and never reads `/task/scantor.yaml` |
| `amqp.consumerTimeoutMs` | the `x-consumer-timeout` the scan queue was declared with (`settings.timeoutMs + SCANTOR_UPLOAD_TIMEOUT + 300000`), so the runtime computes its holding budget without duplicating the formula ([runtime](runtime.md) §8.10) |
| `limits.maxProcessesPerWorker` | `SCANTOR_MAX_PROCESSES_PER_WORKER`; the runtime clamps `processes` to it |
| `limits.minFreeTmpBytes` | `SCANTOR_WORKER_MIN_FREE_TMP_BYTES`; below this free space under `/tmp/scantor` the runtime stops consuming and reports itself unhealthy |
| `uploads.timeoutMs` | `SCANTOR_UPLOAD_TIMEOUT` (presigned URL expiry and PUT timeout) |
| `scheduler.restarts` | integer, the scan's current `scheduling.restarts`; the runtime sets the `schedule` ctx `attempt` to `restarts + 1`, plus 1 for every in-process restart ([runtime](runtime.md) §11.1, [protocol](protocol.md) §5.1) |

`scheduler.uploads` maps every upload id referenced by the effective configs to
`{url (presigned GET, 1 h), sha256, bytes, expiresAt}`. `scheduler.resolved` contains stored resolutions
by key; on resume the runtime must use them instead of resolving again. `amqp.url` and the S3 endpoint of
later presigned URLs follow the node's endpoint profile ([architecture](architecture.md) §8).
`scheduler.dataSources` come from `SCANTOR_TRANCO_URL` and `SCANTOR_CRUX_URL`.

Effects: first bootstrap of a worker → `running`, `runtime.version`/`bootstrappedAt` recorded; first
scheduler bootstrap → `scheduling.state: running`. `action` is `stop` when the scan is no longer
`running` (the runtime exits 0 without connecting).

### 8.2 `POST /api/runtime/state`

Runner request:

```json
{
  "processes": { "running": 2, "busy": 1 },
  "busy": [
    { "seq": 1234, "round": 1, "attempt": 2, "executionId": "b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e", "startedAt": "2026-10-21T10:01:36.000Z", "progress": null }
  ],
  "consuming": true,
  "clockOffsetMs": -12,
  "tmpFreeBytes": 9663676416,
  "counters": { "succeeded": 512, "failed": 3, "retried": 7, "redeliveredSkipped": 1 },
  "scheduler": null
}
```

Scheduler request: `"processes": {"running": 1, "busy": 1}`, `"busy": []`, and
`"scheduler": {"published": 42100, "confirmed": 42000, "nacked": 0, "backpressure": false}`.

```json
{
  "serverTime": 1761041100123,
  "action": "run",
  "processes": 2,
  "scanState": "running",
  "nextPollMs": 5000
}
```

| `action` | Runtime behaviour |
|---|---|
| `run` | keep (or start) consuming with `processes` slots |
| `drain` | cancel consumers, finish in-flight analyses within `drainGraceMs`, nack the rest with requeue, exit 0 (scale-in, pause, scheduling finished) |
| `stop` | cancel consumers, abort in-flight work, exit 0 (scan cancelled or terminal, worker lost) |

`processes` = min(desired, node-applied) while scaling up, desired immediately while scaling down. The
`busy` list feeds `listInflightAnalyses`; it is never written to MongoDB. Effects: `runtime.lastSeenAt`,
`processes.running` updated.

### 8.3 `POST /api/runtime/uploads/presign`

```json
{
  "seq": 1234,
  "round": 1,
  "attempt": 2,
  "executionId": "b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e",
  "files": [
    { "fileId": "e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a", "name": "screenshot.png", "size": 48213, "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "contentType": "image/png" }
  ]
}
```

The runtime calls presign once per successful execution, after `run` returned, with every file the
connector registered. Each `files[]` item carries a required `fileId` (uuid v4) that the runtime generated
when the connector registered the file, because `ctx.files.put` must return the final FileRef during
`run` ([runtime](runtime.md) §8.4).

```json
{
  "files": [
    {
      "fileId": "e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a",
      "name": "screenshot.png",
      "url": "http://rustfs:9000/scantor/files/5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f/1234/b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e/e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a/screenshot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=…&X-Amz-Date=20261021T100137Z&X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-meta-file-id%3Bx-amz-meta-name&X-Amz-Signature=…",
      "method": "PUT",
      "headers": { "Content-Type": "image/png", "Content-Length": "48213", "x-amz-meta-file-id": "e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a", "x-amz-meta-name": "screenshot.png" },
      "expiresAt": "2026-10-21T10:16:37.000Z"
    }
  ]
}
```

The server validates each `fileId` (uuid v4 format, unique within the call), generates the key
`files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>` itself (scan from the token, never from the
body) and echoes `fileId` in the response. The object metadata `x-amz-meta-file-id` and `x-amz-meta-name`
(`encodeURIComponent` of the name, [data model](data-model.md) §9) are signed headers, not hoisted into
the query string, and listed in `headers` with `Content-Type` and `Content-Length`. The runtime must send
exactly the listed headers. The FileRef
the connector already holds is `{id: fileId, name, size, sha256, contentType}`. Errors: 400
`validationFailed` (malformed or duplicate `fileId`, seq out of range, duplicate names in one call, more
than `maxFilesPerAnalysis`, size above `maxFileBytes`), 403 `quotaExceeded`.

### 8.4 `POST /api/runtime/analyses/status`

```json
{ "seqs": [1234, 1235, 1240] }
```

```json
{
  "items": [
    { "seq": 1234, "status": "succeeded", "round": 1, "attempt": 2 },
    { "seq": 1235, "status": "retrying", "round": 1, "attempt": 1 },
    { "seq": 1240, "status": null, "round": null, "attempt": null }
  ]
}
```

At most 1000 seqs. For a redelivered message `{round: R, attempt: n}`, the runtime acks without running
when the document's round is greater than R, or equal to R with status `succeeded` or `failed`.

### 8.5 `POST /api/runtime/scheduler/resolved`

```json
{
  "epoch": 1,
  "key": "schedule",
  "template": "tranco",
  "scanConfig": { "list": "262W9", "subdomains": false, "offset": 0, "limit": 100000 },
  "provenance": {
    "listId": "262W9",
    "date": "2026-10-20",
    "sourceUrl": "https://tranco-list.eu/download/262W9/100000",
    "sha256": "77aa31c4…",
    "fetchedAt": "2026-10-21T10:00:03.120Z"
  },
  "expectedTotal": 100000
}
```

```json
{
  "stored": true,
  "resolution": {
    "template": "tranco",
    "scanConfig": { "list": "262W9", "subdomains": false, "offset": 0, "limit": 100000 },
    "provenance": { "listId": "262W9", "date": "2026-10-20", "sourceUrl": "https://tranco-list.eu/download/262W9/100000", "sha256": "77aa31c4…", "fetchedAt": "2026-10-21T10:00:03.120Z" },
    "expectedTotal": 100000,
    "at": "2026-10-21T10:00:03.500Z"
  }
}
```

If a resolution for the key already exists, it is returned unchanged with `"stored": false` and the
runtime must use it. `key` is `schedule` (unwrapped template) or `call:<n>`. For key `schedule`,
`expectedTotal` is copied to `stats.expectedTotal`. Errors: 409 `staleEpoch`.

### 8.6 `POST /api/runtime/scheduler/checkpoint`

```json
{ "epoch": 1, "confirmed": 42000, "tailHash": "sha256:9b1c7e2f…" }
```

```json
{ "confirmed": 42000, "tailHash": "sha256:9b1c7e2f…", "serverTime": 1761041000456 }
```

Stored only when `confirmed` is greater than the stored value (otherwise the stored values are returned
unchanged). Stale epoch:

```json
{ "error": { "code": "staleEpoch", "message": "scheduler epoch 1 was superseded", "details": { "currentEpoch": 2 } } }
```

(HTTP 409; the scheduler stops publishing and exits 0.)

### 8.7 `POST /api/runtime/scheduler/done`

Success:

```json
{ "epoch": 1, "outcome": "done", "confirmed": 100000, "tailHash": "sha256:41e0aa5c…" }
```

Failure (non-retryable scheduling error):

```json
{
  "epoch": 1,
  "outcome": "failed",
  "confirmed": 5000,
  "tailHash": "sha256:0c7d…",
  "error": {
    "type": "validation",
    "phase": "schedule",
    "message": "schedule() is not deterministic: item 4999 hash mismatch on resume",
    "retryable": false,
    "attempt": 1,
    "at": "2026-10-21T10:20:00.000Z"
  }
}
```

```json
{ "serverTime": 1761041200456, "scheduling": { "state": "done", "confirmed": 100000 } }
```

Effects: checkpoint stored; `scheduling.state` `done` or `failed` (+ `error`, condition `schedulingFailed`);
the scheduler worker is drained; completion is checked. Idempotent for the same epoch. 409 `staleEpoch`.

### 8.8 `POST /api/runtime/errors`

```json
{
  "fatal": false,
  "error": {
    "type": "platform",
    "phase": "bootstrap",
    "message": "connector did not send hello within 30s",
    "retryable": true,
    "attempt": 0,
    "at": "2026-10-21T10:00:21.000Z",
    "details": { "connectorExitCode": 1 }
  },
  "context": { "stderrTail": "ModuleNotFoundError: No module named 'requests'\n" }
}
```

```json
{ "recorded": true }
```

HTTP 202. Effects: `workers.runtime.lastError`, event `worker.error`, condition `workerErrors`; for the
scheduler with a `schedule`-phase or retryable error, `scheduling.restarts` is incremented (and scheduling
fails above `SCANTOR_SCHEDULER_MAX_RESTARTS`). `fatal: true` means the runtime exits non-zero next.
`context.stderrTail` ≤ 4 KiB.

## 9. Non-API routes

The orchestrator process has two HTTP listeners. Host checks use the `Host` header as sent (Traefik
preserves it); `X-Forwarded-Host` is never trusted for this.

| Listener | Container port | Accepts `Host` | Serves |
|---|---|---|---|
| dashboard (Nitro) | 3000 | anything except the editor host, which gets 421 Misdirected Request | UI, `/api/*`, `/mcp`, discovery; never editor routes |
| editor ([editor](editor.md) §8.1) | 3001 | only the host (and port) of `SCANTOR_EDITOR_URL`; anything else gets 421 | `/_auth` and the proxy; nothing else (no `/api`, no assets) |

| Route | Listener | Purpose |
|---|---|---|
| `/api/auth/*` | dashboard | better-auth (§3) |
| `/.well-known/*` | dashboard | OAuth/MCP discovery, forwarded to better-auth |
| `/mcp` | dashboard | MCP Streamable HTTP (POST; GET/DELETE 405), OAuth bearer or API key ([mcp](mcp.md)) |
| `GET /_icons/*` | dashboard | Nuxt Icon local icon endpoint (`icon.localApiEndpoint`), public static data; outside `/api`, so the principal middleware never guards it ([ui](ui.md) §12) |
| SPA routes (`/`, `/login`, `/setup`, `/oauth/consent`, `/tasks/…`, `/scans/…`, `/editor`, …) | dashboard | Nuxt SPA |
| `GET /_auth?code=…` | editor | redeem the 60 s one-time code, set the host-only `scantor_editor` cookie (HttpOnly, 12 h), redirect to `/?folder=/home/coder/workspace[/<task>]` |
| `/*` (HTTP and WebSocket) | editor | byte-level relay to the caller's code-server unix socket with `cookie`, `authorization`, `x-api-key`, `x-scantor-*` and forwarding headers stripped and `Set-Cookie` removed from responses; WebSocket upgrades require `Origin` = editor origin; `Content-Security-Policy: frame-ancestors 'self' <dashboard origin>` |

Compose publishes `SCANTOR_PORT` → 3000 and `SCANTOR_EDITOR_PORT` → 3001; with Traefik the editor router
targets 3001. The dashboard's `/editor` page only embeds the editor origin in an iframe.

## 10. MCP-exposed operations

29 operations have `x-mcp: true`; tool name = `snake_case(operationId)`. Read tools need `scantor:read`,
write tools `scantor:write`, admin tools `scantor:admin`. Tools returning analysis configs, results or logs
wrap that content as `{"untrusted_data": …}`; responses are capped at 256 KiB with a truncation note
([mcp](mcp.md)). `/mcp` also accepts scantor API keys (`Authorization: Bearer sk_scantor_…` or
`x-api-key`); their level is `write`, or `admin` for an admin's `default` key ([mcp](mcp.md) §3.7).
`cancel_scan` is annotated destructive through `x-destructive`. MCP clamps `wait` to 50 s.

| Area | Read | Write |
|---|---|---|
| tasks and files | `list_tasks`, `get_task`, `list_task_files`, `read_task_file` | `create_task`, `write_task_files`, `delete_task_file` |
| revisions and test runs | `get_revision`, `get_test_run` | `publish_revision`, `test_task` |
| catalog | `list_templates`, `get_authoring_guide` | – |
| scans | `list_scans`, `get_scan` | `start_scan`, `pause_scan`, `resume_scan`, `scale_scan`, `cancel_scan`, `retry_failed_analyses`, `restart_scan`, `delete_scan` |
| results | `get_analysis`, `query_analyses`, `aggregate_analyses`, `get_export` | `export_scan` |
| admin | `list_nodes` | – |

## 11. Decisions made in this document

The lead's round-1 rulings accepted items 1, 3, 11, 14 and 16 explicitly; the other items stand as written.
Item 18 records a round-1 ruling.

1. **Error codes and all enum values are camelCase** (`notFound`, `invalidState`), consistent with
   decisions §2 (`taskError`).
2. **`x-read-only` extension** for side-effect-free POST operations (query, aggregate, estimate) so MCP scope
   `scantor:read` covers them.
3. **Tools routes live under `/api/tools/*`** (`/api/tools/session`, `/api/tools/forward-auth`) instead of
   `/api/auth/forward`, to avoid colliding with the better-auth catch-all.
4. **The runtime state poll is `POST /api/runtime/state`** because it carries `busy[]`; bootstrap and state
   return `action: run|drain|stop`.
5. **Creates always return 201**; asynchronous deletes and retry-failed return 202 with a `JobRef`; lifecycle
   actions are idempotent for the current state.
6. **Admins pass ownership checks** on addressed resources; top-level creates can only reference the
   caller's own resources; derived resources inherit the parent's owner.
7. **Reserved task names** `upload`, `import-git`, `new`, `latest` (static route segments).
8. **File downloads are addressed as `/api/analyses/{analysisId}/files/{fileId}`**; test-run files under
   `/api/test-runs/{id}/files/{fileId}`.
9. **`Scantor-Wait` response header**, `SCANTOR_MAX_CONCURRENT_WAITS`, and a `wait` on `getJob` and
   `getWorkerLogs`.
10. **Worker on-demand log tails** go through `logRequests` in assignments and
    `POST /api/node/workers/{workerId}/logs`.
11. **Version window**: same or previous minor for `/api/node/*` and `/api/runtime/*` (426 otherwise).
12. **`/api/jobs` routes** expose job progress (task/user deletion, retry-failed) to the UI and CLI.
13. **`x-session-only` and `x-destructive`** extensions (adopted from [auth](auth.md) §15 and [mcp](mcp.md)),
    enforced and consumed centrally; the generated OpenAPI test checks their placement.
14. **Image tag rule for `cliImage` and `NodeJoin`**: the orchestrator version when it is a release version
    `X.Y.Z`, otherwise `SCANTOR_IMAGE_TAG`, so builds from `main` (whose version is a `git describe` string)
    still hand out pullable images.
15. **Runtime-generated `fileId`** in presign requests (adopted from [runtime](runtime.md) §18): the server
    validates the ids and still builds every key.
16. **Two listeners** (dashboard 3000, editor 3001) replace Host dispatch inside Nitro (adopted from
    [editor](editor.md) §11.1).
17. **Admin node detail routes** `listNodeWorkers` and `listNodeEvents` (requested by [ui](ui.md) §16);
    both are served by existing indexes.
18. **forwardAuth redirects browsers**: `toolsForwardAuth` answers a browser request without a valid tools
    cookie with 302 to `/api/tools/session?target=<target>` instead of 401, so an admin opening a tool URL
    directly gets a cookie without a detour through `/admin/tools`.

## 12. Future extensions

| Extension | Accommodation |
|---|---|
| STS S3 credentials, multipart > 5 GiB | `bootstrap.uploads.mode` enum gains `sts`; a new `POST /api/runtime/s3-credentials` route; presign stays for small files. |
| `ctx.memo` | `POST /api/runtime/scheduler/resolved` already stores keyed values; add a `memo` key kind with a size cap. |
| Cron / recurring scans | New tag `schedules` with `listSchedules`, `createSchedule`, … creating scans through `startScan`'s validation. |
| Multi-replica orchestrator | `wait` uses change streams (works across replicas); MCP internal capabilities and SSE in-process streams would move to MongoDB/RabbitMQ. |
| Per-process multiplexing | State poll `busy[]` already carries `executionId`; no API change. |
| Organisations / shared tasks | The scope model (`owner`) is enforced by one helper; a future `org` principal adds a membership check there. |
| Webhooks / notifications | Events already have stable types; a `webhooks` tag can subscribe to them. |
| More MCP tools | Raise the curated limit deliberately; the generated test enforces the cap. |
| API versioning | A future breaking change would add `/api/v2/*` routes beside the current ones; machine APIs already negotiate versions. |
| Scoped or read-only API keys | `apikey.permissions` exists; the operation registry already knows `x-read-only`, `x-admin-only` and `x-session-only`, so a key level maps onto the same checks as MCP levels. |
| More admin tools (Prometheus, Grafana) | `adminTools.items` is data; a new `target` adds one forwardAuth router and one item. |
