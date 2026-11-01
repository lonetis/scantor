# scantor features

The canonical, numbered inventory of user-visible behaviour that drives test coverage ([testing](../docs/testing.md)
§10). Each feature is one line: its id in bold, the surfaces that exercise it in brackets, and the observable
behaviour in present tense, including validation and error paths. Mechanisms are documented in the `docs/`
sections each area links.

Every id is covered by at least one Playwright test tagged with it (`{ tag: ['@SCAN-012'] }`); `just test-index
--check` fails on uncovered ids and on tags that name no id. Ids are stable: a new feature takes the next free
number of its area, and the id of a removed feature is never reused. Behaviour that only Go or vitest unit tests
can reach (for example the private-host rule of git imports, which the test stack allows) is not listed here; it
is covered next to the code ([testing](../docs/testing.md) §4).

Surfaces: `api` REST API · `ui` dashboard in a browser · `cli` the `scantor` CLI · `mcp` the MCP endpoint · `e2e`
real builds and scans end to end · `authz` the generated authorization matrix and OpenAPI lint · `security`
corpora, white-box and throwaway-orchestrator security tests · `chaos` fault injection.

## API. REST conventions

Mechanisms: [api](../docs/api.md) §1.

- **API-001** [api] Every `/api` response carries an `X-Request-Id` header: a valid incoming value (1–128 characters of `[A-Za-z0-9._:-]`) is echoed back, any other value is replaced by a generated uuid.
- **API-002** [api] Errors use the envelope `{error: {code, message, details?}}` with `Content-Type: application/json` and `Cache-Control: no-store`; an unexpected failure is 500 `internal` with `details.requestId` and no internal message.
- **API-003** [api, security] Deny by default: an `/api` path that matches no operation returns 404 `notFound` (also `/api//users`; one trailing slash is tolerated), and a known path with the wrong method returns 405 `methodNotAllowed` with an `Allow` header and `details.allowed`.
- **API-004** [api] An unknown key in a JSON body or in the query string returns 400 `validationFailed` with `details.issues` `[{path: <key>, message: "unknown field"}]`.
- **API-005** [api] A non-empty body whose `Content-Type` is not `application/json` returns 415 `unsupportedMediaType`, malformed JSON returns 400 `badRequest`, and an empty body is validated as `{}`.
- **API-006** [api, security] A JSON body larger than `SCANTOR_MAX_REQUEST_BYTES` returns 413 `payloadTooLarge`: by its declared `Content-Length` with `details {limit, actual}`, and a chunked one while it streams with `details {limit}`, also behind the proxy while the body is still being sent; `/api/runtime/*` bodies are capped at 1 MiB, node status and log bodies at 2 MiB, and anonymous `/api/auth/*`, `/api/registry/token` and `/mcp` bodies, chunked or not, at 1 MiB.
- **API-007** [api, authz, security] A malformed path id (a non-uuid id, a bad analysis id, `../`, or a URL-encoded `{"$ne": null}`) returns 404 `notFound` on every operation, never 400 or 2xx.
- **API-008** [api, cli] Query values are strict: booleans accept only `true`/`false` and integers must be decimal, so `?wait=60s` or `?recursive=yes` returns 400 `validationFailed`.
- **API-009** [api] Cursor pagination: `limit` defaults to 50 and allows at most 200 (201 returns 400); following `nextCursor` returns the next page newest first without overlap; the last page has `nextCursor: null`; a tampered cursor returns 400 `validationFailed` at path `cursor`.
- **API-010** [api, chaos] While the orchestrator boots, every `/api` route except `/api/health`, `/api/docs` and `/api/docs/openapi.json` returns 503 `unavailable`, and `/api/tools/forward-auth` returns 503 as `text/plain`.
- **API-011** [api, security] The dashboard listener answers 421 Misdirected Request (`text/plain`) to any request whose `Host` is the editor origin.
- **API-012** [api] The `wait` query parameter accepts 0–120 seconds (121 returns 400). Without `wait` or with `wait=0` there is no `Scantor-Wait` header; an already settled resource returns at once with `Scantor-Wait: settled`; otherwise the request holds until it settles (`settled`) or the time runs out (`timeout`) and returns the normal status and body. This holds for `publishRevision`, `getRevision`, `uploadTask`, `testTask`, `getTestRun`, `getScan`, `exportScan`, `getExport` and `getJob`.
- **API-013** [api] More than `SCANTOR_MAX_CONCURRENT_WAITS` concurrent waits of one user return 429 `tooManyRequests` with `details.limit`, and a client disconnect frees its wait slot.

## OAS. OpenAPI document

Mechanisms: [api](../docs/api.md) §1.1, [auth](../docs/auth.md) §5.4.

- **OAS-001** [api] `GET /api/docs/openapi.json` is public and a valid OpenAPI 3.1 document that lists only operations with an `operationId`: no `''` path key and no `/api/auth/{all}`, `/mcp`, `/.well-known` or `/__nuxt_*` entries.
- **OAS-002** [authz] The OpenAPI lint passes: every operation has one tag, a summary, a description, a unique camelCase verb-first `operationId`, `x-scantor-scope` and `x-mcp`; `x-admin-only` is set exactly when the scope is `admin`; `x-session-only` appears only with scope `owner` or `admin`; `x-destructive` never appears on a `DELETE`; at most 30 operations have `x-mcp: true`; every request body has a schema; no route file lacks OpenAPI metadata.
- **OAS-003** [authz] Each operation's scope matches its route prefix: `node` for `/api/node/*` and `/api/registry/token`, `worker` for `/api/runtime/*`, `setup` for `/api/setup/*` (the status is `public`), `tools` for `/api/tools/forward-auth`, `owner` or `admin` elsewhere.
- **OAS-004** [api, mcp] Route-meta values survive Nitro's extraction: the descriptions of `startScan`, `listTasks`, `listTemplates`, `listTaskFiles`, `uploadTask`, `getRegistryToken` and `createRegistryToken` are present in the OpenAPI document and in the MCP tool descriptions, and the `queryAnalyses` sort schema allows both `1` and `-1`.
- **OAS-005** [ui, security] `GET /api/docs` serves the Scalar UI with its docs-specific CSP (which allows `https://fonts.scalar.com`) and loads without console errors; its `script-src` admits no inline script and, beyond `'self'`, only the exact URL of one pinned `@scalar/api-reference` version, which the page loads with an `integrity` hash.

## PLAT. Health, instance info and metrics

Mechanisms: [api](../docs/api.md) §4.1, §4.18, [deployment](../docs/deployment.md) §13.

- **PLAT-001** [api] `GET /api/health` needs no credentials and returns `{status, version, components: {mongo, rabbitmq, s3, registry}, alarms[]}`; `status` is `ok` when every component is `ok` and no RabbitMQ alarm is active, otherwise `degraded`.
- **PLAT-002** [chaos] `/api/health` returns HTTP 503 only while MongoDB is down; with another component down it returns 200 `degraded`, and during a RabbitMQ memory alarm `alarms` contains `memory` and the status is `degraded`.
- **PLAT-003** [api, cli] `GET /api/info` (401 without credentials) returns `version`, `publicUrl`, `editorUrl`, `mcpUrl` (null when MCP is disabled), `registryPublicHost`, `cliImage` (`<prefix>scantor:<tag>`), `features {passkeys, mcp, mcpOAuth, editor}`, `limits {maxWorkersPerScan, maxProcessesPerWorker, maxResultBytes, maxFileBytes, scanConfirmThreshold, waitMaxSeconds: 120}` and `user {id, role}`; `scantor whoami` and `scantor instance` print it.
- **PLAT-004** [api] `cliImage` and the node join image use the orchestrator version as tag for a release `X.Y.Z` and `SCANTOR_IMAGE_TAG` otherwise.
- **PLAT-005** [api] `InstanceInfo.adminTools` appears only for callers with effective admin power (absent for users and for an admin's `editor` key); with Traefik its URLs are `<scheme>://<target>.<domain>[:port]` plus `/`, `/rustfs/console/` or `/dashboard/`, and without `SCANTOR_DOMAIN` it has `enabled: false` and every URL null.
- **PLAT-006** [security] `GET /api/info` never contains secret values: no tokens, passwords, `SCANTOR_SECRET` or registry credentials.
- **PLAT-007** [api] `GET /api/metrics` returns 401 without credentials, 403 `adminRequired` for non-admins and 400 for any query parameter; for an admin it returns `text/plain; version=0.0.4` Prometheus text with the catalogue families, among them `scantor_build_info`, `scantor_scans{state}`, `scantor_scan_queue_messages`, `scantor_workers`, `scantor_nodes`, `scantor_jobs`, `scantor_ingest_messages_total{kind,outcome}`, `scantor_dead_letters_total`, `scantor_breaker_trips_total`, `scantor_rabbitmq_alarm` and `scantor_http_requests_total`.
- **PLAT-008** [api] `scantor_http_requests_total` labels each request with its route pattern, never the raw path.

## SETUP. First admin

Mechanisms: [auth](../docs/auth.md) §7, [api](../docs/api.md) §4.2. Zero-user behaviour runs against throwaway orchestrators ([testing](../docs/testing.md) §8.6).

- **SETUP-001** [api, ui] `GET /api/setup/status` needs no credentials and returns `{needsSetup, passkeysEnabled, mcpUrl}`; `needsSetup` is true only while no user exists.
- **SETUP-002** [security] A zero-user orchestrator without `SCANTOR_ADMIN_*` logs the setup link `[setup] no users exist; open <url>/setup?token=sst_…` (the one unredacted token), generates a new token on every restart, and redacts the `/setup?token=` query in request logs.
- **SETUP-003** [security] `createSetupAdmin` without a token or with a wrong `X-Scantor-Setup-Token` returns 401 `setupTokenInvalid`; the logged token returns 201 with a `User` of role `admin` and `canRunPrivileged: false` and is then discarded.
- **SETUP-004** [authz, security] Once any user exists, every `/api/setup/*` request except `GET status` returns 409 `setupCompleted` for every principal, even with a valid setup token.
- **SETUP-005** [security] `createSetupAdmin` validates its body: a valid email (stored lowercased), a name of 1–100 characters and a password of 8–128 characters, otherwise 400 `validationFailed`.
- **SETUP-006** [security] `createSetupPasskeyToken` returns 201 `{token: "spk_…", expiresIn: 300}`; the token is single use, a passkey registration with it creates the admin (with the default `maxWorkers`), and an aborted ceremony leaves no user behind.
- **SETUP-007** [security] With both `SCANTOR_ADMIN_EMAIL` and `SCANTOR_ADMIN_PASSWORD` set and no users, the first admin is created at boot without a setup token; with exactly one of them set, startup aborts; once a user exists both are ignored and never reset a password.

## AUTH. Authentication

Mechanisms: [auth](../docs/auth.md) §2, §4, §5, [security](../docs/security.md) AUTH-1…AUTH-10.

- **AUTH-001** [api, cli] A `default` API key in `x-api-key` or `Authorization: Bearer sk_scantor_…` authenticates REST calls as its owner, like the owner's session.
- **AUTH-002** [api, security] An explicit credential decides alone: an invalid or expired API key sent together with a valid session cookie returns 401 (no fallback to the cookie).
- **AUTH-003** [security] A Bearer value that is not an `sk_scantor_` key, such as an MCP OAuth access token (`eyJ…`), returns 401 on every `/api/*` user route.
- **AUTH-004** [security] A request to `/api/auth/*` that carries an API key (`x-api-key` or `Bearer sk_scantor_…`, `default` or `editor`) returns 401 `unauthorized` in the scantor envelope, so a key never becomes a better-auth session.
- **AUTH-005** [security] A cookie-authenticated POST, PUT, PATCH or DELETE without an `Origin` header or with a foreign `Origin` returns 403 `forbidden`; the `SCANTOR_PUBLIC_URL` origin passes, the editor origin never does, and API keys and machine tokens need no `Origin`.
- **AUTH-006** [security] No dashboard route sends `Access-Control-Allow-Origin` with credentials; only `/.well-known/*`, `/api/auth/jwks`, `/api/auth/oauth2/token`, `/api/auth/oauth2/register` and `/mcp` send `Access-Control-Allow-Origin: *`, without `Allow-Credentials`.
- **AUTH-007** [security] Credentials are bound to their route prefix: a node, worker or setup token on a user route returns 401, and a session or API key on `/api/node/*` or `/api/runtime/*` (and a node token on `/api/runtime/*`) returns 401.
- **AUTH-008** [security] better-auth endpoints outside the HTTP allowlist return 404: `/sign-up/email`, `/token`, `/api-key/*`, `/admin/*`, `/delete-user`, the password-reset, email-verification and social paths; no better-auth endpoint beyond those of [api](../docs/api.md) §3 is reachable with a session.
- **AUTH-009** [security] On https the session cookie is `__Secure-scantor.session_token`: host-only (no `Domain`), `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure`, valid 7 days, and never sent to the editor, S3, registry or tool hosts.
- **AUTH-010** [security] On a throwaway orchestrator, the 11th `/sign-in/email` from one client within a minute returns 429, even with a different `X-Forwarded-For` on each request, both with `SCANTOR_TRUST_PROXY=false` and with `true` from a peer that is not in `SCANTOR_TRUSTED_PROXIES`; from a trusted proxy each rightmost `X-Forwarded-For` entry is its own client.
- **AUTH-011** [security] Further per-IP auth rate limits return 429 above their budgets per minute: `/passkey/verify-authentication` 20, `/change-password` 5, `/change-email` 5, `/oauth2/register` 10 (on a throwaway orchestrator).
- **AUTH-012** [security] The client IP ignores an incoming `x-scantor-client-ip` header and, with `SCANTOR_TRUST_PROXY=true`, takes the `X-Forwarded-For` only from Traefik: sign-ins straight to the dashboard listener and from a container on `scantor-sandbox` to `orchestrator:3000` keep their socket address (as the account's session list shows).
- **AUTH-013** [security] An internal MCP capability (`x-scantor-internal-auth: sic_…`) sent from outside the orchestrator returns 401.
- **AUTH-014** [security] Passkeys are disabled when `SCANTOR_PUBLIC_URL` is plain http on a non-localhost host or an IP literal: `features.passkeys` and `passkeysEnabled` are false and `createSetupPasskeyToken` returns 400 `passkeysDisabled`; a `SCANTOR_PASSKEY_RP_ID` that is not a registrable suffix of the host aborts startup.
- **AUTH-015** [security] Registering a passkey with a session older than 24 h returns 403 `sessionRequired`, and `generate-register-options` without a session and without a setup context returns 401.
- **AUTH-016** [security] A banned user is rejected with 403 `banned` on every user principal: session, API key and MCP.
- **AUTH-017** [security] Banning a user who holds a session, a `default` key, an `editor` key, an MCP OAuth token, MCP over an API key and (as an admin) a tools cookie rejects every one of these principals within 30 s; the API keys and OAuth consents are deleted and the editor is stopped.
- **AUTH-018** [api, security] Role changes and bans take effect on every principal of the user within 30 s.
- **AUTH-019** [security] Signing out also clears the admin tools cookie (`Set-Cookie: scantor_tools=; Domain=<SCANTOR_DOMAIN>; Max-Age=0`).
- **AUTH-020** [security] A request path that a URL parser would rewrite (dot segments, also percent-encoded, backslashes, repeated leading slashes) returns 400 `badRequest` before any check, so neither an API key on `/.well-known/x/../../api/auth/*` nor a session older than 24 h on `/api/auth/passkey/./*` reaches better-auth.

## ACCT. Account, API keys and authorized apps

Mechanisms: [api](../docs/api.md) §4.3, [auth](../docs/auth.md) §6.4, §8.

- **ACCT-001** [api] `GET /api/account` returns `{id, email, name, role, canRunPrivileged, maxWorkers, credentials: {hasPassword, passkeyCount}, createdAt}`.
- **ACCT-002** [api] `PATCH /api/account {name}` updates the display name (trimmed, 1–100 characters) and returns the account; fields such as `email` or `role` return 400 `validationFailed`.
- **ACCT-003** [api] `POST /api/account/password {newPassword}` returns 204 and sets a password only when the user has none; it returns 409 `alreadyExists` when a password exists and 403 `sessionRequired` with an API key.
- **ACCT-004** [api] `DELETE /api/account/password` returns 204 when the user has at least one passkey and 409 `lastCredential` when they have none.
- **ACCT-005** [api] Deleting the last passkey of a user without a password through `POST /api/auth/passkey/delete-passkey` returns 409 `lastCredential`.
- **ACCT-006** [api, mcp] `GET /api/account/oauth-apps` lists the caller's authorized MCP OAuth clients as `{clientId, name, uri, scopes, createdAt}`.
- **ACCT-007** [api, mcp] `DELETE /api/account/oauth-apps/{clientId}` returns 204 and deletes the client's consent, access tokens and refresh tokens, so its next `/mcp` call gets 401; a client the user never authorized returns 404.
- **ACCT-008** [api] `POST /api/account/api-keys {name, expiresInDays?}` (session only) returns 201 `{apiKey, key}`; `key` matches `^sk_scantor_[A-Za-z]{64}$` and appears only in this response.
- **ACCT-009** [api] A new `default` key expires 90 days (±1 minute) after creation, or after `expiresInDays`; `expiresInDays` 0 or 366 and a name longer than 32 characters return 400.
- **ACCT-010** [api] `GET /api/account/api-keys` lists only the caller's keys (admins included), newest first, with `id`, `name`, `start` (first 15 characters), `configId` (`default` or `editor`), `enabled`, `createdAt`, `expiresAt` and `lastRequest`; `?configId=editor` filters, and the full key is never listed.
- **ACCT-011** [api] `DELETE /api/account/api-keys/{keyId}` returns 204 and the deleted key gets 401 afterwards; another user's key id returns 404.
- **ACCT-012** [api] An expired API key gets 401 and is deleted.

## USER. User administration

Mechanisms: [api](../docs/api.md) §4.4, [auth](../docs/auth.md) §5.7, §6.

- **USER-001** [api] `GET /api/users` (admin) returns `Page<User>` newest first; `?q` filters by a case-insensitive substring of email or name, and each user carries `usage {activeWorkers, tasks, scans}`.
- **USER-002** [api] `POST /api/users {email, name, password?, role?, canRunPrivileged?, maxWorkers?}` returns 201; the email is lowercased, `role` defaults to `user`, `canRunPrivileged` to false and `maxWorkers` to `SCANTOR_USER_MAX_WORKERS`; a duplicate email in any letter case returns 409 `alreadyExists`.
- **USER-003** [api] A user created with a password can sign in with it; a user created without one cannot sign in until an admin sets a password.
- **USER-004** [api] `GET /api/users/{userId}` returns the user; an unknown or malformed id returns 404.
- **USER-005** [api] `PATCH /api/users/{userId}` updates `name`, `email`, `role`, `canRunPrivileged` and `maxWorkers`; an empty body returns 400, a taken email 409 `alreadyExists`, and demoting yourself 400 `badRequest`.
- **USER-006** [api] `PUT /api/users/{userId}/password {password}` (8–128 characters) returns 204 and revokes the target's sessions; setting your own password this way returns 400 `badRequest`.
- **USER-007** [api] `POST /api/users/{userId}/ban {reason?}` returns the user with `banned: true` and `banReason`, and deletes their sessions, `default` and `editor` API keys and OAuth tokens and consents and stops their editor; banning yourself returns 400 `badRequest`.
- **USER-008** [security, e2e] A ban with `cancelScans: true` cancels every non-terminal scan of the user; without it those scans keep running and complete, because worker tokens are not user principals.
- **USER-009** [api] `POST /api/users/{userId}/unban` clears only the ban flag: deleted keys, sessions and OAuth grants stay deleted, and the user can sign in and create keys again; unbanning a user who is not banned returns 200 unchanged.
- **USER-010** [api] `DELETE /api/users/{userId}` returns 202 with a `userPurge` job and locks the user out at once (`banned`, `banReason: "deleted"`); the job cancels their scans and removes their editor, exports, scans, analyses and files, test runs, revisions, task images, tasks, workspace, uploads, credentials, events and jobs, then the user (GET returns 404); deleting yourself returns 400 and an unknown id 404.
- **USER-011** [api] While a `userPurge` job for a user is active, `updateUser`, `setUserPassword`, `banUser` and `unbanUser` return 409 `invalidState`.
- **USER-012** [security] `canRunPrivileged`, `maxWorkers` and `role` cannot be changed through better-auth's own `update-user` endpoint; only the admin `createUser` and `updateUser` operations set them.

## CRED. Git credentials

Mechanisms: [api](../docs/api.md) §4.5, [security](../docs/security.md) WS-7.

- **CRED-001** [api] `POST /api/credentials {kind: "gitToken", name, host, username?, token}` returns 201 `{id, kind, name, host, username, last4, lastUsedAt: null, createdAt, updatedAt}` with `username` defaulting to `x-access-token`; the token is never returned and is stored encrypted.
- **CRED-002** [api] The host is normalised to lowercase `host[:port]` with a default `:443` dropped; a host with a scheme, path, userinfo or whitespace returns 400, and so does a token containing CR or LF.
- **CRED-003** [api] A second credential with the same name for the same user returns 409 `alreadyExists`, also when renaming; different users may reuse a name.
- **CRED-004** [api] `GET /api/credentials` returns `{items}` sorted by name, without a cursor, holding only the caller's own credentials (admins included).
- **CRED-005** [api, security] `PATCH /api/credentials/{id}` updates name, host, username or token (a new token updates `last4`); a new host without the token returns 400 (issue path `token`), so a stored token is never redirected; an empty body returns 400; `DELETE` returns 204; another user's credential returns 404.

## AUTHZ. Authorization

Mechanisms: [security](../docs/security.md) §7, [auth](../docs/auth.md) §5, §9, [testing](../docs/testing.md) §8.5.

- **AUTHZ-001** [authz] Every `owner`-scope operation returns 401 `unauthorized` to an anonymous request.
- **AUTHZ-002** [authz] Every `owner`-scope operation, read or mutation, that user B calls with user A's ids (task, revision, scan, analysis, file, test run, export, upload, credential, job, API key) returns 404 `notFound`, never 403; after all of B's attempts the hash of A's GET representations is unchanged (destructive operations run last, on throwaway copies).
- **AUTHZ-003** [authz] An admin (session or `default` key) can read and act on other users' resources by id, and list operations return every user's items, except `listCredentials` and `listUploads`, which stay caller-scoped (CRED-004, UPL-004).
- **AUTHZ-004** [authz, api] A non-admin passing `?userId=<another user>` to a list operation (tasks, scans, jobs) gets 403 `adminRequired` (their own id is accepted), while an admin passing `?userId=<A>` sees only A's items.
- **AUTHZ-005** [authz] No list response B receives (tasks, scans, revisions, test runs, uploads, exports, jobs, credentials, API keys, OAuth apps) contains any of A's ids.
- **AUTHZ-006** [authz] Task names and revision references (`alpha`, `alpha@1`, `alpha@latest`) resolve only among the caller's tasks: B's `alpha` is B's task, an admin's `alpha` is the admin's own task (404 when there is none), and admins reach other users' tasks only by id.
- **AUTHZ-007** [authz] A create that references another user's document returns 404, also for admins acting on their own behalf: `startScan` with A's revision or a scan config naming A's upload, `importGitTask` with A's credential, `estimateTemplate` with A's upload.
- **AUTHZ-008** [authz] Every `admin`-scope operation (users, nodes, metrics, tools session) returns 401 to anonymous callers and 403 `adminRequired` to non-admin sessions and keys for every id, including nonexistent ones.
- **AUTHZ-009** [authz] Every `x-session-only` operation (`createApiKey`, `setAccountPassword`, `removeAccountPassword`, `createToolsSession`) returns 403 `sessionRequired` to a `default` or `editor` API key and through MCP.
- **AUTHZ-010** [authz] An admin's `editor` API key carries no admin power: 403 `adminRequired` on admin operations, 403 `forbidden` on `createEditorSession`, 403 `sessionRequired` on session-only operations, 404 on other users' resources, and plain-user behaviour on owner routes.
- **AUTHZ-011** [authz] Public operations (`getHealth`, `getSetupStatus`, `/api/docs`, `openapi.json`) answer the same to every principal; an invalid Bearer value does not turn them into 401.
- **AUTHZ-012** [authz] Node-scope operations reject anonymous callers, sessions, API keys and worker tokens with 401; node N1's token works for its own workers, and another node's worker ids return 404 or are ignored.
- **AUTHZ-013** [authz, api] Worker-scope operations reject anonymous callers, users, API keys and node tokens with 401; a runner token on `schedulerResolved`, `schedulerCheckpoint` or `schedulerDone` gets 403 `forbidden`; the token of a stopped or lost worker gets 401.
- **AUTHZ-014** [authz] `toolsForwardAuth` succeeds only with an admin's `scantor_tools` cookie; a session, an API key, an anonymous request or a non-admin's tools cookie gets 401.
- **AUTHZ-015** [authz, mcp] The MCP half of the matrix: B's read/write OAuth session lists exactly the read and write tools, `tools/call` of every tool with A's ids returns `isError` with `httpStatus` 404, a read-only token sees no write tools, and a non-admin never gets `list_nodes`, even when `scantor:admin` was requested.
- **AUTHZ-016** [api, security] Security events (user `null`, for example `security.ingestRejected`) and node events are visible only to admins; owners see only the events of their own scans.

## TASK. Tasks and uploads of task folders

Mechanisms: [api](../docs/api.md) §4.6, §5.3, [tasks](../docs/tasks.md) §12–§13.

- **TASK-001** [api, mcp, cli] `POST /api/tasks {name, language, template?, description?}` scaffolds the workspace (template `single` by default, a template name or `custom`) and returns 201 with `source {kind: "scaffold", template}`, `revisionCount: 0`, `latestRevision: null` and `workspace.dirty: true`; `scantor tasks create` and MCP `create_task` do the same.
- **TASK-002** [api] A task name must be a slug of 1–64 characters: reserved names (`upload`, `import-git`, `new`, `latest`), uuid-shaped names and uppercase or invalid characters return 400 `validationFailed`.
- **TASK-003** [api] `createTask` returns 400 `validationFailed` for an unknown language and for an unknown template (path `template`); every language × template combination plus `custom` can be created.
- **TASK-004** [api] Creating a task with a name the caller already uses returns 409 `alreadyExists`; two users can each own a task with the same name.
- **TASK-005** [api, mcp, cli] `GET /api/tasks` lists the caller's tasks newest first; `?q` matches name or description case-insensitively, `?language` filters, and tasks being deleted are excluded.
- **TASK-006** [api, mcp, cli] `GET /api/tasks/{task}` accepts an id or a name and returns the task with `workspace {packSha256, fileCount, bytes, dirty, lastSyncSha256, checkedAt}`, `revisionCount`, `latestRevision`, `latestReadyRevision` and `privileged`.
- **TASK-007** [api] `workspace.dirty` becomes true when a file is edited after a publish and false again once that content is published.
- **TASK-008** [api] `GET /api/tasks/{task}/workspace` computes the hash fresh, returns `{packSha256, fileCount, bytes, dirty, latestRevisionPackSha256, lastSyncSha256, checkedAt}` and refreshes the cached `tasks.workspace`.
- **TASK-009** [api, cli] `GET /api/tasks/{task}/workspace/archive` streams `application/gzip` as attachment `<task>.tar.gz`; the pack is deterministic, so its sha256 equals the workspace `packSha256`.
- **TASK-010** [api, cli] `DELETE /api/tasks/{task}` returns 202 with a `taskDelete` job and the task disappears at once (GET 404, omitted from lists); the job removes the workspace, revisions, snapshots, images and test runs, cancels running test runs, and ends with `progress.done == progress.total`.
- **TASK-011** [api] Deleting a task that a creating, running, paused or deleting scan uses returns 409 `taskInUse` with `details.scanId`.
- **TASK-012** [api] While a task is being deleted its name cannot be reused (`createTask` and `uploadTask` return 409 `alreadyExists`); the name is free again once the `taskDelete` job finishes.
- **TASK-013** [api, cli] `POST /api/tasks/upload` (a `.tar.gz` body) creates the task named by its manifest when it does not exist and returns 201 `{task, revision, created: true}`, with `source.kind: "upload"` on the task and the published revision.
- **TASK-014** [api, cli] `uploadTask?publish=false` only replaces the workspace and returns `revision: null`; `?message` sets the revision message and `?wait` holds the response until the revision is ready or failed.
- **TASK-015** [api, security] `uploadTask` returns 415 for a `Content-Type` other than `application/gzip` or `application/x-gzip`, and 413 `payloadTooLarge` with `details.limit` while streaming a body over `SCANTOR_TASK_MAX_PACK_BYTES`.
- **TASK-016** [api] An archive without a valid `scantor.yaml` or with an unknown language returns 422 `manifestInvalid` with `BuildError[]`.
- **TASK-017** [api, cli] Uploading to a task whose workspace has unpublished edits returns 409 `workspaceDirty` with `details {current, uploaded}` (CLI exit 2 with a `--force` hint); `force=true` replaces the workspace.
- **TASK-018** [api, cli] An upload never conflicts when the workspace hash equals the uploaded hash, the latest revision's pack hash or `lastSyncSha256`, and a commit sets `lastSyncSha256` to the uploaded hash, so repeated `scantor push --no-publish` and `scantor dev run --remote` from one folder never conflict.
- **TASK-019** [api, cli] Uploading content identical to an existing queued, building or ready revision returns that revision (same id and number) instead of building again, and `scantor push` then prints `Revision <ref> is ready` (or that it failed).

## WS. Workspace files and helpers

Mechanisms: [api](../docs/api.md) §4.7, [editor](../docs/editor.md) §9, [security](../docs/security.md) WS-1…WS-9.

- **WS-001** [api, mcp, cli] `GET /api/tasks/{task}/files` returns `{entries: [{path, type, size, mode}], truncated}`, recursive by default; `?recursive=false` lists one level, `?path` selects a subfolder, at most 5000 entries are returned, and a symlink is listed as type `symlink` without being followed.
- **WS-002** [api, mcp, cli] With `?revision=<N|latest|id>`, listing and reading files use the immutable revision snapshot; later workspace edits do not change what is returned.
- **WS-003** [api, mcp, cli] `GET /api/tasks/{task}/files/content?path` returns `{path, size, sha256, encoding, content, truncated}` with the sha256 of the whole file; binary content comes back as base64, content beyond 1 MiB is truncated, a missing file returns 404, and reading a directory or a symlink (for example one to `/etc/passwd`) returns 422 `invalidPath` without reading the target.
- **WS-004** [api, mcp, cli] `PUT /api/tasks/{task}/files {files: {path: text | {base64}}}` writes 1–200 files atomically, creating parent directories, and returns `{written, workspace: {packSha256, dirty}}`; a binary file written as base64 keeps its sha256.
- **WS-005** [api] `writeTaskFiles` returns 400 `validationFailed` for an empty files map, more than 200 files or invalid base64.
- **WS-006** [api, mcp, cli] `DELETE /api/tasks/{task}/files?path` removes a file, a directory only with `recursive=true`, and returns `{deleted, workspace}`; an empty path (the task root) returns 422 `invalidPath`.
- **WS-007** [security] Every case of `tests/corpora/paths` sent through `writeTaskFiles`, `deleteTaskFile` and `readTaskFile` follows the path rules: absolute paths, `..`, `.` and empty segments, NUL, backslashes, paths over 1024 bytes, segments over 255 bytes, more than 32 levels and `.scantor-staging` return 422 `invalidPath` with `details.path`, the workspace pack hash stays unchanged and nothing is written outside the task folder.
- **WS-008** [security] Every case of `tests/corpora/tar-slip` uploaded with `uploadTask` (`../x`, `/abs`, `a/../../x`, backslash, NUL, symlink, hardlink, device, FIFO, duplicate entries, a 1025-byte path) returns 422 `invalidPath` with `details.path` or 413, leaves the workspace unchanged and writes nothing outside the task folder.
- **WS-009** [security] Archive caps are enforced while streaming: a gzip bomb is stopped, more than `SCANTOR_TASK_MAX_FILES` entries are refused and `SCANTOR_WORKSPACE_MAX_BYTES` is enforced, each with 413 `payloadTooLarge` and `details.limit` and an unchanged workspace.
- **WS-010** [api] Extracted archives are normalised: tar owners are ignored, file modes become 0644 or 0755 and directories 0755, a single top-level directory containing `scantor.yaml` is stripped, and `.git/` and `.scantor/` entries are dropped.
- **WS-011** [security] A write never passes through a pre-existing workspace symlink that points outside the task folder: it returns 422 `invalidPath`.
- **WS-012** [security] Workspace helper containers (`scantor-h-*`) run as 1000:1000 with only the user's volume subpath mounted, network `none` (git operations: `scantor-egress`), a read-only root filesystem with a `noexec` `/tmp`, `CapDrop ALL`, `no-new-privileges`, managed labels and resource limits, and are removed after every run; the orchestrator container mounts no workspace volume.

## GIT. Git import and pull

Mechanisms: [api](../docs/api.md) §4.8, [tasks](../docs/tasks.md) §14, [editor](../docs/editor.md) §9.7.

- **GIT-001** [api, cli] `POST /api/tasks/import-git {url}` for a repository with one manifest returns 201 `{imported: [task], candidates}`; the task has `source.kind: "git"` and `source.git {url, ref: "HEAD", path, commit, packSha256, pulledAt}`, and `workspace.lastSyncSha256` equals the imported hash.
- **GIT-002** [api, cli] For a repository with several valid manifests and no `select`, the import returns 200 `{imported: [], candidates: [{path, name, language, exists}]}`; repeating it with `select: [paths]` returns 201 with exactly those tasks imported.
- **GIT-003** [api] A `select` entry naming a path without a candidate, or two selected folders with the same task name, returns 400 `badRequest`.
- **GIT-004** [api] Importing a task whose name the caller already uses returns 409 `alreadyExists`, and that candidate is reported with `exists: true`.
- **GIT-005** [api] A repository or path without `scantor.yaml` (`no scantor.yaml was found`), or with an invalid manifest or unknown language, returns 422 `manifestInvalid` with `details.errors`.
- **GIT-006** [api, security] URLs other than `https://`, URLs with userinfo, a leading `-`, `ext::` and `file://` return 400 `validationFailed` at path `url`; an unresolvable host returns 422 `gitFailed`; redirects are not followed.
- **GIT-007** [api, security] A failed clone or fetch returns 422 `gitFailed` with `details.message` and credentials redacted; an imported folder contains no `.git` and no token, and a symlink in the selected subtree returns 422 `invalidPath`.
- **GIT-008** [api, e2e] A private repository behind Basic auth imports with the caller's `credentialId`, which sets the credential's `lastUsedAt`; a credential whose host differs from the URL host returns 400 `badRequest` and the token is not sent; another user's credential id returns 404.
- **GIT-009** [api, cli] `POST /api/tasks/{task}/git/pull` returns `{task, previousCommit, commit, changed}`: `changed: false` for an unchanged remote; a fast-forward replaces the workspace and updates `source.git.commit`, `packSha256`, `pulledAt` and `lastSyncSha256`; a pull never publishes.
- **GIT-010** [api, cli] A pull returns 409 `gitDiverged` when the workspace changed since the last import or pull, and when the remote history is not a fast-forward (force-push); `force: true` overrides both.
- **GIT-011** [api] A pull of a task that was not imported from git returns 409 `invalidState`, and a pulled manifest naming a different task returns 422 `manifestInvalid`.
- **GIT-012** [api] A revision published from unmodified imported content has `source.kind: "git"` with `{url, ref, path, commit, dirty: false}`; after a local edit it has `source.kind: "workspace"` with `git.dirty: true`.

## PIPE. Task pipeline

Mechanisms: [tasks](../docs/tasks.md) §2–§9, [runtime](../docs/runtime.md) §16.

- **PIPE-001** [cli] `scantor task pack` is deterministic: the same tree gives the same `packSha256` (sha256 of the uncompressed tar with sorted entries, mtime 0, uid/gid 0 and modes 0644/0755); `.dockerignore` applies with Docker semantics including `!` exceptions, `scantor.yaml`, `Dockerfile` and `.dockerignore` are always included, `.git/` and `.scantor/` are excluded at any depth, and the summary is `{packSha256, packBytes, fileCount, bytes}`.
- **PIPE-002** [cli, security] Packing keeps relative in-tree symlinks as symlinks; absolute or escaping symlinks (whose target is never read), hardlinks to outside files, devices, FIFOs, sockets, invalid UTF-8, NUL or backslashes in paths, segments over 255 bytes and paths over 1024 bytes are pack errors, and so is exceeding `SCANTOR_TASK_MAX_FILES`, `SCANTOR_TASK_MAX_BYTES` or `SCANTOR_TASK_MAX_PACK_BYTES` (the error names the cap).
- **PIPE-003** [api, cli] Manifest rules M1–M10 produce static errors in file `scantor.yaml` with the line: duplicate keys, non-mapping or oversized YAML, schema violations with the instance path, an unknown language, a bad `entry` (`entry "src/main.rs" must end in .ts or .mts`), duration and size bounds (`/defaults/backoff/max: 2s is shorter than initial 5s`), memory not in whole MiB, workers or processes above the instance limits, and a renamed task (`name "echo2" does not match task "echo"; task names are immutable`).
- **PIPE-004** [api, cli] A task needs the regular files `scantor.yaml` (`scantor.yml` is not accepted) and `Dockerfile` at its root plus the entry file of source languages, each missing one being a static error; a successful static check returns the normalised manifest and `settingsDefaults` in platform units (`timeout: 2m` → `timeoutMs: 120000`, `memory: 768MiB` → `memoryMiB: 768`).
- **PIPE-005** [api, cli] Dockerfile warnings never fail the build: W1 (`CMD is ignored; the runtime is the entrypoint`, also for `ENTRYPOINT`, `HEALTHCHECK` and `STOPSIGNAL`), W2 (an `ENV` overriding a `SCANTOR_*` variable) and W3 (a missing `.dockerignore`) appear in the warnings and the build log.
- **PIPE-006** [e2e] The build pulls the base image when it is absent, records `baseImage {ref, digest}` and `image.platform {os, arch}`, and builds without registry credentials.
- **PIPE-007** [api, cli] The check phase runs the base image's type checker (basedpyright, `tsc --noEmit`, `go vet`); each diagnostic becomes a `BuildError` with phase `check` and fails the publish, for example a TS2339 type error in a copy of `power` makes `scantor validate` exit 2 with `[check] main.js:29:55: TS2339 …`.
- **PIPE-008** [security, e2e] Describe and check containers (`scantor-b-*`) run the built image with network `none`, the worker hardening profile without added capabilities, no tokens or platform URLs, managed labels and resource limits, are never privileged, and are removed afterwards.
- **PIPE-009** [api, e2e] A published image is pushed by digest as `tasks/<taskId>:<revisionId>` with the orchestrator's registry credential through the token realm `${SCANTOR_PUBLIC_URL}/api/registry/token`; the build log shows `waiting for push gate` before the push, and scans and assignments always reference the image by digest.
- **PIPE-010** [api, cli] Pipeline events are NDJSON `{v: 1, seq, at, phase, type, stream, level, text}` with consecutive `seq` from 0 and text of at most 16 KiB; the last event is always the `result` with `{ok, pack, manifest, settingsDefaults, language, privileged, baseImage, image, description, errors, warnings, durationsMs}`.
- **PIPE-011** [cli] `scantor task build`, `check-static`, `pack` and `scantor validate` exit 0 on success, 2 when the task content is invalid (pack, static, build, describe, check) and 3 on a platform failure (push, Docker unreachable, internal error).

## REV. Revisions

Mechanisms: [api](../docs/api.md) §4.10, [tasks](../docs/tasks.md) §10.

- **REV-001** [api, mcp, cli] `POST /api/tasks/{task}/revisions {message?}` snapshots the workspace synchronously and returns 201 with state `queued`, number N+1, ref `<task>@N` and `source.kind: "workspace"`; edits after the request do not reach that build, and numbers are never reused (failed builds consume numbers).
- **REV-002** [api, mcp] Publishing content whose pack hash matches a queued, building or ready revision returns that revision without a new number; content whose previous revision failed builds a new revision.
- **REV-003** [api, mcp] A ready revision has `image {repository: "tasks/<taskId>", tag, digest, bytes, platform}`, a `description` (schemas, schedule, `secretPaths`, `uploadPaths`, `fileRefPaths`, warnings), `settingsDefaults`, `manifest`, `language`, `baseImage`, `privileged` and `errors: []`.
- **REV-004** [api] A failed revision has state `failed`, `image: null`, `errors [{phase, file, line, column?, message}]` with phase `static`, `build`, `describe` or `check`, and a build log.
- **REV-005** [api, cli] `GET /api/tasks/{task}/revisions` returns `Page<RevisionSummary>` (`id`, `number`, `ref`, `state`, source kind and pack hash, `privileged`, `errorsCount`, `createdAt`, `finishedAt`) sorted by number descending; `?state` filters.
- **REV-006** [api, mcp, cli] `GET /api/tasks/{task}/revisions/{revision}` accepts a number, `latest` (the highest ready revision) or an id; `latest` without a ready revision, an unknown number and the id of another task's revision return 404, and `?wait` holds until ready or failed.
- **REV-007** [api, cli] `GET …/revisions/{revision}/logs?afterLine&limit` (default 1000, at most 5000; 5001 returns 400) returns `{lines: [{line, at, phase, type, …}], nextLine, complete}` with `line = seq + 1` and the result line last; paging with `nextLine` follows a running build, as `scantor revisions logs --follow` does.
- **REV-008** [api, security] `GET …/revisions/{revision}/source` answers 302 to a presigned snapshot download served as an `application/gzip` attachment, and `?redirect=false` returns `{url, expiresAt}`; the content matches the revision's `packSha256`.
- **REV-009** [api, ui] Described schemas keep the property order of the source, for example the `power` scan config lists `start`, `end`, `onlyOdd` in the API and in the form.
- **REV-010** [e2e, security] Publishing a manifest with `defaults.privileged: true` as a user without `canRunPrivileged` fails the revision with the static error `privileged tasks require the canRunPrivileged permission`.
- **REV-011** [chaos] A revision whose build was interrupted by an orchestrator restart goes back to `queued` and is rebuilt from its stored snapshot.

## TRUN. Test runs

Mechanisms: [api](../docs/api.md) §4.11, [tasks](../docs/tasks.md) §11.

- **TRUN-001** [api, mcp, cli] `POST /api/tasks/{task}/test-runs {taskConfig?, scanConfig?, analysisConfig?, limit?, maxAttempts?, timeoutMs?}` returns 201 with the new test run (`queued`, or already `building`) that snapshots the live workspace and builds a draft image `tasks/<taskId>:draft-<packSha256>` (no revision needed, nothing pushed); it goes `queued` → `building` → `running` → `completed` whatever the analysis outcomes.
- **TRUN-002** [api, mcp] `testTask?wait` returns the settled run with `analyses[]`, `summary {analyses, succeeded, failed}`, `draftImage {ref, digest, cached}` and `expiresAt`; a second run of unchanged content reuses the draft image (`cached: true`) but still runs the static checks and describe.
- **TRUN-003** [api] Test-run inputs are bounded: `limit` 1–50 (default 5), `maxAttempts` 1–5 (default 1) and `timeoutMs` 1000–86400000 (default from the manifest); values outside, such as `limit: 99`, return 400 `validationFailed`, and a config larger than `SCANTOR_MAX_SCAN_CONFIG_BYTES` returns 413.
- **TRUN-004** [api] A config that the described schema rejects causes no HTTP error: the run ends `failed` with one `BuildError` per issue in phase `config` (`taskConfig /text: must be string`); a scheduling failure becomes a `BuildError` with phase `schedule`.
- **TRUN-005** [api] With `analysisConfig` the test run skips `schedule` and calls `run` exactly once (seq 0).
- **TRUN-006** [api] `GET /api/tasks/{task}/test-runs` lists the task's runs newest first without analyses; `GET /api/test-runs/{id}` includes analyses unless `?analyses=false`, and `?wait` holds until completed, failed or cancelled.
- **TRUN-007** [api, cli] `GET /api/test-runs/{id}/stream` is `text/event-stream` with the events `state`, `log {seq, stream, text, at}`, `analysis`, `error` and `end` (the run without analyses) and ends after `end`; for a finished run it replays the state, analyses and errors and then ends.
- **TRUN-008** [api] `POST /api/test-runs/{id}/cancel` moves a queued, building or running run to `cancelled` and removes its `scantor-t-<id>` container; a cancelled run returns 200 unchanged and a completed or failed one 409 `invalidState`; deleting the task cancels its running test runs.
- **TRUN-009** [api] `GET /api/test-runs/{id}/files/{fileId}` returns a `FileDownload` (302 with `?redirect=true`) whose presigned URL serves the exact content; an unknown file id returns 404.
- **TRUN-010** [e2e, security] A test run of a privileged task runs unprivileged (no Docker-in-Docker, no added capabilities), and like a publish it needs the owner's `canRunPrivileged`: without it the test run fails at `static` with `privileged tasks require the canRunPrivileged permission`.
- **TRUN-011** [security] The test-run container `scantor-t-<id>` runs on `scantor-egress` with the worker hardening profile, never privileged and without `SCANTOR_DIND`; a `netprobe` test run reaches no MongoDB, registry, RabbitMQ or orchestrator.
- **TRUN-012** [e2e] A test run that references a list upload and the `tranco` and `crux` templates gets the upload's lines and the data from inside the test-run container.

## UPL. Uploads

Mechanisms: [api](../docs/api.md) §4.9.

- **UPL-001** [api, cli] `POST /api/uploads` with a raw `text/plain` or `application/octet-stream` body, `?name` (default `upload.txt`) and `?kind=list` returns 201 `{id, kind, name, contentType, bytes, sha256, lines, lastUsedAt: null, createdAt}`, where `lines` counts non-blank lines; `scantor uploads create` prints its id.
- **UPL-002** [api] Uploading content identical to one of the caller's uploads returns 200 with that upload; another user uploading the same content gets their own upload.
- **UPL-003** [api] `createUpload` returns 415 for any other `Content-Type`, and 413 `payloadTooLarge` without storing anything for a body over `SCANTOR_MAX_UPLOAD_BYTES`.
- **UPL-004** [api, cli] `GET /api/uploads` pages through the caller's own uploads (admins included), and `GET /api/uploads/{id}` returns one.
- **UPL-005** [api, cli] `DELETE /api/uploads/{id}` returns 204 and deletes the stored object; while a scan that is not deleted references the upload it returns 409 `uploadInUse` with `details.scanId`.
- **UPL-006** [api] Starting a scan that references an upload sets the upload's `lastUsedAt`.

## CAT. Catalog and guides

Mechanisms: [api](../docs/api.md) §4.12, [templates](../docs/templates.md) §1–§2.

- **CAT-001** [api] `GET /api/languages` returns `{items: [{language, title, base, baseImage, entry, extensions}]}` for `python`, `typescript`, `javascript` and `go`.
- **CAT-002** [api, mcp, cli] `GET /api/templates`, `scantor templates list` and MCP `list_templates` return the templates `single`, `repeat`, `list`, `range`, `cidr`, `tranco` and `crux`, each with `name`, `title`, `description`, `scanConfigSchema`, `analysisConfigSchema`, `example` and `resolves`.
- **CAT-003** [api] `GET /api/templates/{template}` returns one template; an unknown or badly formed name returns 404.
- **CAT-004** [api] `POST /api/templates/{template}/estimate {scanConfig}` returns `{expectedTotal, exact, confirmationRequired, tooLarge}` (a `cidr` config gives an exact 8); an unknown template returns 404.
- **CAT-005** [api] `estimateTemplate` returns 422 `configInvalid` with `details.issues` (JSON pointers under `/scanConfig`) for schema violations and semantic rules: `cidr /maxAnalyses`, `range /step` and the `tranco /limit` window.
- **CAT-006** [api] `GET /api/scaffolds` returns `{items: [{language, templates}]}` in which every language lists every template plus `custom`.
- **CAT-007** [api, mcp] `GET /api/guides/authoring/{language}` returns `text/markdown` for every language of `schemas/languages.json`, and an unknown language returns 404.
- **CAT-008** [api] `GET /api/guides/{guide}` returns `text/markdown` for `templates`, `manifest`, `errors-and-retries`, `cli`, `mcp` and `remote-nodes`; any other name returns 404.
- **CAT-009** [cli] `scantor templates estimate <t> --config <json|@file|->` applies the defaults and validates: exit 0 with `{expectedTotal, exact}`, exit 2 with `{issues: [{path, message}]}`; uploads are passed as `--upload <id>=<lines>`, and without `--config` the defaults apply.

## TPL. Templates

Mechanisms: [templates](../docs/templates.md) §3–§9.

- **TPL-001** [e2e] Template `single` yields exactly one analysis whose config is `{}` filled with defaults, with an exact estimate of 1 and `expectedTotal` 1.
- **TPL-002** [e2e] Template `list` combines the inline items with the lines of an uploaded list, trimming whitespace and skipping empty lines, and `offset`/`limit` select a window (`index` is the position before `offset`); the estimate is exact, the provenance is `{inlineItems, upload {id, sha256, bytes, lines}}`, and an upload line over 4096 bytes fails scheduling with `line <n> of upload exceeds 4096 bytes`.
- **TPL-003** [e2e] Template `range` follows Python range semantics (end exclusive, negative steps count down; defaults `start` 0, `end` 10, `step` 1) and yields `{value}`; the count is `max(0, ceil((end − start) / step))`, and `step: 0` is rejected with `/step: must not be 0`.
- **TPL-004** [e2e] Template `repeat` yields `{iteration}` for 0…`times` − 1 (`times` ≥ 1, default 1) with an exact estimate of `times`.
- **TPL-005** [e2e] Template `tranco` resolves `latest`, a date or a list id, downloads the list and yields `{domain, rank}` for ranks `offset + 1`…`offset + limit` in order, with provenance `{listId, date, sourceUrl, sha256, fetchedAt}`; an unknown list id (`unknown Tranco list id <id>`), a date without a list (`no Tranco list for <date>`) and `offset + limit` above 1 000 000 (a `/limit` issue) are rejected.
- **TPL-006** [e2e] Template `crux` with month `latest` uses the newest of the current UTC month and the 3 before it that exists, and yields `{origin, rank}` in file order until the first rank above `bucket`; the estimate is the upper bound `bucket` and the resolved `expectedTotal` is exact; a missing list fails with `no CrUX list for <country> in the last 4 months` or `CrUX list <country> <month> not found`.
- **TPL-007** [e2e] Template `cidr` clears host bits, merges overlapping and adjacent ranges and yields `{ip, prefix, version}` for IPv4 then IPv6 in ascending order, per address or per aligned subnet of length `prefix`, minus exclusions; invalid entries (`/cidrs/<i>`, `/exclude/<i>`), zones, IPv4-mapped addresses, prefix conflicts and an expansion above `maxAnalyses` (`cidrs expand to <n> analyses, above maxAnalyses <m>`) are rejected.
- **TPL-008** [e2e] Template data comes from `SCANTOR_TRANCO_URL` and `SCANTOR_CRUX_URL`, fetched by the scheduler (or the test run) with `User-Agent: scantor/<version>`; a data source answering 5xx or 429 makes a retryable platform error, which restarts the scheduler.
- **TPL-009** [e2e] A custom schedule that wraps a template proxy (as `power` wraps `range`) receives the template's items in order; an invalid scan config for the proxy raises a `validation` error in user code.
- **TPL-010** [e2e, api] Before the first item is published, the scheduler records the template resolution under `scheduling.resolved.<key>` as `{template, scanConfig, provenance, expectedTotal, at}`, with `latest` resolved to a concrete list; key `schedule` sets `stats.expectedTotal`, while wrapped calls (keys `call:<n>`) leave it unchanged.
- **TPL-011** [e2e] A scheduler resumed after a pause reuses the stored resolution instead of resolving again: `scheduling.resolved` (including its `at`) is unchanged and the resumed scan completes with the resolved items.

## SCAN. Scans

Mechanisms: [api](../docs/api.md) §4.13, §5.1, [architecture](../docs/architecture.md) §11.2–§11.3, [queue](../docs/queue.md) §6.8–§6.10, §8–§9.

- **SCAN-001** [api, mcp, cli, e2e] `POST /api/scans {revision, name?, taskConfig?, scanConfig?, settings?, confirm?}` returns 201 with state `creating`, round 1 and the settings merged over the revision's `settingsDefaults`, and writes a `scan.created` event; the scan then runs and completes with the expected counts.
- **SCAN-002** [api, cli] The revision reference accepts `<task>@<N>`, `<task>@latest`, a bare `<task>` (latest), a revision id or a task id (a bare uuid is tried as a revision id first).
- **SCAN-003** [api] `startScan` returns 409 `revisionNotReady` with `details.state` for a queued, building or failed revision, and for `<task>@latest` when the task has no ready revision and its latest is unfinished.
- **SCAN-004** [api] `taskConfig` and `scanConfig` are validated against the revision's schemas with defaults applied: violations return 422 `configInvalid` with `details.issues [{path, message}]` (JSON pointers), and the stored configs contain the defaults.
- **SCAN-005** [api] A `taskConfig` or `scanConfig` larger than `SCANTOR_MAX_SCAN_CONFIG_BYTES` returns 400 `validationFailed`.
- **SCAN-006** [api, e2e] Settings outside the static bounds return 400 `validationFailed` in `startScan`, `scaleScan` and `restartScan`: `timeoutMs` below 1000 or above 86400000, `maxAttempts` above 20, `cpus` below 0.1, `memoryMiB` below 64, more than 16 node labels, an invalid pool, `workers` above `SCANTOR_MAX_WORKERS_PER_SCAN`, `processes` above `SCANTOR_MAX_PROCESSES_PER_WORKER`, and the unknown key `settings.privileged`.
- **SCAN-007** [api, cli] Partial nested settings merge over the revision defaults: `nodeSelector {pool}` without labels, or `resources {cpus}` alone, keep the other defaults (also through `scantor scans start --settings`).
- **SCAN-008** [api] Upload ids at the revision's upload paths must exist and belong to the scan owner (otherwise 404), and more than 32 referenced uploads return 400.
- **SCAN-009** [api, cli, mcp] For template schedules, an estimate above `SCANTOR_MAX_ANALYSES_PER_SCAN` returns 422 `scanTooLarge {expectedTotal, max}`, an estimate above `SCANTOR_SCAN_CONFIRM_THRESHOLD` without `confirm: true` returns 422 `confirmationRequired {expectedTotal, threshold}`, and with `confirm: true` the scan starts.
- **SCAN-010** [api] The validation order is fixed: a not-ready revision with an invalid config returns 409 rather than 422, and the privileged check (403) runs before the broker-alarm check (503) and the config validation (422).
- **SCAN-011** [api, e2e] A scan with a custom schedule has `stats.expectedTotal: null`, and `progress.total` and `percent` stay null until scheduling is done; unwrapped templates show `percent` and `etaSeconds` while the scan runs.
- **SCAN-012** [e2e, security] For a privileged revision whose owner lacks `canRunPrivileged`, `startScan`, `restartScan`, `resumeScan` and `retryFailedAnalyses` return 403 `privilegedNotAllowed`.
- **SCAN-013** [e2e] With `canRunPrivileged`, a privileged scan on nodes without Docker-in-Docker (the test nodes) keeps its workers pending with the `workersPending` reason `dindUnavailable`.
- **SCAN-014** [api, mcp, cli] `GET /api/scans` returns `Page<ScanSummary>` (`id`, `userId`, `name`, `task`, `revision {id, number, ref}`, `state`, `stateReason`, workers and processes, `progress`, `stats`, `conditionsCount`, `createdAt`, `completedAt`); `?state` takes a comma list and `?task` an id or name; deleting and deleted scans are omitted unless `?state` names them.
- **SCAN-015** [api, mcp, cli] `GET /api/scans/{id}` returns the scan with `progress {scheduled, terminal, total, percent, etaSeconds}` and `workers {desired, active, pending, byState}`; a deleted scan returns a tombstone with state `deleted`.
- **SCAN-016** [e2e, cli] `progress.total` equals `stats.expectedTotal` when known, `percent` rises toward 100 and `etaSeconds` is a number only while the scan runs with a non-zero rate (`scantor scans watch -o json` shows them change); a completed scan has `percent` 100 and `terminal == total`.
- **SCAN-017** [api, mcp, cli] `getScan?wait` returns at once with `Scantor-Wait: settled` for a scan that is not creating or running, and otherwise holds until the scan completes, fails, is cancelled or pauses, or until `wait` elapses (`timeout`).
- **SCAN-018** [api, cli] `GET /api/scans/{id}/conditions` returns `{items}` with the scan's current conditions, such as `crashLoop`, `workersPending` with its reasons, `breakerTripped`, `schedulingFailed` and `workerErrors`.
- **SCAN-019** [api, cli] `GET /api/scans/{id}/events` returns `Page<Event>` newest first; `?type` takes an exact type (`scan.stateChanged`) or a prefix ending in `.` (`worker.`); the stream includes `scan.created`, `scan.stateChanged`, `scan.scaled`, `scan.restarted`, `scan.conditionCleared`, `worker.placed`, `worker.pending` and `worker.crashed`.
- **SCAN-020** [api, cli] `GET /api/scans/{id}/workers?state` returns `Page<Worker>` with `role` (`scheduler` or `runner`), `state`, `node {id, name}`, `scan {id, name}`, `processes {desired, assigned, applied, running}`, `restarts`, `lastExit`, `container` and `runtime`, and never `spec.specHash`.
- **SCAN-021** [api, cli] `GET /api/scans/{id}/inflight` returns `{items: [{analysisId, seq, round, attempt, startedAt, workerId, nodeId, progress}], updatedAt}` for analyses in progress and an empty list after completion; `scantor scans inflight` renders progress as `67% 4 of 6 s`.
- **SCAN-022** [api, cli, e2e] `GET /api/scans/{id}/workers/{workerId}/logs?wait&tailBytes` (1024–262144, default 65536) fetches a fresh tail from the worker's node, remote nodes included, and returns `{text, collectedAt, requestedAt, pending, truncated}`; `wait` above 30 returns 400, a worker of another scan 404, and a stopped worker returns its last collected text with `pending: false`.
- **SCAN-023** [api, mcp, cli, e2e] `POST /api/scans/{id}/pause` on a running scan sets `paused` with `stateReason {code: "user"}` and `pausedAt`; its workers drain (in-flight analyses finish) and their containers are removed, while the queue with its ready and delayed messages and the RabbitMQ user remain, late results are still recorded, and a paused scan never completes.
- **SCAN-024** [api, mcp] Forbidden transitions return 409 `invalidState` with `details {state, allowed}` and repeating the current state returns 200 unchanged: pausing a paused scan returns 200 and a completed one 409 (`allowed: ["running"]`); resuming a running scan returns 200 and a completed one 409; scaling a terminal scan returns 409; cancelling a cancelled scan returns 200 and a completed, failed, deleting or deleted one 409; deleting a creating, running or paused scan returns 409.
- **SCAN-025** [api, cli, e2e] `POST /api/scans/{id}/resume` on a paused scan sets `running` and places new workers; an unfinished scheduler resumes from its checkpoint with epoch + 1, and the final counts are exact with no duplicate seq.
- **SCAN-026** [api] `resumeScan`, `restartScan` and `retryFailedAnalyses` return 409 `revisionUnavailable` when the scan's revision no longer exists, and `restartScan` of a deleting or deleted scan returns 409 `invalidState`.
- **SCAN-027** [api, mcp, cli] `POST /api/scans/{id}/scale {workers?, processes?}` works in `creating`, `running` and `paused`, updates the settings and writes a `scan.scaled` event; values equal to the current ones return the scan unchanged without an event, and an empty body returns 400.
- **SCAN-028** [e2e] Scaling applies live: more workers add runner containers, fewer workers drain the least busy runners after their in-flight analyses, and a new `processes` value is applied in place (same container id) with memory = processes × `memoryMiB` + 256 MiB and nano-CPUs = processes × `cpus`; `processes.applied` and the scan queue's consumer count (workers × processes) follow.
- **SCAN-029** [e2e] Scaling beyond node capacity leaves the extra workers pending with the condition `workersPending` and reason `insufficientCapacity`.
- **SCAN-030** [api, mcp, cli, e2e, chaos] `POST /api/scans/{id}/cancel` from `creating`, `running` or `paused` sets `cancelled` and `completedAt`; the RabbitMQ user `scan-<id>` (first) and the queue are removed within seconds, workers are removed, pending and retrying analyses become `cancelled`, results already queued for ingestion are still recorded, and succeeded + failed + cancelled = total stays stable for 30 s.
- **SCAN-031** [e2e] Cancelling a scan during an active retry-failed cancels the `scanRetryFailed` job and returns `scheduling.state` to `done` (or `failed` when `scheduling.error` is set).
- **SCAN-032** [api, mcp, cli, e2e] `POST /api/scans/{id}/retry-failed` returns 202 `{scan, job}` (kind `scanRetryFailed`); the scan moves to round R + 1 with state `running`, `scheduling.state: "retrying"` and `completedAt: null`; every failed analysis and every lost one with a stored config runs again in round R + 1 with its attempts history spanning both rounds, while cancelled analyses are not retried.
- **SCAN-033** [e2e] `retry-failed` on a cancelled scan first lets round 1 settle (an analysis still running at the cancel counts as run once its result arrives), then records the never-run seqs as `cancelled` analyses of round 1 and runs only the failed ones again in round 2.
- **SCAN-034** [api] `retry-failed` returns 409 `nothingToRetry` when no failed or lost analysis has a config, and 409 `invalidState` while scheduling is pending or running, while another retry is active, and for a paused, creating, deleting or deleted scan.
- **SCAN-035** [api, mcp, cli, e2e] `POST /api/scans/{id}/restart {name?, settings?: {workers?, processes?}}` returns 201 with a new scan that has `clonedFrom` set, the same revision and effective configs (secrets included) and the overrides applied, with templates resolved again and no `confirm` needed; the original only gains a `scan.restarted` event.
- **SCAN-036** [api, mcp, cli] `DELETE /api/scans/{id}` on a completed, failed or cancelled scan returns 202 `{scan, job}` with the scan `deleting` and a `scanDelete` job; repeating it while deleting returns 202 with the same job, and a deleted scan returns 409.
- **SCAN-037** [e2e] When the `scanDelete` job finishes, the scan is a tombstone (`deleted`, `purgeAfter` = now + `SCANTOR_TOMBSTONE_DAYS`); its analyses, events, exports, workers, queue, RabbitMQ user and stored files are gone, earlier presigned file and export URLs return 404, and a late result published afterwards is dropped.
- **SCAN-038** [e2e, cli] When enough attempts in the breaker window fail (`SCANTOR_BREAKER_MIN_ATTEMPTS`, `SCANTOR_BREAKER_RATIO`), the running scan is paused automatically with `stateReason` `failureRate` (`100% of the last <n> attempts failed`), `breaker {trippedAt, ratio, attempts, windowMs}`, the condition `breakerTripped` and `scantor_breaker_trips_total` + 1; its workers drain and `scantor scans start --wait` exits 1.
- **SCAN-039** [e2e] Resuming a breaker-paused scan clears `breakerTripped` (a `scan.conditionCleared` event) and starts a fresh failure window.
- **SCAN-040** [e2e] A scan completes only when scheduling is `done` or `failed` and the recounted terminal analyses reach `scheduling.confirmed`: `completed` without `scheduling.error`, `failed` with it, with exact `stats` and `completedAt`; its workers, RabbitMQ user and queue are then removed. The ingestor completes it within 10 s of the last ingested result (at once unless the live counters overestimate), also in a retry-failed round started right after the round before and when a recount ran while the last results were ingested, without waiting for the periodic recount.
- **SCAN-041** [e2e, chaos] Counters are recounted: running scans every 60 s, paused scans while they changed since the last recount (without completing them), and terminal scans once more 2 minutes after the terminal state, which corrects transient over-counts such as `61/60` after a cancel.
- **SCAN-042** [api] Live hint counters (`stats.succeeded`, `failed`, `retrying`) rise as results arrive and never decrease until a recount replaces them with exact values, and `stats.ratePerMin` is above 0 while results arrive.

## PLACE. Placement

Mechanisms: [nodes](../docs/nodes.md) §12.

- **PLACE-001** [e2e] A running scan wants one scheduler while scheduling is pending or running plus `settings.workers` runners; creating, paused and terminal scans want none, surplus workers are drained and missing ones are inserted as pending.
- **PLACE-002** [e2e] An unplaceable worker stays pending and the scan carries the condition `workersPending {count, reasons}`, whose reason is the first filter that removed the last candidate (`userMaxWorkers`, `noNodes`, `archMismatch`, `selectorMismatch`, `dindUnavailable`, `diskLow`, `insufficientCapacity`, `pullLimit`); the condition clears once every worker is placed.
- **PLACE-003** [e2e] Placement reserves per worker one slot, processes × `cpus` CPUs and processes × `memoryMiB` + 256 MiB memory against the node's worker limit, CPUs and memory; a worker that does not fit stays pending with `insufficientCapacity`.
- **PLACE-004** [e2e] A user's non-zero `maxWorkers` caps their active workers across all scans: workers beyond it stay pending with `userMaxWorkers`, and the cap is not checked at scan start.
- **PLACE-005** [e2e] `settings.nodeSelector {pool, labels}` places workers only on nodes of that pool whose labels include the selector's; a scan with pool `remote` and labels `{zone: remote}` runs all of its workers, scheduler included, on `remote-1`.
- **PLACE-006** [e2e] The scheduler worker goes to the built-in node whenever it is a candidate, and a placed worker never moves to another node.
- **PLACE-007** [api, e2e] Placement writes a `worker.placed` event per placement and a `worker.pending` event only when a worker's pending reason changes.

## RES. Analyses, queries, exports and files

Mechanisms: [api](../docs/api.md) §4.14–§4.15, §5.2, [architecture](../docs/architecture.md) §11.5.

- **RES-001** [api, cli] `GET /api/scans/{id}/analyses` returns `Page<Analysis>` sorted by seq ascending with `?status` as a comma list; `?afterSeq` resumes, `nextCursor` is the decimal string of the last seq, and `limit` defaults to 50 with a maximum of 1000 (1001 returns 400).
- **RES-002** [api] `listAnalyses?fields=<dot paths>` returns only those paths plus `id` and `seq`; an unknown root field, a `files.*.key` path or an `id.x` path returns 400 `validationFailed`.
- **RES-003** [api, mcp, cli] `GET /api/analyses/{scanId-seq}` returns the analysis with `round`, `attempt`, `attempts` (at most 10), `config`, `result`, `error`, `logTail`, `timings` and `files` (without storage keys); a malformed id, an unknown seq and another user's scan return 404.
- **RES-004** [api, mcp, cli] `POST /api/scans/{id}/analyses/query {filter, projection?, sort?, limit?, afterSeq?}` returns `{items, nextCursor}` (`limit` default 20, at most 1000; `nextCursor` null with `sort`); the filter is always scoped to the scan, so a filter naming another `scanId` returns nothing, and a projection that excludes `_id` still pages by seq.
- **RES-005** [api, mcp] Sort keys must be dot paths with values 1 or −1 (others return 400 `validationFailed`); more than 8 sort keys return 400 `queryRejected` at path `sort`.
- **RES-006** [api, mcp, cli] `POST /api/scans/{id}/analyses/aggregate {pipeline, limit?}` (at most 100 stages) returns `{items, truncated}`; only allowlisted stages pass, and a nested `$facet`, a `$sample` size above 10 000 and a stage object with more than one key return 400 `queryRejected`.
- **RES-007** [api] An aggregation result over `limit` or `SCANTOR_QUERY_MAX_DOCS` is cut with `truncated: true`.
- **RES-008** [api] A query that runs longer than `SCANTOR_QUERY_MAX_TIME` returns 504 `queryTimeout`.
- **RES-009** [api, e2e] More than `SCANTOR_USER_MAX_CONCURRENT_QUERIES` concurrent queries, aggregations or inline exports of one user return 429 `tooManyRequests` with `details.limit`.
- **RES-010** [api, cli] `GET /api/scans/{id}/export?format=jsonl|csv&status&filter&fields&afterSeq` streams `application/x-ndjson` or `text/csv` sorted by seq as attachment `scantor-<scanId>.<format>`; an inline `filter` that is not a URL-encoded JSON object returns 400 `validationFailed` at path `filter`.
- **RES-011** [api, cli] An inline export that matches more than `SCANTOR_EXPORT_INLINE_MAX` analyses returns 409 `exportTooLarge` with `details.limit`.
- **RES-012** [api, security] A CSV export (inline or background) starts with a header row (default columns `id`, `seq`, `status`, `attempt`, `round`, `error.type`, `error.message`, `timings.durationMs`, `config`, `result`), JSON-encodes nested values, quotes per RFC 4180, ends rows in CRLF and prefixes cells starting with `=`, `+`, `-`, `@`, tab or CR with an apostrophe.
- **RES-013** [api] JSONL export rows are whole masked analysis representations, or the `fields` projection when it is given.
- **RES-014** [api, mcp, cli] `POST /api/scans/{id}/exports {format, filter?, fields?, afterSeq?}?wait` returns 201 with an export that moves from `queued` to `ready` with `rows` and `bytes`; the ready export carries `download {url, expiresAt}` (10 minutes), and the downloaded content equals the inline export.
- **RES-015** [api] Exporting a deleting or deleted scan, inline or in the background, returns 409 `invalidState`.
- **RES-016** [api, cli] `GET /api/exports?scanId` pages through exports newest first and `GET /api/exports/{id}?wait` holds until ready or failed; `DELETE /api/exports/{id}` returns 204, removes the stored object and a running export job, and a later GET returns 404; an export expires `SCANTOR_EXPORT_RETENTION_DAYS` after creation.
- **RES-017** [api, cli] `GET /api/analyses/{id}/files/{fileId}` returns `FileDownload {url, expiresAt, name, size, sha256, contentType, inline}` (302 with `?redirect=true`); the downloaded bytes match the sha256, an unknown file id returns 404, and `scantor files get` downloads and verifies the files.
- **RES-018** [security] File downloads of png, jpeg, gif and webp are served inline with their image type; html, svg and every other type are served as attachment with `application/octet-stream`, and CR, LF and quotes in file names are sanitised in an RFC 5987 `Content-Disposition`.
- **RES-019** [security] Downloads are presigned GETs on `SCANTOR_S3_PUBLIC_URL`, created per request and valid 10 minutes, with `Content-Disposition: attachment` for exports and revision sources; an unsigned or expired URL returns 403.

## JOB. Jobs

Mechanisms: [api](../docs/api.md) §4.16.

- **JOB-001** [api] `GET /api/jobs?kind&state` returns `Page<Job>` (`id`, `kind`, `subject`, `state`, `progress`, `attempts`, `error`, `createdAt`, `startedAt`, `finishedAt`); users see only their own jobs, admins see all, including jobs without a user, and may filter with `?userId`.
- **JOB-002** [api] `GET /api/jobs/{id}?wait` holds until the job is succeeded, failed or cancelled; another user's job, and for non-admins a job without a user, returns 404.

## ING. Queues and result ingestion

Mechanisms: [queue](../docs/queue.md) §3–§7, [security](../docs/security.md) ING-1…ING-7, MC-4.

- **ING-001** [security] Orchestrator boot ensures the vhost `scantor`, the topic exchanges `scantor.analyses`, `scantor.results` and `scantor.dead`, and the quorum queues `scantor.results.ingest` (delivery limit 3, dead-lettered to `scantor.dead`) and `scantor.dead.ingest`.
- **ING-002** [e2e] A creating scan gets the quorum queue `scantor.scan.<id>` (delivery limit `SCANTOR_DELIVERY_LIMIT`, dead-lettering to `scantor.dead`, `x-overflow: reject-publish`, `x-max-length: SCANTOR_SCAN_QUEUE_MAX_READY`) bound with its id, plus the RabbitMQ user `scan-<id>` and its permissions, before it becomes `running` with `startedAt`.
- **ING-003** [e2e] When a scan becomes completed, failed, cancelled or deleting, its user `scan-<id>` is deleted first and then its queue; orphan `scan-*` users and `scantor.scan.*` queues without an active scan are removed within one reconciler tick.
- **ING-004** [security] The scan user's password is derived from `SCANTOR_SECRET` and the scan id and never stored, so a recreated user (resume, retry-failed) has the same password; the user has no tags, so the RabbitMQ management API rejects it with 401.
- **ING-005** [security] A scan user can consume only its own queue and publish only to `scantor.analyses` or `scantor.results` with its own scan id as routing key: another scan's routing key is refused (`ACCESS_REFUSED`), a spoofed `user_id` closes the channel, and it cannot declare, bind or delete anything, publish to `scantor.dead` or the default exchange, or read other queues.
- **ING-006** [security, e2e] The per-scan user is limited to 2 × (workers + 1) connections and that many × (processes + 2) channels; `scaleScan` raises the limits before the new workers are assigned.
- **ING-007** [security] The ingestor takes a result's scan only from the broker-validated `user_id`: a message without `user_id`, with a routing key of another scan, with a body `scanId` or `analysisId` that disagrees, with seq −1, 1.5 or ≥ 2^53, or with a non-JSON body is dead-lettered without writing anything, counted in `scantor_dead_letters_total` and recorded as an admin-only `security.ingestRejected` event; a body claiming scan A sent as scan B writes only `B-<seq>`.
- **ING-008** [security] A result for a round above the scan's round is dropped, and results for unknown, deleting or deleted scans are acknowledged and dropped (counted as `scantor_ingest_messages_total{outcome="dropped"}`), while late results of cancelled scans are recorded.
- **ING-009** [security, e2e] An authenticated result that fails its schema becomes a `failed` analysis of type `platform`, phase `ingest`, with the message `invalid result message: <first schema error>`; an update that cannot be stored becomes `failed` with `result could not be stored: <reason>`; ingestion of other scans continues meanwhile.
- **ING-010** [chaos, security] Results are applied as guarded upserts: a later success beats a failure of the same round, otherwise the first terminal result wins, older rounds never overwrite newer ones, and a re-published duplicate leaves analyses and counts unchanged (counted as `outcome="duplicate"`).
- **ING-011** [e2e] An attempt event sets the analysis to `retrying` and appends an `attempts[]` entry (at most 10 are kept); it is ignored once the analysis is final or a later attempt is recorded.
- **ING-012** [chaos] An analysis whose delivery limit is reached because every worker processing it died is recorded as `failed` with type `crash`, not retryable, the message `every worker that received this analysis died while processing it (delivered <n> times, delivery limit <L>)` and the death details; the other analyses of the scan complete.

## SCHED. Scheduler

Mechanisms: [runtime](../docs/runtime.md) §11, [api](../docs/api.md) §8.5–§8.7.

- **SCHED-001** [e2e] A template schedule without wrapping runs natively in the scheduler without a connector process, and a custom schedule runs in exactly one connector process that streams the analysis items.
- **SCHED-002** [api] `schedulerCheckpoint` stores `{epoch, confirmed, tailHash}` only when `confirmed` increases; an older checkpoint returns the stored values unchanged, and `schedulerResolved` for an existing key returns the stored resolution with `stored: false`.
- **SCHED-003** [e2e, chaos] After a pause and resume, or after the scheduler is lost, a new scheduler with epoch + 1 regenerates the stream from the checkpoint and verifies it, so the final analyses are exact with no duplicate seq (also when the pause happened during backpressure).
- **SCHED-004** [chaos] A custom schedule that yields different items on resume (the `nondeterministic` fixture, scheduler killed after `scheduling.confirmed > 0`) fails scheduling with `schedule() is not deterministic: …`, and the scan ends `failed`.
- **SCHED-005** [e2e] The scheduler keeps at most half of `SCANTOR_SCAN_QUEUE_MAX_READY` in the scan queue (ready messages plus its unconfirmed publishes) and waits while that share is used up (state polls report `backpressure: true`), leaving the other half to retries, which count toward `x-max-length` while they are delayed; publishes that a full queue still refuses are republished only for the refused seqs. A 20 000-analysis scan with a limit of 500 completes with exact counts and seqs 0…19999 without a refused publish; a retry refused by a full queue (it refuses future-dated publishes too) is neither lost nor failed and raises no `workerErrors`: its runner holds the delivery and runs the next attempt once the retry is due.
- **SCHED-006** [e2e] When the stream ends and every item is confirmed, `scheduling.state` becomes `done` and the scheduler worker is drained and removed.
- **SCHED-007** [e2e] Schedule limits fail scheduling with a non-retryable `validation` error in phase `schedule`, such as `schedule() produced more than <max> analyses (SCANTOR_MAX_ANALYSES_PER_SCAN)` or `analysis config <seq> is <n> bytes; the maximum is <max>`; items published earlier still run and the scan ends `failed`.
- **SCHED-008** [e2e] A retryable error in `schedule` increments `scheduling.restarts` and raises the condition `schedulerRestarting`, and the schedule restarts after the scan's backoff `min(maxMs, initialMs × factor^(restarts − 1))` (1 s, 2 s, 4 s with `throws`' initial 1 s and factor 2); above `SCANTOR_SCHEDULER_MAX_RESTARTS` scheduling fails with `scheduling failed after <n> restarts (SCANTOR_SCHEDULER_MAX_RESTARTS=<m>): <error>`, the conditions are `schedulingFailed` and `workerErrors`, and the scan ends `failed` (`throws` mode `fail_in_schedule`).
- **SCHED-009** [e2e] A `Fatal` or `validation` error in `schedule` fails scheduling at once without a restart (condition `schedulingFailed`, `stateReason` `schedulingFailed`); analyses published before the error still run and the scan ends `failed`.
- **SCHED-010** [api, chaos] Scheduler calls with an old epoch return 409 `staleEpoch` with `details.currentEpoch`; a stale scheduler (for example after a partition) stops publishing and never calls done, and its duplicate items are absorbed.

## NODE. Nodes and the node daemon

Mechanisms: [nodes](../docs/nodes.md), [api](../docs/api.md) §4.17, §7, [architecture](../docs/architecture.md) §11.4.

- **NODE-001** [api, mcp, cli] `GET /api/nodes?state&pool` (admin) returns `{items}` with the built-in node first and the others by name; each node has `state`, `pool`, `labels`, `cordoned`, `maxWorkers`, `info` (os/arch, CPUs, memory, free disk, `maxWorkers`, `egressDenyApplied`, `dindMode`) and `activeWorkers`, and never `tokenHash` or the instance id.
- **NODE-002** [api, cli] `POST /api/nodes {name, pool?, labels?, maxWorkers?}` returns 201 `{node, token, join}` with the node `pending` (pool `shared` by default) and a `snt_…` token that is shown only in this response.
- **NODE-003** [api] Node names must be slugs: `builtin` returns 400 `validationFailed` and a duplicate name 409 `alreadyExists`; labels allow at most 32 keys matching the key pattern, with values of at most 63 characters.
- **NODE-004** [api, cli] `join.dockerRun` is exactly `docker run -d --name scantor-node --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock -e SCANTOR_URL=<public url> -e SCANTOR_NODE_TOKEN=<token> <prefix>scantor:<tag> node`; `join.compose` has the same image and environment, and `join.env` is `{SCANTOR_URL, SCANTOR_NODE_TOKEN}`.
- **NODE-005** [api, cli] `GET /api/nodes/{id}/join` returns the join instructions with the token replaced by `${SCANTOR_NODE_TOKEN}`; an unknown node returns 404.
- **NODE-006** [api, cli] `PATCH /api/nodes/{id}` updates `name`, `pool`, `labels`, `maxWorkers` (null removes it) and `cordoned`; an empty body returns 400 and a taken name 409; renaming the built-in node returns 409 `builtInNode`, while its pool, labels, worker limit and cordon flag can change.
- **NODE-007** [api, cli, e2e] `DELETE /api/nodes/{id}` returns 204: the node is removed, its workers become lost and are replaced elsewhere, and its daemon gets 401 on its next call.
- **NODE-008** [api, cli] `POST /api/nodes/{id}/token` returns `{node, token, join}` with a new token: the old token gets 401 on `/api/node/*`, a `node.tokenRotated` event is recorded, and a revoked node returns to `pending`.
- **NODE-009** [api, cli] `DELETE /api/nodes/{id}/token` sets the node `revoked`: its workers become lost at once (their worker tokens stop working), the registry token route answers 401 for it, and a `node.revoked` event is recorded; repeating it returns 200 unchanged.
- **NODE-010** [api, cli] Rotating, revoking or deleting the built-in node returns 409 `builtInNode`, and `scantor nodes` exits 2 for them.
- **NODE-011** [api, cli] `GET /api/nodes/{id}/workers?state` pages through the workers placed on the node, each with `scan {id, name}`; `GET /api/nodes/{id}/events?type` pages through its events newest first, matching the type exactly or by a `.` prefix.
- **NODE-012** [api] The built-in node `builtin` (`builtIn: true`, endpoint profile `internal`, pool `shared`) exists and is online after boot; its `info.maxWorkers` equals `SCANTOR_BUILTIN_NODE_MAX_WORKERS` and its clock offset stays near 0.
- **NODE-013** [e2e] A cordoned node gets no new workers while its running workers stay; a scan that only that node could serve shows `workersPending` (`selectorMismatch` for `remote-1`), and after uncordoning the waiting workers are placed and the scan completes.
- **NODE-014** [e2e] Running the `dockerRun` join snippet on a Docker host brings a pending node online with its reported info, and the daemon creates the `scantor-workers` network there.
- **NODE-015** [api] `POST /api/node/hello` sets the node online, stores its info (hostname, os, arch, kernel, Docker version, CPUs, memory, free disk, effective `dindMode`, `maxWorkers`, `egressDenyApplied`), emits `node.online` and returns `{serverTime, node, config}` with the status interval, long-poll wait, offline window, drain grace, registry host and user `node`, and the minimum free disk.
- **NODE-016** [api] Hello with an unknown or revoked node token returns 401, and hello to a release orchestrator (`X.Y.Z`) from a daemon version outside the same or previous minor returns 426 `incompatibleVersion` with `details.minVersion`; a non-release build such as `dev` accepts every daemon version.
- **NODE-017** [api, security] A second daemon using the same node token on a different Docker engine gets 409 `nodeInstanceConflict` with `details.retryAfterMs` and a `node.instanceConflict` event, also on status; a restarted daemon on the same engine takes the lease over at once.
- **NODE-018** [api] `GET /api/node/assignments?rev&wait` returns at once when the node's assignments revision is newer than `rev` and otherwise after `wait` (at most 60 s); it always returns the complete desired set `{rev, workers[], logRequests[]}`, and a placement change wakes a pending long-poll early.
- **NODE-019** [api, e2e] An assignment references the task image by digest at the node's registry host (`localhost:<port>` on the built-in node, `SCANTOR_REGISTRY_PUBLIC_HOST` on remote nodes), carries memory = processes × `memoryMiB` + 256 MiB and nano-CPUs = processes × `cpus`, and its environment holds only `SCANTOR_URL` (from the node's endpoint profile) and `SCANTOR_WORKER_TOKEN`.
- **NODE-020** [api, security] Node status entries for workers not assigned to the calling node are ignored, and posting worker logs for such a worker or for an unknown request id returns 404 and stores nothing.
- **NODE-021** [security, e2e] A running worker container `scantor-w-<workerId>` matches the hardening profile: the runtime as entrypoint, `Init`, restart policy `no`, `CapDrop ALL` with `CapAdd` only from `NET_BIND_SERVICE`/`NET_RAW`, `no-new-privileges`, the pids limit, `Memory = MemorySwap`, `NanoCpus`, shm size, the `nofile` ulimit, the `local` log driver with rotation, and no mounts or published ports.
- **NODE-022** [security, e2e] Workers on the built-in node join `scantor-sandbox`; workers on a remote node join `scantor-workers` (inter-container traffic disabled), so workers of different scans on one node cannot reach each other.
- **NODE-023** [security, e2e] A worker's environment is exactly the assignment's environment plus `SCANTOR_CA_CERT` (and `SCANTOR_ALLOW_INSECURE_TRANSPORT` when set) from the daemon, and nothing else.
- **NODE-024** [security] The daemon only touches containers it can attribute to itself: a name conflict with a foreign container reports `createFailed` (`name conflict with a foreign container`) and never removes it, containers with copied managed labels but a foreign name are ignored, and helper, editor, build and test-run containers are untouched.
- **NODE-025** [chaos, e2e] On SIGTERM the daemon exits 0 and its workers keep running; the restarted daemon adopts the still-desired containers and removes undesired ones only after its first assignments response, so a scan running across the restart completes with exact counts and no lost workers.
- **NODE-026** [e2e] A worker container that exits non-zero restarts in place (same container id) with a growing backoff, reports `backoff` with `restarts`, `lastExit {exitCode, oomKilled, at, logTail}` and `nextRestartAt`, and raises the scan condition `crashLoop {workerId, nodeId, exitCode, oomKilled, restarts, logTail}` and a `worker.crashed` event (a task whose connector dies before its handshake, so the runtime exits non-zero); an exit 0 restarts without counting a crash and never raises `crashLoop`.
- **NODE-027** [e2e] When a connector process exceeds the container's memory, it is killed first, the worker keeps running, and the analysis fails with type `crash` and `details.oomKilled` (`crashy` mode `memory`).
- **NODE-028** [e2e] A worker that leaves the desired set (scale-in, pause, scheduling done, scan terminal) is stopped after its drain grace and removed with its volumes; its state goes `draining` → `stopped`, and stopped containers never pile up.
- **NODE-029** [cli] `scantor node healthcheck` exits 0 while the daemon's status file is younger than three status intervals and 1 otherwise; it needs no configuration and is the container healthcheck of the compose file and the join snippet.
- **NODE-030** [cli, security] `scantor node` exits 2 at start on invalid configuration (both `SCANTOR_NODE_BUILTIN=true` and `SCANTOR_NODE_TOKEN` set, an unknown `SCANTOR_NODE_DIND`, a malformed CIDR in `SCANTOR_NODE_EGRESS_DENY`), and refuses a plaintext `SCANTOR_URL` to a public address unless `SCANTOR_ALLOW_INSECURE_TRANSPORT=true`.
- **NODE-031** [e2e, security] After its token is rejected (rotated, revoked or node deleted), the daemon logs `orchestrator rejected the node token (401)`, creates no containers, keeps the existing ones and retries hello; still unauthorized after the offline window, it removes its managed worker containers.
- **NODE-032** [security, e2e] Task images are pulled by digest with a per-pull registry credential carrying the node token; the daemon never runs `docker login` and writes no credentials to the host's Docker configuration.
- **NODE-033** [e2e] A failed image pull puts the worker in state `error` with code `imagePullFailed` and raises the scan condition `imagePullFailed {nodeId, message}`, which clears once a pull of the image succeeds.
- **NODE-034** [security, e2e] The daemon runs a one-shot egress helper `scantor-netpol-<nodeId>` (host network, `NET_ADMIN` and `NET_RAW`, read-only, managed labels) that installs a reject rule per CIDR of `SCANTOR_NODE_EGRESS_DENY`; `info.egressDenyApplied` is true only when every CIDR is in place, and then `169.254.169.254` is unreachable from workers.
- **NODE-035** [e2e] A scan with `nodeSelector.pool = "remote"` runs end to end on `remote-1` over the public endpoint profile: the task image is pulled from the public registry host through the token realm over TLS with the test CA, workers use AMQPS and presigned S3 through Traefik, results are ingested, files download correctly and worker logs are available on demand.

## REG. Registry token

Mechanisms: [api](../docs/api.md) §6, [auth](../docs/auth.md) §10.4, [nodes](../docs/nodes.md) §10.

- **REG-001** [api] `GET /api/registry/token?service=scantor-registry&scope=repository:tasks/<id>:pull` with Basic `node:<snt_ token>` returns `{token, access_token, expires_in: 300, issued_at}`, an ES256 JWT (`iss` scantor, `aud` scantor-registry, `sub` `node:<nodeId>`) without a refresh token.
- **REG-002** [api] `POST /api/registry/token` with the form `grant_type=password`, `username=node`, `password=snt_…` and `scope` returns `{access_token, expires_in, issued_at}`.
- **REG-003** [api, security] The granted access is the requested access intersected with what is allowed: a node gets pull only on `tasks/<taskId>` repositories of its current assignments (a token for N1 omits a repository assigned only to N2), never push, delete or catalog, and a request without scope gets `access: []`.
- **REG-004** [api, security] The orchestrator credential gets pull, push and delete on `tasks/*` and `registry:catalog:*` (`sub` `orchestrator`), and only it can list `/v2/_catalog`.
- **REG-005** [api] Token errors use the registry format `{errors: [{code, message}]}`: 401 `UNAUTHORIZED` for an invalid or revoked credential, 400 `DENIED` for an unknown service, 400 `UNSUPPORTED` for a `grant_type` other than `password`, and 400 `SIZE_INVALID` for a form over 64 KiB.
- **REG-006** [api, security] A node's pull grant for a task disappears from the next token once its worker is lost, the node is revoked or the scan ends.

## RT. Runtime

Mechanisms: [runtime](../docs/runtime.md), [api](../docs/api.md) §8, [protocol](../docs/protocol.md).

- **RT-001** [api, security] The first `GET /api/runtime/bootstrap` moves the worker to `running` (the scheduler also moves `scheduling.state` to `running`) and returns the worker, scan, revision, AMQP, limits and intervals; the scheduler gets the scan config, checkpoint, resolutions and data sources with `processes` 1, a runner gets no scan config and `scheduler: null`; clear `writeOnly` values appear only here, for that scan's workers.
- **RT-002** [api] Bootstrap returns action `stop` when the scan is no longer running.
- **RT-003** [api, security] `runtimePresignUploads` builds the keys `files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>` from the token's scan, so path-like names stay inside the scan prefix; content type, length and metadata are signed, so a larger PUT than signed fails; malformed or duplicate file ids, a seq out of range, duplicate names, too many files and an oversized file return 400.
- **RT-004** [api] `runtimeAnalysesStatus` accepts at most 1000 seqs and answers only for the token's scan.
- **RT-005** [api] `runtimeReportError` returns 202 and raises the scan condition `workerErrors` and a `worker.error` event.
- **RT-006** [security, e2e] Connector processes never see `SCANTOR_WORKER_TOKEN`, `SCANTOR_URL`, `SCANTOR_CA_CERT` or `SCANTOR_ALLOW_INSECURE_TRANSPORT`; they get their own `TMPDIR` and the protocol variables, as the `netprobe` fixture in mode `env` shows.
- **RT-007** [e2e] Each runner process consumes the scan queue with prefetch 1, so the queue's consumer count equals the open process slots (3 workers × 4 processes = 12 consumers).
- **RT-008** [e2e, chaos] Deleting the user `scan-<id>` closes every worker connection of the scan, remote nodes included; the runtime aborts its running analyses and exits 0.
- **RT-009** [e2e] A connector process is recycled after `settings.maxAnalysesPerProcess` analyses and after a timeout, crash or protocol violation; after repeated timeouts each slot still has exactly one connector process.
- **RT-010** [security] Malformed analysis messages published as the scan user (wrong scan id, an `analysisId` that is not `<scanId>-<seq>`, seq, round or attempt out of range, a config over `SCANTOR_MAX_ANALYSIS_CONFIG_BYTES`) become `failed` analyses of type `validation` (`malformed analysis message: <reason>`) when seq and round are usable, and are otherwise dropped with a worker error.
- **RT-011** [e2e] A run that exceeds `settings.timeoutMs` has its connector process group killed, child processes included, and fails with type `timeout`, retryable, phase `run`, `run exceeded <timeoutMs> ms`.
- **RT-012** [e2e] A connector process that ends during a run gives type `crash`, retryable, with `details {exitCode, signal, oomKilled}` and `connector process ended during the run (exit code 3)`.
- **RT-013** [e2e] Outcomes are classified per language: `Fatal` fails after 1 attempt, not retryable; `Retry` is retryable with its delay; any other exception, Go error or panic is a retryable `taskError` with a stack; a config or result rejected by the task's model is a non-retryable `validation` error in phase `validate` with `details.issues`.
- **RT-014** [e2e, security] A result that is not a JSON object, or whose size exceeds `SCANTOR_MAX_RESULT_BYTES`, fails as `validation` without retry (`result is <n> bytes; the maximum is <max>; store large data with ctx.files.put`, `big-result` fixture), and other scans keep ingesting.
- **RT-015** [e2e] `ctx.files.put` returns a FileRef `{id, name, size, sha256, contentType}` (null content type becomes `application/octet-stream`); more than `SCANTOR_MAX_FILES_PER_ANALYSIS` files or a file larger than `SCANTOR_MAX_FILE_BYTES` raises a `validation` error in user code and fails the analysis when uncaught.
- **RT-016** [e2e] Files are uploaded only after a successful run, so failed attempts store none; every registered file is listed in `result.files`, and FileRefs nested in objects and arrays of the result are recorded at `fileRefPaths` and downloadable.
- **RT-017** [e2e] When the per-user storage quota `SCANTOR_USER_STORAGE_QUOTA_BYTES` is exceeded, the analysis fails with type `platform`, phase `upload`, not retryable, `storage quota exceeded`; `retry-failed` after freeing storage runs it again.
- **RT-018** [e2e] A retryable failure with attempts left shows the analysis `retrying` with `attempt` n and an `attempts[]` entry (error and a log tail of at most 4 KiB), and the retry waits in the queue as a delayed message (0 ready) until it is due.
- **RT-019** [e2e] Without jitter and with a backoff of 2 s × 2, attempts start 2 s, 4 s and 8 s apart; `Retry(delay)` waits exactly its delay (clamped to at least 1 s and at most `backoff.maxMs`).
- **RT-020** [e2e] When attempts are exhausted, the analysis is `failed` with `attempt == maxAttempts`, keeping the error type's `retryable` value and at most the last 10 attempts; a flaky task succeeds on a later attempt.
- **RT-021** [e2e] An analysis's `logTail` holds the connector's stdout and stderr plus `ctx.log` lines rendered as `[<level>] <message> key=value…`; the final result keeps the last 32 KiB and attempts the last 4 KiB, and a truncated tail starts with `…[<n> bytes truncated]`.
- **RT-022** [security] Worker logs (from `getWorkerLogs`) are JSON lines with `scanId`, `workerId`, `nodeId` and `role`, with connector output as `{msg: "connector output", stream, line}`; the worker token, the AMQP password, presigned query strings and config values never appear in them.
- **RT-023** [e2e] Error fields are bounded: `message` at most 4 KiB, `stack` at most 16 KiB with the middle cut (`…[<n> bytes truncated]…`), and `details` over 4 KiB replaced by `{truncated: true}`.
- **RT-024** [e2e] On drain (pause or scale-in) a worker stops taking work, lets in-flight analyses finish within the drain grace and exits 0; on stop (cancel) it cancels in-flight runs, kills them after at most 5 s and records nothing for them.

## CONN. Connectors, base images and describe

Mechanisms: [protocol](../docs/protocol.md), [tasks](../docs/tasks.md) §4–§7.

- **CONN-001** [e2e] A task image started without the runtime (no readable fd 3 and writable fd 4) prints `scantor: this program is a scantor task connector; run it with "scantor dev run"` and exits 2, in every language.
- **CONN-002** [e2e] User output on stdout and stderr never corrupts the protocol: a printed JSON line that looks like a result is captured as log output.
- **CONN-003** [e2e] An exception while the task module loads fails the revision at describe with the message and stack (for example `ModuleNotFoundError: No module named 'httpx'`), and an invalid definition (a Python module without `task`, a TS/JS default export that is not a task) fails describe as `validation`; the `no-hello` fixture fails at describe.
- **CONN-004** [e2e] `ctx.log(level, message, fields)` lines appear in the analysis log tail and in local-mode events as `[info] hello n=1`, and `ctx.progress(fraction, message)` appears in the scan's in-flight list.
- **CONN-005** [e2e] Python tasks define a module-level `scantor.Task(...)` with configs derived from `scantor.Config`; `run` and `schedule` may be sync or async and return or yield dicts or models, and they build, describe and run.
- **CONN-006** [e2e] TypeScript and JavaScript tasks `export default defineTask({...})` with `config()` roots and `secret()` fields from `@scantor/connector`, and build, describe and run; a plain `z.object` config root fails describe.
- **CONN-007** [e2e] Go tasks call `scantor.Serve(schedule, run)` or `ServeRun(run)`, including uninstantiated template functions such as `cidr.Schedule`, and build, describe and run; a panic becomes a `taskError` with a stack, and a result that violates a struct tag constraint fails as `validation`.
- **CONN-008** [e2e] The base images implement the ENV contract (`SCANTOR_LANGUAGE`, `SCANTOR_CONNECTOR_CMD`, `SCANTOR_CHECK_CMD`, `SCANTOR_DEBUG_CMD`, `SCANTOR_DEBUG_PORT`, `WORKDIR /task`); a Dockerfile `ENV` override of the connector command is honoured and produces warning W2.
- **CONN-009** [e2e] Every base image ships the system CA bundle, so HTTPS from tasks and from the runtime (data sources, S3, AMQPS) works in every language, verified against the system roots plus `SCANTOR_CA_CERT`.
- **CONN-010** [api] Describe exports normalised schemas (`$schema` draft 2020-12, no `$id`, object roots, no defaults on `writeOnly` properties) in source property order and derives `secretPaths`, `uploadPaths` and `fileRefPaths`.
- **CONN-011** [e2e] Describe fails the revision (phase `describe`) for an open config root, a default that violates its own schema, a result root that is not an object and a language that does not match the manifest, and warns about open nested objects.
- **CONN-012** [api, e2e] An unwrapped template proxy (`schedule=tranco.schedule`, `cidr.Schedule`) is described as `{kind: "template", template: <name>}` with the template's canonical schemas, while a custom generator that calls a proxy is described as `{kind: "custom"}` with the task's own schemas.
- **CONN-013** [e2e] A scan config with properties on a task without `schedule` (template `single`) is a definition error.

## DEV. Local development loop

Mechanisms: [tasks](../docs/tasks.md) §9.1, §11–§12, [runtime](../docs/runtime.md) §15, [guide/cli](../docs/guide/cli.md).

- **DEV-001** [cli] `scantor init [dir] --language <l> [--template <t>|custom] [--name] [--description]` writes a scaffold (dir defaults to `./<name>`, name to the slug of the dir, template to `single`) and prints the next steps; it refuses an existing non-empty directory.
- **DEV-002** [cli] A scaffold contains `scantor.yaml` with the schema modeline (valid against `schemas/task-manifest.schema.json`), `Dockerfile`, the entry and dependency files, a type-checker config, `.dockerignore`, `.gitignore`, `.devcontainer/devcontainer.json`, `.vscode/{launch,tasks,settings}.json` and `AGENTS.md`.
- **DEV-003** [e2e, cli] For every language of `schemas/languages.json` × every template plus `custom`, `scantor init`, then `scantor validate` exits 0 and `scantor dev run --limit 2` exits 0 with at least one succeeded analysis.
- **DEV-004** [cli] `scantor validate [dir]` runs pack, static checks, build, describe and the type check on local Docker, never pushes and accepts privileged tasks locally; it exits 0, 2 or 3, and gives the same Dockerfile-policy verdicts and messages as a server publish.
- **DEV-005** [cli] Under `SCANTOR_DEV_MODE=remote` (the editor), `scantor validate` and `scantor dev debug` exit 3 with a hint that they need local Docker.
- **DEV-006** [cli] `scantor dev run [dir]` builds, describes, validates and fills the configs (an invalid config exits 2) and runs the task locally with `--task-config`, `--scan-config` and `--analysis-config` (JSON, `@file` or `-`), `--limit` (default 5), `--max-attempts` and `--timeout` (`2s` gives `run exceeded 2000 ms`); it prints events live, earlier failed attempts as `attempt N failed: …; retrying`, and exits 0, 1, 2 or 3.
- **DEV-007** [cli] Local `dev run` uses `SCANTOR_TRANCO_URL` and `SCANTOR_CRUX_URL` when set, and a config that references an upload fails with a clear message because local mode has no uploads.
- **DEV-008** [cli] `scantor dev run -o json` prints the local-mode NDJSON events unchanged: `start`, `resolved`, `scheduled`, `log`, `attempt {nextAttemptAt}`, `result {status, attempt, config, result, error, files, logTail, attempts, timings}`, `error` and `end {reason, summary, exitCode}`.
- **DEV-009** [cli] Local-mode exit codes, the highest applicable winning: 3 for a total timeout, an interrupt or a runtime failure; 2 when the connector cannot start or describe, or for a validation error outside an analysis; 1 when an analysis or the schedule failed; 0 when everything succeeded, including zero items.
- **DEV-010** [cli] In local mode `--analysis-config` skips `schedule` and runs once with seq 0, `--limit` caps the items taken from the schedule (end reason `limit`), backoff and `Retry` delays are capped at 2 s, and `ctx.scanId` is `local` with round 1.
- **DEV-011** [cli] Files of a local run are copied to `.scantor/out/<timestamp>/files/<seq>/<fileId>/<name>` in the task folder, owned by the invoking user, with sha256 values matching the FileRefs.
- **DEV-012** [cli] On a total timeout or an interrupt, local mode kills the connector processes; in-flight analyses end `failed` with error type `cancelled` and the end event has reason `timeout` or `interrupted`.
- **DEV-013** [cli] `scantor dev run --remote` (or `SCANTOR_DEV_MODE=remote`) syncs the folder with `uploadTask?publish=false` (409 `workspaceDirty` exits 2 unless `--force`), starts a test run, follows its stream, prints the events (`-o json` as `{type, data}`) including earlier failed attempts, and downloads files into `.scantor/out`.
- **DEV-014** [cli, e2e] `scantor dev debug` runs one connector process under the base image's debugger (debugpy, the Node inspector, Delve) with timeouts disabled and the debug port published on 127.0.0.1 (5678, 9229 or 2345, reported in the start event); attaching with DAP, CDP or Delve and resuming completes the analysis, in every language.
- **DEV-015** [cli] `scantor push [dir]` packs locally and uploads; the manifest name selects or creates the task, it publishes unless `--no-publish`, `-m` sets the revision message, and with `--wait` it exits 2 when the revision failed on its content and 3 on a platform failure.

## CLI. Command-line interface

Mechanisms: [guide/cli](../docs/guide/cli.md), [architecture](../docs/architecture.md) §4.2.

- **CLI-001** [cli] Exit codes: 0 success; 1 when analyses failed (`dev run`, and `scans start --wait`, `scans get --wait` and `scans watch` for a failed, cancelled or breaker-paused scan or one completed with failed or lost analyses); 2 for invalid input (usage, configuration, task content, configs, API 4xx); 3 for platform failures (Docker, network, API 5xx, timeouts, interrupts); with `-o json` errors print as `{error: {code, message, exitCode, …}}`.
- **CLI-002** [cli] The CLI takes credentials only from `SCANTOR_URL` and `SCANTOR_TOKEN`; a token that does not start with `sk_scantor_` or a `SCANTOR_IMAGE_PREFIX` not ending in `/` is a configuration error (exit 2); `scantor version` prints the version, commit and image prefix.
- **CLI-003** [cli] Run containerised (the `scantor.sh` shim pattern), the CLI rewrites a `localhost`, `127.0.0.1` or `::1` host in `SCANTOR_URL` to `host.docker.internal`, keeping the port. The shim reaches a port the host binds to `127.0.0.1` also on a Linux Docker Engine, whose host gateway does not: there the CLI container shares the host network.
- **CLI-004** [cli] `scantor push <dir> --wait` uploads a task folder and builds a ready revision, and `scantor scans start <task>@latest --wait -o json` runs a scan to completion, prints the final scan and exits 0.
- **CLI-005** [cli] `scantor scans start [revision]` takes `--task-config`, `--scan-config` and `--settings` as JSON, `@file` or `-`, plus `--workers`, `--processes`, `--confirm`, `--name` and `--wait` (which settles on finish or pause and exits 0 or 1).
- **CLI-006** [cli] `scantor scans watch <scan>` prints progress until the scan completes, fails, is cancelled or is paused by the breaker (a user pause is watched until the scan resumes and finishes); `-o json` prints one scan per change as NDJSON, and `--interval` and `--timeout` are honoured.
- **CLI-007** [cli] `scantor scans pause|resume|cancel|scale|retry-failed|restart|delete|inflight|conditions|events|workers|worker logs` map to their API operations, and a 409 from the server exits 2.
- **CLI-008** [cli] `scantor tasks files ls|cat|put|rm` work on the platform workspace: a binary `put`/`cat` round trip keeps the sha256, `rm -r` removes folders, `--revision` reads snapshots and path traversal is rejected; `scantor tasks import-git --select`, `tasks pull --force` and `tasks delete` work too.
- **CLI-009** [cli] `scantor revisions get|list|logs [--follow]|publish` work on revisions.
- **CLI-010** [cli] `scantor nodes create|list|get|update|delete|join|token rotate|token revoke|workers|events` manage nodes, and `create` prints the token once with the join snippets.
- **CLI-011** [cli] `scantor uploads create` with a list-template scan, `scantor analyses query|aggregate`, `scantor export` (inline JSONL or CSV, or in the background with `--background` or `--wait`) and `scantor files get` (which verifies sha256) work against a scan.

## EDIT. Editor

Mechanisms: [editor](../docs/editor.md), [api](../docs/api.md) §4.18, [security](../docs/security.md) ED-1…ED-10.

- **EDIT-001** [api] `POST /api/editor/session {open?}` returns 201 `{url, expiresAt, editor}` with a one-time URL `<SCANTOR_EDITOR_URL>/_auth?code=sec_…` valid 60 s, and starts the caller's editor in the background (`starting` or `running`).
- **EDIT-002** [api] `createEditorSession` returns 404 when `open` names a task the caller does not own, 400 when `open` is uuid-shaped or a reserved name, and 403 `forbidden` to an `editor` API key.
- **EDIT-003** [api] `GET /api/editor` returns `{state, startedAt, lastActivityAt, idleTimeoutMs, error}`: `stopped` for a user who never started one, and `error` holds the message of the last failed start until a new start begins.
- **EDIT-004** [api] `DELETE /api/editor` returns 204, removes the editor container and deletes the editor API key; it is a no-op for a stopped editor.
- **EDIT-005** [api, security] Every editor start mints a new `editor` API key (at most one per user, listed with `configId=editor`, not creatable through the API), and stopping the editor, a ban or the user's deletion deletes it.
- **EDIT-006** [api] An idle editor stops after `SCANTOR_EDITOR_IDLE_TIMEOUT`, and while it starts its origin serves a 503 `Starting your editor` page with `Retry-After: 2` (a stopped editor 410).
- **EDIT-007** [e2e, security] Inside the editor, `SCANTOR_URL` points at the orchestrator, `SCANTOR_TOKEN` is the editor key, `SCANTOR_DEV_MODE` is `remote` and `SCANTOR_WORKSPACE` is `/home/coder/workspace`: `scantor tasks list`, `scans list` and `dev run . --limit 2` (as a remote test run) work from the terminal, admin routes return 403 `adminRequired`, and the key stops working once the editor stops.
- **EDIT-008** [security] Editor routes always act on the caller's own editor, also for admins; a session code is single use, expires after 60 s and is bound to its user, so user B cannot reach A's editor, and an unknown or used code gets a 401 page.
- **EDIT-009** [security] The editor listener answers 421 to any other host and serves only `/_auth` and the code-server proxy (`/api/*` on the editor origin never reaches the API), and a request to the editor origin that carries only the dashboard session cookie is not authenticated.
- **EDIT-010** [security] The `scantor_editor` cookie is host-only, `HttpOnly`, `SameSite=Lax` and `Secure`, lives 12 h and stops working once the editor is stopped or restarted.
- **EDIT-011** [security] A WebSocket upgrade with a foreign `Origin` gets 403, and `Set-Cookie` headers from code-server never reach the browser.
- **EDIT-012** [security] A code-server socket replaced by a symlink (to `/var/run/docker.sock`, through `docker exec` in the editor) is refused.
- **EDIT-013** [security] A master worker cannot connect to an editor container.
- **EDIT-014** [security] The editor container has no Docker socket and only its home, workspace and socket mounts, runs as 1000:1000 with a read-only root filesystem, `CapDrop ALL`, `no-new-privileges`, resource limits, restart policy `no` and managed labels.
- **EDIT-015** [security] Editor-origin responses carry `Content-Security-Policy: frame-ancestors 'self' <dashboard origin>`, `nosniff`, `Referrer-Policy: same-origin` (`no-referrer` on `/_auth`) and HSTS on https.

## TOOLS. Admin tools

Mechanisms: [api](../docs/api.md) §4.18, [auth](../docs/auth.md) §11, [deployment](../docs/deployment.md) §7.5.

- **TOOLS-001** [api] `GET /api/tools/session?target=rabbitmq|mongo-express|rustfs|traefik` (admin session) answers 302 to the tool and sets `scantor_tools` (`Domain=<SCANTOR_DOMAIN>; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax`); an API key gets 403 `sessionRequired`, a non-admin 403 `adminRequired`, and an invalid target 400.
- **TOOLS-002** [api, security] `GET /api/tools/forward-auth` answers 200 with `X-Scantor-User` for a valid admin tools cookie on a tool host; a non-tool `X-Forwarded-Host`, and a missing, expired, wrongly signed or non-admin cookie, get 401 as `text/plain` (never the JSON envelope), except that a browser request (`Accept: text/html`) without a valid cookie gets 302 to `/api/tools/session?target=<target>`; an admin banned within the last 30 s gets 401.
- **TOOLS-003** [security] Through Traefik, `traefik.`, `rabbitmq.`, `mongo-express.` and `rustfs.<domain>` are reachable only with an admin tools cookie, a client-supplied `X-Forwarded-Host` is ignored, and each tool still asks for its own credentials.
- **TOOLS-004** [security] RabbitMQ management accepts only the admin user, mongo-express runs read-only, and the bucket answers a CORS preflight only from the dashboard origin.

## MCP. MCP server

Mechanisms: [mcp](../docs/mcp.md), [api](../docs/api.md) §10.

- **MCP-001** [mcp] `tools/list` equals the curated table of 29 tools (at most 30): names are `snake_case(operationId)` matching `^[a-z0-9_]{1,64}$`, every tool has a title and a description, `readOnlyHint` follows GET or `x-read-only`, `destructiveHint` follows DELETE, PUT or `x-destructive`, and `openWorldHint` is false.
- **MCP-002** [mcp, security] A `scantor:read` grant sees only read tools (GET plus `query_analyses` and `aggregate_analyses`), and `tools/call` of a write tool returns an unknown-tool error; `list_nodes` appears only for an admin with `scantor:admin` or an admin's `default` API key, never for an admin's `editor` key or read/write grant.
- **MCP-003** [mcp] `wait` on `publish_revision`, `get_revision`, `test_task`, `get_test_run`, `get_scan`, `export_scan` and `get_export` is advertised with a maximum of 50, clamped to 50, and the result carries `_wait` `settled` or `timeout`.
- **MCP-004** [mcp] A non-2xx REST response becomes `isError` with `{error: {httpStatus, code, message, details}}` (plus `retryAfterSeconds` with a `Retry-After` header), for example 409 `invalidState` from `pause_scan` on a completed scan; bad arguments give 400 `validationFailed`; a failed revision or test run is a successful result carrying structured `errors[]`.
- **MCP-005** [mcp, security] Target- and task-derived values are wrapped as `{untrusted_data: …}` (for example `get_analysis` config, result, error, attempts, log tail and files, `query_analyses` items and `read_task_file` content), absent or null values stay unwrapped, and the tool descriptions and instructions say to treat that content as data.
- **MCP-006** [mcp] Tool results are capped at 256 KiB: the longest fitting prefix of the list is kept with `_truncated {field, returned, total}` and `nextCursor`, then long strings are shortened, and a second text block `[scantor] Response truncated to 256 KiB …` is appended (a `query_analyses` call over large results).
- **MCP-007** [mcp, security] No MCP tool manages credentials or identity (API keys, OAuth apps, users, git credentials, editor sessions, admin tools), and `writeOnly` values arrive as `***`.
- **MCP-008** [mcp, security] `/mcp` accepts only POST (GET and DELETE return 405), is stateless, answers OPTIONS with CORS `*` without credentials and ignores cookies (a dashboard session cookie alone gets the 401 challenge); the server info is `{name: "scantor"}` with the app icons (SVG and PNG on the dashboard origin, served without a session) and the capabilities tools, resources and instructions.
- **MCP-009** [mcp] `POST /mcp` without a credential gets 401 with `WWW-Authenticate: Bearer resource_metadata=<public>/.well-known/oauth-protected-resource/mcp` and the scopes `offline_access scantor:read scantor:write scantor:admin`; the protected-resource, authorization-server and OpenID metadata documents are served.
- **MCP-010** [mcp, security] Dynamic client registration accepts loopback http redirect URIs on any port, private-use schemes and https origins listed in `SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS`; https loopback URIs, other https URIs, `javascript:`, `data:`, `file:`, `ws(s):` and URIs with a fragment or userinfo get 400 `invalid_redirect_uri`, and the same policy is enforced again at authorization.
- **MCP-011** [mcp, security] A CIMD `client_id` whose metadata URL is not https or whose host resolves to a private address is refused.
- **MCP-012** [mcp] An MCP client connects through OAuth 2.1 (discovery, a registered client, consent as the signed-in user, PKCE S256): access tokens are JWTs for `<public>/mcp` valid 1 h, `offline_access` issues a rotating refresh token that works, and a token without any `scantor:*` scope gets 403 `insufficient_scope`.
- **MCP-013** [mcp, security] Consent decides the token's level: accepting without scope returns 400 `invalid_request`, `scantor:admin` is stripped for non-admins, `Read only` grants only `scantor:read`, `Read and write` shows no admin tools, and denying returns `access_denied`.
- **MCP-014** [mcp, security] Every `/mcp` request re-checks the user and the consent: after `revokeOAuthApp`, a ban or the user's deletion the next call gets 401 with `Access revoked: …` and a `WWW-Authenticate` `invalid_token` challenge.
- **MCP-015** [mcp] API keys work on `/mcp` (Bearer or `x-api-key`): an admin's `default` key gets level `admin`, other `default` keys and every `editor` key get `write`, and an expired or invalid key gets 401 with the OAuth challenge.
- **MCP-016** [mcp] The server instructions are present at initialize, at most 8 KiB, and every tool they name exists; the resources `scantor://guide`, `scantor://guide/authoring/{language}` (one per row of `languages.json`) and `scantor://guide/{name}` serve markdown, and `get_authoring_guide` works for every language.
- **MCP-017** [mcp] Every MCP tool name and `scantor` command mentioned in `skills/**` and `docs/guide/*.md` exists, and guide code snippets equal the `tasks/` files they claim to include.
- **MCP-018** [mcp, e2e] An agent loop with tools only succeeds: `create_task` (python, `range`), `read_task_file`, `write_task_files`, `test_task` (`wait` 50), `publish_revision`, `start_scan`, `get_scan` until completed, `query_analyses` (sorted by seq −1), `aggregate_analyses`, `export_scan` and `get_export`; analysis content is wrapped as untrusted data, and a deliberately broken edit yields structured build errors.
- **MCP-019** [mcp] `start_scan` above the confirmation threshold returns 422 `confirmationRequired`, and the same call with `confirm: true` starts the scan.

## SEC. Security controls

Mechanisms: [security](../docs/security.md) §6, [tasks](../docs/tasks.md) §8.

- **SEC-001** [security] Every case of `tests/corpora/dockerfile-policy` uploaded with `uploadTask` gives a failed revision whose `errors[0]` is `{phase: "static", file: "Dockerfile", line, message}` as its `expect.json` says, one sample per rule D1–D11 (parser directives, `ARG SCANTOR_BASE`, the final stage, `FROM --platform`, remote `ADD`, `RUN --mount` types, `RUN --network`, `RUN --security`, forbidden `LABEL`s, `BUILDKIT_*` args, `ONBUILD`, `VOLUME`); the `valid-*` cases publish `ready`.
- **SEC-002** [security] Image references in `FROM`, `COPY --from` and `RUN --mount from=` that point at the platform registry or internal hosts are rejected statically: `localhost`, `*.localhost`, `host.docker.internal`, loopback, private, link-local, ULA and unspecified addresses (`FROM 0.0.0.0:5000/x`, `FROM [::]:5000/x`), the registry service, the public registry and URL hosts, any `tasks/` repository path, bare image ids and references containing `$`.
- **SEC-003** [security] The exploit `COPY --from=localhost:<port>/tasks/<victim task>` is rejected with its file and line and never yields the victim's files.
- **SEC-004** [security] A task whose earlier build stage is `FROM` an external image with `ONBUILD` triggers fails the revision in phase `build` with an error naming the image and its Dockerfile line.
- **SEC-005** [security] A task with `LABEL` keys starting with `traefik.`, `com.docker.compose.` or `scantor.` (any case), quoted, or built from an `ARG` (`ARG K=traefik.x` then `LABEL $K=1`) is rejected statically (`hostile-label` fixture).
- **SEC-006** [security] Forbidden labels inherited from a base image pass the static check but fail the revision in phase `build` with the label named, and the built image is removed.
- **SEC-007** [security] Every container scantor creates (worker, helper, build, test run, editor, egress helper) and every network it creates carries managed labels that override image labels: `traefik.enable=false`, `com.docker.compose.project=scantor-managed`, `com.docker.compose.service=""`, `scantor.managed=true`, `scantor.kind` and the identity labels.
- **SEC-008** [security] Defence in depth: a pre-built image carrying `traefik.*` and `com.docker.compose.project=scantor` labels, pushed with the orchestrator credential and swapped into a ready revision, runs as a worker with the managed label values, Traefik gains no router from it, and the dashboard host still reaches the orchestrator.
- **SEC-009** [security] A `RUN` step that connects to `169.254.169.254` fails during a build on a node that reports `egressDenyApplied: true`.
- **SEC-010** [security] Master workers (`netprobe` on the built-in node) cannot open TCP connections to MongoDB, the registry or mongo-express, the RabbitMQ management API rejects the scan user, and the object store answers only presigned requests. RabbitMQ's unauthenticated Prometheus endpoint (`rabbitmq:15692`) is not reachable from them.
- **SEC-011** [security] Every rejected case of `tests/corpora/query-injection` sent through `queryAnalyses`, `aggregateAnalyses` and `exportScan` returns 400 `queryRejected` with `details.path`: `$where`, `$function`, `$accumulator`, `$lookup` (also inside `$facet`), `$graphLookup`, `$unionWith`, `$out`, `$merge`, `$documents`, `$collStats`, `$indexStats`, `$currentOp`, `$listSessions`, `$planCacheStats`, `$changeStream`, `$search` and `$vectorSearch` at any depth.
- **SEC-012** [security] Scope-override attempts (`{"scanId": {"$ne": null}}` in a filter, `$facet` with `$lookup`, `$unionWith`) by user B on B's own scan return only documents of that scan and never A's.
- **SEC-013** [security] Connected directly to MongoDB as the read-only `scantor_query` user, a `$where` find fails (`--noscripting`) and an `insertOne` is unauthorized.
- **SEC-014** [security, mcp] `writeOnly` fields (`secret()`, `SecretStr`, `scantor.Secret`) of `schema-zoo` show `***` in scans, test runs, analyses (config and result), JSONL and CSV exports and MCP results, while the task receives the real values (asserted as a hash inside its result); describe drops their defaults, and a restarted clone runs with the original secret values.
- **SEC-015** [security] Filters, sorts, projection expressions and pipelines that reference a `writeOnly` path return 400 `queryRejected`, so they cannot work as an oracle, and so does any `$jsonSchema` on a scan with secret paths; a plain projection of a secret path returns `***`.
- **SEC-016** [security] TLS verification is always on: `SCANTOR_CA_CERT` is added to the system roots (never replacing them) and passed to workers, and a remote node daemon without the test CA cannot connect.
- **SEC-017** [security] The object store bucket is private: an unsigned GET returns 403, and a CORS preflight from a foreign origin is refused.
- **SEC-018** [security] A throwaway orchestrator in public mode (a non-loopback `SCANTOR_PUBLIC_URL` or `SCANTOR_EDITOR_URL`, `COMPOSE_PROFILES` with `traefik`, or a non-loopback bind address) with insecure secrets exits 1 within 30 s and logs the offending variable names, never their values; offenders are any value ending in `-insecure-dev` (also of variables the orchestrator does not read), a core secret shorter than 16 characters and a non-empty `SCANTOR_ADMIN_PASSWORD` shorter than 16 characters.
- **SEC-019** [security] With `SCANTOR_ALLOW_INSECURE_DEFAULTS=true` a public deployment with offenders starts with a warning per name, and all-loopback settings without Traefik start with the info line `development secrets in use`.
- **SEC-020** [security] A `SCANTOR_EDITOR_URL` with the same origin as `SCANTOR_PUBLIC_URL` always makes the orchestrator exit 1, even with `SCANTOR_ALLOW_INSECURE_DEFAULTS=true`.
- **SEC-021** [security] Invalid security-relevant settings abort startup: a URL with a path, query or credentials, an unparsable bind address, a malformed boolean for an `ALLOW_*` or `TRUST_*` variable, a bad `SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS` or a bad egress deny list.
- **SEC-022** [security] After a `SCANTOR_SECRET` change on a throwaway orchestrator, boot recovers: MCP OAuth works again, the built-in node and registry keys are rewritten, git credentials and `writeOnly` scan secrets are reported as undecryptable, and API keys and remote node tokens keep working.
- **SEC-023** [security] The key derivations from `SCANTOR_SECRET` match the shared vectors of `tests/corpora/keys-vectors.json`, and the credentials the test helpers derive from the stack's secret (scan AMQP users, registry push, `scantor_query`, worker tokens, the built-in node token, tools and editor cookies) work against the stack.
- **SEC-024** [security, chaos] Logs never contain credentials: the orchestrator and node daemon log JSON lines with correlation ids and redact authorization headers, cookies, the token shapes `sk_scantor_`, `snt_`, `swt_`, `sst_`, `spk_`, `sic_` and `sec_`, AMQP URL passwords, `X-Amz-Signature` and git credentials; MongoDB logs no slow operations, whose log lines would carry session tokens; a grep of the stack's container logs after the other suites finds no live token.

## OPS. Deployment and static checks

Mechanisms: [deployment](../docs/deployment.md) §2, §7, [testing](../docs/testing.md) §11.

- **OPS-001** [security] `lint-compose` fails when the infrastructure services (`mongo`, `rabbitmq`, `rustfs`, `registry`, `mongo-express`, `traefik`) differ between `docker-compose.dev.yml` and `docker-compose.prod.yml`.
- **OPS-002** [security] `lint-compose` enforces the compose rules: Traefik `exposedbydefault=false`, the compose-project constraint and `api.insecure=false`; admin GUIs and MongoDB published only on `SCANTOR_ADMIN_BIND_ADDRESS`; the MongoDB TCP router only with `SCANTOR_EXPOSE_MONGO`; mongo-express read-only; `mongod --noscripting`; RabbitMQ with the management plugin only; memory limits on the orchestrator, mongo and rabbitmq; no `scantor-workspaces` mount on the orchestrator; no variable defaults except the image prefix fallback; `env_file: .env` for the orchestrator and Traefik.
- **OPS-003** [security] `lint-env` fails when a `SCANTOR_*` variable read by code, compose files, recipes or the test stack is missing from `.env.example`, or when a non-empty default of a variable whose name contains `PASSWORD` or `SECRET` does not end in `-insecure-dev`.
- **OPS-004** [security] `lint-env` enforces the shipped secure defaults: loopback bind addresses, `SCANTOR_NODE_DIND=disabled` and `SCANTOR_BUILTIN_NODE_DIND=disabled`, `SCANTOR_MONGO_EXPRESS_READONLY=true`, `SCANTOR_EXPOSE_MONGO=false`, an egress deny list covering `169.254.0.0/16` and `fd00:ec2::254/128`, and the first-initialisation note on the database root passwords.
- **OPS-005** [security] `lint-env` fails when a non-configuration variable (`SCANTOR_WORKER_TOKEN`, `SCANTOR_DIND`, `SCANTOR_REGISTRY_PUSH_PASSWORD`, the base-image ENV contract, the protocol variables) appears in `.env.example`.
- **OPS-006** [e2e, security] Traefik redirects `http://` permanently to `https://`, serves the operator's default certificate (the test CA's wildcard) for every host and the SNI TCP router, and its dashboard API is not reachable without the tools cookie.
- **OPS-007** [e2e] Traefik routes each host to its target: `scantor.` to the orchestrator, `editor.` to the editor listener, `registry.` to the registry, `s3.` to the object store (with the `Host` preserved), the tool hosts through forwardAuth, and `amqp.` as a TLS TCP router to RabbitMQ.

## CHAOS. Fault tolerance

Mechanisms: [testing](../docs/testing.md) §8.7, [queue](../docs/queue.md) §11, [nodes](../docs/nodes.md) §7.4. Each case asserts final states and exact counts from `aggregateAnalyses`, never timing.

- **CHAOS-001** [chaos] Killing one runner of a scan while analyses are in flight still ends the scan `completed` with `succeeded == total` and exactly one document per seq.
- **CHAOS-002** [chaos] Restarting the orchestrator during a running scan, also while results are being ingested, ends the scan `completed` with exact counts: runtimes and node daemons keep working while it is unreachable, and replayed results are absorbed.
- **CHAOS-003** [chaos] Restarting RabbitMQ while retries are delayed keeps the quorum queues, delayed messages and users; runtimes and the ingestor reconnect, the retries are delivered and the final counts are exact.
- **CHAOS-004** [chaos] Pausing a scan while retries are delayed, waiting 30 s and resuming loses no analysis, and the final counts are exact.
- **CHAOS-005** [chaos] A scan cancelled and deleted right after a backlog of results built up (the orchestrator paused for 20 s while a fast scan kept publishing) ends as a tombstone with zero analyses after 60 s, with its queue and RabbitMQ user gone.
- **CHAOS-006** [chaos] A remote node disconnected longer than `SCANTOR_NODE_OFFLINE_AFTER` goes `offline` (`node.offline`); its workers become `lost` (`nodeOffline`, their tokens rejected) and are replaced elsewhere (a new scheduler gets epoch + 1); after reconnecting the node is `online` again, its stale containers are removed, and the scan completes with exact counts.
- **CHAOS-007** [chaos] When a scan queue with delayed retries is deleted, the reconciler recreates it empty; after `SCANTOR_SCAN_STALL_AFTER` the waiting analyses become `lost` with their config, missing seqs are recorded as `lost` without one, the scan gets the condition `stalled {lost}` and a `scan.lostAnalyses` event and ends, and `retry-failed` then completes it with `succeeded == total`.
- **CHAOS-008** [chaos] During a RabbitMQ memory alarm, `startScan` returns 503 `brokerAlarm`, running scans show the condition `brokerAlarm`, `scantor_rabbitmq_alarm` is 1 and `/api/health` is `degraded`; after the alarm the condition clears and the scan completes with exact counts.
- **CHAOS-009** [chaos] While MongoDB is paused, results accumulate in `scantor.results.ingest` and the runtimes keep working; after MongoDB returns, ingestion resumes without loss and the scan completes with exact counts.

## UI-NAV. Dashboard shell

Mechanisms: [ui](../docs/ui.md) §3–§4, §8–§11, §14.

- **UI-NAV-001** [ui] The sidebar shows the Workspace (Overview, Tasks, Scans, Templates, Editor) and Access (CLI & MCP access, Git credentials) groups to every user, and the Admin group (Nodes, Users, Admin tools) only to admins.
- **UI-NAV-002** [ui] When `features.editor` is false, the Editor item and every "Open in editor" entry point (task navbar, Files tab link, created-task banner) are hidden.
- **UI-NAV-003** [ui] "New scan" goes to `/scans/new` and "New task" to `/tasks/new`; in the collapsed sidebar they become icon buttons with the same accessible names and tooltips.
- **UI-NAV-004** [ui] The Scans badge counts the user's own creating, running or paused scans, shows `200+` when there are more, is hidden at 0 and refreshes every 15 s.
- **UI-NAV-005** [ui] For admins, the Nodes badge shows the number of offline nodes in the error color and is hidden at 0.
- **UI-NAV-006** [ui] The "API docs" footer link opens `/api/docs` in a new tab.
- **UI-NAV-007** [ui] The sidebar collapses and expands ("Collapse sidebar", "Expand sidebar"; the collapsed logo is named "scantor overview"), resizes between 14 and 24 rem (default 16 rem), keeps its size and collapse state across reloads, and shows the wordmark at full size at 1280 px.
- **UI-NAV-008** [ui] Below the `lg` breakpoint the sidebar is a drawer opened with "Open navigation" and closed with "Close navigation".
- **UI-NAV-009** [ui] The user menu shows initials, name, email and an "admin" badge for admins, with Account, CLI & MCP access and Sign out; signing out ends the session and lands on `/login`, and protected pages then redirect there.
- **UI-NAV-010** [ui] Every page's title is `<Page> · scantor`, and detail pages use the task, scan, revision or node name (for example `echo@3 · scantor`).
- **UI-NAV-011** [ui] The theme toggle offers "Use system theme", "Use light theme" and "Use dark theme" with `aria-pressed` on the active one; dark is the default, and the choice persists across reloads.
- **UI-NAV-012** [ui] A signed-out visit to a protected route redirects to `/login?redirect=<path with query>`, and after signing in the browser lands on exactly that path.
- **UI-NAV-013** [ui, security] The `redirect` parameter is followed only for same-origin paths: `//evil.example`, `/\evil`, `https://evil.example`, control characters and values over 2048 characters fall back to `/`.
- **UI-NAV-014** [ui] A non-admin opening `/admin/nodes`, `/admin/nodes/:id`, `/admin/users` or `/admin/tools` is sent to `/` with the warning toast "Admins only".
- **UI-NAV-015** [ui] A failed API call shows a red toast titled after its error code (for example "Not possible in the current state" for `invalidState`) with the server message as description; forms and the query console show errors inline instead.
- **UI-NAV-016** [ui] A 5xx error toast offers "Copy request id", which copies the `X-Request-Id` and shows "Copied".
- **UI-NAV-017** [ui] Any 401 from the API on a protected page, such as after the session was revoked from another browser, navigates to `/login?redirect=<current path>`.
- **UI-NAV-018** [ui] When an admin bans a signed-in user, the ban deletes their sessions ([auth](../docs/auth.md) §5.7), so their next API call answers 401 and lands on `/login?redirect=<current path>`, where signing in shows "Your account is banned" (UI-AUTH-003); a 403 `banned` (a banned user whose session still exists, for example while the ban is being applied) signs them out and lands on `/login?banned=1` with that message.
- **UI-NAV-019** [ui] Without any response from the server, the UI shows a single toast "Cannot reach the orchestrator" at most once every 10 s, and background polls never toast.
- **UI-NAV-020** [ui] After 3 consecutive failures of a poll, the banner "Live updates paused, retrying…" (`role=status`, `data-testid=live-updates-paused`) appears, and it disappears after the next successful poll.
- **UI-NAV-021** [ui] Polls pause while the tab is hidden and refetch when it becomes visible, keep one request in flight, double their interval after each failure up to 60 s, and never use the API's `wait` long-poll (except worker logs).
- **UI-NAV-022** [ui] Every polled page has a "Refresh" navbar button that refetches at once and shows a spinner while loading.
- **UI-NAV-023** [ui] Every button on every page has an accessible name, icon-only buttons use the same text as `aria-label` and tooltip, all canonical names of [ui](../docs/ui.md) §11 exist, and repeated controls carry a context suffix such as "Scan actions for <name>".
- **UI-NAV-024** [ui] Tables have an `aria-label`, rows carry `data-row-id`, and the documented `data-testid`s exist (`scan-progress`, `scan-stats`, `scan-health`, `condition-<type>`, `build-log`, `build-errors`, `test-run-log`, `analysis-slideover`, `secret-reveal`, `unpublished-badge`).
- **UI-NAV-025** [ui] Status badges always include the state text; modals and slideovers have titles, trap focus and return it on close; confirmation buttons name the action; no native `confirm`, `prompt` or `alert` dialog ever appears.
- **UI-NAV-026** [ui] The new-task wizard's stepper exposes the step position to screen readers.
- **UI-NAV-027** [ui] Copy buttons copy to the clipboard and show "Copied" (a blocked clipboard shows "Copy failed"); id chips show 8 characters with the full value as tooltip, relative times show the ISO time as tooltip, and durations and sizes use binary formatting (`1m 23s`, `850 ms`, `1.5 GiB`).
- **UI-NAV-028** [ui] A type-to-confirm dialog keeps its action disabled until the exact text is typed, and Cancel or closing it does nothing.
- **UI-NAV-029** [ui] UI preferences live in one localStorage key `scantor-ui`; corrupted or unknown-version contents are discarded, and with localStorage unavailable every page still works.
- **UI-NAV-030** [ui] The shell links the favicons (ICO, SVG, Apple touch icon) and the web manifest, which the dashboard serves from `brand/favicons` without a session; the sidebar and the sign-in page show the wordmark (an image named "scantor") in the variant of the current color mode, and the collapsed sidebar shows the decorative standalone S.

## UI-HOME. Overview page

Mechanisms: [ui](../docs/ui.md) §5.4.

- **UI-HOME-001** [ui] A user without tasks and scans sees the empty state "No tasks yet" with "Create your first task", which links to `/tasks/new`.
- **UI-HOME-002** [ui] "Active scans" shows a card per creating, running or paused scan (name, revision, state, progress, rate, ETA and condition count) that opens the scan, or "No scan is running."
- **UI-HOME-003** [ui] "Needs attention" lists, without duplicates, active scans with conditions ("N conditions need attention") and failed scans with their reason.
- **UI-HOME-004** [ui] "Recent scans" shows the last 10 scans and "Recent tasks" the last 5 tasks with language, latest revision and state and the "Unpublished changes" badge, each with an "All …" link, next to the quick actions New task, New scan and CLI & MCP access.
- **UI-HOME-005** [ui] For admins, "Platform health" shows the component states, RabbitMQ alarms, `Nodes: N online · N offline · N total` (linking to `/admin/nodes`) and the free worker capacity of online, uncordoned nodes.

## UI-AUTH. Sign-in, setup and consent pages

Mechanisms: [ui](../docs/ui.md) §5.1–§5.3, [auth](../docs/auth.md) §7, [mcp](../docs/mcp.md) §3.3.

- **UI-AUTH-001** [ui] A user signs in on `/login` with email and password and lands on the redirect target; the email field has `autocomplete="username webauthn"`, and client-side errors ("Enter a valid email address", "Enter your password") appear without a request.
- **UI-AUTH-002** [ui] Wrong credentials show the inline alert "Invalid email or password" (`data-testid=login-error`) and no toast; a 429 shows "Too many attempts, try again in a minute".
- **UI-AUTH-003** [ui] A banned user's sign-in shows "Your account is banned", and `/login?banned=1` shows the same message on load.
- **UI-AUTH-004** [ui] Opening `/login` with a valid session goes straight to the redirect target.
- **UI-AUTH-005** [ui] With passkeys enabled, "Sign in with passkey" signs in with a virtual authenticator and lands on the redirect target.
- **UI-AUTH-006** [ui, mcp] `/login` reached from an OAuth authorization shows "Sign in to authorize an application to access your scantor account." and returns to the consent page after sign-in; a signed-out visit to `/oauth/consent` goes to `/login` with the OAuth query kept.
- **UI-AUTH-007** [ui, security] `/setup?token=…` stores the token in sessionStorage and removes it from the address bar and history at once; a reload of `/setup` still has it.
- **UI-AUTH-008** [ui] Without a token, `/setup` explains where the setup link is printed (`docker logs scantor-orchestrator 2>&1 | grep /setup`) and offers a paste field whose "Use token" button stays disabled until it is filled.
- **UI-AUTH-009** [ui] Password setup takes name, email, password (8–128 characters) and confirmation ("The passwords do not match" on a mismatch), creates the admin, signs in, forgets the token and opens `/`.
- **UI-AUTH-010** [ui] With passkeys enabled, a "Password | Passkey" choice appears, and passkey setup registers "Primary passkey", creates the admin and signs in.
- **UI-AUTH-011** [ui] A wrong setup token shows "The setup token is missing or wrong. Restarting the orchestrator prints a new one.", a completed setup sends the browser to `/login`, and while no user exists every protected route and `/login` redirect to `/setup`.
- **UI-AUTH-012** [ui, mcp] The consent page shows the client name (the metadata host for CIMD clients, otherwise "An application"), an "unverified" badge for dynamically registered clients, a client link only for http(s) URIs with `rel="noopener noreferrer"`, "After approval you will return to <redirect origin>" and the signed-in email.
- **UI-AUTH-013** [ui, mcp] The access level offers "Read only", "Read and write" and, for admins only, "Admin" (never preselected); a level is disabled unless the client requested all its scopes, and "Read and write" is preselected when enabled.
- **UI-AUTH-014** [ui, mcp] "Approve" grants the requested non-scantor scopes plus the chosen level's scopes (so "Read only" yields a token without write tools), "Deny" returns `access_denied`, and both buttons are disabled while loading or submitting.
- **UI-AUTH-015** [ui] `/oauth/consent` without an authorization request shows "This page is only reachable from an application authorization request.", and an unknown client shows the error inline (`data-testid=oauth-consent-error`).

## UI-TASK. Task pages

Mechanisms: [ui](../docs/ui.md) §5.5–§5.7, §5.9.

- **UI-TASK-001** [ui] The tasks list filters by "Search tasks" (debounced) and language, admins get an "Only mine" switch, and a filter change reloads the list from the start.
- **UI-TASK-002** [ui] The tasks table shows the name with the "Unpublished changes" badge (`data-testid=unpublished-badge`) and a privileged badge, language, source kind, latest revision with state, revision count, the owner for admins and the update time; a row opens the task.
- **UI-TASK-003** [ui] The tasks list shows "No tasks yet" only without filters ("No tasks." with filters), "Tasks could not be loaded" on failure, and "Load more" for further pages.
- **UI-TASK-004** [ui] The new-task wizard starts with the sources "From a scaffold", "Import from git" and "Upload a folder"; scaffolding steps through Language (cards with base image, entry and extensions), Template and Name, "Back" returns a step, and switching the source resets the choices.
- **UI-TASK-005** [ui] The template step lists the scaffold's templates with title, description (code spans rendered as `<code>`), a "pins inputs" badge and an example config, plus a "Custom schedule" card.
- **UI-TASK-006** [ui] The name step validates the slug live and limits the description to 500 characters; "Create task" opens `/tasks/:id?created=1`, and an existing name shows "A task with this name already exists." under Name.
- **UI-TASK-007** [ui] The git import form accepts only https URLs (http, ssh, userinfo, `file://` and `ext::` are rejected before any request), defaults Ref to `HEAD` and Path to `.`, and offers saved credentials as `<name> (<host>)` plus "Add a credential".
- **UI-TASK-008** [ui] A git import of one task opens it; several manifests show a "Select tasks" checklist (existing tasks marked "already exists" and disabled), and "Import selected" imports only the checked ones and shows "Imported N tasks".
- **UI-TASK-009** [ui] Git import errors show inline: `gitFailed` with its message under "The import failed", `manifestInvalid` under "Manifest errors".
- **UI-TASK-010** [ui] The upload step accepts only `.tar.gz` and `.tgz` files ("Expected a .tar.gz or .tgz file"), shows the chosen file's name and size, and keeps "Upload" disabled until a file is chosen; "Publish a revision" is on and "Replace unpublished changes" off by default.
- **UI-TASK-011** [ui] An upload that published a revision opens the revision page, otherwise the task page; `workspaceDirty` shows "The workspace has unpublished changes" with "Replace anyway", and `manifestInvalid` and `invalidPath` show their errors.
- **UI-TASK-012** [ui] The task header shows the name, language, source (git tasks `git · <commit8>`), privileged and "Unpublished changes" badges and the latest revision with its state.
- **UI-TASK-013** [ui] The task navbar offers "Open in editor" (`/editor?task=<name>`), "Publish revision", "Start scan" (only with a ready revision), "Pull from git" (git tasks only), "Download workspace" and "Delete task", keeping their accessible names on narrow screens.
- **UI-TASK-014** [ui] `?created=1` shows the banner "Task <name> is ready" in full with "Open the editor", "Try a test run" and "Publish now", and closing it removes the parameter.
- **UI-TASK-015** [ui] The Overview, Files, Revisions and Test tabs sync with `?tab=`, and an unknown value falls back to Overview.
- **UI-TASK-016** [ui] The Overview tab shows the description and cards for the workspace ("Check now" refreshes its status), the revisions and the source, plus up to 10 recent scans and 5 recent test runs of the task.
- **UI-TASK-017** [ui] The publish modal shows a fresh workspace status, notes when the workspace equals an existing revision, takes an optional message (at most 500 characters), opens the new revision page, and shows errors under "Publishing failed".
- **UI-TASK-018** [ui] "Pull from git" shows "Pulled <commit8>" or "Already up to date", and on `gitDiverged` asks "Overwrite the workspace?" before pulling with force.
- **UI-TASK-019** [ui] "Delete task" requires typing the task name, then shows "Task <name> is being deleted" and opens `/tasks`; on `taskInUse` the toast "A scan still uses this task" offers "Show active scans", which lists the scans of that task.
- **UI-TASK-020** [ui] An unknown task shows "Task not found", and the revision badge updates live while a new revision builds.
- **UI-TASK-021** [ui] The Files tab shows the workspace tree with file, folder and symlink icons; a file shows its path, size and hash, UTF-8 content with line numbers or "Binary file, N bytes", and the notices "Only the first MiB is shown", "Only the first 5000 entries are shown" and "The folder is empty."
- **UI-TASK-022** [ui] The Files tab's source select switches between "Workspace" and "Revision N" (synced with `?revision=`), and the view is read-only.
- **UI-TASK-023** [ui] The Revisions tab filters by state and lists ref, state, source, pack hash, error count, created time and build duration; a row opens the revision, and an empty list says "No revisions yet. Publish the workspace to create one."; a revision published or built while the tab is open (for example pushed with the CLI) shows up with its current state, and "Refresh" re-reads the list.
- **UI-TASK-024** [ui] The revision page shows ref, state, privileged badge, message and times, "Start scan" for ready revisions, "Download source" and "View files", and "Revision not found" for an unknown revision.
- **UI-TASK-025** [ui] A failed revision shows its errors first (`data-testid=build-errors`), each with phase, `file:line:column` and message.
- **UI-TASK-026** [ui] The build log (`data-testid=build-log`) follows a running build, groups lines by phase with collapsible headers and counts, tints error lines, strips ANSI sequences, and with "Follow log" stays scrolled to the bottom until the user scrolls up.
- **UI-TASK-027** [ui] The revision facts show source, pack hash, git origin, base image, image digest, size and platform, connector language and version, protocol and schedule.
- **UI-TASK-028** [ui] A ready revision's describe section has Task config, Scan config, Analysis config and Result tabs with schema tables (path, type, required, default, constraints, description and secret, upload, file, deprecated and read-only badges) in source order, a "Raw JSON" toggle, and the settings defaults, warnings and manifest.

## UI-TRUN. Test runs in the dashboard

Mechanisms: [ui](../docs/ui.md) §5.8.

- **UI-TRUN-001** [ui] The Test tab offers "Schedule + run" (task and scan config forms, limit 1–50) and "One analysis" (analysis config form), plus max attempts (1–5) and a timeout whose hint shows the manifest default.
- **UI-TRUN-002** [ui] The forms use the latest known schemas; without any, "No schemas known yet" appears and the forms start as JSON, and after a run with new schemas the banner "Schemas changed in your workspace; the form now uses the new schemas" appears and the form shows fields.
- **UI-TRUN-003** [ui] "Start test run" is disabled while a run is active, and start errors (for example an invalid limit) appear under "The test run could not start".
- **UI-TRUN-004** [ui] A live run streams its state (queued → building → running → completed), the "draft image cached" badge, the summary `N analyses · s succeeded · f failed`, build and run logs (`data-testid=test-run-log`), errors and an analyses table.
- **UI-TRUN-005** [ui] When the event stream fails, the panel polls the run every 2 s and still shows its results.
- **UI-TRUN-006** [ui] "Cancel test run" cancels the active run, and the history shows it cancelled.
- **UI-TRUN-007** [ui] An analysis row opens the slideover "Analysis <seq>" with status, attempt, duration, error and stack, config, result, earlier attempts, log tail and "Download <name>" buttons for its files.
- **UI-TRUN-008** [ui] The history lists earlier runs with state, `x / y succeeded` and pack hash, and a row loads that run.
- **UI-TRUN-009** [ui, security] Unsent test-run inputs are restored per task after a reload, without the values of `writeOnly` fields; config values typed while no schemas are known are never stored, also not after the run's description arrives.

## UI-EDIT. Editor page

Mechanisms: [ui](../docs/ui.md) §5.10.

- **UI-EDIT-001** [ui] `/editor` starts the user's editor, shows "Editor is starting…", and then loads code-server from the editor origin in an iframe titled "Editor".
- **UI-EDIT-002** [ui] `/editor?task=<name>` opens that task's folder; an unknown task shows "Task “<name>” was not found" with "Open workspace".
- **UI-EDIT-003** [ui] The navbar shows the editor state and `stops after N min idle`, and "Open in new tab" opens a fresh session URL in a new tab.
- **UI-EDIT-004** [ui] "Stop editor" asks for confirmation, shows "Editor stopped", removes the iframe and offers "Open editor".
- **UI-EDIT-005** [ui] A failed start shows "The editor could not start" with the message and "Retry"; too many running editors show "Too many editors are running; try again later".
- **UI-EDIT-006** [ui] An editor stopped elsewhere disappears from the page, and an editor restarted elsewhere is loaded with a fresh session.

## UI-SCAN. Scan pages

Mechanisms: [ui](../docs/ui.md) §5.11–§5.13.1.

- **UI-SCAN-001** [ui] The scans list filters by state (default "All states except deleted") and task, admins get "Only mine", and the filters persist across reloads.
- **UI-SCAN-002** [ui] The scans table shows name and id, revision, state with condition count, progress with terminal/total and percent, rate, ETA, workers × processes, the owner for admins, and created and finished times.
- **UI-SCAN-003** [ui] The row menu "Scan actions for <name>" offers Open, Pause, Resume, Cancel, Restart and Delete as the state allows; Cancel and Delete ask for confirmation and Restart opens the restart dialog.
- **UI-SCAN-004** [ui] Without filters and scans the list shows "No scans yet" with "New scan", and "Load more" pages through the list.
- **UI-SCAN-005** [ui] The new-scan form picks a task and a revision ("latest ready revision" or @N) and shows the revision's language, schedule, privileged badge and publish time; choosing another task starts at "latest ready revision"; `?revision=<task>@latest` preselects them, and an unknown task, a task without ready revision or a non-ready revision is explained in the picker.
- **UI-SCAN-006** [ui, security] For a privileged revision and a user without `canRunPrivileged`, the form shows "Privileged revision" and disables "Start scan"; once an admin grants the permission, the block disappears.
- **UI-SCAN-007** [ui] The task and scan config forms follow the revision's schemas in source order with "Edit as JSON", and choosing another revision resets configs, settings and estimate.
- **UI-SCAN-008** [ui] "Runner workers" and "Processes per worker" are bounded by the instance limits and prefilled from the defaults, with the derived line `Total: W runner workers × P processes = N concurrent analyses; per worker: X CPUs, Y MiB memory` (singular for 1).
- **UI-SCAN-009** [ui] "Advanced settings" hold timeout, attempts, analyses per process, backoff, CPUs, memory, node pool and node labels, and only fields that differ from the defaults are sent.
- **UI-SCAN-010** [ui] For template schedules the form estimates the scan ("≈ N analyses", "exactly N analyses"); custom schedules say "The number of analyses is known after scheduling starts."
- **UI-SCAN-011** [ui] An estimate above the instance maximum disables "Start scan"; above the confirmation threshold the checkbox "I want to start about N analyses" must be checked first, and the scan starts with `confirm`.
- **UI-SCAN-012** [ui] "Start scan" starts the scan and opens its page; a `configInvalid` answer marks each issue on its field (or lists it under "The server rejected this configuration"), and `scanTooLarge`, `privilegedNotAllowed`, `revisionNotReady` and `brokerAlarm` show form-level alerts.
- **UI-SCAN-013** [ui] A client-side validation failure shows "Check the highlighted fields" and sends no request.
- **UI-SCAN-014** [ui] An upload field offers the user's uploads (`name · N lines · size`) and "Upload a list for <field>", which uploads a text file and selects it; an unknown id shows `Upload <id> (not in your recent uploads)`.
- **UI-SCAN-015** [ui] The scan header shows name and id, state with its reason (`paused · failure rate`), round when above 1, privileged badge, revision, template, "Restarted from <id>" for clones, the owner for admins and the times.
- **UI-SCAN-016** [ui, security] An unknown scan, or another user's scan for a non-admin, shows "Scan not found" without revealing anything about it.
- **UI-SCAN-017** [ui] The scan controls enable Pause, Resume, Scale, Cancel, "Retry failed analyses", Restart, "Export results" and "Delete scan" per state, explain disabled ones in a tooltip ("Only running scans can be paused"), and disable all while one action runs.
- **UI-SCAN-018** [ui] Pause shows "Scan paused" and the workers drain away; Resume shows "Scan resumed" and runners return; resuming a scan whose revision was deleted shows "Revision no longer exists".
- **UI-SCAN-019** [ui] The scale dialog is bounded by the instance limits, shows the derived capacity line, and on submit shows "Scan scaled" with `W workers × P processes`.
- **UI-SCAN-020** [ui] Cancel asks "Cancel scan <name>?", then shows "Scan cancelled" and the state `cancelled`.
- **UI-SCAN-021** [ui] "Retry failed analyses" is enabled only for a finished scheduling with failed or lost analyses; after confirming "Retry up to N failed or lost analyses in round R+1", the page shows the job's progress, and `nothingToRetry` shows "Nothing to retry".
- **UI-SCAN-022** [ui] The restart dialog defaults the name to `<name> (restart)`, starts the clone with the chosen workers and processes, shows "Scan restarted" and opens the clone.
- **UI-SCAN-023** [ui] "Delete scan" requires typing the scan's name (or id), shows "Scan deletion started" and opens `/scans`; it is disabled for running scans.
- **UI-SCAN-024** [ui] The Overview, Results, Query, Workers, Events and Exports tabs sync with `?tab=`, and `?analysis=` opens the analysis drawer from any tab.
- **UI-SCAN-025** [ui] The scan page refreshes while the scan is active, keeps refreshing for a few minutes after it ends to show the final recount, and "Refresh" reloads it at once.
- **UI-SCAN-026** [ui] The progress card (`data-testid=scan-progress`) shows the bar (indeterminate without a total), `done / total analyses (percent)`, the number scheduled with the scheduling state, the rate and the ETA.
- **UI-SCAN-027** [ui] The stats tiles (`data-testid=scan-stats`) for pending, retrying, succeeded, failed, lost and cancelled link to the filtered results, captioned "exact as of <time>" after a recount and "live estimate" otherwise.
- **UI-SCAN-028** [ui] The health card (`data-testid=scan-health`) shows "Healthy", or one item per condition (`data-testid=condition-<type>`) sorted by severity with title, severity, reason, message and since.
- **UI-SCAN-029** [ui] `workersPending` shows `N workers pending` with readable reasons (for example "No online node matches", "Your worker limit is reached"), as an impossible node selector produces.
- **UI-SCAN-030** [ui] `crashLoop` (a task whose connector is OOM-killed at import inside workers) shows the worker, the node (a link for admins only), the exit code, an "OOM killed" badge, the restart count and the log tail without ANSI sequences.
- **UI-SCAN-031** [ui] `breakerTripped` shows `X % of N attempts failed within D` with a "Resume scan" button, which resumes the scan and clears the condition.
- **UI-SCAN-032** [ui] Other conditions render their details: `schedulingFailed`, `workerErrors` and `schedulerRestarting` with error type, phase, message and restarts; `imagePullFailed` with the node; `brokerAlarm` with the alarms; `stalled` with the lost count.
- **UI-SCAN-033** [ui, security] The settings card shows the effective settings, the task and scan configs with `***` values rendered as a locked "secret", the template resolutions with provenance, and a "Scheduling failed" alert when scheduling failed.

## UI-RES. Results, queries, workers, events and exports in the dashboard

Mechanisms: [ui](../docs/ui.md) §5.13.2–§5.13.6.

- **UI-RES-001** [ui] The results status filter syncs with `?status=` and reloads the table from the start; "Go to seq" accepts digits only and starts the table at that seq with "Show from the start".
- **UI-RES-002** [ui] The advanced filter takes a JSON filter (default `{"status": "failed"}`), disables "Apply filter" for invalid JSON, switches the table to the query API, and shows a rejected filter with `(at <path>)`.
- **UI-RES-003** [ui] "Result columns" allows up to 4 result fields (default the first four of the result schema) and remembers the choice per task; columns a later revision's result schema lacks are dropped (the defaults return when none remain).
- **UI-RES-004** [ui, security] The results table shows seq, status, attempt, round (when above 1), duration, error, the chosen result columns and finished time; FileRef values render as file chips, other values as plain text cut at 200 characters, never as links; a row opens `?analysis=<seq>`.
- **UI-RES-005** [ui] Results load 50 rows per page through "Load more" or scrolling, and stop at 5000 rows with "Showing the first 5,000 rows. Use the query console or an export for more."
- **UI-RES-006** [ui] "Auto-refresh" appears only while the scan runs, is on by default and reloads the loaded rows (the first 1000; rows loaded beyond them stay).
- **UI-RES-007** [ui] `?analysis=<seq>` opens the drawer "Analysis <seq>" on load, closing removes the parameter, and an analysis that does not exist yet shows "No such analysis yet".
- **UI-RES-008** [ui] The drawer summary shows the analysis id, status, attempt, round, worker, node (a link for admins), times and duration; "Copy as JSON" copies the analysis, and "Query similar" opens the Query tab prefilled with the error type (or the seq).
- **UI-RES-009** [ui, security] The drawer shows the config with `***` secrets as locks (or "No config was stored for this analysis."), the result with file chips at the FileRef paths, and other files under "Files".
- **UI-RES-010** [ui] The drawer's error section shows type, phase, retryability, attempt, message and details, and "Show stack trace" reveals the stack without ANSI sequences.
- **UI-RES-011** [ui] The attempts table lists attempts across rounds newest first with their errors, worker and node, and expands each attempt's log (the `throws` flaky scan shows 3 attempts).
- **UI-RES-012** [ui] The drawer's log view shows the final log tail with "Wrap lines" and "Follow log", or "No output captured."
- **UI-RES-013** [ui, security] A file chip shows name, size and type; "Download <name>" downloads through a presigned URL, and png, jpeg, gif and webp files show a preview image with `referrerpolicy=no-referrer` ("Preview unavailable." on failure).
- **UI-RES-014** [ui] The query console has Query (filter, projection, sort, limit, after seq) and Aggregate (pipeline, limit) modes; invalid JSON disables "Run query", and Ctrl/⌘+Enter runs it.
- **UI-RES-015** [ui] Query output shows `N items` as JSON or, for flat items, as a table; "Load more" follows the cursor of the query that was run (not of edited, unrun editors) for unsorted queries, and a cut aggregation shows "Output truncated".
- **UI-RES-016** [ui, security] Query errors stay inline: a rejected operator shows under its editor with `(at <path>)`, timeouts and rate limits show as an alert, and a filter naming another scan returns no rows.
- **UI-RES-017** [ui] The last 20 queries per scan are kept, "Recent queries" restores one, `?filter=<json>` prefills the filter once, and "Export these results" opens the export dialog with the filter.
- **UI-RES-018** [ui] The Workers tab shows `N active · N pending · N desired` and a table of workers (role, state, node (a link for admins only), processes, restarts, last exit with an OOM badge, runtime version, last seen), filtered to non-terminal states by default.
- **UI-RES-019** [ui] "Show worker logs of <id>" opens "Logs of <role> <id>", requests a fresh tail ("Requesting the latest output from the node…"), and shows when it was collected with "waiting for the node" or "truncated" badges and a "Refresh" button.
- **UI-RES-020** [ui] The in-flight table lists running analyses with seq, attempt, round, a live "running for" timer, worker, node and progress, captioned with the last update.
- **UI-RES-021** [ui] The Events tab lists events newest first with level, type, time and message, filters all, scan or worker events, expands an event's data, and loads older events with "Load more".
- **UI-RES-022** [ui] The Exports tab lists format, state (with the error when failed), rows, size, selection, created and expiry; "Download <format> export <id>" appears for ready exports, delete asks "Delete export?", and "New export" is disabled for deleted scans.
- **UI-RES-023** [ui] The export dialog takes JSON Lines or CSV, a status selection or a JSON filter, and fields (at most 64 dot paths), shows server errors at their field, and "Start export" shows "Export started"; the export is followed until it settles with "Export ready" (with "Download") or "Export failed", and an export started from the scan controls or the query console appears in the open Exports tab.

## UI-FORM. Schema forms

Mechanisms: [ui](../docs/ui.md) §6.

- **UI-FORM-001** [ui] Object properties render as field groups in schema source order; nested objects from depth 2 are collapsible, deeper or recursive schemas fall back to JSON, and an object without properties shows "No options."
- **UI-FORM-002** [ui] String fields use the input type of their format (uri, email, date; date-time is a text input that accepts RFC 3339 values), a textarea above 256 characters, the first example or the default as placeholder, and show pattern, length and format errors under the field.
- **UI-FORM-003** [ui, security] `writeOnly` strings render as password inputs with "Show value of <field>" and a "secret" badge, are never prefilled, and show no default.
- **UI-FORM-004** [ui] Enums and unions of titled constants render as a select with titles, required fields with at most 4 options as radio buttons, and non-string values keep their JSON type.
- **UI-FORM-005** [ui] A discriminated union renders a select of the branch titles followed by the chosen branch's fields, and switching branches keeps only the discriminator.
- **UI-FORM-006** [ui] Numbers take min, max and step from the schema and clearing removes the key; booleans are switches labelled "on (default)" or "off (default)" while unset; constants and `readOnly` fields are shown but never sent, and deprecated fields carry a badge.
- **UI-FORM-007** [ui] Arrays of enums render as a multi-select, arrays of primitives as rows with "Add item to <field>" (disabled at `maxItems`) and "Remove item <n> from <field>", and arrays of objects as "Item n" sections.
- **UI-FORM-008** [ui] Maps render as a key-value editor with "Add <field> entry", key validation ("Duplicate key", "Key is required"), and open maps as JSON.
- **UI-FORM-009** [ui] Nullable fields have "Set <field> to null", fields with a default show it and offer "Reset <field>", required fields are marked, and descriptions render code spans as `<code>`.
- **UI-FORM-010** [ui] Unsupported constructs (`allOf`, `if`/`then`/`else`, `not`, `patternProperties`, `prefixItems`, other unions) render as a `<field> (JSON)` textarea with "Invalid JSON: …" errors and the note "Edited as JSON (<reason>)".
- **UI-FORM-011** [ui] "Edit as JSON" switches the whole form to JSON and "Edit as form" back (blocked while the JSON is invalid); a missing or non-renderable schema shows "This schema can only be edited as JSON."
- **UI-FORM-012** [ui] An untouched optional field is absent from the request, so the server applies its default, and clearing a field removes its key, also the key of an optional object without a default whose last value was cleared.
- **UI-FORM-013** [ui, security] The browser validates forms under the production CSP (no `unsafe-eval`) and shows errors such as "is required" and `unknown property "x"` before submitting, for the selected union branch only.

## UI-TPL. Templates page

Mechanisms: [ui](../docs/ui.md) §5.14.

- **UI-TPL-001** [ui] `/templates` shows a card per template with title, name, description, a "pins inputs at scan start" badge for resolving templates and the example configs; "Show schemas of <title>" reveals the schema tables.
- **UI-TPL-002** [ui] A card's estimate form, prefilled with the example, shows "N analyses (exact)", "(estimate)" or "unknown" with "needs confirmation" and "too large" badges (`cidr` gives "8 analyses (exact)"), and maps invalid configs onto the fields.

## UI-ADMIN. Admin pages

Mechanisms: [ui](../docs/ui.md) §5.15–§5.16, §5.20.

- **UI-ADMIN-001** [ui] The nodes table shows name (with a "built-in" pill), state and "cordoned" badges, pool and labels, platform, CPUs, memory, free disk, active workers / capacity, DinD mode, version and last seen, plus warnings such as "Egress deny list not applied"; it filters by state and pool (a change reads the list at once; a pool that is no slug is explained under the filter and not sent).
- **UI-ADMIN-002** [ui] "Add node" (name, pool, labels, worker limit) reveals "Token of node <name>" (`data-testid=secret-reveal`) once, with copy buttons for the token, the `docker run` and compose snippets and the host checklist; it does not close on an outside click and never shows the token again after "Done".
- **UI-ADMIN-003** [ui] A duplicate node name shows "A node with this name already exists.", and an invalid name or label is blocked before any request.
- **UI-ADMIN-004** [ui] "Node actions for <name>" offer Edit (with a "Cordoned" switch; only changed fields are saved, "Node <name> saved") and "Show join command" with the `${SCANTOR_NODE_TOKEN}` placeholder; cordoning shows the "cordoned" badge.
- **UI-ADMIN-005** [ui] "Rotate token" reveals a new token, "Revoke token" shows "Token of <name> revoked" and the `revoked` state, and "Delete" requires the node name and removes the row; all three are disabled for the built-in node with an explanation.
- **UI-ADMIN-006** [ui] The node page shows the node's info, lease, labels, workers (with "Active only") and events, and "Node not found" for an unknown id.
- **UI-ADMIN-007** [ui] The users table searches by name or email and shows name (with "(you)"), email, role, status (active, banned with reason, or the deletion job's progress), privileged flag, worker limit ("unlimited"), usage and created time.
- **UI-ADMIN-008** [ui] "New user" creates a user with email, name, password, role, "Can run privileged tasks" and worker limit, shows "User <email> created", and a duplicate email shows "A user with this email already exists."
- **UI-ADMIN-009** [ui] Editing a user sends only changed fields; on the admin's own row the role is locked ("You cannot change your own role.") and "Set password", Ban and Delete are disabled; the worker limit's help says "Empty keeps the current limit." when editing and "Empty uses the instance default." when creating.
- **UI-ADMIN-010** [ui] "Set password" (with confirmation) notes that it signs the user out everywhere and shows "Password of <email> set".
- **UI-ADMIN-011** [ui] Ban takes an optional reason and "Also cancel all their scans" (checked by default); the row then shows "banned", and Unban returns it to active.
- **UI-ADMIN-012** [ui] Deleting a user requires typing their email, shows the purge job's progress on the row, and removes the row with "User deleted"; a failed or cancelled job unlocks the row again.
- **UI-ADMIN-013** [ui, security] With Traefik, the admin tools page shows cards for RabbitMQ management, mongo-express, the RustFS console and the Traefik dashboard; "Open <title>" sets the tools cookie and reaches the tool, and without Traefik the page says "Traefik is not enabled" and shows the bind address instead.
- **UI-ADMIN-014** [ui] The admin tools page links the API reference, the OpenAPI document and the metrics, and shows the health report (also when it answers 503) and a jobs table of all users with kind and state filters and failed jobs first.

## UI-ACCT. Account pages

Mechanisms: [ui](../docs/ui.md) §5.17–§5.19.

- **UI-ACCT-001** [ui] The account page has Profile, Password, Passkeys, Sessions and Editor sections that load and fail independently; if the account fails to load, "Your account could not be loaded" offers "Retry".
- **UI-ACCT-002** [ui] The profile saves the name ("Saved") and changes the email ("Email changed"), and shows role, privileged permission, worker limit and member-since date.
- **UI-ACCT-003** [ui] Changing the password takes the current one, a new one and its confirmation, signs out other sessions by default, and shows "Password changed" or the error.
- **UI-ACCT-004** [ui] A passkey-only account sets a password ("Password set"); "Remove password" appears only with a password and a passkey, confirms in two steps and shows "Password removed; sign in with a passkey from now on".
- **UI-ACCT-005** [ui] The passkeys section lists passkeys (name or "Unnamed passkey", added time, synced or device-bound), adds one with an optional name ("Passkey added"), renames inline, and removes with a two-step confirmation that is disabled for the last way to sign in.
- **UI-ACCT-006** [ui] The sessions section lists device, IP and sign-in time with "this browser" first, signs out a single session or all other sessions, and asks for a fresh sign-in when the session is older than 24 h.
- **UI-ACCT-007** [ui] The account's editor section shows the editor state, opens `/editor`, stops the editor after confirmation ("Editor stopped"), and shows "The last start failed" after a failed start.
- **UI-ACCT-008** [ui] CLI & MCP access lists `default` keys (name, prefix, created, expiry, last use, enabled) and the editor's keys separately under "Managed by the editor"; "Create key" takes a name (1–32 characters) and an expiry (1–365 days, default 90).
- **UI-ACCT-009** [ui, cli, mcp] A new key is revealed once (`data-testid=secret-value`) with the `SCANTOR_URL`/`SCANTOR_TOKEN` environment snippet, the Docker alias with the CLI image and the MCP command with the key; the key works for the CLI and the API, and two-step delete revokes it (401 afterwards). The alias runs the CLI image like `scantor.sh` (the invoking user with the socket's group, `HOME=/tmp`, the image pair of `cliImage`) and works as shown.
- **UI-ACCT-010** [ui] CLI download links appear only for a release version, and dev builds show none.
- **UI-ACCT-011** [ui, mcp] The MCP section shows the endpoint (`data-testid=mcp-url`) with "Copy MCP URL", the OAuth command and client snippet when OAuth is available, and the API-key command; with MCP disabled it says "MCP is disabled on this instance."
- **UI-ACCT-012** [ui, mcp] Authorized apps list name, client id, URI (http(s) links only, `rel="noopener noreferrer"`), scopes and time; a two-step "Revoke <app>" removes the row, and the app's next MCP call gets 401.
- **UI-ACCT-013** [ui] The git credentials page lists name, host, username, the token as `••••<last4>`, last use and created time.
- **UI-ACCT-014** [ui] "New credential" takes name, host (`host[:port]` without scheme), username (default `x-access-token`) and a hidden token, shows "Credential <name> saved", and reports a duplicate name; editing keeps the stored token when the field stays empty unless the host changes (a new host requires the token again), and delete confirms in two steps.
- **UI-ACCT-015** [ui, e2e] A saved credential is offered in the git import form and makes the import of a private repository on its host work.

## UI-SEC. Dashboard security

Mechanisms: [ui](../docs/ui.md) §12–§14, [security](../docs/security.md) HDR-1…HDR-6.

- **UI-SEC-001** [ui, security] Every dashboard response, static assets included, and every `/api` response carries a CSP with `frame-ancestors 'self'`, `object-src 'none'` and `base-uri 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, the `Permissions-Policy` and HSTS on https; `/api` responses add `Cache-Control: no-store`.
- **UI-SEC-002** [ui, security] `/login`, `/setup` and `/oauth/consent` send `frame-ancestors 'none'` and `Cache-Control: no-store`.
- **UI-SEC-003** [ui, security] No page logs a CSP violation, and the production `script-src` never contains `unsafe-eval`.
- **UI-SEC-004** [ui, security] Results, logs, error and event messages and file names of the `hostile-output` fixture render as inert text: no element is injected, no script runs, ANSI sequences are stripped, and the only data-derived links are http(s) links with `rel="noopener noreferrer"`.
- **UI-SEC-005** [ui, security] The dashboard sends no request outside its own origin except to the S3 public origin (downloads, previews) and the editor origin: no third-party fonts, CDNs or telemetry.
- **UI-SEC-006** [ui, security] Browser storage never holds tokens, API keys, node tokens, passwords, `writeOnly` values or results, also after revealing secrets, running test runs with secret fields and finishing setup.
