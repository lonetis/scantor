# Data model

This document defines every piece of persistent state in scantor: each MongoDB collection (fields,
types, meaning, example document, exact indexes and ownership rules), the state machines stored in those
documents and who may move them, the invariants and limits that implementations must uphold, the S3
bucket layout, and a summary of the RabbitMQ objects. The REST representation of these documents is
defined in [api](api.md); the message formats on the broker are defined in [queue](queue.md); the
system context is in [architecture](architecture.md).

## 1. Conventions

| Topic | Rule |
|---|---|
| Database | One MongoDB 9.0 replica set (`rs0`), database `SCANTOR_MONGO_DB`, one `MongoClient` shared by better-auth and scantor. Connection: `SCANTOR_MONGO_URL` (no credentials) with `SCANTOR_MONGO_USER` / `SCANTOR_MONGO_PASSWORD`. User queries run on a second client logged in as the read-only user `scantor_query` ([api](api.md) §5.2). |
| Collection names | scantor collections: plural camelCase (`tasks`, `testRunAnalyses`). better-auth collections: the singular model names its Mongo adapter creates (`user`, `apikey`, …). No name collides. |
| Ids | uuid v4 strings (`crypto.randomUUID()` / `uuid.NewString()`) stored as strings in `_id`. Exceptions: `analyses._id = "<scanId>-<seq>"`, `testRunAnalyses._id = "<testRunId>-<seq>"`, `editors._id = <userId>`, `locks._id` and `meta._id` are fixed names. better-auth is configured with `advanced.database.generateId: () => crypto.randomUUID()`, so its ids are plain strings too. |
| Field and enum casing | camelCase for field names and for enum string values (`taskError`, `workersPending`). Event types are dotted camelCase (`scan.stateChanged`). |
| Timestamps | BSON `Date` in MongoDB, ISO 8601 UTC strings with milliseconds in the REST API. Every scantor document has `createdAt` and `updatedAt` unless stated otherwise. |
| Units | Durations are integer milliseconds with suffix `Ms`; memory is integer MiB with suffix `MiB`; byte counts are integers with suffix `Bytes` or the field name `bytes`/`size`. |
| Ownership | Every user-owned document has `userId` (string, the better-auth `user._id`). It is set from the principal at creation, or copied from the parent document for derived documents, and never changes. A request never supplies `userId`. |
| Representation | The API maps `_id` → `id`, omits fields marked *internal* below, and masks secrets. |
| Encrypted values | Format `enc:v1:<base64url(iv, 12 bytes)>:<base64url(ciphertext ‖ tag)>`, AES-256-GCM with an HKDF key ([architecture](architecture.md) §9), AAD = `<collection>:<_id>:<field or JSON pointer>`. Used for git credentials and `writeOnly` config values. |
| Index management | The orchestrator creates every index at boot with `createIndexes` (idempotent). TTL durations that come from env are applied with `collMod` when they differ. Boot step 3 creates the indexes better-auth declares (field `unique`/`index` attributes and table indexes of `$context.tables`; unique only for required fields), because the MongoDB adapter does not create them (§3). |
| Schema version | `meta` document `schema` holds the data-model version (1). Migrations run at boot under the `migrations` lock. |
| Writes to better-auth data | Only through better-auth (`auth.api.*`, `ctx.internalAdapter`, `ctx.adapter`). Scantor reads `user` and `apikey` directly only for listings. |

## 2. Collection overview

| Collection | Owner field | Purpose | Retention |
|---|---|---|---|
| better-auth (`user`, `session`, `account`, `verification`, `passkey`, `jwks`, `apikey`, `oauth*`) | various | identities, sessions, API keys, OAuth/MCP | better-auth |
| `tasks` | `userId` | task identity, workspace cache, revision pointers | until task delete |
| `revisions` | `userId` | immutable numbered builds of a task | until task delete |
| `testRuns` | `userId` | test-run state and summary | TTL `expiresAt` |
| `testRunAnalyses` | `userId` | per-analysis output of test runs | TTL `expiresAt` |
| `scans` | `userId` | scan intent, effective configs, settings, scheduling, stats, conditions | tombstone TTL `purgeAfter` |
| `analyses` | `userId` (not indexed) | one doc per analysis | deleted with the scan |
| `workers` | `userId` | desired and actual worker containers | TTL `expiresAt` after stop |
| `nodes` | – (admin) | node identity, token hash, capacity, liveness | until node delete |
| `credentials` | `userId` | encrypted git credentials | until deleted |
| `uploads` | `userId` | uploaded list files for templates | until deleted |
| `events` | `userId` (nullable) | timeline of scans, workers, nodes, revisions | TTL `at` |
| `jobs` | `userId` (nullable) | resumable background work | TTL `expiresAt` after finish |
| `locks` | – | lease locks for singleton loops | renewed leases |
| `exports` | `userId` | background export results | TTL `expiresAt` |
| `editors` | `_id` = userId | per-user editor container state | permanent (small) |
| `meta` | – | schema version | permanent |

## 3. better-auth collections

Adapter: `mongodbAdapter(db, { client, usePlural: false })` from `better-auth/adapters/mongodb` (transactions
on, which needs the replica set). The adapter maps `id` ↔ `_id`. Collections are created lazily; their
indexes (for example `session.token`, `user.email`, `apikey.key`) are created at boot by the orchestrator
from better-auth's table metadata, because the adapter creates none ([auth](auth.md) §2.1).

| Collection | Added by | Purpose | Notable fields |
|---|---|---|---|
| `user` | core + `admin()` + scantor `user.additionalFields` | accounts | `name`, `email` (unique), `emailVerified`, `image`, `role` (`admin`\|`user`), `banned`, `banReason`, `banExpires`, `canRunPrivileged`, `maxWorkers`, `createdAt`, `updatedAt` |
| `session` | core + `admin()` | browser sessions (cookie `scantor.session_token`, named `__Secure-scantor.session_token` on https; 7 days, refreshed daily) | `token`, `userId`, `expiresAt`, `ipAddress`, `userAgent`, `impersonatedBy` |
| `account` | core | credential accounts (`providerId: "credential"` holds the password hash) | `accountId`, `providerId`, `userId`, `password` |
| `verification` | core | short-lived values; also OAuth state and DPoP replay reservations (`identifier: "dpop-proof:<key>"`) | `identifier`, `value`, `expiresAt` |
| `passkey` | `@better-auth/passkey` | WebAuthn credentials | `name`, `publicKey`, `userId`, `credentialID`, `counter`, `deviceType`, `backedUp`, `transports`, `aaguid` |
| `jwks` | `jwt()` | signing keys of OAuth access tokens for MCP (private key encrypted by better-auth); keys that cannot be decrypted with the current `SCANTOR_SECRET` are deleted at boot | `publicKey`, `privateKey`, `alg`, `crv`, `expiresAt` |
| `apikey` | `@better-auth/api-key` | user API keys (stored hashed) | `configId` (`default` = CLI/MCP-client keys, `editor` = per-user editor key), `name`, `start`, `prefix`, `key` (base64url SHA-256), `referenceId` (= userId), `enabled`, `expiresAt`, `lastRequest`, `requestCount`, `rateLimitEnabled` (false), `metadata`. `prefix` is `sk_scantor_` for configId `default` and `sk_scantor_editor_` for configId `editor` (key = prefix + 64 letters); `start` stores the first 15 (`default`) or 22 (`editor`) characters for display ([auth](auth.md) §8.1) |
| `oauthClient`, `oauthConsent`, `oauthAccessToken`, `oauthRefreshToken`, `oauthResource`, `oauthClientResource`, `oauthClientAssertion` | `@better-auth/oauth-provider` (used by `@better-auth/mcp`; `@better-auth/cimd` registers metadata-document clients in `oauthClient`) | OAuth 2.1 authorization server for MCP clients | `clientId`, `redirectUris`, `userId`, `scopes`, … |

Scantor additional user fields (declared with `input: false`, so only server code sets them):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `canRunPrivileged` | boolean | `false` | admin-set; required to publish or start privileged (DinD) tasks |
| `maxWorkers` | integer ≥ 0 | `SCANTOR_USER_MAX_WORKERS` at user creation | admin-set cap on the user's active workers across all scans; `0` = unlimited |

```json
{
  "_id": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "name": "Louis",
  "email": "louis@example.com",
  "emailVerified": false,
  "role": "admin",
  "banned": false,
  "canRunPrivileged": false,
  "maxWorkers": 0,
  "createdAt": { "$date": "2026-10-21T08:00:00.000Z" },
  "updatedAt": { "$date": "2026-10-21T08:00:00.000Z" }
}
```

## 4. Scantor collections

Field tables use: **Req** ✓ = always present; – = optional or nullable. *internal* = never returned by the
API.

### 4.1 `tasks`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | task id |
| `userId` | uuid | ✓ | owner |
| `name` | slug | ✓ | `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, must not match the uuid pattern or a reserved name (`upload`, `import-git`, `new`, `latest`), unique per owner, immutable. Workspace folder name. At publish, manifest `name` must equal it. |
| `language` | `python`\|`typescript`\|`javascript`\|`go` | ✓ | from the creating request or manifest; updated from the manifest of every successful publish |
| `description` | string ≤ 500 | – | from the manifest |
| `source` | object | ✓ | `{kind: "scaffold"\|"upload"\|"git", template?: string, git?: GitSource}` — how the workspace was created |
| `source.git` | GitSource | – | `{url, ref, path, credentialId?, commit, packSha256, pulledAt}`; `packSha256` = workspace pack hash right after the last import/pull (local-change detection for pull) |
| `workspace` | object | ✓ | cache, updated whenever a helper computes a summary: `{packSha256: string\|null, fileCount, bytes, checkedAt, lastSyncSha256: string\|null}` |
| `workspace.lastSyncSha256` | string \| null | ✓ | workspace pack hash right after the last upload, git import or git pull (set by those operations only; editor and file-route writes never set it); lets repeated uploads of the same folder pass the conflict check ([tasks](tasks.md) §13) |
| `revisionSeq` | int ≥ 0 | ✓ | last allocated revision number; incremented atomically by publish |
| `latestRevision` | RevisionPointer \| null | ✓ | highest-numbered revision: `{id, number, state, packSha256, createdAt}` |
| `latestReadyRevision` | RevisionPointer \| null | ✓ | highest-numbered `ready` revision; target of `@latest` |
| `privileged` | boolean | ✓ | `settingsDefaults.privileged` of `latestReadyRevision` |
| `deletingAt` | Date \| null | – | set when a `taskDelete` job starts; the task then behaves as not found |
| `createdAt`, `updatedAt` | Date | ✓ | |

Derived (API only): `workspace.dirty = workspace.packSha256 != latestRevision.packSha256` (the last
published content, whatever its build outcome; true when there is no revision yet). All pack hashes are
SHA-256 of the uncompressed deterministic tar ([tasks](tasks.md) §9.2).

```json
{
  "_id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "name": "echo",
  "language": "python",
  "description": "Echo a greeting",
  "source": { "kind": "scaffold", "template": "single" },
  "workspace": { "packSha256": "a3f1…9c", "fileCount": 9, "bytes": 14336, "checkedAt": { "$date": "2026-10-21T09:00:00.000Z" }, "lastSyncSha256": null },
  "revisionSeq": 3,
  "latestRevision": { "id": "c1d2…", "number": 3, "state": "ready", "packSha256": "a3f1…9c", "createdAt": { "$date": "2026-10-21T09:01:00.000Z" } },
  "latestReadyRevision": { "id": "c1d2…", "number": 3, "state": "ready", "packSha256": "a3f1…9c", "createdAt": { "$date": "2026-10-21T09:01:00.000Z" } },
  "privileged": false,
  "createdAt": { "$date": "2026-10-21T08:30:00.000Z" },
  "updatedAt": { "$date": "2026-10-21T09:02:10.000Z" }
}
```

Indexes:

| Keys | Options | Serves |
|---|---|---|
| `{userId: 1, name: 1}` | unique | name lookup, uniqueness |
| `{userId: 1, createdAt: -1, _id: -1}` | | list |

### 4.2 `revisions`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | revision id; also the image tag |
| `userId` | uuid | ✓ | copied from the task |
| `taskId`, `taskName` | uuid, slug | ✓ | parent task (name denormalised for `name@N` display) |
| `number` | int ≥ 1 | ✓ | per-task sequence, never reused (failed builds consume numbers) |
| `state` | `queued`\|`building`\|`ready`\|`failed` | ✓ | §6.4 |
| `message` | string ≤ 500 | – | user note |
| `source` | object | ✓ | `{kind: "workspace"\|"upload"\|"git", packSha256, packBytes, fileCount, git?: {url, ref, path, commit, dirty}}`; `packBytes` = size of the stored tar.gz, `packSha256` = hash of the uncompressed tar; kind rules in [tasks](tasks.md) §10 |
| `snapshotKey` | string | ✓ | `snapshots/<taskId>/<packSha256>.tar.gz` |
| `manifest` | object | – | parsed, normalised `scantor.yaml` (set after `check-static`) |
| `language` | enum | – | from the manifest |
| `baseImage` | `{ref, digest}` | – | `SCANTOR_BASE` pinned by digest |
| `image` | object \| null | – | after push: `{repository: "tasks/<taskId>", tag: "<revisionId>", digest: "sha256:…", bytes, platform: {os, arch}}` |
| `description` | Description \| null | – | describe output, below |
| `settingsDefaults` | ScanSettings (without `nodeSelector`) | – | manifest `defaults` normalised (§4.5) |
| `privileged` | boolean | ✓ | manifest `defaults.privileged` |
| `buildLogKey` | string | ✓ | `build-logs/<revisionId>.ndjson` |
| `errors` | BuildError[] | ✓ | `[{phase, file?, line?, column?, message}]`, empty unless failed (warnings live in `description.warnings`). `phase` ∈ `pack`, `static`, `build`, `describe`, `check`, `push`, `platform` (task-pipeline phases); test runs additionally use `config` (input validation) and `schedule` (scheduling failure in local mode). `file` relative to the task root, `line`/`column` 1-based, `message` ≤ 4 KiB |
| `jobId` | uuid | ✓ | the `revisionBuild` job |
| `createdAt`, `startedAt`, `finishedAt`, `updatedAt` | Date | ✓/– | |

Description (also used by `testRuns.description`):

| Field | Type | Meaning |
|---|---|---|
| `protocolVersion` | int | negotiated connector protocol version |
| `connector` | `{language, version}` | from `hello` |
| `schemas` | `{taskConfig, scanConfig, analysisConfig, result}` | JSON Schema draft 2020-12; configs in input mode, result in output mode |
| `schedule` | `{kind: "template", template: "<name>"}` \| `{kind: "custom"}` | how scheduling runs |
| `secretPaths` | `{taskConfig, scanConfig, analysisConfig, result}`: JSON pointer arrays | paths of `writeOnly: true` values; `*` matches any array index or property name |
| `uploadPaths` | `{taskConfig, scanConfig}`: JSON pointer arrays | paths of `"x-scantor": "upload"` string fields (upload ids) |
| `fileRefPaths` | JSON pointer array | paths of `"x-scantor": "file"` objects in the Result schema |
| `warnings` | string[] | schema subset warnings and similar |

```json
{
  "_id": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "taskId": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c",
  "taskName": "echo",
  "number": 3,
  "state": "ready",
  "message": "add greeting option",
  "source": { "kind": "workspace", "packSha256": "a3f1…9c", "packBytes": 4211, "fileCount": 9 },
  "snapshotKey": "snapshots/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c/a3f1…9c.tar.gz",
  "manifest": { "scantor": 1, "name": "echo", "language": "python", "entry": "main.py", "defaults": { "processes": 2 } },
  "language": "python",
  "baseImage": { "ref": "ghcr.io/lonetis/scantor-base-python:1.4.0", "digest": "sha256:0d1e…" },
  "image": { "repository": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "tag": "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "digest": "sha256:4e5f…", "bytes": 187654321, "platform": { "os": "linux", "arch": "amd64" } },
  "description": {
    "protocolVersion": 1,
    "connector": { "language": "python", "version": "1.4.0" },
    "schemas": { "taskConfig": { "type": "object" }, "scanConfig": { "type": "object" }, "analysisConfig": { "type": "object" }, "result": { "type": "object" } },
    "schedule": { "kind": "template", "template": "single" },
    "secretPaths": { "taskConfig": [], "scanConfig": [], "analysisConfig": [], "result": [] },
    "uploadPaths": { "taskConfig": [], "scanConfig": [] },
    "fileRefPaths": [],
    "warnings": []
  },
  "settingsDefaults": { "workers": 1, "processes": 2, "timeoutMs": 300000, "maxAttempts": 3, "backoff": { "initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true }, "resources": { "cpus": 1, "memoryMiB": 512 }, "maxAnalysesPerProcess": 1000, "privileged": false },
  "privileged": false,
  "buildLogKey": "build-logs/c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f.ndjson",
  "errors": [],
  "jobId": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d",
  "createdAt": { "$date": "2026-10-21T09:01:00.000Z" },
  "startedAt": { "$date": "2026-10-21T09:01:01.000Z" },
  "finishedAt": { "$date": "2026-10-21T09:01:48.000Z" },
  "updatedAt": { "$date": "2026-10-21T09:01:48.000Z" }
}
```

Indexes:

| Keys | Options | Serves |
|---|---|---|
| `{taskId: 1, number: 1}` | unique | `name@N`, uniqueness |
| `{taskId: 1, state: 1, number: -1}` | | `@latest`, list by state |
| `{taskId: 1, "source.packSha256": 1}` | | publish de-duplication |
| `{userId: 1, createdAt: -1}` | | per-user listing, purge |

### 4.3 `testRuns`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | test run id |
| `userId` | uuid | ✓ | copied from the task |
| `taskId`, `taskName` | uuid, slug | ✓ | |
| `state` | `queued`\|`building`\|`running`\|`completed`\|`failed`\|`cancelled` | ✓ | §6.5. `completed` = ran to the end (analyses may have failed); `failed` = platform, build, describe, config or schedule failure |
| `input` | object | ✓ | `{taskConfig?, scanConfig?, analysisConfig?, limit, maxAttempts, timeoutMs}`: the configs as requested (secrets masked, no defaults filled, see `secrets`), `timeoutMs` as used (the request value, else the described manifest default) |
| `secrets` | object | – | *internal*; encrypted `writeOnly` input values, as on scans. Until the draft image is described the secret paths are unknown, so the requested configs are held encrypted as a whole under `secrets.request`; after validation they are replaced by the per-pointer encrypted values |
| `packSha256` | string | – | workspace pack hash used |
| `draftImage` | `{ref, digest, cached}` | – | `tasks/<taskId>:draft-<packSha256>`; `cached` = reused |
| `description` | Description | – | describe output of the draft image |
| `errors` | BuildError[] | ✓ | pipeline errors (`pack` … `platform`), input validation errors (phase `config`, one per issue: `"taskConfig /greeting: must be string"`) and scheduling failures (phase `schedule`) |
| `summary` | `{analyses, succeeded, failed}` | ✓ | |
| `buildLogKey`, `logKey` | string | ✓ | `test-runs/<id>/build.ndjson`, `test-runs/<id>/log.ndjson` |
| `jobId` | uuid | ✓ | |
| `createdAt`, `startedAt`, `finishedAt`, `updatedAt` | Date | ✓/– | |
| `expiresAt` | Date | ✓ | `createdAt + SCANTOR_TEST_RUN_RETENTION_DAYS` (TTL) |

```json
{
  "_id": "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "taskId": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c",
  "taskName": "echo",
  "state": "completed",
  "input": { "taskConfig": { "greeting": "Hi" }, "limit": 5, "maxAttempts": 1, "timeoutMs": 300000 },
  "packSha256": "b7c2…01",
  "draftImage": { "ref": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:draft-b7c2…01", "digest": "sha256:aa01…", "cached": true },
  "description": { "protocolVersion": 1, "schedule": { "kind": "template", "template": "single" } },
  "errors": [],
  "summary": { "analyses": 1, "succeeded": 1, "failed": 0 },
  "buildLogKey": "test-runs/3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d/build.ndjson",
  "logKey": "test-runs/3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d/log.ndjson",
  "jobId": "b1c2d3e4-f5a6-4b7c-9d8e-0f1a2b3c4d5e",
  "createdAt": { "$date": "2026-10-21T09:10:00.000Z" },
  "startedAt": { "$date": "2026-10-21T09:10:00.500Z" },
  "finishedAt": { "$date": "2026-10-21T09:10:02.100Z" },
  "updatedAt": { "$date": "2026-10-21T09:10:02.100Z" },
  "expiresAt": { "$date": "2026-10-28T09:10:00.000Z" }
}
```

Indexes: `{taskId: 1, createdAt: -1}`, `{userId: 1, createdAt: -1}`, `{expiresAt: 1}` with
`expireAfterSeconds: 0`.

### 4.4 `testRunAnalyses`

Same field shapes as `analyses` (§4.6) with `_id = "<testRunId>-<seq>"`, `testRunId` instead of `scanId`,
`status ∈ {succeeded, failed}`, no `round`, `workerId`, `nodeId` or `executionId`, and `expiresAt` copied
from the test run. File keys are `test-runs/<testRunId>/files/<seq>/<fileId>/<safeName>`.

```json
{
  "_id": "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d-0",
  "testRunId": "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "seq": 0,
  "status": "succeeded",
  "attempt": 1,
  "config": {},
  "result": { "text": "Hi" },
  "attempts": [],
  "files": [],
  "logTail": "",
  "timings": { "scheduledAt": { "$date": "2026-10-21T09:10:02.000Z" }, "startedAt": { "$date": "2026-10-21T09:10:02.000Z" }, "finishedAt": { "$date": "2026-10-21T09:10:02.040Z" }, "durationMs": 40 },
  "createdAt": { "$date": "2026-10-21T09:10:02.050Z" },
  "updatedAt": { "$date": "2026-10-21T09:10:02.050Z" },
  "expiresAt": { "$date": "2026-10-28T09:10:00.000Z" }
}
```

Indexes: `{testRunId: 1, seq: 1}` unique, `{expiresAt: 1}` with `expireAfterSeconds: 0`.

### 4.5 `scans`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | scan id; also names the queue `scantor.scan.<id>` and RabbitMQ user `scan-<id>` |
| `userId` | uuid | ✓ | owner (caller of `startScan`; copied from the original on restart) |
| `name` | string ≤ 100 | – | free-text label |
| `task` | `{id, name}` | ✓ | denormalised; survives task deletion |
| `revision` | object | ✓ | `{id, number, language, repository: "tasks/<taskId>", digest, platform: {os, arch}, privileged, schedule: {kind, template?}}` |
| `state` | ScanState | ✓ | §6.1 |
| `stateReason` | `{code, message, at}` \| null | ✓ | why the last transition happened: `user`, `failureRate`, `schedulingFailed`, `completed`, `stalled`, `revisionUnavailable` |
| `taskConfig` | object | ✓ | effective task config; `writeOnly` values replaced by `"***"` |
| `scanConfig` | object | ✓ | effective scan config as requested (before template resolution); secrets `"***"` |
| `secrets` | object | ✓ | *internal*; `{taskConfig: {"<pointer>": "enc:v1:…"}, scanConfig: {…}}` |
| `secretPaths` | object | ✓ | copied from `revision.description.secretPaths`; drives masking of configs, analysis configs and results |
| `uploadIds` | uuid[] | ✓ | uploads referenced by configs |
| `settings` | ScanSettings | ✓ | effective settings (below) |
| `round` | int ≥ 1 | ✓ | current retry-failed round |
| `scheduling` | Scheduling | ✓ | below |
| `stats` | Stats | ✓ | below |
| `conditions` | Condition[] (≤ 16) | ✓ | active conditions only, §4.5.4 |
| `breaker` | `{trippedAt, ratio, attempts, windowMs}` \| null | ✓ | last circuit-breaker trip |
| `clonedFrom` | uuid \| null | ✓ | source scan of a restart |
| `createdAt`, `updatedAt` | Date | ✓ | |
| `startedAt`, `pausedAt`, `completedAt`, `deletedAt` | Date \| null | ✓ | `completedAt` = time the scan last entered a terminal state |
| `purgeAfter` | Date | – | set when `deleted`; TTL purges the tombstone |

#### 4.5.1 ScanSettings

| Field | Type | Bounds | Live-mutable | Meaning |
|---|---|---|---|---|
| `workers` | int | 1 … `SCANTOR_MAX_WORKERS_PER_SCAN` | yes (`scaleScan`) | runner workers |
| `processes` | int | 1 … `SCANTOR_MAX_PROCESSES_PER_WORKER` | yes (`scaleScan`) | connector processes per worker |
| `timeoutMs` | int | 1000 … 86 400 000 | no (queue argument) | per-analysis timeout |
| `maxAttempts` | int | 1 … 20 | no | attempts per analysis per round |
| `backoff` | `{initialMs, factor, maxMs, jitter}` | `initialMs` ≥ 1000, `factor` 1 … 10, `initialMs` ≤ `maxMs` ≤ 86 400 000 | no | delay after failed attempt n = `min(maxMs, initialMs × factor^(n−1))`; with `jitter` a uniform value in [delay/2, delay] |
| `resources` | `{cpus, memoryMiB}` | `cpus` 0.1 … 64, `memoryMiB` 64 … 65 536 | no | **per process**; container = processes × value (+ 256 MiB memory overhead) |
| `maxAnalysesPerProcess` | int | 1 … 1 000 000 | no | recycle a process after this many analyses |
| `nodeSelector` | `{pool, labels}` | `pool` slug, `labels` ≤ 16 entries | no | placement filter; `pool` defaults to `shared` |
| `privileged` | boolean | – | no | copied from the revision; never user-supplied |

Fallbacks when the manifest omits a default (the manifest schema in [tasks](tasks.md) uses the same values):
`workers` 1, `processes` 1, `timeoutMs` 300000, `maxAttempts` 3,
`backoff` `{initialMs: 5000, factor: 2, maxMs: 600000, jitter: true}`, `resources` `{cpus: 1, memoryMiB: 512}`,
`maxAnalysesPerProcess` 1000.

The manifest (`schemas/task-manifest.schema.json`) writes durations and memory as strings; `check-static`
normalises them into `settingsDefaults`: `defaults.timeout` (`5m`) → `timeoutMs`, `defaults.backoff.initial` /
`defaults.backoff.max` (`5s` / `10m`) → `backoff.initialMs` / `backoff.maxMs`, `defaults.resources.memory`
(`512MiB`) → `resources.memoryMiB`. Every other field keeps its name. ScanSettings wherever they appear
(`settingsDefaults`, `scans.settings`, `StartScan.settings`, bootstrap) use only the normalised names;
`revisions.manifest` keeps the manifest's own names.

#### 4.5.2 Scheduling

| Field | Type | Meaning |
|---|---|---|
| `state` | `pending`\|`running`\|`done`\|`retrying`\|`failed` | §6.2 |
| `confirmed` | int ≥ 0 | contiguous published-and-confirmed prefix; only increases |
| `tailHash` | string \| null | `sha256:<hex>` of the canonical JSON of analysis config `confirmed − 1` |
| `epoch` | int ≥ 0 | incremented for every new scheduler worker |
| `restarts` | int ≥ 0 | scheduler crashes and retryable scheduler errors; > `SCANTOR_SCHEDULER_MAX_RESTARTS` fails scheduling |
| `resolved` | map key → Resolution | template resolutions; key `schedule` for an unwrapped template, `call:<n>` for the n-th wrapped template call (0-based) |
| `error` | ScantorError \| null | set when scheduling fails; once set, the scan ends `failed` |
| `startedAt`, `checkpointAt`, `doneAt` | Date \| null | |

Resolution: `{template, scanConfig, provenance: {…template-specific, e.g. listId, month, country, sourceUrl,
sha256, fetchedAt}, expectedTotal: int | null, at}`.

#### 4.5.3 Stats

| Field | Meaning |
|---|---|
| `pending`, `retrying`, `succeeded`, `failed`, `lost`, `cancelled` | analysis counts by status; exact after a recount, otherwise live `$inc` hints. For `cancelled` scans, `cancelled = scheduling.confirmed − succeeded − failed − lost` (never-run seqs are implicitly cancelled). |
| `expectedTotal` | int \| null; from the `schedule` resolution or the start-time estimate |
| `ratePerMin` | completions per minute over the ingestor's 5-minute window |
| `recountedAt` | Date \| null of the last authoritative recount (running scans every 60 s and on triggers; terminal scans once more 2 minutes after entering the terminal state) |

#### 4.5.4 Conditions

Condition: `{type, severity: "info"|"warning"|"error", reason, message, since, updatedAt, details?}`; at most
one entry per type; removed when cleared.

| Type | Severity | Set by | Cleared when | `details` |
|---|---|---|---|---|
| `workersPending` | warning | reconciler | all desired workers placed | `{count, reasons: {<reason>: n}}`; reasons `noNodes`, `archMismatch`, `selectorMismatch`, `insufficientCapacity`, `userMaxWorkers`, `dindUnavailable`, `diskLow`, `pullLimit` |
| `crashLoop` | error | reconciler (node status), only when a worker reports `backoff` with a new `lastExit.at` and `exitCode ≠ 0` or `oomKilled`; exit code 0 (the runtime stopping after drain, stop or 401) never raises it | no worker of the scan in `backoff` for 5 min | `{workerId, nodeId, exitCode, oomKilled, restarts, logTail}` |
| `imagePullFailed` | error | reconciler (node status) | a pull of the image succeeds | `{nodeId, message}` |
| `workerErrors` | warning | runtime error reports | no report for 10 min | `{workerId, error}` (latest) |
| `schedulerRestarting` | warning | reconciler | scheduler `running` again | `{restarts, error}` |
| `schedulingFailed` | error | API (`scheduler/done` failed) / reconciler | never (scan ends `failed`) | `{error}` |
| `topologyFailed` | error | reconciler | topology ensured | `{message}` |
| `brokerAlarm` | error | reconciler (RabbitMQ health checks) | alarm gone | `{alarms}` |
| `breakerTripped` | error | ingestor | `resumeScan` | `{ratio, attempts, windowMs}` |
| `stalled` | warning | reconciler | never (informational on the finished scan) | `{lost}` |
| `clockSkew` | warning | reconciler | offsets back under 2 s | `{nodeId, offsetMs}` |

```json
{
  "_id": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "name": "tranco top 100k",
  "task": { "id": "7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "name": "origins" },
  "revision": { "id": "c1d2e3f4-…", "number": 3, "language": "typescript", "repository": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "digest": "sha256:4e5f…", "platform": { "os": "linux", "arch": "amd64" }, "privileged": false, "schedule": { "kind": "template", "template": "tranco" } },
  "state": "running",
  "stateReason": null,
  "taskConfig": { "expectedStatus": 200, "apiKey": "***" },
  "scanConfig": { "list": "latest", "subdomains": false, "offset": 0, "limit": 100000 },
  "secrets": { "taskConfig": { "/apiKey": "enc:v1:q8Zk…:Xc0…" }, "scanConfig": {} },
  "secretPaths": { "taskConfig": ["/apiKey"], "scanConfig": [], "analysisConfig": [], "result": [] },
  "uploadIds": [],
  "settings": { "workers": 4, "processes": 2, "timeoutMs": 300000, "maxAttempts": 3, "backoff": { "initialMs": 5000, "factor": 2, "maxMs": 600000, "jitter": true }, "resources": { "cpus": 1, "memoryMiB": 512 }, "maxAnalysesPerProcess": 1000, "nodeSelector": { "pool": "shared", "labels": {} }, "privileged": false },
  "round": 1,
  "scheduling": { "state": "running", "confirmed": 42000, "tailHash": "sha256:9b1c…", "epoch": 1, "restarts": 0, "resolved": { "schedule": { "template": "tranco", "scanConfig": { "list": "262W9", "subdomains": false, "offset": 0, "limit": 100000 }, "provenance": { "listId": "262W9", "date": "2026-10-20", "sourceUrl": "https://tranco-list.eu/download/262W9/100000", "sha256": "77aa…", "fetchedAt": "2026-10-21T10:00:03.120Z" }, "expectedTotal": 100000, "at": { "$date": "2026-10-21T10:00:03.500Z" } } }, "error": null, "startedAt": { "$date": "2026-10-21T10:00:02.000Z" }, "checkpointAt": { "$date": "2026-10-21T10:05:00.000Z" }, "doneAt": null },
  "stats": { "pending": 0, "retrying": 17, "succeeded": 39811, "failed": 102, "lost": 0, "cancelled": 0, "expectedTotal": 100000, "ratePerMin": 8100, "recountedAt": { "$date": "2026-10-21T10:05:00.000Z" } },
  "conditions": [],
  "breaker": null,
  "clonedFrom": null,
  "createdAt": { "$date": "2026-10-21T10:00:00.000Z" },
  "updatedAt": { "$date": "2026-10-21T10:05:00.000Z" },
  "startedAt": { "$date": "2026-10-21T10:00:01.000Z" },
  "pausedAt": null, "completedAt": null, "deletedAt": null
}
```

Indexes:

| Keys | Options | Serves |
|---|---|---|
| `{userId: 1, createdAt: -1, _id: -1}` | | list |
| `{state: 1, updatedAt: 1}` | | reconciler (non-terminal scans), ingestor cache warm-up |
| `{"task.id": 1, state: 1}` | | `taskInUse` checks |
| `{"revision.id": 1}` | | revision usage |
| `{uploadIds: 1}` | | `uploadInUse` checks |
| `{purgeAfter: 1}` | `expireAfterSeconds: 0` | tombstone purge (only docs with the field) |

### 4.6 `analyses`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | string | ✓ | `"<scanId>-<seq>"`, built by the ingestor from the AMQP `user_id` scan and the message `seq` |
| `scanId` | uuid | ✓ | |
| `userId` | uuid | ✓ | copied from the scan (defence in depth in query filters) |
| `seq` | int | ✓ | 0 ≤ seq < 2^53 |
| `round` | int ≥ 1 | ✓ | round of the latest write |
| `status` | `pending`\|`retrying`\|`succeeded`\|`failed`\|`lost`\|`cancelled` | ✓ | §6.3 |
| `attempt` | int ≥ 0 | ✓ | latest attempt number in `round` (0 after a retry-failed reset) |
| `config` | object | – | analysis config (≤ `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES`); absent for gap-filled `lost`/`cancelled` docs |
| `result` | object | – | only when `succeeded` (≤ `SCANTOR_MAX_RESULT_BYTES`) |
| `error` | ScantorError | – | final error (`failed`, `lost`) or latest error (`retrying`) |
| `attempts` | Attempt[] (≤ 10) | ✓ | most recent attempts across rounds (`$push` with `$slice: -10`) |
| `files` | FileRef[] | ✓ | files of the execution that produced the final status |
| `logTail` | string ≤ 32 KiB | – | captured stdout/stderr of the final attempt |
| `timings` | `{scheduledAt, startedAt, finishedAt, durationMs}` | – | of the final (or latest) attempt |
| `workerId`, `nodeId`, `executionId` | uuid | – | of the final (or latest) attempt |
| `createdAt`, `updatedAt` | Date | ✓ | first and last ingest write |

ScantorError (the unified, runtime-owned error model):

| Field | Type | Meaning |
|---|---|---|
| `type` | `taskError`\|`fatal`\|`retry`\|`timeout`\|`crash`\|`validation`\|`platform`\|`cancelled` | classification ([runtime](runtime.md)) |
| `message` | string ≤ 4 KiB | |
| `retryable` | boolean | |
| `phase` | `bootstrap`\|`schedule`\|`run`\|`validate`\|`upload`\|`publish`\|`platform`\|`ingest` | where it happened |
| `attempt` | int | |
| `stack` | string ≤ 16 KiB | optional |
| `details` | object ≤ 4 KiB | optional, type-specific: `{exitCode, signal, oomKilled}` for a `crash` of a connector process; `{deathReason, deathQueue, deliveryCount, acquiredCount}` for a dead-lettered analysis (values of the broker headers `x-first-death-reason`, `x-first-death-queue`, `x-delivery-count`, `x-acquired-count`, [queue](queue.md) §7) |
| `at` | Date | |

Attempt: `{attempt, round, executionId, workerId, nodeId, startedAt, finishedAt, durationMs, error: ScantorError | null, logTail}`
(`logTail` ≤ 4 KiB for non-final attempts).

FileRef: `{id: uuid, name: string, size: int, sha256: hex, contentType: string}`. `name` has 1–255 characters
and contains no NUL, `/` or `\` ([protocol](protocol.md) §5.6). The S3 `key` is stored as an *internal* extra
field on entries of `files[]` only.

```json
{
  "_id": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-1234",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "seq": 1234,
  "round": 1,
  "status": "succeeded",
  "attempt": 2,
  "config": { "origin": "https://example.org" },
  "result": { "status": 200, "title": "Example", "screenshot": { "id": "e0c4…", "name": "screenshot.png", "size": 48213, "sha256": "9f86…", "contentType": "image/png" } },
  "attempts": [
    { "attempt": 1, "round": 1, "executionId": "a1…", "workerId": "w1…", "nodeId": "n1…", "startedAt": { "$date": "2026-10-21T10:01:00.000Z" }, "finishedAt": { "$date": "2026-10-21T10:01:30.000Z" }, "durationMs": 30000, "error": { "type": "timeout", "message": "run exceeded 30000 ms", "retryable": true, "phase": "run", "attempt": 1, "at": { "$date": "2026-10-21T10:01:30.000Z" } }, "logTail": "…" },
    { "attempt": 2, "round": 1, "executionId": "b2…", "workerId": "w2…", "nodeId": "n1…", "startedAt": { "$date": "2026-10-21T10:01:36.000Z" }, "finishedAt": { "$date": "2026-10-21T10:01:37.200Z" }, "durationMs": 1200, "error": null, "logTail": "" }
  ],
  "files": [ { "id": "e0c4…", "name": "screenshot.png", "size": 48213, "sha256": "9f86…", "contentType": "image/png", "key": "files/5e1f…/1234/b2…/e0c4…/screenshot.png" } ],
  "logTail": "fetching https://example.org\n",
  "timings": { "scheduledAt": { "$date": "2026-10-21T10:00:05.000Z" }, "startedAt": { "$date": "2026-10-21T10:01:36.000Z" }, "finishedAt": { "$date": "2026-10-21T10:01:37.200Z" }, "durationMs": 1200 },
  "workerId": "w2…", "nodeId": "n1…", "executionId": "b2…",
  "createdAt": { "$date": "2026-10-21T10:01:30.100Z" },
  "updatedAt": { "$date": "2026-10-21T10:01:37.400Z" }
}
```

Indexes:

| Keys | Options | Serves |
|---|---|---|
| `{scanId: 1, seq: 1}` | unique | pagination, exports, gap scans, batched deletes |
| `{scanId: 1, status: 1, seq: 1}` | | recount (`$group` by status), status filters, retry-failed cursor |

### 4.7 `workers`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | worker id; container `scantor-w-<id>`; token subject |
| `userId`, `scanId` | uuid | ✓ | |
| `role` | `scheduler`\|`runner` | ✓ | |
| `nodeId` | uuid \| null | ✓ | set once at assignment, never changes |
| `epoch` | int | ✓ | scheduler: the scan epoch it was created with; runners 0 |
| `state` | WorkerState | ✓ | §6.6 |
| `stateReason` | `{code, message, at}` \| null | ✓ | pending reasons (§4.5.4 `workersPending`), `backoff` cause, `lost` cause (`nodeOffline`, `nodeRevoked`, `nodeDeleted`) |
| `spec` | object | ✓ | `{repository, digest, resources: {cpus, memoryMiB}, privileged, dindMode: null\|"sysbox"\|"privileged", specHash}` |
| `processes` | object | ✓ | `{desired, assigned, applied, running}`: desired = `settings.processes` of the scan for runners, always 1 for the scheduler (at most one connector process); assigned = value sent to the node; applied = node-reported limits; running = runtime-reported open slots |
| `container` | object \| null | ✓ | `{id, name, startedAt, restarts, lastExit: {exitCode, oomKilled, at, logTail} \| null, nextRestartAt}` |
| `runtime` | object \| null | ✓ | `{version, protocolVersion, bootstrappedAt, lastSeenAt, lastError: ScantorError \| null}` |
| `logs` | object \| null | ✓ | on-demand tail: `{requestId, requestedAt, tailBytes, text, collectedAt, truncated}` |
| `createdAt`, `assignedAt`, `startedAt`, `stoppedAt`, `updatedAt` | Date \| null | ✓ | |
| `expiresAt` | Date | – | set on `stopped`/`lost` to `stoppedAt + 7 days` (TTL) |

The busy list of each worker (`busy[]` from state polls) is kept **in memory only** and served by
`listInflightAnalyses`.

```json
{
  "_id": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "role": "runner",
  "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "epoch": 0,
  "state": "running",
  "stateReason": null,
  "spec": { "repository": "tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c", "digest": "sha256:4e5f…", "resources": { "cpus": 1, "memoryMiB": 512 }, "privileged": false, "dindMode": null, "specHash": "sha256:5d41…" },
  "processes": { "desired": 2, "assigned": 2, "applied": 2, "running": 2 },
  "container": { "id": "f1e2d3c4b5a6", "name": "scantor-w-9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "startedAt": { "$date": "2026-10-21T10:00:20.000Z" }, "restarts": 0, "lastExit": null, "nextRestartAt": null },
  "runtime": { "version": "1.4.0", "protocolVersion": 1, "bootstrappedAt": { "$date": "2026-10-21T10:00:21.000Z" }, "lastSeenAt": { "$date": "2026-10-21T10:05:00.000Z" }, "lastError": null },
  "logs": null,
  "createdAt": { "$date": "2026-10-21T10:00:01.000Z" },
  "assignedAt": { "$date": "2026-10-21T10:00:01.200Z" },
  "startedAt": { "$date": "2026-10-21T10:00:20.000Z" },
  "stoppedAt": null,
  "updatedAt": { "$date": "2026-10-21T10:05:00.000Z" }
}
```

Indexes: `{scanId: 1, role: 1, state: 1}`, `{nodeId: 1, state: 1}`, `{userId: 1, state: 1}`,
`{expiresAt: 1}` with `expireAfterSeconds: 0`.

### 4.8 `nodes`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | node id |
| `name` | slug | ✓ | unique; the built-in node record is named `builtin` |
| `builtIn` | boolean | ✓ | the master's node (exactly one; upserted at every boot) |
| `state` | `pending`\|`online`\|`offline`\|`revoked` | ✓ | §6.7 |
| `endpointProfile` | `internal`\|`public` | ✓ | `internal` only for the built-in node |
| `tokenHash` | hex SHA-256 \| null | ✓ | *internal*; null when revoked. For the built-in node it is the hash of the HKDF-derived token, rewritten at every boot |
| `tokenPrefix` | string | – | first 8 characters of the token (`snt_ab12`) for display |
| `tokenRotatedAt` | Date \| null | ✓ | |
| `pool` | slug | ✓ | default `shared` |
| `labels` | map string → string | ✓ | ≤ 32 entries; keys `^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$`, values ≤ 63 chars |
| `maxWorkers` | int \| null | ✓ | admin override; effective capacity = min(`info.maxWorkers`, `maxWorkers`) |
| `cordoned` | boolean | ✓ | no new placements; existing workers stay |
| `instance` | `{id, version, startedAt, lastSeenAt}` \| null | ✓ | lease holder; the lease is live while `lastSeenAt > now − SCANTOR_NODE_OFFLINE_AFTER` |
| `info` | object \| null | ✓ | last report: `{version, hostname, os, arch, kernel, dockerVersion, cpus, memoryBytes, diskFreeBytes, dindMode: "disabled"\|"sysbox"\|"privileged", maxWorkers, egressDenyApplied, clockOffsetMs}`. `dindMode` is the **effective** mode (daemon `SCANTOR_NODE_DIND`, but a node configured for `sysbox` without the `sysbox-runc` runtime reports `disabled`); `maxWorkers` is daemon `SCANTOR_NODE_MAX_WORKERS` (0 → number of CPUs) |
| `assignmentsRev` | int ≥ 0 | ✓ | desired-state revision; incremented on every change of the node's desired set or log requests |
| `lastSeenAt` | Date \| null | ✓ | last hello/status |
| `createdBy` | uuid \| null | ✓ | admin who created it (null for built-in) |
| `createdAt`, `updatedAt` | Date | ✓ | |

```json
{
  "_id": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "name": "scan-eu-1",
  "builtIn": false,
  "state": "online",
  "endpointProfile": "public",
  "tokenHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "tokenPrefix": "snt_3q8Z",
  "tokenRotatedAt": null,
  "pool": "shared",
  "labels": { "region": "eu" },
  "maxWorkers": null,
  "cordoned": false,
  "instance": { "id": "4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e", "version": "1.4.0", "startedAt": { "$date": "2026-10-21T07:00:00.000Z" }, "lastSeenAt": { "$date": "2026-10-21T10:05:10.000Z" } },
  "info": { "version": "1.4.0", "hostname": "scan-eu-1", "os": "linux", "arch": "amd64", "kernel": "6.8.0-48-generic", "dockerVersion": "29.9.2", "cpus": 16, "memoryBytes": 68719476736, "diskFreeBytes": 409600000000, "dindMode": "disabled", "maxWorkers": 8, "egressDenyApplied": true, "clockOffsetMs": -8 },
  "assignmentsRev": 43,
  "lastSeenAt": { "$date": "2026-10-21T10:05:10.000Z" },
  "createdBy": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "createdAt": { "$date": "2026-10-20T12:00:00.000Z" },
  "updatedAt": { "$date": "2026-10-21T10:05:10.000Z" }
}
```

Indexes: `{name: 1}` unique; `{tokenHash: 1}` unique with `partialFilterExpression: {tokenHash: {$type: "string"}}`;
`{builtIn: 1}` unique with `partialFilterExpression: {builtIn: true}`; `{state: 1}`.

### 4.9 `credentials`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id`, `userId` | uuid | ✓ | |
| `kind` | `gitToken` | ✓ | HTTPS token for git import/pull |
| `name` | string ≤ 64 | ✓ | unique per user |
| `host` | string | ✓ | lowercase `host[:port]` the token is sent to (exact match) |
| `username` | string ≤ 128 | ✓ | Basic username (default `x-access-token`) |
| `secretEnc` | encrypted string | ✓ | *internal*; the token (HKDF label `credentials`) |
| `last4` | string | ✓ | last 4 characters for display |
| `lastUsedAt` | Date \| null | ✓ | |
| `createdAt`, `updatedAt` | Date | ✓ | |

```json
{
  "_id": "6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "kind": "gitToken",
  "name": "github",
  "host": "github.com",
  "username": "x-access-token",
  "secretEnc": "enc:v1:3sK9qZ1mX0bVn4Tc:Q2lwaGVydGV4dEFuZFRhZw…",
  "last4": "9fQz",
  "lastUsedAt": null,
  "createdAt": { "$date": "2026-10-21T08:00:00.000Z" },
  "updatedAt": { "$date": "2026-10-21T08:00:00.000Z" }
}
```

Indexes: `{userId: 1, name: 1}` unique.

### 4.10 `uploads`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id`, `userId` | uuid | ✓ | |
| `kind` | `list` | ✓ | newline-separated items for the `list` template (future kinds possible) |
| `name` | string ≤ 255 | ✓ | original file name (metadata only) |
| `contentType` | string | ✓ | |
| `bytes` | int | ✓ | ≤ `SCANTOR_MAX_UPLOAD_BYTES` |
| `sha256` | hex | ✓ | content hash; unique per user (identical uploads return the existing doc) |
| `lines` | int | ✓ | non-empty lines (list kind): each line is trimmed of ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`); empty results do not count (the rule of [templates](templates.md) §9.2) |
| `key` | string | ✓ | *internal*; `uploads/<userId>/<sha256>` |
| `lastUsedAt` | Date \| null | ✓ | |
| `createdAt`, `updatedAt` | Date | ✓ | |

```json
{
  "_id": "4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "kind": "list",
  "name": "targets.txt",
  "contentType": "text/plain",
  "bytes": 182044,
  "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "lines": 10000,
  "key": "uploads/0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11/2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "lastUsedAt": null,
  "createdAt": { "$date": "2026-10-21T08:10:00.000Z" },
  "updatedAt": { "$date": "2026-10-21T08:10:00.000Z" }
}
```

Indexes: `{userId: 1, sha256: 1}` unique; `{userId: 1, createdAt: -1}`.

### 4.11 `events`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | |
| `at` | Date | ✓ | event time (TTL field) |
| `type` | string | ✓ | catalog below |
| `level` | `info`\|`warning`\|`error` | ✓ | |
| `userId` | uuid \| null | ✓ | owner of the subject; null = admin-only (node and security events) |
| `scanId`, `taskId`, `revisionId`, `workerId`, `nodeId` | uuid | – | subject references |
| `message` | string ≤ 1 KiB | ✓ | human-readable |
| `data` | object ≤ 8 KiB | – | type-specific |

| Type | Level | Data |
|---|---|---|
| `scan.created` | info | `{revision, settings}` |
| `scan.stateChanged` | info/warning/error | `{from, to, reason}` |
| `scan.scaled` | info | `{workers, processes}` |
| `scan.retryFailed` | info | `{round, count}` |
| `scan.restarted` | info | `{newScanId}` |
| `scan.conditionRaised` / `scan.conditionCleared` | per condition | `{type, reason}` |
| `scan.schedulingResolved` | info | `{key, template, provenance}` |
| `scan.schedulingDone` | info | `{confirmed}` |
| `scan.schedulingFailed` | error | `{error}` |
| `scan.lostAnalyses` | warning | `{count}` |
| `worker.placed` / `worker.pending` / `worker.started` / `worker.stopped` | info/warning | `{nodeId, reason?}` |
| `worker.crashed` | error | `{exitCode, oomKilled, restarts}` |
| `worker.error` | warning | `{error}` |
| `worker.lost` | warning | `{reason}` |
| `revision.ready` / `revision.failed` | info/error | `{number, errors?}` |
| `node.online` / `node.offline` / `node.revoked` / `node.tokenRotated` / `node.instanceConflict` | info/warning | `{instanceId?}` |
| `security.ingestRejected` | warning | `{reason, routingKey, userIdProperty}` |

```json
{
  "_id": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
  "at": { "$date": "2026-10-21T10:04:58.100Z" },
  "type": "worker.crashed",
  "level": "error",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "workerId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "nodeId": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  "message": "worker exited with code 137 (OOM killed), restart 3",
  "data": { "exitCode": 137, "oomKilled": true, "restarts": 3 }
}
```

Indexes: `{scanId: 1, at: -1}` (partial: `scanId` exists), `{userId: 1, at: -1}`, `{nodeId: 1, at: -1}`
(partial: `nodeId` exists), `{at: 1}` with `expireAfterSeconds = SCANTOR_EVENTS_TTL_DAYS × 86400`.

### 4.12 `jobs`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id` | uuid | ✓ | |
| `kind` | JobKind | ✓ | below |
| `userId` | uuid \| null | ✓ | owner of the subject |
| `subject` | `{kind: "revision"\|"testRun"\|"scan"\|"export"\|"task"\|"user", id}` | ✓ | |
| `state` | `queued`\|`running`\|`succeeded`\|`failed`\|`cancelled` | ✓ | §6.8 |
| `active` | boolean | ✓ | true while `queued` or `running` (partial unique index) |
| `params` | object | ✓ | kind-specific input |
| `cursor` | object | ✓ | kind-specific resume position, persisted after every batch |
| `progress` | `{done, total}` | ✓ | `total` may be null |
| `attempts`, `maxAttempts` | int | ✓ | |
| `lease` | `{owner, expiresAt}` \| null | ✓ | owner = orchestrator instance id `<hostname>:<pid>:<bootNonce>`; renewed every 10 s, 30 s lease |
| `notBefore` | Date | ✓ | earliest (re)start |
| `error` | `{code, message}` \| null | ✓ | |
| `createdAt`, `startedAt`, `finishedAt`, `updatedAt` | Date \| null | ✓ | |
| `expiresAt` | Date | – | `finishedAt + 7 days` (TTL) |

| Kind | Component | Subject | `params` | `cursor` | Concurrency |
|---|---|---|---|---|---|
| `revisionBuild` | api | revision | `{revisionId}` | `{phase: "build"\|"push"\|"waitRegistry"\|"finalize"}`, set as in [tasks](tasks.md) §9.7; registry GC waits while any job has `phase: "push"` ([deployment](deployment.md) §14.1); restarts from scratch (from the stored snapshot) after a lease expiry | `SCANTOR_BUILD_CONCURRENCY` (shared with test-run builds), FIFO |
| `testRun` | api | testRun | `{testRunId}` | `{phase}` | `SCANTOR_TEST_RUN_CONCURRENCY` |
| `scanDelete` | reconciler | scan | `{}` | `{phase, afterSeq}` | 2 |
| `scanRetryFailed` | reconciler | scan | `{round, materialize}` (`materialize`: the scan was cancelled, so never-run seqs are first inserted as `cancelled`) | `{phase: "materialize"\|"reset"\|"publish"\|"finish", afterSeq}` | 2 |
| `export` | reconciler | export | `{exportId}` | `{afterSeq, part}` | `SCANTOR_USER_MAX_CONCURRENT_QUERIES` per user |
| `taskDelete` | reconciler | task | `{}` | `{phase}` | 2 |
| `userPurge` | reconciler | user | `{}` | `{phase, scanId?}` | 1 |

```json
{
  "_id": "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a",
  "kind": "scanRetryFailed",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "subject": { "kind": "scan", "id": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f" },
  "state": "running",
  "active": true,
  "params": { "round": 2, "materialize": false },
  "cursor": { "phase": "publish", "afterSeq": 41211 },
  "progress": { "done": 37, "total": 102 },
  "attempts": 1,
  "maxAttempts": 5,
  "lease": { "owner": "orchestrator-7f9c:1:5b2e", "expiresAt": { "$date": "2026-10-21T11:00:30.000Z" } },
  "notBefore": { "$date": "2026-10-21T11:00:00.000Z" },
  "error": null,
  "createdAt": { "$date": "2026-10-21T11:00:00.000Z" },
  "startedAt": { "$date": "2026-10-21T11:00:00.200Z" },
  "finishedAt": null,
  "updatedAt": { "$date": "2026-10-21T11:00:10.000Z" }
}
```

Indexes: `{state: 1, kind: 1, notBefore: 1, createdAt: 1}`, `{state: 1, "lease.expiresAt": 1}`,
`{kind: 1, "subject.id": 1}` unique with `partialFilterExpression: {active: true}` (one active job per
kind and subject), `{userId: 1, createdAt: -1}`, `{expiresAt: 1}` with `expireAfterSeconds: 0`.

### 4.13 `locks`

| Field | Type | Meaning |
|---|---|---|
| `_id` | string | lock name: `reconciler`, `gc`, `bootSweep`, `migrations`, `registryGc` |
| `owner` | string | orchestrator instance id |
| `acquiredAt`, `expiresAt` | Date | lease (30 s, renewed every 10 s) |

```json
{ "_id": "reconciler", "owner": "orchestrator-7f9c:1:5b2e", "acquiredAt": { "$date": "2026-10-21T07:00:00.000Z" }, "expiresAt": { "$date": "2026-10-21T11:00:30.000Z" } }
```

Acquire or renew: `findOneAndUpdate({_id, $or: [{expiresAt: {$lt: now}}, {owner: me}]}, {$set: {owner: me,
expiresAt: now + 30s}, $setOnInsert: {acquiredAt: now}}, {upsert: true})`; an E11000 means another owner
holds it. Release: `deleteOne({_id, owner: me})`. No extra indexes.

### 4.14 `exports`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `_id`, `userId`, `scanId` | uuid | ✓ | |
| `format` | `jsonl`\|`csv` | ✓ | |
| `filter` | object | ✓ | validated query filter (same allowlist as `queryAnalyses`); `{}` = all |
| `fields` | string[] \| null | ✓ | dot paths to include; null = whole docs (jsonl) / default columns (csv) |
| `afterSeq` | int \| null | ✓ | start after this seq |
| `state` | `queued`\|`running`\|`ready`\|`failed` | ✓ | §6.9 |
| `key` | string | ✓ | *internal*; `exports/<userId>/<exportId>.<format>` |
| `bytes`, `rows` | int | ✓ | |
| `error` | `{code, message}` \| null | ✓ | |
| `jobId` | uuid | ✓ | |
| `createdAt`, `finishedAt`, `updatedAt` | Date \| null | ✓ | |
| `expiresAt` | Date | ✓ | `createdAt + SCANTOR_EXPORT_RETENTION_DAYS` (TTL; the S3 lifecycle rule uses the same days) |

```json
{
  "_id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b",
  "userId": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "scanId": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
  "format": "jsonl",
  "filter": { "status": "succeeded" },
  "fields": null,
  "afterSeq": null,
  "state": "ready",
  "key": "exports/0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11/e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b.jsonl",
  "bytes": 734003200,
  "rows": 99811,
  "error": null,
  "jobId": "f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b9c",
  "createdAt": { "$date": "2026-10-21T12:00:00.000Z" },
  "finishedAt": { "$date": "2026-10-21T12:03:10.000Z" },
  "updatedAt": { "$date": "2026-10-21T12:03:10.000Z" },
  "expiresAt": { "$date": "2026-10-28T12:00:00.000Z" }
}
```

Indexes: `{userId: 1, createdAt: -1}`, `{scanId: 1}`, `{expiresAt: 1}` with `expireAfterSeconds: 0`.

### 4.15 `editors`

| Field | Type | Meaning |
|---|---|---|
| `_id` | uuid | the user id |
| `state` | `starting`\|`running`\|`stopping`\|`stopped` | §6.10 |
| `containerId`, `containerName` | string \| null | `scantor-editor-<userId>` |
| `image` | string | editor image reference (`<SCANTOR_IMAGE_PREFIX>scantor-editor:<SCANTOR_IMAGE_TAG>` at start) |
| `apiKeyId` | string \| null | *internal*; current better-auth `apikey` id (`configId: editor`) |
| `apiKeyExpiresAt` | Date \| null | *internal*; expiry of the current editor key (start time + `SCANTOR_EDITOR_API_KEY_TTL`; a new key is minted at every start and revoked at every stop); the reaper stops the editor 5 minutes before it ([editor](editor.md) §6.4) |
| `startedAt` | Date \| null | set on entering `starting`; binds `scantor_editor` cookies, so stopping or restarting an editor invalidates all its cookies |
| `lastActivityAt`, `stoppedAt`, `updatedAt` | Date \| null | `lastActivityAt` is written at most once per 60 s from proxied requests and open WebSockets |
| `error` | string \| null | last start failure |

```json
{
  "_id": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "state": "running",
  "containerId": "c0d1e2f3a4b5",
  "containerName": "scantor-editor-0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
  "image": "ghcr.io/lonetis/scantor-editor:1.4.0",
  "apiKeyId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "apiKeyExpiresAt": { "$date": "2026-10-28T09:00:00.000Z" },
  "startedAt": { "$date": "2026-10-21T09:00:00.000Z" },
  "lastActivityAt": { "$date": "2026-10-21T09:40:00.000Z" },
  "stoppedAt": null,
  "updatedAt": { "$date": "2026-10-21T09:40:00.000Z" },
  "error": null
}
```

Indexes: `{state: 1, lastActivityAt: 1}` (idle reaper).

### 4.16 `meta`

`{_id: "schema", version: 1, updatedAt}`. Future singleton documents use other fixed `_id` values.

## 5. Ownership rules

| Collection | Visible to | Mutable by |
|---|---|---|
| `tasks`, `revisions`, `testRuns`, `testRunAnalyses`, `scans`, `analyses`, `workers`, `uploads`, `exports`, `credentials` | owner and admins (`credentials` never expose secrets) | owner and admins through the API; system components |
| `events` | owner (rows with their `userId`) and admins (all, including `userId: null`) | system only |
| `jobs` | owner and admins (`GET /api/jobs/{id}`) | system only |
| `nodes` | admins | admins (API), nodes (their own record through `/api/node/*`) |
| `editors` | the user it belongs to | editor manager |
| `locks`, `meta` | – | system only |

- Not owned → 404, never 403 ([api](api.md) §ownership).
- Derived documents copy `userId` from their parent: revisions and test runs from the task, analyses and
  workers from the scan, a restart clone from the original scan, exports from the scan.
- Top-level creates (`tasks`, `scans`, `uploads`, `credentials`, API keys) are owned by the caller and may
  reference only the caller's own documents (revision, uploads, credential).
- User deletion (`userPurge` job) cancels the user's scans, then deletes in order: editors and editor API
  key, exports, scans (scan-delete logic, including analyses and files), test runs, revisions and task
  images, tasks, the user's workspace and editor-home directories (helper `purge`), uploads, credentials,
  events, jobs; finally the better-auth user.

## 6. State machines

Unlisted transitions are forbidden. API attempts at forbidden transitions return 409 `invalidState` with
`details: {state, allowed}`.

### 6.1 Scan state

```
creating ──topology──► running ──pause / breaker──► paused
    │                   │  ▲                          │
    │                   │  └──────────resume──────────┘
    │                   ├──completion──► completed | failed
    │                   │
    └──────cancel───────┴──────cancel (also from paused)──► cancelled

completed | failed | cancelled ──retry-failed──► running
completed | failed | cancelled ──delete──► deleting ──job──► deleted ──TTL purgeAfter──► (purged)
```

| From | To | Trigger | Actor |
|---|---|---|---|
| – | `creating` | `startScan`, `restartScan` | API |
| `creating` | `running` | topology ensured | reconciler |
| `creating`, `running`, `paused` | `cancelled` | `cancelScan` | API |
| `running` | `paused` | `pauseScan` (`stateReason.code=user`) or breaker (`failureRate`) | API / ingestor |
| `paused` | `running` | `resumeScan` | API |
| `running` | `completed` | completion function with `scheduling.error == null` | ingestor / reconciler |
| `running` | `failed` | completion function with `scheduling.error != null` | ingestor / reconciler |
| `completed`, `failed`, `cancelled` | `running` | `retryFailedAnalyses` | API |
| `completed`, `failed`, `cancelled` | `deleting` | `deleteScan` | API |
| `deleting` | `deleted` | `scanDelete` job finished | jobs runner |

Completion function (the only path to `completed`/`failed`, idempotent):
1. Recount: `aggregate([{$match: {scanId}}, {$group: {_id: "$status", n: {$sum: 1}}}])`; write `stats` and
   `recountedAt`.
2. If `succeeded + failed + lost + cancelled ≥ scheduling.confirmed`:
   `findOneAndUpdate({_id, state: "running", round: R, "scheduling.state": {$in: ["done", "failed"]}},
   {$set: {state: <"failed" if scheduling.error else "completed">, stateReason, stats, completedAt}})`.

### 6.2 `scan.scheduling.state`

| From | To | Trigger | Actor |
|---|---|---|---|
| – | `pending` | scan created | API |
| `pending` | `running` | first scheduler bootstrap | API (bootstrap) |
| `pending`, `running` | `done` | `scheduler/done` with `outcome: "done"` | API |
| `pending`, `running` | `failed` | `scheduler/done` with `outcome: "failed"` (non-deterministic schedule, validation, `SCANTOR_MAX_ANALYSES_PER_SCAN`); `restarts > SCANTOR_SCHEDULER_MAX_RESTARTS` | API / reconciler |
| `done`, `failed` | `retrying` | `retryFailedAnalyses` | API |
| `retrying` | `done` (no `error`) or `failed` (`error` set) | retry-failed job finished | jobs runner |

A scheduler worker exists only while the state is `pending` or `running`.

### 6.3 Analysis status and guarded upserts

| From | To | Trigger |
|---|---|---|
| (none), `pending`, `retrying` (same round, lower attempt), any doc of an older round | `retrying` | attempt event |
| (none), `pending`, `retrying`, `failed`, `lost`, `cancelled` (same round), any older round | `succeeded` | success result |
| (none), `pending`, `retrying`, `lost`, `cancelled` (same round), any older round | `failed` | failed result, dead-lettered analysis (`crash`), ingest error (`platform`, phase `ingest`) |
| `failed` or `lost` (with `config`) | `pending` (round + 1, attempt 0) | retry-failed job; `cancelled` documents and gap-filled `lost` documents (no `config`) are never reset |
| `pending`, `retrying` | `cancelled` | scan cancel (reconciler) |
| (none) | `lost` | stall detection gap fill (no `config`) |
| `pending`, `retrying` | `lost` | stall detection gap fill by the reconciler ([queue](queue.md) §9; for example analyses reset by retry-failed whose messages vanished); the documents keep their `config` |
| (none) | `cancelled` | retry-failed on a cancelled scan materialises never-run seqs |

The ingestor writes every result and attempt event as an upsert with `_id` and `scanId` in the filter. With
`R` = message round and `n` = message attempt:

| Message | Filter (besides `{_id, scanId}`) |
|---|---|
| succeeded(R) | `$or: [{round: {$lt: R}}, {round: R, status: {$in: ["pending", "retrying", "failed", "lost", "cancelled"]}}]` |
| failed(R) | `$or: [{round: {$lt: R}}, {round: R, status: {$in: ["pending", "retrying", "lost", "cancelled"]}}]` |
| retrying(R, n) | `$or: [{round: {$lt: R}}, {round: R, status: {$in: ["pending", "retrying"]}, attempt: {$lt: n}}]` |

If the document exists but the filter does not match, the upsert raises E11000 on `_id` for that one
operation: the message is a duplicate or was superseded; it is acked. Consequences: a later success beats a
failure in the same round; otherwise the first terminal result wins; older rounds never overwrite newer
ones. Results with `round` greater than `scan.round` are rejected as invalid.

### 6.4 Revision state

| From | To | Trigger | Actor |
|---|---|---|---|
| – | `queued` | `publishRevision`, `uploadTask` | API |
| `queued` | `building` | job claimed | jobs runner |
| `building` | `ready` | push succeeded, digest recorded | jobs runner |
| `queued`, `building` | `failed` | pipeline error, timeout, task deleted, job attempts exhausted | jobs runner |
| `building` | `queued` | job lease expired (orchestrator crash); rebuild from the snapshot | jobs runner |

### 6.5 Test-run state

| From | To | Trigger |
|---|---|---|
| – | `queued` | `testTask` |
| `queued` | `building` | job claimed (static checks and describe always run; only the image build is skipped when the draft image is cached) |
| `building` | `running` | draft image ready, described, configs valid |
| `running` | `completed` | runtime finished (any analysis outcome) |
| `queued`, `building`, `running` | `failed` | build/describe/config/schedule/platform error, total timeout |
| `queued`, `building`, `running` | `cancelled` | `cancelTestRun`, task deletion |

### 6.6 Worker state

| From | To | Trigger | Actor |
|---|---|---|---|
| – | `pending` | placement needs a worker | reconciler |
| `pending` | `assigned` | node chosen, `nodeId` set | reconciler |
| `assigned` | `pulling` | node reports pulling | node status |
| `assigned`, `pulling` | `starting` | node reports container created/started | node status |
| `starting`, `backoff` | `running` | first successful `runtimeBootstrap` | API |
| `starting`, `running` | `backoff` | node reports exit and restart backoff | node status |
| `backoff` | `starting` | node restarted the container | node status |
| `assigned` … `backoff` | `draining` | removed from the desired set (scale-in, pause, scheduling done, scan terminal, cancel) | reconciler |
| `draining` | `stopped` | node reports the container `removed`, or the worker is absent from two consecutive status reports (status `workers` is a complete snapshot, [api](api.md) §7.3) | node status |
| `pending` | `stopped` | no longer needed before placement | reconciler |
| `assigned` … `draining` | `lost` | node offline, node revoked or deleted | reconciler / API |

Active states (count against node capacity and user `maxWorkers`, token valid): `assigned`, `pulling`,
`starting`, `running`, `backoff`, `draining`. Terminal: `stopped`, `lost`.

### 6.7 Node state

| From | To | Trigger |
|---|---|---|
| – | `pending` | `createNode` (built-in: boot upsert) |
| `pending`, `offline` | `online` | successful hello or status |
| `online` | `offline` | no status for `SCANTOR_NODE_OFFLINE_AFTER` (reconciler); workers → `lost` |
| any | `revoked` | `revokeNodeToken`; workers → `lost` |
| `revoked` | `pending` | `rotateNodeToken` (new token) |

`cordoned` is an independent flag.

### 6.8 Job state

| From | To | Trigger |
|---|---|---|
| – | `queued` | created by an API handler (`active: true`) |
| `queued` | `running` | claimed with a lease (`attempts += 1`) |
| `running` | `succeeded` / `failed` | finished / non-retryable error or `attempts == maxAttempts` (`active: false`, `expiresAt` set) |
| `running` | `queued` | lease expired or retryable error (`notBefore` = backoff) |
| `queued`, `running` | `cancelled` | subject deleted or cancelled |

### 6.9 Export state

`queued → running → ready | failed`; `ready` documents disappear by TTL (`expiresAt`) together with the S3
object (lifecycle rule).

### 6.10 Editor state

`stopped → starting → running → stopping → stopped`; a failed start passes through `stopping` while its cleanup runs (`starting → stopping → stopped`, with `error`), so a concurrent stop or a reaper in another process never tears down twice.
`startedAt` is set on entering `starting`. At most `SCANTOR_EDITOR_MAX_RUNNING` editors are `starting` or
`running` at once (429 `tooManyRequests`). Idle for `SCANTOR_EDITOR_IDLE_TIMEOUT`, `apiKeyExpiresAt` less
than 5 minutes away, ban, user deletion or `stopEditor` trigger `stopping`; the editor API key is deleted on
every stop, and every start mints a new one.

## 7. Invariants

1. `analyses._id == scanId + "-" + seq`, with `scanId` taken only from the AMQP `user_id` (`scan-<scanId>`)
   and `seq` an integer 0 ≤ seq < 2^53. The ingestor builds documents field by field; it never spreads or
   `$set`s a message body.
2. Worker identity comes only from the worker token; node identity only from the node token. Request bodies
   never carry authoritative `scanId`, `workerId`, `nodeId` or `userId`.
3. `scheduling.confirmed` and `scan.round` only increase. Checkpoints are written with a conditional update
   (`"scheduling.epoch": epoch, "scheduling.confirmed": {$lt: confirmed}`).
4. At most one scheduler worker per scan is active, and only the one with the current epoch can checkpoint
   or finish.
5. For `completed` and `failed` scans: `succeeded + failed + lost + cancelled == scheduling.confirmed` after
   the final recount. For `cancelled` scans, seqs without a document count as cancelled.
6. Revision numbers per task strictly increase and are never reused; ready revisions are immutable;
   scans reference images by digest.
7. A scan document holds only scalars and bounded maps/arrays (`conditions` ≤ 16, `uploadIds` ≤ 32,
   `scheduling.resolved` ≤ 16 keys); unbounded data lives in `workers`, `events`, `analyses` or S3.
8. No plaintext secret is stored: API keys and node tokens are hashes; worker tokens, AMQP passwords and
   the built-in node token are derived; git tokens and `writeOnly` config values are encrypted.
9. After `deleted`: no analyses, workers, files, exports, events, RabbitMQ queue or user exist for the scan;
   only the tombstone, until `purgeAfter`.
10. `userId` on a document never changes and always equals the owner of its parent.
11. Every container scantor creates carries managed labels; the node daemon identifies its containers only
    by labels it set plus the name prefix.

## 8. Limits

All limits are enforced at the earliest point listed. Values come from the named env variable (documented in
`.env.example`) or are fixed by this spec.

| Limit | Value | Enforced by |
|---|---|---|
| analysis config size | `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES` | runtime (schedule `validation` error) |
| result size | `SCANTOR_MAX_RESULT_BYTES` | runtime (non-retryable `validation`), ingestor |
| result message size | 2 MiB; RabbitMQ `max_message_size` 4 MiB | runtime, broker |
| log tail per analysis | 32 KiB final attempt, 4 KiB earlier attempts | runtime |
| error stack | 16 KiB; message 4 KiB; details 4 KiB | runtime |
| attempts kept | 10 | ingestor (`$slice: -10`) |
| analyses per scan | `SCANTOR_MAX_ANALYSES_PER_SCAN` | API (estimate), runtime (schedule `validation`) |
| ready messages per scan queue | `SCANTOR_SCAN_QUEUE_MAX_READY` | broker (`x-max-length`, reject-publish) |
| delivery limit | `SCANTOR_DELIVERY_LIMIT` | broker |
| file size / files per analysis | `SCANTOR_MAX_FILE_BYTES` / `SCANTOR_MAX_FILES_PER_ANALYSIS` | runtime, presign |
| storage per user | `SCANTOR_USER_STORAGE_QUOTA_BYTES` (0 = unlimited) | presign |
| task/scan config size | `SCANTOR_MAX_SCAN_CONFIG_BYTES` each | API |
| request body | `SCANTOR_MAX_REQUEST_BYTES` | API middleware |
| task upload (compressed) | `SCANTOR_TASK_MAX_PACK_BYTES` | API (streaming), `task pack` |
| task files / uncompressed bytes | `SCANTOR_TASK_MAX_FILES` / `SCANTOR_TASK_MAX_BYTES` | workspace helpers, `task pack` |
| workspace per user | `SCANTOR_WORKSPACE_MAX_BYTES` | workspace helpers |
| list upload | `SCANTOR_MAX_UPLOAD_BYTES` | API (streaming) |
| workers per scan / processes per worker | `SCANTOR_MAX_WORKERS_PER_SCAN` / `SCANTOR_MAX_PROCESSES_PER_WORKER` | API, task pipeline (manifest defaults), runtime (clamps `processes` to bootstrap `limits.maxProcessesPerWorker`) |
| minimum free work space per worker | `SCANTOR_WORKER_MIN_FREE_TMP_BYTES` | runtime (stops consuming below it, worker unhealthy) |
| minimum free disk per node | `SCANTOR_NODE_MIN_FREE_DISK` | placement (`diskLow`), node daemon (emergency image GC) |
| active workers per user | `user.maxWorkers` | placement |
| image size | `SCANTOR_MAX_IMAGE_BYTES` | task pipeline |
| query time / documents | `SCANTOR_QUERY_MAX_TIME` / `SCANTOR_QUERY_MAX_DOCS` | query API |
| concurrent queries and exports per user | `SCANTOR_USER_MAX_CONCURRENT_QUERIES` | query/export API |
| concurrent `wait` requests per user | `SCANTOR_MAX_CONCURRENT_WAITS` | API |
| running editors | `SCANTOR_EDITOR_MAX_RUNNING` | editor manager (429) |
| concurrent workspace helpers | `SCANTOR_HELPER_CONCURRENCY` (a request waits ≤ 30 s for a slot, then 503) | helper runner |
| inline export size | `SCANTOR_EXPORT_INLINE_MAX` analyses | export API |
| test run | `limit` ≤ 50, `maxAttempts` ≤ 5, total `SCANTOR_TEST_RUN_TIMEOUT` | API, job |
| names | task/node slugs ≤ 64, scan name ≤ 100, credential name ≤ 64, upload name ≤ 255 | API |
| conditions per scan | 16 | reconciler |
| event message / data | 1 KiB / 8 KiB | event writer |
| node labels | 32 | API |

## 9. S3 layout

One private bucket `SCANTOR_S3_BUCKET`. Keys are generated by the server only; user-supplied names appear only
as a sanitised last segment (`safeName`: NFC, characters outside `[A-Za-z0-9._-]` replaced by `_`, at most
128 characters, never `.` or `..`, no empty segments) and as object metadata.

| Prefix / key | Content | Written by | Deleted by |
|---|---|---|---|
| `snapshots/<taskId>/<packSha256>.tar.gz` | deterministic task pack (immutable, content-addressed per task) | `publishRevision` / `uploadTask` (synchronously, before the revision is inserted; [architecture](architecture.md) §11.1 step 6) | `taskDelete` |
| `tmp/snapshots/<uuid>.tar.gz` | snapshot being streamed before its pack hash is known | `publishRevision` / `uploadTask` | the same request after the copy; lifecycle rule after 1 day for leftovers |
| `build-logs/<revisionId>.ndjson` | task-pipeline NDJSON events | `revisionBuild` job | `taskDelete` |
| `files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>` | analysis files; metadata `x-amz-meta-file-id`, `x-amz-meta-name` (`encodeURIComponent` of the name), signed as headers of the presigned PUT and returned in its `headers` ([api](api.md) §8.3) | runtime via presigned PUT | `scanDelete` (whole `files/<scanId>/` prefix) |
| `test-runs/<testRunId>/build.ndjson`, `test-runs/<testRunId>/log.ndjson`, `test-runs/<testRunId>/files/<seq>/<fileId>/<safeName>` | test-run logs and files | `testRun` job | lifecycle rule after `SCANTOR_TEST_RUN_RETENTION_DAYS` |
| `exports/<userId>/<exportId>.<jsonl\|csv>` | background exports | `export` job | lifecycle rule after `SCANTOR_EXPORT_RETENTION_DAYS`, `deleteExport`, `scanDelete` |
| `uploads/<userId>/<sha256>` | uploaded list files (immutable) | `createUpload` | `deleteUpload`, `userPurge` |

Bucket configuration (ensured at boot): private ACL, CORS allowing `GET`/`HEAD` from the dashboard origin
only, lifecycle rules for `test-runs/`, `exports/` and `tmp/` (1 day), and `AbortIncompleteMultipartUpload`
after 1 day.

## 10. RabbitMQ objects (summary)

Details, arguments and message schemas are in [queue](queue.md).

| Object | Name | Notes |
|---|---|---|
| vhost | `scantor` | `default_queue_type: quorum` |
| exchange | `scantor.analyses` (topic) | analysis messages, routing key `<scanId>` |
| exchange | `scantor.results` (topic) | result and attempt messages, routing key `<scanId>`, `user_id` = `scan-<scanId>` |
| exchange | `scantor.dead` (topic) | dead letters, original routing key kept |
| queue | `scantor.scan.<scanId>` (quorum, per scan) | bound to `scantor.analyses` with `<scanId>`; delivery limit, DLX `scantor.dead` (at-least-once), `x-overflow=reject-publish`, `x-max-length`, `x-consumer-timeout`; deleted in terminal states, recreated by retry-failed |
| queue | `scantor.results.ingest` (quorum) | bound `#` on `scantor.results`; `x-delivery-limit: 3`; DLX `scantor.dead` with `x-dead-letter-strategy: at-least-once` and `x-overflow: reject-publish` (required for at-least-once dead-lettering; no `x-max-length`, so it never refuses results) |
| queue | `scantor.dead.ingest` (quorum) | bound `#` on `scantor.dead`; `x-delivery-limit: 20`, no DLX; consumed by the ingestor's dead-letter consumer (dead analyses → `failed`/`crash`; poison results → `security.ingestRejected` event) |
| user | orchestrator admin user | management API and AMQP for the orchestrator |
| user | `scan-<scanId>` (per scan) | password `HMAC(HKDF(SCANTOR_SECRET, "amqp"), scanId)`, never stored; configure `^$`, write `^scantor\.(analyses\|results)$`, read `^scantor\.scan\.<scanId>$`; topic write `^<scanId>$` on both exchanges; `max-connections` / `max-channels` limits; deleting it is the cancel kill switch |

Message bodies (camelCase JSON, `v: 1`): analysis `{v, analysisId, scanId, seq, round, attempt, config,
scheduledAt}`; result and attempt messages add `kind`, `executionId`, `workerId`, `nodeId`, timings, and
`status`/`result`/`error`/`files`/`logTail` as applicable. AMQP bodies use epoch-millisecond integers for
times.

## 11. Decisions made in this document

The lead's round-1 rulings accepted items 1, 3, 4, 5, 7, 9 and 12 explicitly; the other items stand as
written. Item 14 records a round-1 ruling.

1. **Analysis statuses `lost` and `cancelled`** are first-class (instead of `failed` with a `lost` error).
   Never-run seqs of a cancelled scan are implicitly cancelled (no gap fill on cancel); retry-failed on a
   cancelled scan materialises them first.
2. **No standalone `userId` index on `analyses`.** Every analysis access is scoped by `scanId` after the scan's
   ownership check; at 20 M documents an extra index costs about a third more index memory for no query.
   User purge deletes per scan.
3. **`testRunAnalyses`** collection holds test-run outputs (same shape as analyses), keeping test-run
   documents small.
4. **`uploads`** collection for list-template inputs, de-duplicated per user by SHA-256; configs reference
   uploads through fields annotated `"x-scantor": "upload"`.
5. **`writeOnly` config values are encrypted at rest** (`scans.secrets`, `testRuns.secrets`) and stored masked
   in the config fields.
6. **`scheduling.resolved` is a keyed map** (`schedule`, `call:<n>`) so wrapped template calls resolve and
   resume independently.
7. **Scheduling after retry-failed** returns to `failed` iff `scheduling.error` is set; the completion outcome
   is `failed` iff `scheduling.error` is set.
8. **Jobs carry an `active` flag** for the partial unique index (one active job per kind and subject).
9. **`editors` and `meta` collections**; task names are immutable and must equal the manifest name.
10. **Worker docs expire** 7 days after stopping (TTL), so scale churn on long scans stays bounded.
11. **File keys include the file id** (`files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>`), so
    sanitised names can never collide; the original name is kept as metadata and in the FileRef. The
    `fileId` is generated by the runtime when the connector registers the file (the FileRef must exist
    during `run`, uploads happen after it); the server validates it and builds the key itself.
12. **`tasks.workspace.lastSyncSha256`** and **dirty against `latestRevision`** (any state) are adopted from
    [tasks](tasks.md) §13/§15: every published snapshot is stored, so comparing with the last published
    content loses nothing and a failed build does not block the next push.
13. **BuildError phases `config` and `schedule`** exist only in `testRuns.errors`; revisions use the
    task-pipeline phases.
14. **Retry-failed also resets `lost` analyses that still have a `config`** (those converted from
    `pending`/`retrying` by stall detection), besides `failed` ones. Gap-filled `lost` documents have no config
    and `cancelled` analyses are never retried; restart the scan to redo them.

## 12. Future extensions

| Extension | Accommodation |
|---|---|
| Cron / recurring scans | A `schedules` collection (owner, revision ref, configs, settings, cron expression) that creates scans through `startScan`; scans gain an optional `scheduleId`. |
| Scan priorities | `settings.priority` field; placement ordering and queue priority. |
| Per-user node-pool allowances | `user.allowedPools` additional field; placement filter. |
| `ctx.memo` | Another keyed entry type in `scheduling.resolved` (≤ 64 KiB values). |
| STS-scoped S3 credentials, multipart > 5 GiB | No data-model change; keys already per scan prefix; `AbortIncompleteMultipartUpload` already configured. |
| Multi-arch images | `revision.image.platform` becomes an array of platforms of an index digest; placement filter checks membership. |
| Organisations / shared tasks | Ownership is a single `userId` today; a future `ownerRef {kind, id}` can replace it, with the same scoping helper. |
| Time-series metrics history | A capped or time-series collection fed by the metrics component. |
| Additional upload kinds (CIDR files, seeds) | `uploads.kind` enum; templates reference them through `"x-scantor": "upload"`. |
| Editor kinds (JupyterLab, terminal) | an `editors.kind` field selecting image and flags; the cookie already binds `startedAt`. |
