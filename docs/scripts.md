# Scripts

This document is the authoritative specification of scripts and script runs as implemented: the script folder
and its manifest, the scaffold, the script pipeline, the start checks, the run lifecycle (build, container,
adoption, cancellation, timeout, garbage collection, deletion cascades), the run log, outputs, the script runtime
API the container calls, the injected runtime's script mode and the Python SDK. The backbone documents carry the
summaries: glossary, components and flow in [architecture](architecture.md) §2, §4 and §11.7, collections in
[data model](data-model.md) §4.18–§4.20, routes and representations in [api](api.md) §2 and §4.19–§4.22, the
principal in [auth](auth.md) §10.5, threats in [security](security.md) §6.20. When this document and a backbone
document disagree, the backbone wins and this document is fixed.

## 1. Concept

A **script** is a user-owned Python folder in the workspace (`<userId>/.scripts/<name>/`) with a manifest
`scantor-script.yaml`, a `Dockerfile` (`FROM ${SCANTOR_BASE}`) and an entry file (default `main.py`) that defines
`script = scantor.script.Script(run=…)`. It evaluates the results and files of the owner's scans **on the
master**. Scripts have no revisions: editing is instant, and a **script run** executes the code the folder held
when the run was started.

A run snapshots the folder into S3, builds it into a local image `scripts/<scriptId>:<packSha256>` (never pushed,
no registry), and runs one container `scantor-s-<scriptRunId>` on the master. The container reaches only the
orchestrator and the internal S3 endpoint over the internal network `scantor-scripts`; it reads the typed analyses
and stored files of 1–20 selected scans through the **script runtime API** (`/api/script-runtime/*`) with a
run-scoped token (`ssr_…`), reports progress, saves checkpoints, stores output files and ends `completed` (with an
optional JSON result) or `failed`. Runs can last days, survive orchestrator restarts (the next claim adopts the
running container), and can be restarted with `resume` to continue from the original's checkpoint and outputs.

```
 create / upload ─► <userId>/.scripts/<name>/ ─► startScriptRun ─► snapshot (S3) ─► scriptRun job
       ▲ editor / MCP file tools / CLI push             │                               │
       └──────────────── edit (instant) ◄──────────────┘     build scripts/<id>:<pack> ◄┘
                                                                 │
                                    scantor-s-<runId> (network scantor-scripts) ──► /api/script-runtime/*
                                                                 │                    (ssr_ token)
                                     completed │ failed │ cancelled ◄── exit code, reported outcome
```

Terms (binding, [architecture](architecture.md) §2.5): script, script manifest, script run, script runtime API,
script-run token, output, checkpoint. "Run" alone stays reserved for the task operation `run`; a script run is never
called a job or an execution, an output never an artifact.

## 2. Script folder and manifest

### 2.1 Location and names

- Folder `<userId>/.scripts/<scriptName>/` in the volume `scantor-workspaces`. The leading dot fails the task-name
  rule, so `.scripts` never collides with a task folder; it is visible in the editor (not in `files.exclude`).
- One mapping turns (kind, name) into a folder: Go `internal/workspace/folder.go` (`Folder{Kind, Name}`, `Rel()` →
  `<name>` or `.scripts/<name>`, every path component `lstat`-checked and opened through `os.Root`; `.scripts` is
  created without following symlinks) and its TS twin `workspaceFolderPath(kind, name)` in
  `server/services/editor/open.ts`. Helper operations take `--task <name>` or `--script <name>` (exactly one).
- Names follow the task-name rules unchanged (TS `shared/utils/slug.ts`, Go `workspace.ValidateTaskName` shared
  through `ValidateScriptName`): a slug of 1–64 characters, not uuid-shaped, not `upload`, `import-git`, `new`,
  `latest`. A name is unique per owner among scripts (`{userId, name}` unique index); a task and a script may share
  a name because their folders differ. Names are immutable (rule S6).
- Caps: the workspace cap `SCANTOR_WORKSPACE_MAX_BYTES` covers script folders; per-folder caps reuse
  `SCANTOR_TASK_MAX_FILES`, `SCANTOR_TASK_MAX_BYTES` and `SCANTOR_TASK_MAX_PACK_BYTES`.
- Required files: `scantor-script.yaml`, `Dockerfile` and the entry. Extra files are allowed.

### 2.2 Manifest `scantor-script.yaml`

Schema `schemas/script-manifest.schema.json` (draft 2020-12, `additionalProperties: false`, embedded in the binary
and shipped in the editor image at `/opt/scantor/schemas/script-manifest.schema.json`, bound to
`scantor-script.yaml` by `editor/machine-settings.json`).

| Field | Rule |
|---|---|
| `scantor` | const `1` |
| `name` | the task manifest's slug pattern and reserved words |
| `language` | string; must be a `schemas/languages.json` row with a `script` object (rule S3) |
| `description` | optional, ≤ 1024 characters |
| `entry` | optional; the task manifest's entry constraints; default `script.entry` of the language row |
| `defaults.timeoutMs` | optional integer ≥ 1000: total duration of a run, counted from its start |
| `defaults.resources.cpus` | optional number, 0.1–64 (the task manifest's bounds); fallback 1 |
| `defaults.resources.memoryMiB` | optional integer, 256–65536; fallback 1024 |

The fallbacks are `default` annotations of the schema, equal to Go `manifest.ScriptDefaultCPUs` and
`ScriptDefaultMemoryMiB` (a test keeps them in sync). Every default can be overridden per run and is capped by the
instance limits (§5).

### 2.3 Checks S1–S6

`manifest.CheckScript(data, Options{ExpectName, Languages, IsRegularFile})` (Go `internal/manifest/script.go`) shares
the parsing and entry code of the task checker (`Limits` and `AllowPrivileged` do not apply). It returns every issue
of the first failing step (S1, then S2, then S3–S6 together); each issue is a BuildError of phase `static` with
file `scantor-script.yaml`.

| Rule | Check |
|---|---|
| S1 | size bound (`manifest.MaxBytes`, read with `MaxBytes+1`) and YAML parsing, like M1 |
| S2 | strict schema validation against `schemas/script-manifest.schema.json`, like M2 |
| S3 | `language` is a languages.json row with a `script` object (`go does not support scripts; scripts can be written in python`) |
| S4 | source languages: the entry is relative, normalised, has one of the language's extensions and exists in the pack as a regular file, like M4 ([tasks](tasks.md) §3.2) |
| S5 | binary languages: the entry is a normalised path, like M5 |
| S6 | `name` equals `ExpectName` (the script's name; script names are immutable) |

A folder without the manifest gets one message naming `scantor-script.yaml`: absent, not a regular file, a
`scantor-script.yml` rename hint, or "this folder has a task manifest (scantor.yaml); every script needs
scantor-script.yaml at its root". Helper `extract --kind script` and the script pipeline's static step run these
checks; `extract` names `scantor-script.yaml` in its `manifestInvalid` errors.

### 2.4 Language table and base image

- `schemas/languages.json`: the python row carries `"script": {"entry": "main.py", "scaffold":
  "scaffolds/python-script", "guide": "docs/guide/scripts.md"}`. The object is optional; when present all three fields
  are required and `script.entry` must have one of the language's extensions (Go `internal/languages`:
  `Language.Script`, `SupportsScripts()`, `Table.WithScripts()`; TS `scriptLanguageNames()` in
  `server/services/catalog/languages.ts`). `createScript` takes the first row with a `script` object, so there is no
  language switch anywhere.
- Base image ENV contract ([tasks](tasks.md) §4.2): `SCANTOR_SCRIPT_CMD="python -m scantor.script {entry}"` in
  `connectors/python/Dockerfile`. A base image without it cannot run scripts (the runtime exits 2, §10). `WORKDIR`
  stays `/task`; the script scaffold's Dockerfile does not set one.
- Pack: the task pack code unchanged ([tasks](tasks.md) §9.2); `scantor-script.yaml` is in the one global
  `forcedIncludes` set (`internal/taskpipe/pack.go`), so `.dockerignore` can never drop it.
- Dockerfile policy: the task policy unchanged, plus D5 forbids repository paths starting with `scripts/` exactly
  like `tasks/` ([tasks](tasks.md) §8.2), so no build can pull another user's script image.

## 3. Scaffold

`scaffolds/python-script/files/` is rendered by the existing scaffold renderer (`[[ ]]` delimiters, `*.tmpl`
files) through helper `scaffold --script <name> --language <language> [--description …]` (`createScript`) and
`scantor scripts init` (`workspace.RenderScriptInto`, local). There is no template choice.

| File | Content |
|---|---|
| `scantor-script.yaml` | `scantor: 1`, name, language, description, a schema modeline |
| `Dockerfile` | exactly the Python task scaffold's: `ARG SCANTOR_BASE`, `FROM ${SCANTOR_BASE}`, `COPY requirements.txt .`, `RUN pip install --no-cache-dir -r requirements.txt`, `COPY . .` |
| `.dockerignore`, `.gitignore`, `requirements.txt` (comment only), `pyrightconfig.json` | as in the task scaffold |
| `models.py` | where to paste the evaluated task's `Result` model, with a placeholder model |
| `main.py` | a working example: streams the first scan's succeeded analyses through `ctx.map(..., processes=ctx.cpus, ordered=True)` (in input order, so the rows written and the counters match the checkpointed watermark), counts them, reports progress, writes a CSV with `ctx.outputs.open`, checkpoints and returns a summary; a run restarted with resume continues after the checkpoint and first copies the CSV (or `.partial`) of the run it resumes |
| `AGENTS.md` | instructions for coding agents in the editor |

`scaffolds/python-script` is not a language row's `scaffold`, so it has its own tests (Go
`internal/workspace/script_test.go`; Python `connectors/python/tests/test_script_scaffold.py` renders it, lints
and type-checks it and runs it against the fake platform, once from the start and once resumed).

## 4. Script pipeline

`scantor script build <dir|tgz|-> --tag <ref> --expect-name <name> [--reuse-existing] [--events ndjson|text]`
(hidden; `internal/cli/script_build.go`, `(*taskpipe.Pipeline).BuildScript`). It shares pack, the static step and the
build with `scantor task build` and runs **pack → static → build** only: no describe, no type check, no push, no
runtime resolver.

- Static: `taskpipe.CheckScriptStatic` reads `scantor-script.yaml` (§2.3), requires the `Dockerfile` and the
  entry, and runs the unchanged `dockerfile.Check` (D1–D11, [tasks](tasks.md) §8.2).
- Build: the base image of the manifest's language is pulled when absent or outdated and pinned by digest
  ([tasks](tasks.md) §9.4); `--reuse-existing` skips the build when the tag exists and was built on that base image;
  the image passes the size cap and the inherited-label check (LBL-3); BuildKit's cache is pruned to
  `SCANTOR_BUILD_CACHE_MAX_BYTES` like every build.
- `--expect-name` is required (rule S6). Phases are `pack`, `static`, `build`; the NDJSON event framing and the exit
  codes are those of `task build` (0 success, 2 content error, 3 platform error). An interrupt after a successful
  build adds no error, because no phase follows.
- Environment: the task pipeline's (the `SCANTOR_TASK_MAX_*` caps, `SCANTOR_BUILD_TIMEOUT`,
  `SCANTOR_MAX_IMAGE_BYTES`, `SCANTOR_BUILD_CACHE_MAX_BYTES`, `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG`,
  `SCANTOR_PUBLIC_URL`, `SCANTOR_REGISTRY_PUBLIC_HOST`); no push password.
- The final event's `result`:

```json
{
  "ok": true,
  "pack": { "packSha256": "9c0d…", "packBytes": 2211, "fileCount": 7, "bytes": 6123 },
  "manifest": { "scantor": 1, "name": "csp-stats", "language": "python", "entry": "main.py", "defaults": {} },
  "entry": "main.py",
  "defaults": { "timeoutMs": null, "resources": { "cpus": 1, "memoryMiB": 1024 } },
  "baseImage": { "ref": "ghcr.io/lonetis/scantor-base-python:1.4.0", "digest": "sha256:0d1e…" },
  "image": { "ref": "scripts/5b1d…:9c0d…", "id": "sha256:77ab…", "bytes": 201234567, "platform": { "os": "linux", "arch": "amd64" } },
  "errors": [],
  "warnings": [],
  "durationsMs": { "pack": 12, "static": 4, "build": 21877 }
}
```

`defaults` is the normalised manifest `defaults` (Go `manifest.ScriptDefaults`): `timeoutMs` null means "the
instance limit"; the resources carry the fallbacks. The orchestrator drives the command as a subprocess
(`server/services/pipeline/script-build.ts`, `runScriptBuild` on the generic `runPipelineCommand` that task builds
use too) and never uses dockerode for builds.

## 5. Starting a run

`startScriptRun` and `restartScriptRun` (`server/services/script-runs/start.ts`) check synchronously, in this order:

1. **Script**: resolved by the route (`resolveScript`: id, or name among the caller's own scripts; a script being
   deleted is 404). The run's owner is always `script.userId`, also when an admin starts it.
2. **Scans**: ids deduplicated in request order (1–20); `scans.find({_id: {$in}, userId: script.userId, state ∉
   {deleting, deleted}})` (`loadScansForScriptRun`); any missing or foreign id is 404 `notFound`. `loadOwnedScan`
   is never used here, so an admin cannot bind another user's scan to a run. A non-terminal scan is allowed: the
   run reads a moving target, and the build writes one `system` log line per such scan.
3. **Config** a JSON object of at most `SCANTOR_MAX_SCAN_CONFIG_BYTES` (413 `payloadTooLarge`); **settings** within
   the instance caps (400 `validationFailed`, `details.issues` at `/settings/…`): `timeoutMs ≤
   SCANTOR_SCRIPT_RUN_TIMEOUT`, `cpus ≤ SCANTOR_SCRIPT_RUN_MAX_CPUS`, `memoryMiB · MiB ≤
   SCANTOR_SCRIPT_RUN_MAX_MEMORY`. The request schema also bounds secrets (≤ 32, names `^[A-Z][A-Z0-9_]{0,63}$`,
   values ≤ 8 KiB) and the static setting ranges (400).
4. **Snapshot now**, like a revision publish: helper `snapshot --script <name>` streams the pack into a temporary
   S3 object (`snapshotToTmp`, the helper hash verified); it is promoted to `script-runs/<runId>/source.tar.gz`
   only after steps 5 and 6 passed, and discarded on any refusal. Its summary refreshes the script's `workspace`
   cache (a failed refresh is only logged), so `workspace.packSha256` names the content this run builds.
5. **Config schema**: when `script.describe.packSha256` equals the snapshot's pack hash and a `configSchema` exists,
   the config is validated with ajv (`useDefaults`) → 422 `configInvalid` with `details.issues`. Otherwise it is
   stored as given (the SDK validates it in the container, §11).
6. **MCP confirmation**: an MCP principal (`via === 'mcp'`) without `settings.limit` and without `confirm: true` →
   422 `confirmationRequired` with `details {scans: [{id, name, analyses}], packSha256}` (`analyses` = the scan's
   status-count total). The agent asks the user and repeats with `confirm: true` ([security](security.md) MCP-3, [mcp](mcp.md) §7).
7. **Insert** the run `queued` (secrets sealed for this run, §9.6), then `scripts.latestRun`, then its `scriptRun`
   job: the pointer exists before the job's first state change. A failed job insert deletes the run again and moves
   a pointer that still names it back to the newest remaining run. A deletion that began meanwhile (the script got
   `deletingAt`) cancels the new run at once and answers 404.

The route reserves its `wait` slot before step 1 (429 `tooManyRequests` means nothing was created) and, with
`?wait`, returns once the run is terminal ([api](api.md) §1.9).

**Restart** (`restartScriptRun`) creates a new run of the script's **current** folder with the original's scans,
config, secrets (unsealed and sealed again with the new run's AAD) and settings; `config` and each setting can be
overridden (`settings.limit: null` removes a limit). The original's settings are the merged effective settings once
it was built, so a changed manifest default does not reach the restart. `resume: true` requires a terminal original
(409 `invalidState`); every restart records `restartedFrom {id, resume}`, and only `resume: true` hands the
original's checkpoint and stored outputs to the new run's bootstrap. The script must still exist and not be being
deleted (404). Steps 2–7 apply unchanged.

## 6. Run lifecycle

### 6.1 States

```
 queued ──► building ──► running ──► completed     (exit 0)
   │           │            ├──────► failed        (build/config errors, reported error, crash, OOM, timeout, platform)
   └───────────┴────────────┴──────► cancelled     (cancelScriptRun, scan or script deletion, lockout, purge)
```

`queued`, `building` and `running` are active; `completed`, `failed`, `cancelled` are terminal and final. Every
transition is one conditional update on the expected state(s); the terminal update also sets `finishedAt` and
`expiresAt` (`finishedAt + SCANTOR_SCRIPT_RUN_RETENTION_DAYS` days, null when the variable is 0) and refreshes the
script's `latestRun` pointer (only while the run is still the script's newest). `completed` and `failed` write the
events `scriptRun.completed` (info) and `scriptRun.failed` (error) through `writeEvent`, so push notifications see
them; a cancelled run writes none.

### 6.2 The `scriptRun` job

Job kind `scriptRun` (`server/services/script-runs/job.ts`): component `api`, concurrency
`SCANTOR_SCRIPT_RUN_CONCURRENCY` per orchestrator process, per-user concurrency
`SCANTOR_SCRIPT_RUN_CONCURRENCY_PER_USER`, `maxAttempts: 10`, backoff 5 s … 30 s, no `onRequeued`,
`refundAttemptOnStop: true`, and `onFailed` → the run fails with a `platform` error, pending outputs are aborted and
the container is removed by id (`failScriptRun`).

`refundAttemptOnStop` is a jobs-runner option (`JobKindDefinition`, `services/jobs/runner.ts`): when the runner
requeues its jobs at an orchestrator stop, it writes `attempts: max(0, attempts − 1)`, so restarts of the
orchestrator during a days-long run never use up its attempts.

The handler is resumable: each claim loads the run and continues where it is. A missing run is a fatal job error;
a terminal run only gets a recorded container removed. Otherwise one `ScriptRunExecution` resumes the log writer
(§7) and runs the phases below.

### 6.3 Phase build (state `building`)

1. `queued|building → building`. On the first transition the run logs a `system` line for every scan that is not
   terminal yet.
2. When `image.id` and `entry` are recorded and the image still exists locally, the build is skipped.
3. Otherwise `ref = scripts/<scriptId>:<packSha256>`; `image.cached` records whether that tag already existed. Under a
   build slot (`useBuildSlots()`, shared with revision and test-run builds, `SCANTOR_BUILD_CONCURRENCY`, FIFO) the
   stored `source.tar.gz` streams from S3 into `scantor script build - --tag <ref> --expect-name <scriptName>
   --reuse-existing --events ndjson` with the pipeline environment and a wall-clock bound of
   `SCANTOR_BUILD_TIMEOUT` plus 5 minutes. Build `log` events become `build` log lines; `error` events become
   `build` lines `error (<phase>): <file>:<line>: <message>`.
4. A failed build ends the run `failed` with `errors[]` (BuildErrors of phases `pack`, `static`, `build`); `error`
   stays null unless a `platform` error is among them. A driver timeout or a missing result is a `platform`
   failure.
5. **Settings merge**: explicit > manifest `defaults` > `SCANTOR_SCRIPT_RUN_TIMEOUT` for the timeout, and explicit
   > manifest > the fallbacks (1 CPU, 1024 MiB) for the resources. The caps of §5 step 3 are checked again; a manifest
   default above a cap fails the run with BuildErrors of phase `config`, file `scantor-script.yaml`
   (`defaults.timeoutMs must be at most …`).
6. `building` conditional update records `image {ref, id, cached}`, `entry` and the merged `input.settings`. Then this
   script's other images `scripts/<scriptId>:*` that no active run uses are removed (an image still used by a
   container, 409, is left for the GC).

### 6.4 Phase start

The container `scantor-s-<scriptRunId>` (`server/services/script-runs/container.ts`):

| Setting | Value |
|---|---|
| Image | the built image by id |
| Entrypoint | `/scantor/scantor runtime script --entry <entry>`, `Cmd` empty |
| Env | `SCANTOR_URL=<SCANTOR_INTERNAL_URL>`, `SCANTOR_SCRIPT_TOKEN=<ssr_ token>`; nothing else |
| Network | `scantor-scripts` only |
| Capabilities | `CapDrop: [ALL]`, `CapAdd: []` (never `SCANTOR_WORKER_CAP_ADD`), never privileged, `no-new-privileges` |
| Process | `Init: true`, `PidsLimit 4096`, `nofile` 65536, `OomScoreAdj 1000` (the OOM killer's first choice) |
| Resources | `Memory = MemorySwap = memoryMiB MiB + 256 MiB`, `NanoCpus = cpus · 1e9` |
| Log | driver `local`, `max-size 50m`, `max-file 5` (the follower resumes from it after an orchestrator restart) |
| Lifecycle | `RestartPolicy no`, `AutoRemove false`, no mounts, no published ports |
| Health | `RUNTIME_HEALTHCHECK` (`scantor runtime healthcheck` against the heartbeat, informational) |
| Labels | managed labels of kind `scriptRun` with `scantor.user` and `scantor.script-run` |

1. Create the container. On a 409 name conflict the existing container is inspected by name and used only when it
   carries the managed labels, the `scantor-s-` prefix and `scantor.script-run=<runId>`
   (`isManagedContainer(…, identity)`); otherwise the run fails (`platform`). A started one is adopted; one still in
   `created` is removed by id and created again. Nothing is ever removed by name without that label check.
2. Inject the runtime: one tar (`scantor/` and `scantor/scantor`, 0755, owner 0:0) copied with `putArchive` to `/`.
3. **One conditional update before the start**: `{state: 'building'} → {state: 'running', container {id, name,
   createdAt}, startedAt (kept when already set)}`. The token is valid only while the run is `running`, so the script
   can authenticate from its first instruction. A recreate (§6.5) accepts `running` instead.
4. Start. A failure here or in steps 1–2 removes the container by id and fails the run (`platform`).

### 6.5 Phase run, adoption and timeout

Supervision inspects the recorded container **by id**:

| Container | Action |
|---|---|
| missing | `failed` `{type: 'crash', message: 'the script-run container disappeared'}` |
| `created` (never started) | removed by id and recreated (phase start with state `running`) |
| `exited`, `dead` | drain the remaining log lines, read `ExitCode` and `OOMKilled`, finish |
| `running` (and others) | follow the log from the cursor (§7.3), wait for the exit, enforce the timeout |

The same table serves the first claim and every later one: a claim after an orchestrator restart **adopts** the
container and continues to follow its log without duplicates. Waiting uses Docker's `wait` with condition
`not-running`; a broken wait (a Docker daemon restart) is retried every 5 s while the container still runs.

The timeout is total and counted from `startedAt`: at `startedAt + settings.timeoutMs` the run logs a `system`
line and stops the container with `docker stop -t 60` (the runtime forwards SIGTERM and kills the script 50 s
later, §10), which ends the run `failed` `{type: 'timeout'}`. Timers re-arm above 2³¹ ms.

### 6.6 Phase finish

1. A `system` line: `the script exited with code N` or `the script was killed: out of memory`.
2. The pending progress and checkpoint of this process are written (`flushScriptRunState`), then outputs still
   `pending` are aborted (`AbortMultipartUpload`, dropped from the run).
3. The outcome:

| Exit | State | `error` |
|---|---|---|
| timeout (§6.5) | `failed` | `{type: 'timeout', message: 'the script run exceeded its timeout of <d>'}` |
| `OOMKilled` | `failed` | `{type: 'crash', message: 'killed: out of memory'}` |
| code 0 | `completed` | null (a reported error is cleared; the result stays) |
| code ≠ 0 | `failed` | the error the script reported through `scriptRuntimeFinish` (`scriptError`, `validation`), else `{type: 'crash', message: 'exited with code N', stack: <last 20 stderr lines, masked like the log (§7.1) before they are cut to ≤ 8 KiB>}` |

4. The terminal conditional update (`state`, `error`, `exitCode`, `finishedAt`, `expiresAt`) on any active state,
   the `latestRun` pointer, the event; when the run was already terminal (a cancel won the race) only a missing
   `exitCode` is filled in. Finally the container is removed by id.

### 6.7 Detach, cancel and lost leases

Every execution listens to the job's abort signal and to an in-process cancellation signal of its run
(`server/services/script-runs/live.ts`). When either fires, or a conditional update finds the run no longer
active, the execution decides:

- **Cancelled**: the in-process cancellation fired, or the reloaded run is `cancelled` or gone. The container is
  stopped (`docker stop -t 60`), its last log lines are drained, its exit code is recorded when none is, a `system`
  line `the script run was cancelled` is written, pending progress, checkpoint and outputs are settled, and the
  container is removed by id.
- **Detach**: anything else, an orchestrator stop (the runner aborts its jobs at the component stop), a lost lease
  (another runner owns the run now) or a run another runner settled. The execution stops following the log, flushes
  it and returns within the runner's stop grace; **the container keeps running** and the next claim adopts it
  (§6.5). An orchestrator stop requeues the job with its attempt refunded (§6.2).

`cancelScriptRun` (`queued`, `building`, `running` → `cancelled`; a cancelled run is returned unchanged; `completed`
or `failed` is 409 `invalidState`; `cancelScriptRunState` in `server/services/script-runs/cleanup.ts`):

- `queued` or `building` (no container yet): one conditional update to `cancelled` (with `finishedAt`, `expiresAt`); a
  queued job is cancelled with it, a running one notices and ends after its last log lines.
- `running`: a **cancel request** — `cancelRequest {at, reason}`, `finishedAt` and `expiresAt` are set while the
  document stays `running`. Every representation (`getScriptRun`, `latestRun`, `recentRuns`, lists) already reports
  `cancelled` with the request's error, but the run token, the checkpoint, `finish` and the completion of `.partial`
  outputs keep working while the job stops the container, and the GC leaves the container alone. The job is never
  cancelled: it stops the container, drains its log and then writes `cancelled` with exit code 143
  (`settleCancelRequest`); a script that exits by itself while a cancel is pending also ends `cancelled`. A
  `?wait` settles only then (so a run a wait returned can be resumed). `restartScriptRun` with `resume` waits up to
  30 s for a pending stop (the resumed run reads the `.partial` outputs and the last checkpoint stored during it) and
  answers 409 `invalidState` when it is still pending then. That wait holds one of the caller's
  `SCANTOR_MAX_CONCURRENT_WAITS` slots even without `?wait` (429 `tooManyRequests` before anything is created). The GC ends a pending cancel whose job does not run after
  2 minutes.

`requestCancellation` aborts the run's execution at once when this process runs it; a job in another process
notices within `CANCEL_POLL_MS` (5 s), when it re-reads the run. A run cancelled by a cascade carries `error {type:
'platform', message: <reason>}` (`a scan of the run was deleted`, `the script was deleted`, `the user was locked
out`, `the user was deleted`); a user's cancel leaves `error` null. Outputs stored before the cancel are kept; an
output open in `ctx.outputs.open` is completed as `<name>.partial` by the SDK when its SIGTERM handler runs (§11.5).

### 6.8 Garbage collection

`ScriptsGc` (`server/services/scripts/gc.ts`), the reconciler component task `scripts-gc` under the lease lock
`scriptsGc`: one sweep when the lease is acquired, then every 60 s.

| Step | Rule |
|---|---|
| hard limit | an active run past `startedAt + timeoutMs + 10 min` fails (`platform`, "the script run exceeded its timeout and no job stopped it") |
| pending cancels | a run with a `cancelRequest` whose `scriptRun` job is not running (queued behind other runs, or gone) ends `cancelled` 2 minutes after the request (`CANCEL_SETTLE_GRACE_MS`): container removed, pending outputs aborted, the queued job cancelled |
| stale runs | an active run without an active `scriptRun` job whose job ended (or, without a job, that was created) more than 5 minutes ago fails (`platform`, "the script run was interrupted; restart it"): container removed, pending outputs aborted. The run's own writes (progress, checkpoint) do not count as activity |
| orphan containers | containers with the managed labels of kind `scriptRun`, the prefix and a `scantor.script-run` label whose run is terminal or missing are removed by id |
| old images | local images matching `^scripts/<uuid>:<sha256 hex>$` older than `SCANTOR_DRAFT_IMAGE_RETENTION` that no active run uses are removed |
| expired runs | terminal runs with `expiresAt < now` (100 per sweep), except the original of an active run restarted with `resume` (its bootstrap handed out that run's checkpoint and outputs): S3 prefix `script-runs/<id>/`, log chunks, document, in that order; a `latestRun` pointer that named the run moves to the script's newest remaining run, or null |

Retention is this sweep, never a TTL index, because S3 objects and log chunks must go first.

### 6.9 Deletion cascades

| Trigger | Effect |
|---|---|
| `deleteScript` | `deletingAt` set at once (name lookups, starts, restarts and the editor no longer find the script), then job `scriptDelete` (reconciler, concurrency 2, cursor `{phase}`): **stop** (cancel active runs; defer 20 s after cancelling, re-check every 5 s while a `scriptRun` job of the script is active, via `JobDeferredError` so the wait holds no slot) → **runs** (S3 prefixes, log chunks, documents of terminal runs) → **images** `scripts/<scriptId>:*` → **workspace** (helper `delete-files --script <name> --path "" --recursive`) → **script** (a run inserted after the stop phase sends the job back to stop; then the document) |
| `deleteScan` | the first phase `scriptRuns` of `scanDelete` cancels active runs whose `scanIds` contain the scan; terminal runs keep the id (the scan's name disappears from their representation) |
| user lockout (ban, delete) | hook `cancelScriptRuns` (order 55) cancels the user's active runs, whether or not the admin chose `cancelScans`; token validation refuses a banned owner at once (§9.2) |
| user purge | step 15 `cancel-script-runs` cancels active runs; step 65 `scripts` cancels again for a racing start, defers while a run job is active, then deletes the runs' data, the scripts' images and the script documents; step 80 (workspace) removes the folders |

Every step is idempotent and resumes after a lease expiry.

## 7. Logs

### 7.1 Writer

`ScriptRunLogWriter` (`server/services/script-runs/logs.ts`) stores the run's log in `scriptRunLogs` chunks
`<runId>-<chunk>` of at most 500 lines, numbered from 1 in storage order, streams `build` (pipeline events),
`stdout`, `stderr` (the container) and `system` (the platform's own lines).

- **Flush** every 2 s or when 500 lines are pending, serialized. A chunk write is idempotent (`replaceOne` upsert by
  `_id`); the run's `log {lines, bytes, firstLine, droppedLines, nextChunk, cursor}` follows in the same flush. A
  writer that resumes counts the chunks at or after `nextChunk` first, so a crash between the two writes loses and
  repeats nothing.
- **Line bounds**: Docker's partial frames are joined until `\n` (a trailing `\r` is dropped); a stored line is at
  most 16 KiB and cut with the marker ` [line truncated]`; a line without end that exceeds 32 KiB is stored cut and
  the rest of it is skipped up to the next newline.
- **Redaction**: every line passes `redactText` (the text rules of [security](security.md) MC-10: `ssr_`, `swt_`,
  `sk_scantor_`, `X-Amz-Signature`, …), then the run's own secret values (at least 6 characters, longest first) are
  replaced by `***` (`maskScriptRunText`, `server/services/script-runtime/secrets.ts`). The run's other texts from
  script code go through the same masking before they are stored: the `error.message` and `error.stack` the script
  reports through `scriptRuntimeFinish`, the crash stack (§6.6) and `progress.message`.
- **Ingestion rate limit** per run: at most 10 MiB and 20 000 lines per 10 s window (1 MiB/s, 2000 lines/s on
  average); `system` lines are exempt. Excess lines are counted in `droppedLines` and replaced by one `system`
  marker per window.
- **Retention**: when the stored bytes exceed `SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES`, the head chunks (from the first
  until 1 MiB is reached) and the newest chunk are kept and the oldest chunks in between are deleted until the log
  fits; their lines count into `droppedLines`. `firstLine` stays 1 because the head is always kept. One `system`
  marker is appended the first time (at the end of the log at the time of the drop, not at the gap). The chunk that
  holds it carries `retentionMarker`; when a later pass deletes that chunk, the marker is appended again, so exactly
  one stays visible (a writer that resumes a gap without one appends it).

### 7.2 Reading

- `getScriptRunLogs ?afterLine&limit` (1–1000, default 200): the stored lines after `afterLine` (default: from the
  first retained line), skipping the retention gap → `{lines: [{line, at, stream, text}], firstLine, nextLine,
  complete}`; `complete` = the run's document is terminal (a pending cancel is not, §6.7), no `scriptRun` job of the
  run is active any more (a cancelled run's job may still store the lines of the container's stop; every job stores
  its last lines before it ends) and `nextLine ≥ log.lines`, re-read after the job check. Clients poll with
  `afterLine = nextLine` until `complete` (not until the run's state is terminal) and notice a gap in the numbers
  (the CLI warns, the UI shows the dropped-lines notice).
- `logTail` on single-run representations: the last ≤ 50 lines and ≤ 16 KiB from the two newest chunks.

### 7.3 Follow and resume

The execution follows the container log (`follow`, `stdout`, `stderr`, `timestamps`). The cursor `{ts, countAtTs}`
is the Docker RFC3339Nano timestamp of the last stored container frame and how many frames with exactly that
timestamp were stored. A claim that adopts a running container follows with `since = ts − 1 s` (sent as
`<sec>.<nanos>`), drops frames older than the cursor and, of the frames equal to it, skips the first `countAtTs`.
An orderly detach flushes first, so its boundary is exact; a crash of the orchestrator process can repeat or lose
the lines of its last flush interval, and lines Docker rotated out of the `local` driver's files (5 × 50 MiB) during
a long outage are lost. After the container exited, the stream gets 5 s to deliver the last lines; draining a
stopped container's log is bounded to 10 s.

## 8. Outputs

An **output** is a file a run stores (`ctx.outputs`), at `script-runs/<runId>/outputs/<outputId>/<safeName>` with
object metadata `output-id` and `name` (URI-encoded). The script uploads it itself with S3 multipart uploads
through presigned URLs of the internal endpoint (`server/services/script-runtime/outputs.ts`); keys are generated by
the server only.

| Step | Route | Rules |
|---|---|---|
| create | `scriptRuntimeCreateOutput` `{name, contentType?}` | name 1–255 characters without NUL, `/`, `\`; content type a MIME type (default `application/octet-stream`); CreateMultipartUpload, then one conditional `$push` (no duplicate name, below `SCANTOR_SCRIPT_RUN_MAX_OUTPUTS`, run running) → 201 `{output: {id, name, contentType}, partBytes}`. Idempotent on the name: the pending output of the same name and type is returned with 200; a stored one, or a pending one of another type, is 409 `alreadyExists`; one more than the limit is 400 `validationFailed` |
| parts | `scriptRuntimeCreateOutputPart` `{partNumber 1–10000, size 1 B–5 GiB}` | the run's stored and reserved output bytes plus `size` must fit `SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES` (413), checked in the same conditional write that does `reservedBytes += size`, so concurrent presigns never pass the cap together; then `reserveStorage` against the owner's quota (403 `quotaExceeded`, which takes the run's reservation back) → `{url, method: 'PUT', headers: {Content-Length}, expiresAt}`: a presigned UploadPart of `SCANTOR_S3_INTERNAL_URL` with the Content-Length signed, valid `SCANTOR_UPLOAD_TIMEOUT` |
| complete | `scriptRuntimeCompleteOutput` `{parts: [{partNumber, etag}], sha256, name?}` | idempotent (a stored output is returned); `name` renames on completion (the SDK's `<name>.partial`; 409 `alreadyExists` when taken); CompleteMultipartUpload (S3 part errors → 400; `NoSuchUpload` → 409 `invalidState` unless a concurrent complete stored it), HEAD for the size (more than reserved → deleted, 400; unreachable while Content-Length is signed), then `stored` with the size and the SHA-256 **as reported by the script** (not verified by the server); reservation cleared → `{output: {id, name, size, sha256, contentType, createdAt}}` |
| read back | `scriptRuntimeOutputUrl` | a presigned internal GET (1 h) of a stored output of this run, or of the run it continues when restarted with `resume` |
| end | finish, cancel, failure | `abortPendingOutputs` aborts and drops every output still `pending`; the bucket's abort-incomplete-multipart rule removes uploads whose abort failed |

Users read stored outputs with `getScriptRunOutputDownload` (a public presigned GET valid 10 minutes, the DL-1
rules, `?redirect=true` → 302) and `readScriptRunOutput` (the shared `FileContent` service, [api](api.md) §4.15).
Pending outputs never appear in representations.

**Quota**: `measureUsage` ([data model](data-model.md) §8) adds the sizes of stored outputs and the `reservedBytes`
of pending outputs of all the owner's run documents. Known gap: part reservations are not idempotent per
(outputId, partNumber), so a re-presign after an expired URL counts the bytes twice against the per-run cap and the
quota until the output is stored (fails closed).

## 9. Script runtime API

### 9.1 Principal and scope

Scope `scriptRun` (`x-scantor-scope`), tag `script-runtime`, prefix `/api/script-runtime/`, MCP no. The principal is
`{kind: 'scriptRun', scriptRun: {id, userId, scriptId, scanIds, limit}}`: it acts for the run's owner, on the run's
scans only. `requireScriptRun(event)` is the only accessor; routes load scans with `loadRunScan` and analyses with
`loadRunAnalysis` (`server/utils/authz.ts`). The OpenAPI lint pins the scope to the `scriptRuntime*` operationIds
(`MACHINE_NAMESPACES.scriptRun`).

### 9.2 Token

`ssr_<scriptRunId>.<mac>`, `mac = base64url(HMAC-SHA256(key("script-run-token"), scriptRunId + "\n" + scriptId +
"\n" + userId))` (43 characters), pattern `^ssr_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$`. It is minted when the
container is created, passed only in the container's environment and never stored. Every request
(`resolveScriptRunToken`, `server/utils/script-run-tokens.ts`) parses it, loads the run (no cache), requires
`running`, recomputes the MAC and compares it with `timingSafeEqual`, and requires the owner to exist and not be
banned (the user cache, ≤ 30 s); anything else is 401 `unauthorized`, except a failed run or owner lookup, which is
503 `unavailable` (the SDK retries it). A token therefore dies with its run's state,
and handlers that reload the run require `running` again (401 when it ended meanwhile). The script SDK sends no
`X-Scantor-Version`, so there is no version check. Shared vectors: `tests/corpora/keys-vectors.json`
(`scriptRunToken`).

### 9.3 Peer restriction

`/api/script-runtime/*` accepts a request only when its **socket peer address** lies in a subnet of the Docker
network `scantor-scripts` and is not a trusted reverse proxy (`SCANTOR_TRUST_PROXY`), so the request did not come
through Traefik; otherwise 403 `forbidden`. The check runs before the token, so outside callers cause no database
read and learn nothing about tokens. A leaked token is useless outside the master.

- The subnets come from the network's IPAM configuration (`server/utils/script-network.ts`), inspected by boot step
  `scripts-network` (order 650, `server/plugins/35.scripts.ts`). The step never fails the boot: while the subnets
  are unknown (the network is missing, has no subnet, or Docker failed) every request is refused (fail closed), and
  a refused check triggers a new inspection at most every 30 s. IPv4-mapped IPv6 peers are normalised.
- **Dev stack only**: under `nuxt dev`, Nitro proxies every request to its worker thread over a unix socket, so the
  socket has no peer address. Only then (`import.meta.dev`, never in production builds, the test stack or vitest)
  the check uses a single-entry `X-Forwarded-For` value. Nitro's dev proxy keeps a client-sent header, so in the dev
  stack the restriction is advisory; the token checks are unchanged.

### 9.4 Body caps and limits

Bodies: 1 MiB, except `finish` and `checkpoint`: `max(1 MiB, SCANTOR_MAX_RESULT_BYTES) + 128 KiB`, applied before
the credential like every cap ([api](api.md) §1.5). Fixed limits (`server/services/script-runtime/limits.ts`, handed
to the script by bootstrap): presigned GETs of files and outputs valid 1 h, output part size 16 MiB, at most 4
concurrent analysis streams and aggregations per run in one orchestrator process (429 `tooManyRequests` beyond; they
never take the owner's `SCANTOR_USER_MAX_CONCURRENT_QUERIES` slots), progress written at most once per second,
checkpoints at most once per 10 s, keep-alive checkpoint lines every 10 s, checkpoint state ≤ 1 MiB of JSON,
stored checkpoints and results nested ≤ 64 levels without keys that start with `$` or contain NUL (400
`validationFailed`).

### 9.5 Routes

| Route | operationId | Body | Response |
|---|---|---|---|
| `GET /bootstrap` | `scriptRuntimeBootstrap` | – | §9.7 |
| `POST /scans/{scanId}/analyses` | `scriptRuntimeStreamAnalyses` (`x-read-only`) | `{status?: AnalysisStatus[], filter?: object, fields?: string[] \| "all", afterSeq?: int ≥ −1, untilSeq?: int > afterSeq, fileUrls? (true)}` | `application/x-ndjson`, §9.8; 400 for a filter or fields the export rules reject; 404; 429 |
| `POST /scans/{scanId}/aggregate` | `scriptRuntimeAggregate` (`x-read-only`) | the `aggregateAnalyses` body `{pipeline, limit?}` | `{items, truncated}` with the rules of [api](api.md) §5.2 (scope first, allowlist, secret paths, `SCANTOR_QUERY_MAX_TIME`, `SCANTOR_QUERY_MAX_DOCS`); suited to status and seq predicates, large evaluations stream; 429; 504 |
| `GET /analyses/{analysisId}/files/{fileId}` | `scriptRuntimeFileUrl` | – | `{url, expiresAt, name, size, sha256, contentType}`: a fresh presigned internal GET (1 h) of a stored file; 404 for unknown or unstored files |
| `POST /progress` | `scriptRuntimeProgress` | `{done ≥ 0, total?: number \| null, message?: string ≤ 256 \| null}` | `{state: "running"}`; the message is stored masked (§7.1) |
| `PUT /checkpoint` | `scriptRuntimeCheckpoint` | `{state: <any JSON>}` | `{savedAt}`; 413 above 1 MiB of JSON; 400 unstorable |
| `POST /describe` | `scriptRuntimeDescribe` | `{configSchema: object \| null, resultSchema: object \| null}` (each ≤ 256 KiB) | `{packSha256, at}`: stored on the script as `describe {packSha256 = run.source.packSha256, configSchema, resultSchema, at}` (the last report wins); 404 when the script is gone |
| `POST /outputs` | `scriptRuntimeCreateOutput` | §8 | 201 / 200 `{output, partBytes}` |
| `POST /outputs/{outputId}/parts` | `scriptRuntimeCreateOutputPart` | §8 | `{url, method, headers, expiresAt}` |
| `POST /outputs/{outputId}/complete` | `scriptRuntimeCompleteOutput` | §8 | `{output}` |
| `GET /outputs/{outputId}` | `scriptRuntimeOutputUrl` | – | `{url, expiresAt, name, size, sha256, contentType}` |
| `POST /finish` | `scriptRuntimeFinish` | exactly one of `{result: <any JSON, null included>}` or `{error: {type: "scriptError" \| "validation", message ≤ 16 KiB, stack? ≤ 64 KiB}}` | `{received: "result" \| "error"}`; 413 above `SCANTOR_MAX_RESULT_BYTES`; 400 unstorable; a reported message and stack are stored masked (§7.1) |

Paths are relative to `/api/script-runtime`. Every route answers 401 for an invalid, expired or ended run's token and
403 for a peer outside `scantor-scripts`. `finish` stores the outcome on the run (the last call wins: a result clears
a reported error and vice versa) and writes the pending progress and checkpoint at once, because the script exits
right after; the job decides the final state at the exit (§6.6).

### 9.6 Secrets

`secrets` of a start request (NAME → value) are sealed as one JSON document with AES-256-GCM under HKDF label
`config-secrets` and AAD `scriptRuns:<runId>:secrets`, so a sealed blob cannot be moved to another run
(`server/services/script-runtime/secrets.ts`). Representations list only the names. The values are decrypted in
`scriptRuntimeBootstrap` and nowhere else (the run's job also opens them to mask them in the stored log). A blob that
no longer opens (after a `SCANTOR_SECRET` change) makes bootstrap answer 500 `internal`.

### 9.7 Bootstrap

```json
{
  "scriptRun": {
    "id": "8d2e…", "scriptId": "5b1d…", "scriptName": "csp-stats",
    "config": { "minBytes": 0 }, "secrets": { "API_TOKEN": "…" },
    "settings": { "timeoutMs": 86400000, "resources": { "cpus": 2, "memoryMiB": 2048 }, "limit": null },
    "cpus": 2, "startedAt": "2026-11-08T10:00:05.000Z", "deadline": "2026-11-09T10:00:05.000Z"
  },
  "scans": [
    {
      "id": "5e1f…", "name": "tranco top 100k", "state": "completed",
      "task": { "id": "7f3b…", "name": "origins" }, "revision": { "id": "c1d2…", "number": 3 },
      "createdAt": "2026-10-21T10:00:00.000Z", "completedAt": "2026-10-21T14:00:00.000Z", "maxSeq": 99999,
      "counts": { "total": 100000, "pending": 0, "retrying": 0, "succeeded": 99811, "failed": 189, "lost": 0, "cancelled": 0, "hint": false },
      "schemas": { "analysisConfig": { "type": "object" }, "result": { "type": "object" } },
      "fileRefPaths": ["/report"], "secretPaths": { "analysisConfig": [], "result": [] }
    }
  ],
  "resume": null,
  "limits": { "maxResultBytes": 524288, "maxCheckpointBytes": 1048576, "maxOutputs": 50, "maxOutputBytes": 10737418240, "partBytes": 16777216, "fileUrlTtlSeconds": 3600, "maxStreams": 4, "progressIntervalMs": 1000, "checkpointIntervalMs": 10000 },
  "s3Origin": "http://rustfs:9000"
}
```

- `scans` keeps the request order; a scan deleted meanwhile makes bootstrap 404 (deleting a scan cancels the run
  anyway). `maxSeq` comes from the `{scanId, seq}` index (null without analyses). `counts` are exact (`hint: false`)
  only for a terminal scan recounted at or after its end ([queue](queue.md) §6.9), otherwise the scan's hint
  counters. `secretPaths` hold only the analysis config and result paths of the scan.
- `cpus` = `max(1, floor(resources.cpus))`, the number of processes for CPU-bound work. `deadline` =
  `startedAt + timeoutMs`.
- `resume` (restart with `resume`): `{runId, checkpoint: <state> | null, outputs: [{id, name, size, sha256,
  contentType}]}` of the original's stored outputs.
- `s3Origin` is the origin of `SCANTOR_S3_INTERNAL_URL`; the SDK refuses file URLs of any other origin.

### 9.8 Analysis stream

`scriptRuntimeStreamAnalyses` (`server/services/script-runtime/stream.ts`) streams the analyses of one scan of the
run in `seq` order after `afterSeq` (up to `untilSeq`), read in the export's seq windows of 10 000 (`exportDocuments`
with its `onRange` hook, `maxTimeMS` per window, `allowDiskUse: false`, the `scantor_query` client), masked like every
read ([api](api.md) §1.6), with backpressure (`Readable.from` + `sendStream`) and a `setImmediate` between windows.

- Selection: `filter` and `fields` pass `validateExportSelection` (allowlist, secret-path checks). Without `fields`
  the projection is `id, seq, status, attempt, round, config, result, error, files`; `"all"` is the full
  representation; with an explicit list `id` and `seq` are always added, and `files` while `fileUrls` is on (a
  FileRef in a result resolves by id against `files`). Analysis lines never carry S3 keys.
- Lines (one JSON object each):

| Line | When |
|---|---|
| `{"analysis": {...}, "urls": {"<fileId>": "<url>"}}` | one per analysis; `urls` (presigned internal GETs, 1 h) only for stored files and only with `fileUrls` |
| `{"checkpoint": {"afterSeq": N}}` | after every seq window and after 10 s of silence: every match with seq ≤ N was sent (keep-alive and resume point) |
| `{"end": {"afterSeq": N, "count": n, "limited": bool}}` | exactly once on success; `limited: true` when `settings.limit` analysis lines were sent |
| `{"error": {"code", "message", "retryable": bool}}` | instead of `end` on a failure, then the stream closes |

- Before every further window the run must still be `running`, the scan the owner's and not being deleted, and the
  owner not banned; otherwise an error line `unauthorized` or `notFound` (not retryable) ends the stream.
- Retryable error lines: a lost cursor (`CursorNotFound`), a transient database error (`unavailable`), and the
  orchestrator stopping (`shutdownSignal()`: the best checkpoint line, then `unavailable`; a client that does not read
  them within 5 s is disconnected). The client resumes after `max(last seq, last checkpoint)`.
- A sample run (`settings.limit`) ends every stream after `limit` analysis lines; the SDK enforces the limit across
  resumes too.
- The open stream holds one of the run's 4 read slots until it closes.

## 10. Runtime script mode

`scantor runtime script --entry <entry>` (hidden; `internal/runtime/script`) is the entrypoint of every script-run
container ([runtime](runtime.md) §2):

- It parses `SCANTOR_SCRIPT_CMD` with the command-template parser of the connector pool (`pool.ParseCommand`,
  `ResolveExecutable`, `{entry}` substituted) and starts it in `/task` as the leader of its own process group, with
  the container's stdio and its complete environment (the script reads `SCANTOR_URL` and `SCANTOR_SCRIPT_TOKEN`).
- It writes the heartbeat (`Mode: "script"`, every 10 s), so `scantor runtime healthcheck` works.
- SIGTERM and SIGINT are forwarded to the group (a cancelled context counts as SIGTERM); 50 s after the first signal
  the group is killed (below the 60 s `docker stop` timeout, so the runtime outlives the script). Group members left
  behind after the script exited are killed too.
- Exit code: the script's, or 128 + signal (137 after the forced kill). A start failure prints `scantor: …` on stderr
  and exits 2, for example `scantor: this base image does not support scripts: SCANTOR_SCRIPT_CMD is not set`. Its
  only other lines are `received SIGTERM; stopping the script (killed after 50s)` and `the script did not stop within
  50s; killing it`.
- No log framing, no API calls: the script talks to the script runtime API itself.

## 11. Python SDK

`connectors/python/src/scantor/script/` (namespaced, not re-exported from `scantor`; standard library only beyond
the connector's pydantic). The user-facing API is in [docs/guide/scripts.md](guide/scripts.md).

### 11.1 Surface

- `Script(*, run, config=Empty, result=None)`: import-time checks like `Task` (`DefinitionError`), PEP 696 generics;
  a `writeOnly` in the JSON Schema of `config` or `result` is a `DefinitionError` (secrets belong in `ctx.secrets`).
- `ScriptContext`: `run_id`, `script_name`, `cpus`, `limit`, `deadline`, `remaining()`, `cancelled`,
  `check_cancelled()`, `secrets`, `scans`, `scan(id_or_name)`, `analyses(scan, *, result, analysis_config, status,
  filter, fields, after_seq, until_seq, file_urls, invalid)`, `aggregate(scan, pipeline, *, limit)`, `count(scan, *,
  status)`, `map(fn, items, *, workers=16, processes=1, ordered=False, errors, max_errors)`, `progress(done, total,
  message)`, `checkpoint(state)`, `resume_state`, `resume_outputs`, `log(message, **fields)`, `outputs.put(…)`,
  `outputs.open(…)`.
- Models: `Scan` (with `ScanCounts`), `Analysis[R, C]` (frozen pydantic, camelCase aliases; file helpers `file`,
  `open`, `read_bytes(verify=True)`, `read_text`, `read_json`, `download` accept a `FileRef`, a mapping or an id or
  name), `AnalysisStream`, `MapResult` (`.watermark`, `.errors`), `AggregateResult` (a list with `.truncated`),
  `Output`, errors `Cancelled` and `ScriptError` (`code`, `status`, `retryable`, `details`).
- URLs live in a private mapping never shown in `repr` or dumps. A FileRef resolves by `id` against the
  server-sent `files[]` only; untyped results get the embedded FileRef dicts at `fileRefPaths` converted.

### 11.2 Entry

`python -m scantor.script <entry>` (`SCANTOR_SCRIPT_CMD`; `_main.py`): import the entry through the shared entry
loader (`scantor/_entry.py`, refactored out of the task server; the attribute `script` must be a `Script`) →
bootstrap → `describe` (the config and result JSON Schemas) → validate the config (`validation` error → finish →
exit 1) → `run(ctx, config)` (sync or async) → serialise the result strictly → flush progress and checkpoint →
`finish {result}` → exit 0. An uncaught exception (including `sys.exit` in script code) → `finish {error: {type:
'scriptError', message, stack}}` → exit 1. Exit codes: 0 completed, 1 failed, 143 cancelled, 2 missing environment
or bad usage. The environment is read in exactly one function: `SCANTOR_URL`, `SCANTOR_SCRIPT_TOKEN`, optional
`SCANTOR_CA_CERT` (PEM; `\n` escapes accepted).

### 11.3 HTTP and retries

stdlib `http.client`, keep-alive connections per thread, socket timeout 60 s (streams send a checkpoint at least
every 10 s), longest stream line 64 MiB. **One retry policy** for every runtime call: 429, 500, 502, 503, 504 and
connection errors are retried with capped exponential backoff from 1 s to 30 s (`Retry-After` honoured up to 30 s)
within a total budget of 10 minutes, long enough to outlast an orchestrator restart or a MongoDB or S3 failover (the
runtime handlers answer a driver error with 500 `internal`); a stale keep-alive connection reconnects at once. The
decision is taken after the error envelope is parsed: 504 `queryTimeout` (the query hit `maxTimeMS` and would hit it
again) is raised at once as `ScriptError(code='queryTimeout')`. Retrying is safe because every runtime call is
idempotent (a re-requested part URL only reserves its bytes again, §8). File-store requests retry the same statuses.
File and output URLs are fetched without the token, without redirects and only when their origin equals bootstrap
`s3Origin`; a 403 (expired URL) is refreshed once through `scriptRuntimeFileUrl` / `scriptRuntimeOutputUrl`.

### 11.4 Streams and parallelism

- `ctx.analyses` validates each line from bytes with a cached private TypeAdapter, resumes after a dropped
  connection or a retryable error line from `max(last seq, last checkpoint)` (at once after progress, else with
  backoff), raises `ScriptError` on a non-retryable error line, and with `invalid='skip'` logs the first 10 invalid
  lines individually and counts the rest. A stream whose position reached `until_seq` (after the line or the
  checkpoint at `until_seq`, or an `after_seq ≥ until_seq`) is complete and sends no further request, because the
  platform refuses `afterSeq ≥ untilSeq`. With a `fields` list it always adds `id, seq, status, attempt, round`, plus
  `files` while file URLs are on.
- `ctx.map` with `processes == 1`: a thread pool of `workers` threads with at most 2 × workers items in flight.
- `processes > 1`: an SDK-owned `multiprocessing` pool with the `spawn` start method. The pool initializer re-imports
  the entry under the same module name through the shared loader and builds its own HTTP client from the parent's
  `ClientConfig` (the environment is still read once). With an `AnalysisStream` input the parent forwards raw line
  bytes (with the line's URLs) in chunks of `workers` lines, at most 2 × processes chunks in flight; children validate
  them and run `fn` on a `workers`-sized thread pool. Other items are pickled. `fn` must be a module-level function
  and its results picklable (clear errors otherwise); the entry must be import-safe. Worker processes ignore
  SIGTERM and SIGINT; the parent kills them on close or cancellation. A `Cancelled` raised in `fn` is never collected
  as an error, and neither is an analysis that fails validation with `invalid='raise'`: it stops the map with the
  `pydantic.ValidationError` and the note naming the analysis, whatever `processes` and `errors` are.
  `MapResult.watermark` is the highest seq with every item at or below it done (for checkpoints).

### 11.5 Reporting, outputs and cancellation

- `progress` and `checkpoint` are throttled by the bootstrap intervals; a checkpoint copies its state when called; the
  latest values are flushed at the end, also on failure and cancellation. One background thread sends every value in
  order, the final ones included (after the send it is in, ignoring the intervals), because the platform keeps the
  value it accepts last: an older checkpoint still being retried never overtakes the newest one.
- `outputs.put(name, data)` and `outputs.open(name, mode, *, encoding, newline, content_type)` stream parts of
  `partBytes` from memory, never spooling the whole file; without a content type the SDK guesses it from the extension.
  Empty outputs raise `ValueError` (parts must hold at least 1 byte). A part is uploaded as a copy and leaves the
  buffer only once uploaded; the reported SHA-256 covers the uploaded bytes. On an exception or `Cancelled` inside
  `open`, including a failed part (413 from the per-run cap, 403 `quotaExceeded`, a rejected PUT), the bytes written
  so far are completed as `<name>.partial` (a new output when no part was uploaded yet, otherwise a rename on
  complete; when the rest cannot be uploaded, only the parts already uploaded). A failure while storing the partial
  output is logged and never replaces the exception that propagates.
- SIGTERM sets `cancelled`; iterators and `map` raise `Cancelled` at their next check, open outputs complete as
  `.partial`, and `finish` reports `{type: 'scriptError', message: 'cancelled: received SIGTERM'}` (the job keeps the
  run `cancelled`, §6.7).

### 11.6 Tests

`connectors/python/tests/test_script*.py` against a loopback fake runtime API and fake S3 (`script_fake.py`,
`http.server`, works with `--network none`): definitions, streams (resume after a dropped stream, retryable error
lines, a stream cut at `until_seq`), `map` with `processes=2`, outputs (multipart, `.partial`, failed parts),
reporting (the final checkpoint after one in flight), the retry policy (500 retried, `queryTimeout` not), the entry,
the `files-report` fixture, the guide excerpts and the scaffold (also resumed); typing cases in
`tests/typing/scripts.py`.

## 12. User surfaces

| Surface | Scripts |
|---|---|
| REST | tags `scripts`, `script-files`, `script-runs` ([api](api.md) §4.19–§4.21) |
| MCP | 13 tools: `list_scripts`, `create_script`, `get_script`, `list_script_files`, `read_script_file`, `write_script_files`, `delete_script_file`, `start_script_run`, `get_script_run`, `cancel_script_run`, `restart_script_run`, `get_script_run_logs`, `read_script_run_output` ([mcp](mcp.md) §5); skill `skills/scantor-scripts/SKILL.md` |
| CLI | `scantor scripts list \| get \| create \| delete \| init \| push \| run \| files … \| runs …`; `scantor push` uploads a folder with `scantor-script.yaml` as a script (both manifests: usage error) ([docs/guide/cli.md](guide/cli.md)) |
| UI | `/scripts`, `/scripts/new`, `/scripts/:scriptId` (tabs overview, files, runs), `/scripts/:scriptId/runs/:runId`, "Run script" on the scan page ([ui](ui.md) §4) |
| Editor | script folders under `.scripts/`; `createEditorSession {openScript}`; the manifest schema binding ([editor](editor.md)) |

CLI specifics: `scripts run [<script>|dir] --scan <id>… [--config] [--secret NAME=VALUE|NAME=@file]… [--limit N]
[--timeout] [--cpus] [--memory] [--follow] [--yes]` pushes a folder argument (or the current folder with
`scantor-script.yaml`) first, never with force, and uses the name directly inside the editor (`SCANTOR_WORKSPACE`,
`.scripts/<name>`). `--follow` polls `getScriptRunLogs` (`afterLine`) and `getScriptRun` until terminal, retrying
temporary errors for up to 2 minutes; **Ctrl-C detaches** (prints the run id and the `scripts runs logs <id> --follow`
/ `scripts runs cancel <id>` hints, exit 3) unless `--cancel-on-interrupt`. `--yes` sends `confirm: true`. Exit codes
with `--follow`/`--wait`: 0 completed, 1 failed or cancelled, 3 platform failure, network error or interrupt. Log text
printed to a terminal goes through `TerminalSafe` (HDR-5); `-o json` is exact (`runs logs -o json` prints NDJSON).
Downloads (`runs outputs get`, `runs source`) use `--file/-f` because `-o` is the output format; `runs source` checks
the size only, because `packSha256` hashes the uncompressed tar.

## 13. Limits and configuration

Configuration (defaults only in `.env.example`, section BUILDS & TASK PIPELINE → Script runs; parsed only in
`server/utils/config.ts`; orchestrator-only, compose passes them through `env_file`):

| Variable | Governs |
|---|---|
| `SCANTOR_SCRIPT_RUN_CONCURRENCY` | concurrent script runs per orchestrator process (`scriptRun` job slots) |
| `SCANTOR_SCRIPT_RUN_CONCURRENCY_PER_USER` | concurrent script runs per user |
| `SCANTOR_SCRIPT_RUN_TIMEOUT` | maximum and fallback total duration of a run (bounded to 365 days) |
| `SCANTOR_SCRIPT_RUN_MAX_CPUS` | maximum CPUs of a script-run container |
| `SCANTOR_SCRIPT_RUN_MAX_MEMORY` | maximum memory of a script-run container (the container gets 256 MiB on top) |
| `SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES` | log bytes kept per run (head 1 MiB + tail) |
| `SCANTOR_SCRIPT_RUN_MAX_OUTPUTS` | output files per run |
| `SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES` | total bytes of all outputs of a run |
| `SCANTOR_SCRIPT_RUN_RETENTION_DAYS` | days a finished run is kept; 0 keeps runs forever |

Reused: `SCANTOR_TASK_MAX_FILES`, `SCANTOR_TASK_MAX_BYTES`, `SCANTOR_TASK_MAX_PACK_BYTES` (folder caps, upload cap),
`SCANTOR_WORKSPACE_MAX_BYTES`, `SCANTOR_BUILD_CONCURRENCY`, `SCANTOR_BUILD_TIMEOUT`, `SCANTOR_MAX_IMAGE_BYTES`,
`SCANTOR_BUILD_CACHE_MAX_BYTES`, `SCANTOR_DRAFT_IMAGE_RETENTION` (draft and script images),
`SCANTOR_MAX_SCAN_CONFIG_BYTES` (run config), `SCANTOR_MAX_RESULT_BYTES` (run result), `SCANTOR_UPLOAD_TIMEOUT`
(part URLs), `SCANTOR_USER_STORAGE_QUOTA_BYTES` (outputs), `SCANTOR_QUERY_MAX_TIME`, `SCANTOR_QUERY_MAX_DOCS`,
`SCANTOR_MAX_CONCURRENT_WAITS`, `SCANTOR_INTERNAL_URL`, `SCANTOR_S3_INTERNAL_URL`, `SCANTOR_TRUST_PROXY`.

Internal contract (set by scantor for its children, never configuration): `SCANTOR_SCRIPT_TOKEN` and `SCANTOR_URL`
in the container, `SCANTOR_SCRIPT_CMD` in the base image. The test stack sets short script-run limits in
`tests/docker/stack.env`.

## 14. Implementation map

| Area | Files |
|---|---|
| Go | `internal/manifest/script.go`, `internal/taskpipe` (`CheckScriptStatic`, `BuildScript`, `ScriptResult`, `EventOf[R]`), `internal/cli/script_build.go`, `internal/runtime/script`, `internal/workspace/folder.go`, `script_scaffold.go`, `internal/cli/workspace.go` (`--script`, `extract --kind`), `internal/cli/scripts.go`, `scripts_runs.go`, `push.go`, `internal/api/types_scripts.go`, `user_scripts.go`, `internal/keys` (`script-run-token`), `internal/redact` (`ssr_`), `internal/container` (`KindScriptRun`), `internal/languages` |
| Schemas | `schemas/script-manifest.schema.json`, `languages.json` (`script` object), `managed-labels.json` (kind `scriptRun`) |
| Orchestrator | `server/plugins/35.scripts.ts`; `server/services/scripts/` (store, mappers, index, upload, files, delete, purge, gc, register), `server/services/script-runs/` (start, job, container, logs, cleanup, live, pointer, events, mappers, index, register), `server/services/script-runtime/` (bootstrap, stream, reads, state, outputs, describe, finish, secrets, limiter, limits, run, schemas, register), `server/services/pipeline/script-build.ts`, `server/services/editor/open.ts`, `server/utils/script-network.ts`, `script-run-tokens.ts`; routes `server/api/scripts/`, `server/api/script-runs/`, `server/api/script-runtime/`; `shared/schemas/scripts.ts`, `shared/types/scripts.ts` |
| UI | `app/pages/scripts/`, `app/components/Script*.vue`, `RunScriptModal.vue`, `FilesBrowser.vue`, `app/composables/useScripts.ts`, `useScriptRuns.ts` |
| Python | `connectors/python/src/scantor/script/`, `scantor/_entry.py`, `scaffolds/python-script/` |
| Tests | [testing](testing.md) §4 and §8 |

## 15. Decisions

1. **A script is a folder, not a revisioned task.** Evaluations change with every look at the data; a run snapshots
   the folder at its start (stored as `source.tar.gz`, downloadable), which keeps runs reproducible without a
   publish step.
2. **Scripts run on the master, in one container per run.** They read millions of analyses and files at internal
   bandwidth; placement on nodes, queues and fan-out bring nothing for one sequential program. Parallelism lives
   inside the container (`ctx.map` with threads and processes).
3. **Local images, never pushed.** `scripts/<scriptId>:<packSha256>` is content-addressed, so unchanged code reuses
   its image; no registry repository, token grant or registry GC is involved. D5 forbids `scripts/` references.
4. **A dedicated internal network and a run-scoped API.** The container reaches only the orchestrator and RustFS on
   `scantor-scripts` (`internal: true`): no internet, RabbitMQ, workers or editors. Its only credential is a
   derived token that dies with the run's state, bound to the owner's scans by `loadRunScan`; the API also refuses
   peers outside the network.
5. **NDJSON stream with checkpoints instead of pages.** Seq windows of the export reader keep MongoDB work bounded,
   checkpoint lines make every interruption resumable, and the stream needs no server-side cursor state.
6. **Presigned internal URLs valid 1 h.** A slow consumer may lag behind the stream; the URLs are signed for
   `SCANTOR_S3_INTERNAL_URL`, which only the master's containers reach ([security](security.md) DL-7).
7. **Container adoption over restarts.** A run is a container, not a process of the orchestrator: an orchestrator
   stop detaches, the next claim adopts the container by its recorded id and resumes the log from a Docker
   timestamp cursor; attempts are refunded at a stop, so restarts never use up a days-long run.
8. **The job decides the final state from the exit code.** `finish` only stores the reported outcome; exit code,
   OOM and timeout are facts the platform observes, so a script cannot claim success and crash.
9. **Run owner = script owner, always.** Admins can address another user's script and runs by id, but a run reads
   only its owner's scans; `loadScansForScriptRun` never uses the admin bypass.
10. **Head + tail log retention and a rate limit.** A days-long run's log keeps its start and its newest lines within
    `SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES`; the rate limit keeps one run from flooding MongoDB.
11. **Outputs as multipart uploads by the script.** Bytes never pass through the orchestrator; parts are presigned
    with a signed Content-Length and reserved against the quota and the per-run cap before they are signed.
12. **Retention by sweep, not TTL.** A run owns S3 objects and log chunks, which must go before its document.
13. **The dev-stack peer check is advisory.** `nuxt dev` hides the socket peer behind its worker proxy; using
    `X-Forwarded-For` only in dev keeps the dev stack usable without weakening production builds.

## 16. Future extensions

| Extension | Accommodation |
|---|---|
| Config schemas before the first run | `describe` is per pack hash; a describe-only container mode (like the task pipeline's describe) could fill it at save time. |
| Local runs (`scantor scripts run --local`) | The SDK reads only `SCANTOR_URL` and `SCANTOR_SCRIPT_TOKEN`; a local fake of the runtime API over a user API key would serve it. |
| Scheduled scripts | A run is created by one service function (`startScriptRun`); a schedule document would call it like the UI. |
| Admin cross-user scripts | The principal carries `userId` and `scanIds`; a separate admin binding would relax `loadScansForScriptRun` deliberately. |
| More languages | `languages.json` `script` object + a base image with `SCANTOR_SCRIPT_CMD` + an SDK speaking §9; no switch in Go or TS. |
| Free-threaded Python | `ctx.map` already separates threads and processes; a free-threaded base image would make `processes` optional. |
| Opt-in runtime egress | A run setting attaching `scantor-egress` beside `scantor-scripts`, gated by an instance flag. |
| Build-slot priority, queue reasons | Builds share `useBuildSlots()`; a priority class and a `queuedReason` field on the run would explain waiting runs. |
| Disk quotas for script containers | `StorageOpt` on the container spec where the storage driver supports it. |
| Idempotent part reservations | Store reservations per (outputId, partNumber) and replace instead of add. |
