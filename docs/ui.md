# UI

This document specifies the web UI of the orchestrator: a Nuxt 4 single-page application built with
Nuxt UI 4 (UDashboard* layout components, UTable, UForm + zod) that follows agentor's dense, dark-first
developer-tool look. It defines the `app/` structure, the navigation, every page with its content, data
sources (by `operationId` from [api](api.md)) and actions, the JSON-Schema form renderer used for task,
scan and analysis configs, the polling/SSE strategy, the central fetch wrapper and error toasts, theme,
accessibility rules that the Playwright suite depends on, icons, security headers and local UI state.
Server routes, resource shapes and states are defined in [api](api.md) and [data model](data-model.md);
this document never redefines them.

## 1. Stack and configuration

| Item | Choice |
|---|---|
| Framework | Nuxt 4.6 (`ssr: false`, SPA), Nitro `node-server` preset (shared with the API, [architecture](architecture.md) §4.1) |
| Components | Nuxt UI 4.12 (`@nuxt/ui`), Tailwind CSS 4.3 (CSS-first: `@import "tailwindcss"; @import "@nuxt/ui";`) |
| Layout | `UDashboardGroup`, `UDashboardSidebar`, `UDashboardPanel`, `UDashboardNavbar`, `UDashboardToolbar`, `UDashboardSidebarCollapse`, `UDashboardSidebarToggle` |
| Tables | `UTable` (TanStack) with server-side cursor loading (`Load more`), `sticky`, `virtualize` for result tables |
| Forms | `UForm` + `UFormField`; static forms validate with zod schemas from `#shared/schemas`; JSON-Schema forms validate with `@cfworker/json-schema` through `UForm`'s `validate` prop (§6) |
| Auth client | `better-auth/vue` `createAuthClient` with `passkeyClient()` and `oauthProviderClient()` |
| Helpers | `@vueuse/core` (explicit dependency): `useIntervalFn`, `useDocumentVisibility`, `useInfiniteScroll`, `useDebounceFn` |
| JSON Schema | `@cfworker/json-schema` (draft 2020-12): an interpreter that generates no code, so the production CSP needs no `'unsafe-eval'` (§13). The server validates with ajv ([tasks](tasks.md) §6.3) and stays authoritative. |
| Icons | `@iconify-json/lucide` only, bundled (§12) |
| Type checking | `nuxt typecheck` with `vue-tsc` and TypeScript `~6.0.3` (not 7, [development](development.md) §11) |

`nuxt.config.ts` essentials (UI-relevant only; Nitro/OpenAPI settings are in [api](api.md)):

```ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/eslint'],     // @nuxt/eslint: standalone lint config (development §15)
  ssr: false,
  css: ['~/assets/css/main.css'],
  ui: { fonts: false },                       // system font stacks; no font downloads at build or run time
  colorMode: { preference: 'dark', fallback: 'dark', storageKey: 'scantor-color-mode' },
  icon: {
    clientBundle: { scan: { globInclude: ['app/**/*.{vue,ts}'] } },
    serverBundle: 'local',
    fallbackToApi: false,
    localApiEndpoint: '/_icons',              // outside /api, see §12
  },
  experimental: { emitRouteChunkError: 'automatic-immediate' },  // re-verify on Nuxt 4.6 before keeping
  routeRules: { /* static security headers, §13 */ },
  compatibilityDate: '2026-10-01',
})
```

`app/app.config.ts` (inside `app/`, otherwise Nuxt ignores it):

```ts
export default defineAppConfig({ ui: { colors: { primary: 'green', neutral: 'slate' } } })
```

The SPA reads no runtime configuration. Everything instance-specific (public, editor and MCP URLs,
feature flags, limits, version, CLI image) comes from `getInstanceInfo` (`GET /api/info`) and
`getSetupStatus` (`GET /api/setup/status`).

## 2. `app/` structure

```
orchestrator/app/
├── app.vue                       <UApp :toaster="{ position: 'bottom-right' }"><NuxtLayout><NuxtPage/></NuxtLayout></UApp>
├── app.config.ts                 colors (primary green, neutral slate)
├── assets/css/main.css           tailwind + nuxt ui imports, font stacks, log/JSON viewer tokens
├── assets/img/scantor-symbol.svg logo
├── layouts/
│   ├── default.vue               UDashboardGroup + AppSidebar + <slot/>
│   └── auth.vue                  centered card (login, setup, OAuth consent)
├── middleware/
│   └── auth.global.ts            setup / session / admin guard driven by page meta
├── plugins/
│   └── api.ts                    provides $api (central $fetch wrapper, §8)
├── pages/                        §4 route map
├── components/                   flat, PascalCase, role suffixes (§2.1)
├── composables/                  use<Resource> data composables, use<Thing> UI composables (§7)
└── utils/                        auto-imported pure helpers: status.ts, format.ts, errors.ts,
                                  json-pointer.ts, ansi.ts, navigation.ts, schema-subset.ts, download.ts,
                                  clipboard.ts
```

Types and validation schemas are shared with the server, never duplicated in `app/`:

| Location | Content | Import |
|---|---|---|
| `orchestrator/shared/types/<area>.ts` | API representations (`Task`, `Revision`, `Scan`, `ScanSummary`, `Analysis`, `Worker`, `Node`, `ApiError`, …) exactly as in [api](api.md) §2 | auto-imported (Nuxt 4 `shared/types`) |
| `orchestrator/shared/schemas/<area>.ts` | zod request schemas (`startScanBody`, `createTaskBody`, `scaleScanBody`, `createUserBody`, …); the server validates with them and `UForm` uses them | `#shared/schemas/<area>` |
| `orchestrator/shared/utils/<x>.ts` | pure helpers shared with the server: enum value lists, `scanActions(scan)` (which lifecycle actions a state allows, from [architecture](architecture.md) §11.3), slug rules | auto-imported (Nuxt 4 `shared/utils`) |

Naming conventions (from agentor): components live flat in `components/` and carry a role suffix:
`XxxModal` (dialog), `XxxSlideover` (side panel), `XxxPanel` (tab content), `XxxTable`, `XxxCard`,
`XxxSection` (account page section), `XxxField` (schema form field), `XxxStep` (wizard step). Routable
screens exist only in `pages/`.
Pages call their composables directly; there is no event relaying through layout components.

### 2.1 Components

| Area | Components |
|---|---|
| Shell | `AppSidebar`, `AppLogo`, `ThemeToggle`, `UserMenu`, `RefreshButton` |
| Common | `StatusBadge` (kind + state → color/icon/label from `utils/status.ts`), `IdChip` (short id + copy), `CopyButton`, `RelativeTime`, `DurationText`, `BytesText`, `JsonView` (text-only, collapsible, long-string truncation), `InlineCodeText` (template and schema descriptions with Markdown code spans as `<code>`, everything else plain text), `CodeBlock`, `LogView` (ANSI-stripped, follow toggle), `EmptyState`, `ConfirmModal`, `SecretRevealModal` (token/key shown once), `KeyValueEditor`, `FileDropZone`, `LoadMoreButton` |
| Schema forms | `SchemaForm`, `SchemaField` (dispatcher), `StringField`, `NumberField`, `BooleanField`, `EnumField`, `ArrayField`, `ObjectField`, `MapField`, `UnionField` (discriminated unions), `UploadField`, `JsonField`, `SchemaTable` (read-only schema viewer) |
| Tasks | `TaskTable`, `TaskHeader`, `TaskWorkspaceCard`, `TaskFilesBrowser`, `RevisionTable`, `RevisionFacts`, `BuildLog`, `BuildErrors`, `DescribeView`, `PublishModal`, `TestRunPanel`, `TestRunAnalysisSlideover`, `WizardSourceStep`, `WizardLanguageStep`, `WizardTemplateStep`, `WizardNameStep`, `WizardGitStep`, `WizardUploadStep` |
| Scans | `ScanTable`, `ScanHeader`, `ScanControls`, `ScanProgress`, `ScanStats`, `ScanHealth`, `ConditionItem`, `ScanSettingsCard`, `ScanResultsTable`, `ResultsFilterBar`, `AnalysisSlideover`, `AttemptsTable`, `FileChip`, `QueryConsole`, `ExportsPanel`, `ExportModal`, `ScaleModal`, `RestartModal`, `WorkersTable`, `InflightTable`, `WorkerLogsModal`, `EventTimeline`, `NewScanForm`, `RevisionPicker`, `SettingsFields`, `EstimateBadge` |
| Admin | `NodeTable`, `NodeFormModal`, `NodeJoinModal`, `UserTable`, `UserFormModal`, `BanUserModal`, `ToolCard`, `JobsTable` |
| Account | `ProfileSection`, `PasswordSection`, `PasskeysSection`, `SessionsSection`, `EditorSection`, `ApiKeysSection`, `McpAccessSection`, `OAuthAppsSection`, `CredentialsTable`, `CredentialFormModal` |
| Catalog | `TemplateCard` |

## 3. Layout and navigation

### 3.1 Shell

```
┌──────────────────────── UDashboardGroup (storage="local", storage-key="scantor-dashboard") ──────────────────────┐
│ UDashboardSidebar (collapsible, resizable)   │ UDashboardPanel (one per page)                                     │
│ ┌──────────────────────────────────────────┐ │ ┌ #header: UDashboardNavbar ─────────────────────────────────────┐ │
│ │ logo · "scantor" · ThemeToggle           │ │ │ [≡ collapse] Title · badges            [Refresh] [actions…]    │ │
│ │ [ New scan ]   [ New task ]              │ │ ├ UDashboardToolbar: page tabs (UTabs / UNavigationMenu)         │ │
│ │ ── Workspace ──                          │ │ └────────────────────────────────────────────────────────────────┘ │
│ │ Overview · Tasks · Scans (n) ·           │ │ #body: page content (scrolls)                                     │
│ │ Templates · Editor                       │ │                                                                   │
│ │ ── Access ──                             │ │                                                                   │
│ │ CLI & MCP access · Git credentials       │ │                                                                   │
│ │ ── Admin ── (admins only)                │ │                                                                   │
│ │ Nodes (offline n) · Users · Admin tools  │ │                                                                   │
│ │ ── (bottom) API docs ↗                   │ │                                                                   │
│ │ #footer: UserMenu (avatar, name, admin   │ │                                                                   │
│ │   badge, email) → Account · Sign out     │ │                                                                   │
│ └──────────────────────────────────────────┘ │                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- `layouts/default.vue` renders `UDashboardGroup` → `AppSidebar` + `<slot/>`. Every page renders one
  `UDashboardPanel` with `id` = route name; the `#header` slot holds `UDashboardNavbar` (title,
  `#leading` = `UDashboardSidebarCollapse`, `#right` = page actions) and optionally a `UDashboardToolbar`
  with page tabs.
- On screens below `lg`, the sidebar becomes a drawer opened by `UDashboardSidebarToggle` (aria-label
  "Open navigation").
- Page titles: `useHead({ title: '<Page> · scantor' })`.

### 3.2 Sidebar items

Defined once in `app/utils/navigation.ts` (a `.ts` file, hence the icon scan glob in §1).

| Group | Label | Route | Icon | Badge | Visible |
|---|---|---|---|---|---|
| (top buttons) | New scan (primary, block) | `/scans/new` | `i-lucide-play` | – | all |
| | New task (neutral outline, block) | `/tasks/new` | `i-lucide-plus` | – | all |
| Workspace | Overview | `/` | `i-lucide-layout-dashboard` | – | all |
| | Tasks | `/tasks` | `i-lucide-package` | – | all |
| | Scans | `/scans` | `i-lucide-radar` | count of the caller's scans in `creating`/`running`/`paused` | all |
| | Templates | `/templates` | `i-lucide-layout-template` | – | all |
| | Editor | `/editor` | `i-lucide-code` | – | `features.editor` |
| Access | CLI & MCP access | `/account/access` | `i-lucide-terminal` | – | all |
| | Git credentials | `/account/credentials` | `i-lucide-key-round` | – | all |
| Admin | Nodes | `/admin/nodes` | `i-lucide-server` | offline nodes (color error) | admins |
| | Users | `/admin/users` | `i-lucide-users` | – | admins |
| | Admin tools | `/admin/tools` | `i-lucide-wrench` | – | admins |
| (bottom) | API docs ↗ | `/api/docs` (new tab) | `i-lucide-book-open` | – | all |

The Scans and Nodes badges come from the singleton `useSidebarCounts()` (one poll, §9). The header holds
the logo (`AppLogo`, decorative `alt=""`) next to the text "scantor" and the `ThemeToggle`. The footer
`UserMenu` is a `UDropdownMenu` with "Account" (`/account`), "CLI & MCP access" and "Sign out". Sign-out
calls `signOut()` and then hard-reloads to `/login` (resets every module-level singleton).

## 4. Route map

`meta` columns: **auth** `false` = public page; **admin** `true` = admins only (the server enforces it
again). Layout `auth` for the three public pages, `default` everywhere else.

| Route | Page file | Meta | Main operations |
|---|---|---|---|
| `/login` | `pages/login.vue` | auth false | `getSetupStatus`, better-auth sign-in |
| `/setup` | `pages/setup.vue` | auth false | `getSetupStatus`, `createSetupAdmin`, `createSetupPasskeyToken` |
| `/oauth/consent` | `pages/oauth/consent.vue` | auth false (requires a session; redirects to login keeping the query) | better-auth `oauth2/public-client`, `oauth2/consent` |
| `/` | `pages/index.vue` | | `listScans`, `listTasks`, `getHealth`, `listNodes` (admin) |
| `/tasks` | `pages/tasks/index.vue` | | `listTasks` |
| `/tasks/new` | `pages/tasks/new.vue` | | `listLanguages`, `listScaffolds`, `listTemplates`, `createTask`, `importGitTask`, `uploadTask`, `listCredentials` |
| `/tasks/:taskId` | `pages/tasks/[taskId]/index.vue` | | `getTask`, `getTaskWorkspace`, `listRevisions`, `listTaskFiles`, `readTaskFile`, `testTask`, `streamTestRun`, `listTestRuns`, `getTestRun`, `cancelTestRun`, `publishRevision`, `pullGitTask`, `deleteTask`, `listScans` |
| `/tasks/:taskId/revisions/:revision` | `pages/tasks/[taskId]/revisions/[revision].vue` | | `getRevision`, `getRevisionBuildLog`, `downloadRevisionSource` |
| `/editor` | `pages/editor.vue` | | `getEditor`, `createEditorSession`, `stopEditor` |
| `/scans` | `pages/scans/index.vue` | | `listScans` |
| `/scans/new` | `pages/scans/new.vue` | | `listTasks`, `listRevisions`, `getRevision`, `listUploads`, `createUpload`, `estimateTemplate`, `startScan` |
| `/scans/:scanId` | `pages/scans/[scanId].vue` | | `getScan`, lifecycle operations, `listAnalyses`, `getAnalysis`, `queryAnalyses`, `aggregateAnalyses`, `listScanWorkers`, `listInflightAnalyses`, `getWorkerLogs`, `listScanEvents`, `exportScan`, `listExports`, `getExport`, `deleteExport`, `getFileDownload`, `getJob`, `getRevision` |
| `/templates` | `pages/templates.vue` | | `listTemplates`, `estimateTemplate` |
| `/account` | `pages/account/index.vue` | | `getAccount`, `updateAccount`, `setAccountPassword`, `removeAccountPassword`, better-auth password/email/passkey/session endpoints, `getEditor`, `stopEditor` |
| `/account/access` | `pages/account/access.vue` | | `listApiKeys`, `createApiKey`, `deleteApiKey`, `listOAuthApps`, `revokeOAuthApp`, `getInstanceInfo` |
| `/account/credentials` | `pages/account/credentials.vue` | | `listCredentials`, `createCredential`, `updateCredential`, `deleteCredential` |
| `/admin/nodes` | `pages/admin/nodes/index.vue` | admin | `listNodes`, `createNode`, `updateNode`, `deleteNode`, `rotateNodeToken`, `revokeNodeToken`, `getNodeJoin` |
| `/admin/nodes/:nodeId` | `pages/admin/nodes/[nodeId].vue` | admin | `getNode`, `listNodeWorkers`, `listNodeEvents` |
| `/admin/users` | `pages/admin/users.vue` | admin | `listUsers`, `createUser`, `updateUser`, `setUserPassword`, `banUser`, `unbanUser`, `deleteUser`, `getJob` |
| `/admin/tools` | `pages/admin/tools.vue` | admin | `getInstanceInfo` (`adminTools`), `createToolsSession` (navigation), `listJobs`, `getHealth` |

Route parameters always use ids (`taskId` uuid, `scanId` uuid, `revision` number), because a task
*name* resolves only among the caller's tasks and admins open other users' tasks. A typed name in the
address bar still works for own tasks (the API accepts it). Query parameters carry tab and drawer state:
`?tab=<tab>` on task and scan detail, `?analysis=<seq>` opens the analysis drawer, `?revision=<ref>` pre-
selects the revision on `/scans/new`, `?task=<name>` on `/editor`, `?redirect=<path>` on `/login`.

### 4.1 Route middleware (`auth.global.ts`)

```
to.meta.auth === false ──► allow (login, setup, consent)
setup not yet confirmed done ──► GET /api/setup/status ──► needsSetup ? /setup : cache "done" (never flips back)
await better-auth session (wait while isPending)
no session ──► /login?redirect=<to.fullPath>   (consent: /login?<original OAuth query>)
to.meta.admin && role !== 'admin' ──► / + toast "Admins only"
```

`redirect` is accepted only when it is a same-origin path (starts with `/`, not `//`, no scheme).

## 5. Pages

Shared page conventions: every polled page has a `Refresh` icon button (aria-label "Refresh") in the
navbar that refetches immediately; lists use `Load more` (cursor or `afterSeq`) instead of page numbers,
because every list API is cursor-based ([api](api.md) §1.8); empty states use `EmptyState` (big faded
icon + one line + optional primary action); destructive operations go through `ConfirmModal` (page-level)
or a two-step inline button (row-level, agentor pattern); the UI never calls `window.confirm()` or
`window.prompt()`.

### 5.1 Login (`/login`)

- Centered card (layout `auth`): logo, "scantor", form `UForm` with zod `{email, password}`:
  `UInput type="email" autocomplete="username webauthn"`, `UInput type="password"
  autocomplete="current-password webauthn"`, submit "Sign in" (`type="submit"`, block).
- When `getSetupStatus.passkeysEnabled`: an "or" divider and "Sign in with passkey" (outline,
  `i-lucide-key-round`). On mount, if `PublicKeyCredential.isConditionalMediationAvailable()` resolves true
  and `navigator.webdriver` is false, start `client.signIn.passkey({ autoFill: true })` (conditional UI);
  it is skipped under webdriver because it races test-driven passkey calls.
- On mount: `needsSetup` → `/setup`; an existing session (checked with `GET /api/auth/get-session`) →
  hard navigation to the redirect target.
- Success: if the URL carries a signed OAuth query (`sig` parameter) follow the better-auth redirect;
  otherwise `window.location.href = redirect || '/'` (hard reload).
- Errors inline under the form (`invalid credentials`; 429 from better-auth's rate limit, 10 sign-ins per
  minute per client IP ([auth](auth.md) §2.7) → "Too many attempts, try again in a minute"; `banned`).

### 5.2 Setup (`/setup`)

- Reads `token` from the query, keeps it in `sessionStorage` (key `scantor-setup-token`, so a reload still
  works; removed after success or on `409 setupCompleted`) and immediately removes it from the address bar
  with `history.replaceState` (the token must not stay in history, [auth](auth.md) §7.2).
- `getSetupStatus.needsSetup === false` → `/login`.
- Without a token: explanation "Open the setup link printed in the orchestrator log" with the command
  `docker compose logs orchestrator | grep setup` (CodeBlock) and an input to paste the token.
- Segmented control "Password | Passkey" (passkey only when `passkeysEnabled`):
  - Password: `{name, email, password, confirm}` (zod: password 8–128, confirm equal) →
    `createSetupAdmin` with header `X-Scantor-Setup-Token` → better-auth `signIn.email` → hard reload `/`.
  - Passkey: `{name, email}` → `createSetupPasskeyToken` → `client.passkey.addPasskey({ name: 'Primary
    passkey', context: token })` (the registration creates the admin and signs the browser in,
    [auth](auth.md) §7.3) → hard reload `/`.
- `401 setupTokenInvalid` → inline "The setup token is missing or wrong. Restarting the orchestrator
  prints a new one." `409 setupCompleted` → `/login`.

### 5.3 OAuth consent (`/oauth/consent`)

Layout and behaviour follow [mcp](mcp.md) §3.3:

- Loads the client with better-auth `oauth2/public-client` (`client_id` from the query). Shows the client
  name (DCR clients carry an "unverified" badge; CIMD clients show the metadata document's host), a link
  to `client_uri` only when it is `http(s)`, the **redirect origin** prominently ("After approval you will
  return to `http://127.0.0.1:53682`", protects against look-alike names) and the signed-in user's email.
- **Access level** (`URadioGroup`): "Read only" (`scantor:read`: read tasks, scans and results), "Read and
  write" (`scantor:read scantor:write`: also create and change tasks and start and control scans;
  preselected), "Admin" (`scantor:read scantor:write scantor:admin`: also manage nodes; rendered only for
  admins and never preselected). An option is enabled only when the client requested all of its scopes.
- "Approve" calls `oauth2/consent` with `{accept: true, scope: "<requested non-scantor scopes> <level
  scopes>"}`, "Deny" with `{accept: false}`; both follow the returned redirect ([auth](auth.md) §2.8).
- Served with `frame-ancestors 'none'` (§13).

### 5.4 Overview (`/`)

| Block | Content | Source |
|---|---|---|
| Active scans | cards for scans in `creating`, `running`, `paused`: name, `task@N`, state badge, `ScanProgress` (compact), rate, ETA, conditions icon | `listScans?state=creating,running,paused&limit=20` |
| Needs attention | scans with `conditionsCount > 0` or `state=failed` in the last list page, with the top condition | same list + `listScans?state=failed&limit=10` |
| Recent scans | last 10 scans (`ScanTable` compact) | `listScans?limit=10` |
| Recent tasks | last 5 tasks: name, language, latest revision badge, "Unpublished changes" badge | `listTasks?limit=5` |
| Platform health (admins) | component dots for mongo, rabbitmq, s3, registry; RabbitMQ alarms; nodes online/offline/total, free capacity (the sum of `max(0, capacity − activeWorkers)` over online, uncordoned nodes, with capacity = `info.maxWorkers`, capped by the node's `maxWorkers` when set) | `getHealth`, `listNodes` |
| Quick actions | New task, New scan, CLI & MCP access | – |

Empty first-run state: "No tasks yet" with "Create your first task" (→ `/tasks/new`).

### 5.5 Tasks list (`/tasks`)

- Toolbar: search (`q`, debounced 300 ms), language filter (`USelect` from `listLanguages`), admin-only
  "Only mine" switch (sets `userId` to the caller).
- `TaskTable` columns: name (link, mono), language (`UBadge`), source (`scaffold`/`upload`/`git` with
  icon), latest revision (`@N` + state badge), "Unpublished changes" badge when `workspace.dirty`,
  privileged badge, revisions (`revisionCount`), owner (admins), updated (relative).
- Navbar action "New task". Row click → `/tasks/:taskId`.

### 5.6 New task wizard (`/tasks/new`)

`UStepper` whose steps depend on the chosen source. Step 1 is always **Source**: three cards "From a
scaffold", "Import from git", "Upload a folder".

**From a scaffold** (source → language → template → name):

| Step | Content | Source |
|---|---|---|
| Language | one card per language: title, base image, default entry, extensions | `listLanguages` |
| Template | cards for every template the language's scaffold supports: title, description, example analysis config (JsonView, compact), "pins inputs" badge when `resolves`; plus a "Custom schedule" card (template `custom`: generator stub) | `listTemplates` ∩ `listScaffolds[language].templates` |
| Name | `name` (slug rules from `#shared/schemas/tasks`: `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, not a reserved name, live validation), `description` (≤ 500) | – |

"Create task" → `createTask {name, language, template, description}` → `/tasks/:id` with a success
banner offering "Open in editor", "Start test run" and "Publish". `409 alreadyExists` → inline under name.

**Import from git**: `url` (https only, no userinfo, no leading `-`: zod with the request schema's `gitUrl`, so such URLs are rejected before any request), `ref` (default `HEAD`), `path` (default `.`), credential
(`USelect` from `listCredentials` + "None", link "Add a credential" → `/account/credentials` in a new
tab) → `importGitTask`. A 200 with `imported: []` and `candidates` adds a step "Select tasks": checkbox
list (name, language, path, "already exists" badge disables the row) → `importGitTask` with `select`. One
imported task → its page; several → `/tasks` with a toast. `422 gitFailed` shows `details.message` inline.

**Upload a folder**: `FileDropZone` accepting `.tar.gz`/`.tgz` (the CLI `scantor push` is the main path;
the help text shows `tar czf task.tgz -C <dir> .`), checkboxes "Publish a revision" (default on) and
"Replace unpublished changes" (`force`, default off), optional message → `uploadTask` (body = the file,
`Content-Type: application/gzip`, query `publish`, `force`, `message`). Result: revision → revision page,
otherwise task page. `409 workspaceDirty` → inline with a "Replace anyway" button (retries with
`force=true`); `422 manifestInvalid` lists `details.errors` with `BuildErrors`; `422 invalidPath` shows
`details.path`.

### 5.7 Task detail (`/tasks/:taskId`)

Header (`TaskHeader`): name, language badge, source badge (git: `url@ref:path` and short commit),
privileged badge, **"Unpublished changes"** warning badge when `workspace.dirty` (tooltip "The workspace
differs from the latest revision"; `dirty` compares with `latestRevision.packSha256`, [api](api.md) §2),
latest revision link with state badge.

Navbar actions (icon + label; icon-only on narrow screens with the same aria-label):

| Action | aria-label | Enabled when | Behaviour |
|---|---|---|---|
| Open in editor | "Open in editor" | `features.editor` | → `/editor?task=<name>` |
| Publish | "Publish revision" | always | `PublishModal`: optional message, workspace status (fresh `getTaskWorkspace`), notice when not dirty and the latest revision is `queued`, `building` or `ready` ("Publishing returns the existing revision", [api](api.md) §4.10) → `publishRevision` → revision page (live build log) |
| Start scan | "Start scan" | `latestReadyRevision` set | → `/scans/new?revision=<taskId>@latest` |
| Pull from git | "Pull from git" | `source.kind === 'git'` | `pullGitTask {}` → toast "Pulled <short commit>" or "Already up to date"; `409 gitDiverged` → `ConfirmModal` "Local changes or a non-fast-forward remote. Overwrite the workspace?" → `pullGitTask {force: true}` |
| Download workspace | "Download workspace" | always | anchor to `downloadTaskWorkspace` (`download` attribute) |
| Delete task | "Delete task" | always | `ConfirmModal` (type the task name) → `deleteTask` → 202 → `/tasks` with toast; `409 taskInUse` → toast "A scan still uses this task" with "Show active scans" (`/scans?task=<taskId>&state=creating,running,paused`, §5.11) |

Tabs (`?tab=`):

| Tab | Content |
|---|---|
| `overview` (default) | description; workspace card (files, size, pack hash short, `checkedAt`, "Check now" → `getTaskWorkspace`); latest and latest ready revision cards; source details; recent scans of this task (`listScans?task=<id>&limit=10`); recent test runs (`listTestRuns?limit=5`) |
| `files` | `TaskFilesBrowser`: left tree from `listTaskFiles?recursive=true` (≤ 5000 entries, `truncated` notice), right read-only viewer from `readTaskFile` (UTF-8 in a mono `CodeBlock` with line numbers; base64 content shows "Binary file, N bytes"; `truncated` notice above 1 MiB). A source switch "Workspace / Revision N" passes `revision`. A prominent "Open in editor" link; the UI does not edit files itself. |
| `revisions` | `RevisionTable` from `listRevisions` (number/ref, state badge, source kind, pack hash short, privileged, errors count, created, duration) with a state filter; row → revision page |
| `test` | `TestRunPanel` (§5.8) |

### 5.8 Test run panel (task detail, tab `test`)

```
┌ Inputs ───────────────────────────────┐ ┌ Run ─────────────────────────────────────────────┐
│ Mode: (•) Schedule + run  ( ) One     │ │ state badge · draft image (cached) · duration     │
│       analysis                        │ │ BuildLog / LogView (live, SSE)                     │
│ Task config      [SchemaForm | JSON]  │ │ Analyses: seq · status · duration · result/error  │
│ Scan config      [SchemaForm | JSON]  │ │   (row → TestRunAnalysisSlideover)                 │
│  or Analysis config                   │ │ Summary: analyses / succeeded / failed             │
│ limit [5]  maxAttempts [1]  timeout   │ │ [Cancel test run]                                  │
│ [ Start test run ]                    │ └───────────────────────────────────────────────────┘
└───────────────────────────────────────┘  History: last test runs (listTestRuns) → load one
```

- Schemas: the draft's schemas are unknown until the test run has built, so the forms use the
  description of `latestRevision` (or the last test run's `description` when it is newer). When no
  description exists yet, the forms start in raw JSON mode with `{}`. After a run, if the test run's
  `description.schemas` differ, a banner says "Schemas changed in your workspace; the form now uses the
  new schemas" and the forms re-render.
- Mode "One analysis" sends `analysisConfig` (schedule skipped); mode "Schedule + run" sends `scanConfig`
  and `limit` (1–50, default 5). `maxAttempts` 1–5 (default 1), `timeoutMs` entered in seconds (default
  from the manifest).
- Start → `testTask` (no `wait`) → `useTestRunStream(testRunId)` opens `EventSource('/api/test-runs/<id>/stream')`:
  `state` updates the badge, `log` appends to `LogView` (build lines grouped under "Build", runtime lines
  prefixed with the seq), `analysis` appends/updates a row, `error` adds a `BuildErrors` entry, `end` closes
  the stream and replaces the summary. On stream error the panel falls back to polling `getTestRun` every
  2 s until the run settles.
- Files of test-run analyses render as `FileChip`s using `getTestRunFileDownload`.
- Cancel (aria "Cancel test run") → `cancelTestRun`.
- Unsent inputs are kept per task in UI prefs (§14) **without** `writeOnly` fields.

### 5.9 Revision detail (`/tasks/:taskId/revisions/:revision`)

- Header: ref `echo@3`, state badge, message, created/started/finished and build duration, privileged
  badge; actions "Start scan" (ready only, → `/scans/new?revision=<taskId>@<number>`), "Download source"
  (anchor `downloadRevisionSource?redirect=true`), "View files" (→ task `files` tab with `revision`).
- Facts (`dl` grid): source kind, pack hash, files, packed bytes, git `{url, ref, path, commit, dirty}`,
  base image ref and digest, image repository, digest, size, platform `os/arch`, connector language and
  version, protocol version, schedule (`template:<name>` or `custom`).
- **Errors** (failed only, shown first): `BuildErrors` list: phase badge, `file:line:column`, message.
- **Build log** (`BuildLog`): incremental `getRevisionBuildLog?afterLine=<n>&limit=1000` every 1 s while
  the revision is `queued` or `building` and until `complete`; lines grouped by `phase` (`pack`, `static`,
  `build`, `describe`, `check`, `push`) with collapsible phase headers, `error` lines tinted, auto-scroll
  while at the bottom (toggle aria "Follow log"), also when the log mounts with its lines already loaded
  (`useFollowScroll`, shared with `LogView`).
- **Describe** (`DescribeView`, ready revisions): `UTabs` "Task config", "Scan config", "Analysis
  config", "Result"; each shows a `SchemaTable` (property path, type, required, default, constraints,
  description, badges `secret` (`writeOnly`), `upload`, `file`) with a "Raw JSON" toggle; below: settings
  defaults table (`settingsDefaults`), warnings list, normalised manifest (JsonView).

### 5.10 Editor (`/editor`)

- On mount `getEditor`. "Open" requests `createEditorSession {open: <task name from ?task>}`; the returned
  `url` (`<SCANTOR_EDITOR_URL>/_auth?code=…`, valid 60 s, single use) becomes the `src` of a full-height
  `<iframe title="Editor" allow="clipboard-read; clipboard-write">` inside the panel body. The editor
  origin is same-site with the dashboard, so its host-only cookie works inside the frame ([editor](editor.md)).
- While the editor is `starting`: placeholder "Editor is starting…" with a spinner; poll `getEditor`
  every 2 s; once `running`, request a fresh session URL (codes expire) and mount the iframe.
- Navbar: state badge, idle timeout ("stops after N min idle", from `idleTimeoutMs`), "Open in new tab"
  (requests a fresh session URL, then `window.open(url, '_blank', 'noopener')`), "Stop editor" (aria "Stop
  editor", `ConfirmModal`) → `stopEditor`.
- A start failure (`error` of `getEditor`, the last `editors.error`, [api](api.md) §4.18) renders as an alert
  with "Retry". `429 tooManyRequests` from `createEditorSession` (all `SCANTOR_EDITOR_MAX_RUNNING` editor
  slots busy) renders as an alert "Too many editors are running; try again later".

### 5.11 Scans list (`/scans`)

- Toolbar: state filter (`USelectMenu` multiple over scan states, default all except `deleting`/
  `deleted`), task filter (`USelectMenu` over `listTasks`), admin "Only mine" switch. The filters are
  remembered (§14); `?task=<taskId>` and `?state=<state,…>` take precedence over the remembered ones and are
  dropped from the URL at the first filter change.
- `ScanTable` columns: name (or short id) + id chip, `task@N` link, state badge (+ amber triangle with
  `conditionsCount` when > 0), progress bar + `terminal / total` + percent, rate (`stats.ratePerMin` /min),
  ETA, `workers × processes`, owner (admins; `userId` resolved to an email through a cached `getUser`),
  created (relative), completed (relative).
- Row actions (`UDropdownMenu`, aria "Scan actions"): Open, Pause, Resume, Cancel, Restart, Delete, each
  enabled per `scanActions(scan)`.
- Navbar action "New scan". Polls every 10 s (§9).

### 5.12 New scan form (`/scans/new`)

Sections in one `UForm` (static parts validated by `startScanBody` from `#shared/schemas/scans`, config
parts by the JSON-Schema validator, §6):

1. **Revision**: `RevisionPicker`: task (`USelectMenu` searchable, `listTasks`) → revision (`USelect`:
   "latest" + ready revisions from `listRevisions?state=ready`) → `getRevision` loads the description.
   Shows language, schedule kind (`template: tranco` / `custom`), privileged badge, and a warning when the
   user lacks `canRunPrivileged` (from `getAccount`) for a privileged revision (start disabled).
2. **Name** (optional, ≤ 100).
3. **Task config**: `SchemaForm` on `description.schemas.taskConfig` with "Edit as JSON" toggle.
4. **Scan config**: `SchemaForm` on `description.schemas.scanConfig` with "Edit as JSON" toggle;
   `"x-scantor": "upload"` fields render `UploadField` (select an existing upload from `listUploads` or
   upload a newline-separated file via `createUpload`, showing lines and size).
5. **Scaling**: `workers` (1 … `limits.maxWorkersPerScan`) and `processes` (1 …
   `limits.maxProcessesPerWorker`) as `UInputNumber`, prefilled from `settingsDefaults`. A derived line:
   "Total: W runner workers × P processes = W·P concurrent analyses; per worker: P×cpus CPUs, P×memoryMiB +
   256 MiB memory".
6. **Limits** (collapsible "Advanced settings"): timeout (seconds → `timeoutMs`), `maxAttempts` (1–20),
   backoff (`initialMs`, `factor`, `maxMs`, `jitter`), resources per process (`cpus`, `memoryMiB`),
   `maxAnalysesPerProcess`, node selector (`pool` default `shared`, labels via `KeyValueEditor`). Only fields
   that differ from `settingsDefaults` are sent.
7. **Estimate and confirmation** (template schedules only, `description.schedule.kind === 'template'`):
   after the scan config validates, `estimateTemplate(template, {scanConfig})` runs debounced 500 ms and
   shows `EstimateBadge`: "≈ 100,000 analyses" (or "exactly"), "unknown" when `expectedTotal` is null.
   `tooLarge` → error "Above the instance maximum" and Start disabled. `confirmationRequired` → a required
   checkbox "I want to start about N analyses" which sets `confirm: true`. Custom schedules show "The
   number of analyses is known after scheduling starts".
8. **Summary + Start scan** (aria "Start scan") → `startScan` → `/scans/:id`.

Errors: `422 configInvalid` maps `details.issues[].path` (JSON pointers) onto form fields (§6.4) and
scrolls to the first; `422 confirmationRequired` (race with a changed estimate) shows the checkbox with
`details.expectedTotal`; `422 scanTooLarge`, `403 privilegedNotAllowed`, `409 revisionNotReady`,
`503 brokerAlarm` show a form-level `UAlert`. The form never sends `writeOnly` values back from an existing
scan (restart is server-side, §5.13).

### 5.13 Scan detail (`/scans/:scanId`)

**Header** (`ScanHeader`): name (or id), id chip, link to `task@N` revision, state badge with
`stateReason` ("Paused: failure rate", "Failed: scheduling failed", …), round badge when `round > 1`,
privileged badge when `revision.privileged`, "Restarted from <link>" when `clonedFrom`, owner (admins),
created/started/completed (relative with absolute tooltip).

**Controls** (`ScanControls`, icon + label buttons; availability from `scanActions(scan)`; disabled
buttons show the reason as tooltip):

| Control | aria-label | Allowed states | Behaviour |
|---|---|---|---|
| Pause | "Pause scan" | `running` | `pauseScan` |
| Resume | "Resume scan" | `paused` | `resumeScan` (`409 revisionUnavailable` → alert) |
| Scale | "Scale scan" | `creating`, `running`, `paused` | `ScaleModal`: workers, processes (bounds from `/api/info` limits), derived resource totals → `scaleScan` |
| Cancel | "Cancel scan" | `creating`, `running`, `paused` | `ConfirmModal` ("In-flight analyses are aborted; queued ones are dropped") → `cancelScan` |
| Retry failed | "Retry failed analyses" | `running`, `completed`, `failed`, `cancelled` with `scheduling.state ∈ {done, failed}` (not `retrying`: no retry job active) and `stats.failed + stats.lost > 0` | `ConfirmModal` ("Retry up to N failed or lost analyses in round R+1. Lost analyses without a stored config and cancelled analyses are not retried; restart the scan for those.") → `retryFailedAnalyses` → job progress inline (`getJob` every 2 s); `409 nothingToRetry` → toast |
| Restart | "Restart scan" | all except `deleting`, `deleted` | `RestartModal`: name (default "<name> (restart)"), workers, processes → `restartScan` → navigate to the new scan |
| Delete | "Delete scan" | `completed`, `failed`, `cancelled` | `ConfirmModal` (type the scan name or id) → `deleteScan` → `/scans` + toast; the job continues server-side |
| Export | "Export results" | all except `deleting`, `deleted` | `ExportModal` (§5.13.6) |

Tabs (`?tab=`): `overview` (default), `results`, `query`, `workers`, `events`, `exports`.

#### 5.13.1 Overview

- `ScanProgress`: `UProgress` with `progress.percent` (indeterminate when `progress.total` is null),
  text "39,913 / 100,000 analyses (39.9 %)", scheduled count (`scheduling.confirmed`) with the scheduling
  state badge (`pending`, `running`, `done`, `retrying`, `failed`), rate "8,100 / min" and ETA "≈ 7 min"
  (`etaSeconds`, hidden when null). `data-testid="scan-progress"`.
- `ScanStats`: tiles pending, retrying, succeeded, failed, lost, cancelled; each tile links to the results
  tab filtered by that status; a caption "exact as of <recountedAt>" or "live estimate".
- `ScanHealth` (conditions panel, `data-testid="scan-health"`): "Healthy" with a green check when
  `conditions` is empty; otherwise one `ConditionItem` per condition sorted by severity, with icon, a
  title per type, `reason`, `message`, `since` (relative) and type-specific details:

| Condition | Details rendering |
|---|---|
| `workersPending` | `count` and a reasons table (`noNodes` "No online node matches", `archMismatch`, `selectorMismatch`, `insufficientCapacity`, `userMaxWorkers` "Your worker limit is reached", `dindUnavailable`, `diskLow`, `pullLimit`) |
| `crashLoop` | worker and node links, exit code, OOM badge, restarts, `logTail` in a `LogView` (ANSI stripped) |
| `imagePullFailed` | node, message |
| `workerErrors` | worker, `ScantorError` (type, phase, message) |
| `schedulerRestarting` | restarts, latest error |
| `schedulingFailed` | `ScantorError` with phase and message (for example "schedule() is not deterministic") |
| `topologyFailed`, `brokerAlarm` | message / alarms list |
| `breakerTripped` | ratio, attempts, window, and a "Resume scan" button |
| `stalled` | number of analyses recorded as lost |
| `clockSkew` | node, offset in ms |

- `ScanSettingsCard`: effective settings (`dl`), task config and scan config (JsonView; `"***"` values
  render as a lock icon + "secret"), template resolutions from `scheduling.resolved` (template, resolved
  scan config, provenance such as list id, month, source URL, SHA-256, fetched at, expected total), and
  `scheduling.error` when set.

#### 5.13.2 Results

- `ResultsFilterBar`: status multi-select (→ `listAnalyses?status=`), "Go to seq" (`afterSeq = seq − 1`),
  "Advanced filter" (a JSON filter; switches the table source to `queryAnalyses {filter, projection,
  limit, afterSeq}`), column picker (persisted per task id, §14), auto-refresh switch (default on while
  the scan is `running`).
- `ScanResultsTable` (`UTable sticky virtualize`, fixed height): columns seq (mono), status badge, attempt,
  round (when > 1), duration, error type and message (truncated), up to four result columns (default: the
  first four top-level properties of the Result schema from `getRevision(scan.task.id,
  scan.revision.id).description.schemas.result`; FileRef columns render a `FileChip`), finished at.
- The table requests a projection with `fields=id,seq,status,attempt,round,error.type,error.message,timings,files,<result columns>`
  so large results never load in the list. Page size 50 with "Load more" and infinite scroll
  (`afterSeq` = last seq); at most 5000 rows stay in memory, after which the table says "Use the query
  console or an export for more".
- Auto-refresh reloads the loaded range (capped at the first 1000 rows) every 10 s.
- Row click → `AnalysisSlideover` (`?analysis=<seq>`).

#### 5.13.3 Analysis detail (`AnalysisSlideover`)

`USlideover` (right, wide) loading `getAnalysis(<scanId>-<seq>)`:

| Section | Content |
|---|---|
| Header | analysis id (copy), status badge, attempt/round, worker and node (links), timings (scheduled, started, finished, duration) |
| Config | JsonView of the analysis config (secrets already masked by the API) |
| Result | JsonView; objects at `description.fileRefPaths` render as `FileChip` (name, size, content type, SHA-256 tooltip, "Download <name>" button → `getFileDownload` → `window.location.assign(url)`; for `inline` images a preview `<img>` with the presigned URL) |
| Error | type badge, phase, retryable, message, `details` JsonView, `stack` in a collapsible mono block |
| Attempts | `AttemptsTable`: attempt, round, started, duration, error type and message, worker, node, expandable `logTail` |
| Logs | `logTail` of the final attempt in `LogView` (ANSI stripped, wrap toggle) |

Actions: "Copy as JSON", "Query similar" (opens the query tab with `{"error.type": <type>}` or `{"seq":
<seq>}` prefilled). Everything is rendered as text; result values that look like URLs are not linkified.

#### 5.13.4 Query console

- Mode switch "Query | Aggregate" (`UTabs`).
- Query: JSON editors (`UTextarea` mono, JSON-validated on input) for `filter` (default `{"status":
  "failed"}`), `projection`, `sort`, plus `limit` (default 20, ≤ 1000) and `afterSeq`. Aggregate: `pipeline`
  (default `[{"$group": {"_id": "$error.type", "n": {"$sum": 1}}}]`) and `limit`.
- "Run" (aria "Run query", `Ctrl/⌘+Enter`) → `queryAnalyses` / `aggregateAnalyses`. Output toggle
  "JSON | Table" (table only when items are flat objects); "Load more" uses `nextCursor` (query mode
  without `sort`); `truncated` notice for aggregations.
- Errors stay inline (no toast): `400 queryRejected` highlights `details.path`, `504 queryTimeout`, `429
  tooManyRequests`.
- "Export these results" (query mode) opens `ExportModal` with the filter prefilled.
- The last 20 queries per scan are kept in UI prefs (§14) and listed as "Recent".

#### 5.13.5 Workers

- `WorkersTable` from `listScanWorkers` (state filter, default active states): short id, role badge,
  state badge with `stateReason`, node name, processes `desired / applied / running`, restarts, last exit
  (code, OOM badge), runtime version, last seen, started. Row action "Logs" (aria "Show worker logs") →
  `WorkerLogsModal`: `getWorkerLogs?wait=20&tailBytes=65536` shows a `LogView` with "Collected <time>",
  `truncated`, and "Refresh".
- `InflightTable` from `listInflightAnalyses`: analysis id (opens the slideover), seq, attempt, round,
  running for (live duration), worker, node, progress; "updated <time>" caption.

#### 5.13.6 Events and exports

- Events: `EventTimeline` (`UTimeline`) from `listScanEvents` (type filter by prefix `scan.`/`worker.`,
  `Load more`): time, level icon/color, type, message, `data` JsonView on expand.
- Exports: `listExports?scanId=` table (format, state badge, rows, size, created, expires) with
  "Download" (`download.url`, navigation) and delete (two-step). `ExportModal`: format (`jsonl`/`csv`),
  status quick filter or JSON filter, `fields` (comma-separated dot paths, CSV default columns hint) →
  `exportScan` (no `wait`) → the row polls `getExport` every 2 s until `ready`/`failed`, then a toast with a
  "Download" action. The UI always uses background exports (never `exportScanInline`).

### 5.14 Templates catalog (`/templates`)

One `TemplateCard` per `listTemplates` item: title, name (mono), description, "pins inputs at scan start"
badge when `resolves`, collapsible `SchemaTable`s for the scan config and analysis config schemas, the
example scan config and analysis config (JsonView), and "Estimate" (a `SchemaForm` on the scan config
schema + button → `estimateTemplate`, showing expected total, `exact`, `confirmationRequired`, `tooLarge`).
A note links to the authoring guides ([templates](templates.md) is the internal reference).

### 5.15 Nodes (`/admin/nodes`, `/admin/nodes/:nodeId`)

- `NodeTable` from `listNodes` (filters state, pool): name (mono) + "built-in" pill, state badge, cordoned
  badge, pool, labels (chips), arch, CPUs, memory, free disk, workers `activeWorkers / capacity`, DinD
  mode, version, last seen (relative), warnings: egress deny not applied (`info.egressDenyApplied ===
  false`), clock offset > 2 s.
- Navbar "Add node" → `NodeFormModal` (name slug, pool default `shared`, labels `KeyValueEditor` ≤ 32,
  `maxWorkers` optional) → `createNode` → `SecretRevealModal` showing the token **once** with copy, the
  `docker run` command and the compose snippet from `join` (each in a `CodeBlock` with copy), and the
  warning "This token is shown only now. A node sees everything about the scans placed on it; add only
  machines you trust like the master."
- Row actions (aria "Node actions"): Edit (`NodeFormModal` + cordon switch → `updateNode`), Show join
  command (`getNodeJoin`, token placeholder `${SCANTOR_NODE_TOKEN}`), Rotate token (`ConfirmModal` →
  `rotateNodeToken` → `SecretRevealModal`), Revoke token (`ConfirmModal`, "Its workers are rescheduled" →
  `revokeNodeToken`), Delete (`ConfirmModal` → `deleteNode`). Rotate, revoke and delete are disabled for
  the built-in node (tooltip "The built-in node's token is derived from SCANTOR_SECRET").
- Node detail: info `dl` (all `info` fields, instance version and start, lease), workers on the node
  (`listNodeWorkers`: scan link, role, state, processes, restarts), node events (`listNodeEvents`).

### 5.16 Users (`/admin/users`)

- `UserTable` from `listUsers` (search `q`): name, email, role badge (`admin` warning / `user` neutral
  soft), banned badge with reason, `canRunPrivileged`, `maxWorkers` (0 = unlimited), usage (active
  workers, tasks, scans), created. The caller's row says "(you)".
- Navbar "New user" → `UserFormModal` (`createUserBody`: email, name, password optional ≥ 8, role,
  `canRunPrivileged`, `maxWorkers`) → `createUser`.
- Row actions: Edit (`updateUser`), Set password (`setUserPassword`), Ban (`BanUserModal`: reason, "Also
  cancel all their scans" **checked by default**, with the hint "Unchecked, their running scans continue
  until they end" ([auth](auth.md) §5.7) → `banUser {reason, cancelScans}`), Unban (`unbanUser`), Delete (`ConfirmModal`
  typing the email → `deleteUser` → 202; the row shows the `userPurge` job progress via `getJob`). Demote,
  set password and delete are disabled on the caller's own row.

### 5.17 Account (`/account`)

Sections (`XxxSection`, each with its own loading, error and success state, loaded with
`Promise.allSettled` so one failure does not blank the page):

| Section | Content and operations |
|---|---|
| Profile | name → `updateAccount`; email → better-auth `changeEmail`; role and limits read-only (`canRunPrivileged`, `maxWorkers`) from `getAccount` |
| Password | with a password: change (`changePassword {currentPassword, newPassword, revokeOtherSessions}`); without: set (`setAccountPassword`); "Remove password" (two-step, only when `passkeyCount > 0`) → `removeAccountPassword`; `409 lastCredential` inline |
| Passkeys | shown when `passkeysEnabled`: list (`passkey.listUserPasskeys`: name, added, device type), rename (`updatePasskey`), remove (two-step, disabled for the last credential), add (`passkey.addPasskey {name}`, placeholder "e.g. MacBook Touch ID") |
| Sessions | `list-sessions` (device/user agent, IP, created, current marker), "Sign out other sessions" (`revoke-session` once per other session: `revoke-sessions` would also end the current one). better-auth lists sessions only for a session signed in within the last 24 h; older sessions see a hint to sign in again |
| Editor | editor state (`getEditor`), "Stop editor" (`stopEditor`) |

### 5.18 CLI & MCP access (`/account/access`)

- **API keys** (`ApiKeysSection`): table from `listApiKeys?configId=default` (name, prefix `start`,
  created, expires, last used, enabled); "Create key" (`createApiKeyBody`: name 1–32, expires in days
  1–365, default 90) → `createApiKey` → `SecretRevealModal` with the key shown once and three snippets
  filled with it and the instance URL:

  ```sh
  export SCANTOR_URL=https://scantor.example.com
  export SCANTOR_TOKEN=sk_scantor_…
  ```

  ```sh
  alias scantor='docker run --rm -i -v "$PWD:$PWD" -w "$PWD" -v /var/run/docker.sock:/var/run/docker.sock -e SCANTOR_URL -e SCANTOR_TOKEN --add-host host.docker.internal:host-gateway <cliImage>'
  ```

  ```sh
  claude mcp add --transport http scantor <mcpUrl> --header "Authorization: Bearer sk_scantor_…"
  ```

  (the MCP snippet only when `mcpUrl` is not null), plus a pointer to the docker shim `scantor.sh` and
  native binary download links, only when `version` is a release version: the release assets
  `https://github.com/lonetis/scantor/releases/download/v<version>/<asset>` with `<asset>` one of
  `scantor-darwin-arm64`, `scantor-darwin-amd64`, `scantor-linux-amd64`, `scantor-linux-arm64`,
  `scantor.sh` (the shim, its default tag set to the release) and `SHA256SUMS` ([development](development.md)
  §14). Delete is two-step → `deleteApiKey`. Editor keys
  (`configId=editor`) appear in a read-only "Managed by the editor" row.
- **MCP** (`McpAccessSection`, [mcp](mcp.md) §3.8): when `mcpUrl` is null, "MCP is disabled on this
  instance". Otherwise `mcpUrl` with copy and, when `features.mcpOAuth`, the OAuth command
  `claude mcp add --transport http scantor <mcpUrl>`, a generic client snippet
  `{"mcpServers": {"scantor": {"type": "http", "url": "<mcpUrl>"}}}` and a note that the access level is
  chosen on the consent screen. When `features.mcpOAuth` is false, only the API-key form
  (`--header "Authorization: Bearer $SCANTOR_TOKEN"`) is shown, with the note "OAuth for MCP clients needs
  an https public URL".
- **Authorized apps** (`OAuthAppsSection`): `listOAuthApps` (name, URI, scopes, authorized at) with
  two-step "Revoke" → `revokeOAuthApp`.

### 5.19 Git credentials (`/account/credentials`)

`CredentialsTable` from `listCredentials`: name, host, username, token `••••<last4>`, last used, created.
"New credential" → `CredentialFormModal` (`kind: gitToken`, name ≤ 64, host `host[:port]`, username
default `x-access-token`, token as password input) → `createCredential`; Edit (token optional: empty keeps
it) → `updateCredential`; Delete two-step → `deleteCredential`. Help text explains which host the token is
sent to (exact host match) and that tokens are never shown again.

### 5.20 Admin tools (`/admin/tools`)

- Tool cards from `getInstanceInfo.adminTools`: RabbitMQ management, mongo-express,
  RustFS console, Traefik dashboard. With Traefik (`adminTools.enabled`), "Open" navigates (new tab) to
  `/api/tools/session?target=<target>`, which sets the `scantor_tools` cookie and redirects. A browser that
  opens a tool host directly without a valid cookie is redirected by forwardAuth to the same route
  ([auth](auth.md) §11). Without Traefik (`url` null), cards show the bind-address hint ("Bound to
  SCANTOR_ADMIN_BIND_ADDRESS; use an SSH tunnel") and no button.
- Links: API reference (`/api/docs`), OpenAPI document (`/api/docs/openapi.json`), metrics
  (`/api/metrics`, Prometheus text).
- Health: `getHealth` components and alarms.
- Jobs: `listJobs` (all users; filters kind and state; failed jobs first): kind, subject, state, progress,
  attempts, error, created, finished.

## 6. JSON-Schema form renderer

`SchemaForm` renders a JSON Schema (draft 2020-12, the subset defined in [tasks](tasks.md)) as a form and
falls back to raw JSON wherever the schema leaves the renderable subset. It is used for task config, scan
config and analysis config (scan form, test-run panel, template estimate).

### 6.1 API

```vue
<SchemaForm
  v-model="state.taskConfig"              <!-- object; keys absent = "use default" -->
  :schema="description.schemas.taskConfig"
  name="taskConfig"                       <!-- UFormField name prefix, errors map to "taskConfig.<path>" -->
  :upload-paths="description.uploadPaths.taskConfig"
  :server-issues="issues"                 <!-- configInvalid issues for this config -->
/>
```

`SchemaForm` is a nested `UForm` (`nested`, `name`) whose `validate` prop runs a `@cfworker/json-schema`
`Validator` (draft `2020-12`, all errors reported; defaults are never filled; `discriminator` is an
annotation it ignores; the server is authoritative) and returns `FormError[]` with dot paths derived from
each error's `instanceLocation` (`#/headers/0` → `taskConfig.headers.0`). Validators are cached per
schema hash. The validator interprets the schema instead of generating code, so it runs under the
production CSP; ajv, which compiles validators with `new Function`, would need `'unsafe-eval'` (§13).

### 6.2 Widgets

| Schema | Widget |
|---|---|
| `type: object` with `properties` | field group; nested objects render as titled sub-sections (collapsible below depth 1); depth > 4 → JSON fallback |
| `type: object` with `additionalProperties: <primitive schema>` (map) | `KeyValueEditor` (keys validated by `propertyNames` if present) |
| `type: object` with `additionalProperties: true` (open map) | `JsonField` for that object |
| `type: string` | `UInput`; `format` `uri`, `email`, `date`, `date-time` choose the input type; `maxLength > 256` → `UTextarea`; `pattern`, `minLength`, `maxLength` via the validator |
| `type: string` + `writeOnly: true` | password `UInput` with a reveal button (aria "Show value"); never prefilled from server data; no default (describe drops it, [tasks](tasks.md) §6.5) |
| `type: string` (or nullable string) + `"x-scantor": "upload"` | `UploadField` (existing upload or upload a file; "None" for a nullable field) |
| `enum`, or `oneOf`/`anyOf` whose members are all `{const, title?}` | `USelect` with `title` labels; ≤ 4 options and required → radio group |
| discriminated union: `oneOf`/`anyOf` of object branches sharing a property with distinct `const` values ([tasks](tasks.md) §6.4) | `UnionField`: a select over the discriminator values (branch `title` as label), then the selected branch's fields; switching branches keeps only the discriminator |
| `const` | read-only text |
| `readOnly: true` | disabled input; the key is never sent |
| `deprecated: true` | "deprecated" badge next to the label |
| `type: integer` / `number` | `UInputNumber` with `min`/`max` from `minimum`/`maximum`, `step` from `multipleOf` (integers: step 1); exclusive bounds via the validator |
| `type: boolean` | `USwitch` |
| `type: array`, `items` with `enum` | `USelectMenu` multiple |
| `type: array`, `items` primitive | `ArrayField`: rows with add/remove (aria "Add item", "Remove item <n>"); `minItems`, `maxItems`, `uniqueItems` via the validator |
| `type: array`, `items` object | repeated object sub-sections (depth rule applies) |
| `type: [T, "null"]` or `anyOf: [T, {type: "null"}]` | widget for `T` plus a "null" checkbox |
| `$ref` to `#/$defs/…` | resolved inline; recursive references → JSON fallback |
| `default` | shown as placeholder and in the hint ("default: …"); a "Reset" button removes the key |
| `title`, `description`, `examples[0]` | label, hint, placeholder |
| `required` | required marker on the label |

This is the subset of [tasks](tasks.md) §6.4. Anything else (`allOf`, other `oneOf`/`anyOf` unions,
`if`/`then`/`else`, `not`, `patternProperties`, `prefixItems`, `dependentSchemas`, recursive refs, unknown
`type` combinations), for which describe emits a warning, renders `JsonField`: a mono `UTextarea` for that
subtree, parsed on blur and validated with the same validator.

### 6.3 Value semantics

- An untouched optional field is **absent** from the value, so the server's `useDefaults` fills it; the
  UI does not copy defaults into the value.
- Clearing a field removes the key; the "null" checkbox sends `null` explicitly.
- "Edit as JSON" (aria "Edit as JSON") switches the whole form to a JSON editor of the current value and
  back; switching back is blocked while the JSON is invalid (inline parse error).
- Analysis configs, results and config values from the API are masked (`"***"`) and are never fed back
  into forms.

### 6.4 Server issues

`422 configInvalid` returns `details.issues: [{path, message}]` with JSON pointers into the request body
(for example `/taskConfig/headers/0`, [api](api.md) §1.7). Each `SchemaForm` takes the issues under its own
`name`, converts the pointer to a dot path (`taskConfig.headers.0`) and shows the message on the matching
field, on the nearest rendered ancestor, or as a form-level alert when no field matches.

## 7. Composables

| Composable | Responsibility |
|---|---|
| `useAuth()` | better-auth client singleton (`passkeyClient`, `oauthProviderClient`), `session`, `user`, `isAdmin`, `signIn`, `signOut` (hard reload) |
| `useInstance()` | singleton: `getInstanceInfo` once per page load and `getSetupStatus`; exposes `features`, `limits`, URLs, `cliImage`, `version` |
| `useApiFetch(path, opts)` | `useFetch` with `$fetch: $api`, typed by `#shared/types`; `opts.toast` (default true) |
| `usePoll(fn, {intervalMs, enabled})` | polling with visibility pause, in-flight skip and error backoff (§9) |
| `useCursorList(fetchPage)` | generic `Load more` / infinite loading over `nextCursor` or `afterSeq`, with reset on filter change and an epoch guard against stale responses; `loading` covers the first page and "Load more", `refreshing` a re-read of the loaded pages (polls; the "Refresh" button spins on either) |
| `useSidebarCounts()` | singleton poll for the Scans and Nodes badges |
| `useScan(scanId)` / `useScanActions(scan)` | scan polling by state; action availability (`scanActions`) and calls with confirmations and toasts |
| `useTestRunStream(testRunId)` | `EventSource` lifecycle, event reducer, polling fallback |
| `useBuildLog(taskId, revision)` | incremental build-log reader (`afterLine`) |
| `useSchemaForm(schema)` | subset detection, validator cache (`@cfworker/json-schema`), error mapping |
| `useUiPrefs()` | versioned localStorage store (§14) |
| `useFollowScroll(container, lineCount)` | "Follow log" of `LogView` and `BuildLog`: scrolls to the end on mount and on new lines while following, pauses when scrolled up |
| `useCopy()` | `writeClipboard` (`utils/clipboard.ts`: the Clipboard API, then an `execCommand('copy')` fallback whose result is checked) + toast "Copied", or "Copy failed" when both refuse (VueUse's `useClipboard` never reports a refusal) |

## 8. Central fetch wrapper and errors

`plugins/api.ts` provides `$api(url, options)`, a typed function around `ofetch.create({credentials:
'same-origin', retry: 0})`, used by every composable (never raw `$fetch` or `fetch` for `/api`, except
`EventSource` and anchor downloads). It catches errors itself rather than using `onResponseError`,
because ofetch cannot replace the error it throws from a hook. `useApiFetch` is a small composable over
`$api` (not `useFetch`). Per-request options: `toast: false` and `background: true` (below).

- Sends `credentials: 'same-origin'`; browsers add `Origin` themselves (required for cookie mutations).
- Converts the envelope `{error: {code, message, details}}` into `ApiError {status, code, message,
  details, requestId}` (request id from `X-Request-Id`).
- `401` on any route except `/login`/`/setup`: hard navigation to `/login?redirect=<current path>`.
- `403 banned`: sign out and show "Your account is banned" on the login page.
- Other errors: a toast unless the request opted out (`toast: false`, used by forms and the query console
  that show errors inline). Toast: `color: 'error'`, `icon: 'i-lucide-circle-alert'`, title from
  `errorTitle(code)` (`app/utils/errors.ts`; for example `invalidState` "Not possible in the current
  state", `notFound` "Not found", `brokerAlarm` "The message broker is out of resources",
  `tooManyRequests` "Too many requests", `internal` "Unexpected server error"), description = message,
  and for 5xx a "Copy request id" action.
- Network failures (no response) show one deduplicated toast "Cannot reach the orchestrator" at most every
  10 s.
- Background polls (`background: true`, set by `usePoll`) never toast, not even for network failures;
  after 3 consecutive poll failures a page-level banner "Live updates paused, retrying…" appears and
  disappears on the next success.

Success feedback: toasts for asynchronous or off-page effects ("Scan paused", "Export ready"), no toast
when the page visibly changes.

## 9. Data freshness: polling and SSE

The UI polls with short requests. It does not use the API's `wait` long-poll (that is for CLI and MCP
clients, and browser tabs would consume the per-user `SCANTOR_MAX_CONCURRENT_WAITS` budget). The only
server push is the test-run SSE stream, the only streaming endpoint the API offers.

`usePoll` rules: built on `useIntervalFn` + `useDocumentVisibility`; paused while the tab is hidden and
refetched immediately when it becomes visible; skips a tick while the previous request is in flight;
doubles the interval after each failure up to 60 s and resets on success; one interval per singleton, not
per consumer; stops on unmount.

| Data | Interval | Condition |
|---|---|---|
| Scan (`getScan`) | 3 s | `creating`, `running`; 10 s `paused`; 15 s for 3 min after `completedAt` (final recount); then stop |
| In-flight (`listInflightAnalyses`) | 3 s | workers tab visible, scan `running` |
| Workers (`listScanWorkers`) | 5 s | workers tab visible, scan not terminal |
| Events (`listScanEvents`) | 10 s | events tab visible, first page only |
| Results table | 10 s | auto-refresh on, scan `running` |
| Retry-failed / user purge job (`getJob`) | 2 s | job `queued`/`running` |
| Exports (`getExport`) | 2 s | export `queued`/`running` |
| Scans list, overview | 10 s | page visible |
| Tasks list | 30 s | page visible |
| Task detail (`getTask`) | 10 s; 2 s while `latestRevision.state` is `queued`/`building` | page visible |
| Revision + build log | 1 s | `queued`/`building` until the log is `complete` |
| Test run | SSE (`streamTestRun`); fallback 2 s polling | until settled |
| Editor (`getEditor`) | 2 s while `starting`/`stopping`, otherwise 30 s | editor page |
| Nodes list, node detail | 10 s | page visible |
| Sidebar counts | 15 s | always (signed in) |

## 10. Theme and look

- Dark by default (`colorMode.preference: 'dark'`), user-switchable with `ThemeToggle`: a segmented
  control (system / light / dark) with aria-labels "Use system theme", "Use light theme", "Use dark theme";
  the choice persists in color-mode's own storage key `scantor-color-mode`.
- Colors: Nuxt UI tokens only (`primary` green, `neutral` slate); custom markup uses semantic classes
  (`bg-default`, `bg-elevated`, `bg-muted`, `text-muted`, `text-dimmed`, `border-default`) instead of raw
  `gray-*` classes, so a palette change is a single edit. Log and JSON viewers use CSS variables defined in
  `main.css` for both modes (agentor's GitHub palette).
- Density (agentor look): body `text-sm`, metadata `text-xs`, ids and hashes `font-mono text-xs` shortened
  to 8 characters with a copy button, small icon buttons (`size="xs"`, `color="neutral"`,
  `variant="ghost"`/`subtle`), uppercase micro section headers (`text-[10px] font-semibold uppercase
  tracking-wider text-dimmed`), `dl` key/value grids, subtle status badges (`variant="subtle" size="xs"`).
- Fonts: system stacks (`ui.fonts: false`): sans `ui-sans-serif, system-ui, …`, mono `ui-monospace,
  'JetBrains Mono', 'Cascadia Code', Menlo, monospace`.
- Status colors, icons and labels come only from `app/utils/status.ts`:

| Kind | State → color |
|---|---|
| scan | `creating` info · `running` success (pulsing dot, `motion-safe:animate-pulse`) · `paused` warning · `completed` primary · `failed` error · `cancelled` neutral · `deleting`/`deleted` neutral |
| scheduling | `pending` neutral · `running` info · `done` success · `retrying` warning · `failed` error |
| analysis | `pending` neutral · `retrying` warning · `succeeded` success · `failed` error · `lost` warning · `cancelled` neutral |
| revision | `queued` neutral · `building` info · `ready` success · `failed` error |
| test run | `queued` neutral · `building` info · `running` info · `completed` success · `failed` error · `cancelled` neutral |
| worker | `pending` warning · `assigned`/`pulling`/`starting` info · `running` success · `backoff` error · `draining` warning · `stopped` neutral · `lost` error |
| node | `pending` neutral · `online` success · `offline` error · `revoked` neutral; cordoned → extra warning badge |
| export / job | `queued` neutral · `running` info · `ready`/`succeeded` success · `failed` error · `cancelled` neutral |
| editor | `starting` info · `running` success · `stopping` warning · `stopped` neutral |
| condition severity | `info` info · `warning` warning · `error` error |

- Formatting (`app/utils/format.ts`): relative times ("3 min ago") with the absolute ISO time in a
  tooltip; durations `1h 02m`, `1m 23s`, `850 ms`; bytes in binary units (`1.5 GiB`); counts with
  `Intl.NumberFormat`; percentages with one decimal.

## 11. Accessibility and test hooks

The Playwright suite selects by role and accessible name ([testing](testing.md) §9); these rules are part
of the contract:

1. Every icon-only button has an `aria-label`; the same text is its tooltip. Buttons with visible text use
   that text as their name. No two buttons in the same region share a name (row actions include the row
   name, for example "Remove passkey MacBook").
2. Canonical names (tests depend on them): "Refresh", "Open navigation", "Collapse sidebar", "Use system
   theme", "Use light theme", "Use dark theme", "Sign in", "Sign in with passkey", "Sign out", "New task",
   "New scan", "Open in editor", "Publish revision", "Start scan", "Pull from git", "Download workspace",
   "Delete task", "Start test run", "Cancel test run", "Pause scan", "Resume scan", "Scale scan", "Cancel
   scan", "Retry failed analyses", "Restart scan", "Delete scan", "Export results", "Scan actions", "Run
   query", "Show worker logs", "Follow log", "Edit as JSON", "Show value", "Add item", "Copy to clipboard",
   "Add node", "Node actions", "Rotate token", "Revoke token", "Create key", "Stop editor", "Approve",
   "Deny"; radio labels on the consent page: "Read only", "Read and write", "Admin". Where the same
   control repeats within a region, the canonical name is followed by its context ("Add item to
   <field>", "Remove item <n> from <field>", "Show value of <field>", "User actions for <email>"), so
   tests match these names by their canonical prefix.
3. Non-interactive regions that tests assert on carry `data-testid`: `scan-progress`, `scan-stats`,
   `scan-health`, `condition-<type>`, `build-log`, `build-errors`, `test-run-log`, `analysis-slideover`,
   `secret-reveal`, `unpublished-badge`. Table rows carry `data-row-id="<id>"` (analyses:
   `data-row-id="<seq>"`); `UTable` cannot set row attributes, so `useTableRowIds` writes the attribute
   onto each rendered row.
4. Status badges always contain the state text (color is never the only signal). Pulsing indicators use
   `motion-safe:`.
5. Modals and slideovers have a title (`UModal`/`USlideover` `title` or an `aria-labelledby` heading),
   trap focus and return focus on close; `ConfirmModal`'s destructive button names the action ("Delete
   scan"), never just "OK".
6. Tables have an `aria-label`; sortable headers expose `aria-sort`.
7. No native `confirm()`/`prompt()`/`alert()`.

## 12. Icons

- Only lucide icons (`i-lucide-*`), from the locally installed `@iconify-json/lucide` collection.
- `icon.clientBundle.scan` includes `app/**/*.{vue,ts}` so icons named in `.ts` files (navigation, status
  maps) are bundled; icon names are always literal strings (no `i-lucide-${name}`).
- `fallbackToApi: false`: the app never contacts `api.iconify.design`. The local icon endpoint is moved
  out of `/api` to `/_icons` (public, static data, [api](api.md) §9) so the API auth middleware does not
  guard it.
- A UI test asserts that no request leaves the dashboard origin except to the S3 public origin (downloads,
  image previews) and the editor origin.

## 13. Security headers and CSP

**Required headers** on every dashboard response ([security](security.md) HDR-1 to HDR-3), set by the
`01.security-headers` server middleware. These are never relaxed:

| Header | Value |
|---|---|
| `Content-Security-Policy` | at least `frame-ancestors 'self'; object-src 'none'; base-uri 'self'`; `frame-ancestors 'none'` on `/login`, `/setup` and `/oauth/consent` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `same-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)` |
| `Strict-Transport-Security` | `max-age=31536000` when `SCANTOR_PUBLIC_URL` is https |
| `Cache-Control` | `no-store` on `/login`, `/setup`, `/oauth/consent` and every `/api/*` response |

The values that do not depend on configuration are repeated in `routeRules` (`nuxt.config.ts`), because
Nitro serves public assets before server middleware runs.

**Full policy.** The middleware extends the CSP with defence-in-depth directives. They depend on runtime
origins (`SCANTOR_EDITOR_URL`, `SCANTOR_S3_PUBLIC_URL`), so the policy is built once at boot (option 1
below adds a per-response value):

```
default-src 'self';
script-src 'self' <inline-script allowance>;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: <S3 public origin>;
font-src 'self' data:;
connect-src 'self';
frame-src <editor origin>;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self'
```

`<inline-script allowance>` admits the inline scripts of the Nuxt SPA shell. The implementation uses the
first option that works reliably in Nuxt 4 SPA mode, as verified by `ui/headers.spec.ts` (no CSP
violation on any page):

1. a per-request nonce, added to the shell's inline scripts by a Nitro `render:html` hook
   (`server/plugins/csp.ts`) and to the header for that response;
2. SHA-256 hashes of the shell's inline scripts, computed by the same hook from the rendered shell
   (constant per deployment);
3. `'unsafe-inline'`, in `script-src` only.

CSP must never break the app. A defence-in-depth directive that blocks something the UI needs is relaxed,
and the reason is recorded in this section; the required headers stay. `script-src` never contains
`'unsafe-eval'` in production, which is why the browser JSON-Schema validator is `@cfworker/json-schema`
rather than ajv (§6.1); only the development server (`nuxt dev`) adds `'unsafe-eval'` and
`'unsafe-inline'` for Vite. `/api/docs` (Nitro's Scalar UI) is
the only exception to `script-src`/`style-src`/`font-src`: it additionally allows the pinned Scalar bundle's CDN
origin and the font origin that bundle loads from (`https://fonts.scalar.com`). The editor host has its own headers ([editor](editor.md) §8.8).

Rendering rules that keep untrusted content harmless: no `v-html` anywhere (lint
rule `vue/no-v-html` as an error), logs are ANSI-stripped text, JSON is rendered by `JsonView` as text,
result strings are never linkified, file downloads use presigned URLs with forced
`Content-Disposition`/`Content-Type` ([architecture](architecture.md) §11.5).

## 14. Local UI state

- One localStorage key `scantor-ui` holding `{v: 1, …}`, managed by `useUiPrefs()` (module singleton,
  defensive parse and sanitize, unknown versions discarded, writes debounced 500 ms, flushed on
  `beforeunload`). Every read and write is wrapped in `try/catch`; the UI works with storage unavailable.
- Sidebar size and collapse are stored by `UDashboardGroup` (`storage="local"`,
  `storage-key="scantor-dashboard"`); the color mode by color-mode (`scantor-color-mode`).
- Contents of `scantor-ui`:

| Key | Content | Bound |
|---|---|---|
| `tables.<tableId>` | column visibility and page size | – |
| `resultColumns.<taskId>` | chosen result columns | 200 tasks, LRU |
| `queries.<scanId>` | recent query console inputs | 20 per scan, 50 scans, LRU |
| `testRunDrafts.<taskId>` | last test-run inputs **without** `writeOnly` fields | 50 tasks, LRU |
| `filters.<page>` | last list filters (state, language, "Only mine") | – |

- Never stored: tokens, API keys, node tokens, passwords, `writeOnly` values, results. The only exception
  is the setup token, which stays in `sessionStorage` during setup and is removed afterwards (§5.2).
- Server-side state (who is signed in, scans, results) is always re-read from the API.

## 15. Decisions

1. **Ids in routes** (`/tasks/:taskId`, `/scans/:scanId`): names resolve only among the caller's tasks,
   ids work for admins too.
2. **Cursor lists use "Load more"/infinite scroll**, no `UPagination`, because every list API is
   cursor-based.
3. **Short polling everywhere except test runs (SSE)**; the UI does not use `wait` long-polls.
4. **Background exports only** in the UI (`exportScan`), never `exportScanInline`.
5. **JSON-Schema forms validate with `@cfworker/json-schema` in the browser** through `UForm`'s
   `validate` prop (an interpreter: no `'unsafe-eval'` in the production CSP; the server's ajv stays
   authoritative); static forms use zod schemas shared with the server (`#shared/schemas`).
6. **Results table projects fields** (`fields=…`) and loads full analyses only in the slideover.
7. **CSP is set by the `01.security-headers` middleware** from env-derived origins. The static
   headers and `frame-ancestors`, `object-src 'none'` and `base-uri 'self'` are required; the inline SPA
   scripts are admitted by a nonce only if that works reliably in Nuxt 4 SPA mode, otherwise by hashes or
   a minimal `'unsafe-inline'` (§13). CSP never breaks the app.
8. **`@nuxt/fonts` disabled** (`ui.fonts: false`) and the icon endpoint moved to `/_icons` with
   `fallbackToApi: false`: the UI makes no third-party requests at build or run time.
9. **The editor is embedded as an iframe of the separate editor origin** on `/editor`, plus "Open in new
   tab"; every load uses a fresh one-time session URL.
10. **The UI never edits task files itself**; editing happens in the editor, over MCP or with the CLI.

## 16. Backbone dependencies

Adopted in [api](api.md): `getInstanceInfo.cliImage` (`<SCANTOR_IMAGE_PREFIX>scantor:<tag>`, where the
tag is the orchestrator version when it is a release version `X.Y.Z`, otherwise `SCANTOR_IMAGE_TAG`; the
same rule as `NodeJoin`, [api](api.md) §4.1), `features.mcpOAuth`, and for admins
`adminTools {enabled, items: [{target, title, url}]}`; `ScanSummary.userId`; the admin operations
`listNodeWorkers` (`GET /api/nodes/{nodeId}/workers`) and `listNodeEvents`
(`GET /api/nodes/{nodeId}/events`); `/_icons/*` as a public non-API route ([api](api.md) §9); `getEditor`
returns `error` (the last start failure, `editors.error`, [data model](data-model.md) §4.15), which §5.10
renders ([api](api.md) §4.18).

## 17. Future extensions

| Extension | How the design accommodates it |
|---|---|
| Live scan stream (SSE per scan from change streams) | `useScan` hides the transport; `usePoll` callers switch to an `EventSource` reducer like `useTestRunStream` without page changes. |
| Command palette (`UDashboardSearch`) | navigation items are data in `utils/navigation.ts`; tasks are searchable through `listTasks?q`. |
| Cron / recurring scans | a "Schedules" sidebar item and pages reusing `NewScanForm` (it already produces a `StartScan` body). |
| Scan priorities | one more field in the "Advanced settings" section, driven by `ScanSettings`. |
| Multi-arch revisions | revision facts render `image.platform` as a list; the picker filters nothing today. |
| Organisations / shared tasks | "Only mine" generalises to an owner filter; ownership display already exists for admins. |
| In-browser file edits | `writeTaskFiles`/`deleteTaskFile` exist; a Monaco-free inline editor could reuse `TaskFilesBrowser`. |
| Prometheus/Grafana | the admin tools card list is data from `adminTools`. |
| Per-user node-pool allowances | the node selector field becomes a select of allowed pools. |
| Notifications / webhooks | toasts already map event-like outcomes; a notifications page would read `events`. |
| Additional languages and templates | wizard cards come from `listLanguages`, `listScaffolds` and `listTemplates`; no UI change. |
