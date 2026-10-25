# Tasks

This document is the task authoring contract: the structure of a task folder, the manifest
`scantor.yaml`, the language table and the base image ENV contract, the definition API of every
connector (Python, TypeScript, JavaScript, Go) including `ctx`, files and errors, the rules for the
JSON Schemas a task exports, the describe output, the Dockerfile policy, the task pipeline
(`scantor task pack | check-static | build`) with its NDJSON events, structured errors and limits,
revisions, test runs, scaffolds, the workspace model and git import. It is the reference for the
connector authors, the `internal/taskpipe`, `internal/workspace` and `internal/manifest` packages, the
orchestrator's revision and test-run jobs, the scaffolds and the user guides in `docs/guide/`. The
wire format between runtime and connector processes is in [protocol](protocol.md); templates are in
[templates](templates.md); persistent fields are in [data model](data-model.md); routes are in
[api](api.md).

## 1. Overview

```
 author (editor · CLI · MCP · git)                 scantor binary (one implementation)
        │ edit                                      ┌──────────────────────────────────────────┐
        ▼                                           │ task pack ─► check-static ─► build ─►    │
 workspace/<userId>/<taskName>/  ──snapshot──────►  │ describe ─► check ─► push (by digest)    │
        │                                           └──────────────────────────────────────────┘
        ├── test run (draft image, local mode, not pushed)            │ NDJSON events, BuildError[]
        └── publish ──► revision echo@3 (queued → building → ready | failed) ──► scans pin it
```

A task is source code plus a Dockerfile. The platform never interprets user code itself: it builds the
image, injects the runtime ([runtime](runtime.md)), and talks to connector processes through the
connector protocol ([protocol](protocol.md)). Everything that touches a task folder (packing,
validation, Dockerfile policy, build, describe, check, push, scaffolding, workspace edits) is
implemented once in the Go binary and used identically by the orchestrator, the CLI and the editor.

## 2. Task folder

```
<task>/                         any name locally; equals the manifest name in a workspace
├── scantor.yaml                required: manifest (§3)
├── Dockerfile                  required: FROM ${SCANTOR_BASE} (§8)
├── main.py | main.ts | main.js required for source languages: the entry (§3, manifest `entry`)
├── main.go, go.mod, go.sum     Go: sources of the binary the Dockerfile builds
├── requirements.txt            optional dependency files (Python)
├── package.json, package-lock.json   optional (TypeScript/JavaScript)
├── .dockerignore               optional; also defines what the pack contains (§9.2)
├── .gitignore, AGENTS.md       scaffold files
├── .devcontainer/devcontainer.json, .vscode/{launch,tasks,settings}.json   scaffold files (§12)
└── anything else               allowed (libraries, data files, tests)
```

Rules:

| Rule | Checked by |
|---|---|
| `scantor.yaml` exists at the root (exact name; `scantor.yml` is not accepted) and is a regular file | `check-static` |
| `Dockerfile` exists at the root (exact name) and is a regular file | `check-static` |
| For `entryKind: source` languages, the entry exists in the folder as a regular file with an allowed extension | `check-static` |
| For `entryKind: binary` languages (Go), the entry exists in the built image and is executable | `describe` |
| Only regular files, directories and in-tree relative symlinks; no devices, FIFOs or sockets | `pack` |
| Paths are valid UTF-8, contain no NUL or backslash, segments ≤ 255 bytes, total ≤ 1024 bytes | `pack` |
| `.git/` and `.scantor/` are never part of a task (hard excludes) | `pack` |

`.scantor/` is the local scratch directory of the CLI (`scantor dev run` output under `.scantor/out/`).

## 3. Manifest `scantor.yaml`

The manifest is YAML 1.2 (parsed with `go.yaml.in/yaml/v3`; duplicate keys are an error; anchors are
allowed, but the expanded document may hold at most 131 072 values, 1 MiB of scalar text and 4 MiB of
instance paths (the JSON pointer of every value, which repeats every key above it), so nested aliases
or a long key above many values cannot multiply a small file; an error inside an aliased value is
reported at the alias) and validated by the strict JSON Schema `schemas/task-manifest.schema.json`
(`$id: https://scantor.dev/schemas/task-manifest.schema.json`), plus the semantic rules of §3.2. Editors
bind the schema with a modeline on the first line (unknown keys such as `$schema` are rejected, so the
schema is never referenced from inside the document):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/task-manifest.schema.json
```

The editor image and the devcontainer additionally map the embedded copy of the schema to `scantor.yaml`
through `yaml.schemas`, so completion works offline.

### 3.1 Fields

| Field | Type | Req | Default | Validation | Meaning |
|---|---|---|---|---|---|
| `scantor` | integer | ✓ | – | `const 1` | manifest format version |
| `name` | string | ✓ | – | `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`; not a uuid; not `upload`, `import-git`, `new`, `latest` | task name, unique per owner, immutable, equals the workspace folder name |
| `language` | string | ✓ | – | key of `schemas/languages.json`: `python`, `typescript`, `javascript`, `go` | selects base image and default entry |
| `description` | string | – | none | ≤ 500 characters | shown in UI, CLI and MCP |
| `entry` | string | – | `languages.json` `entry` (`main.py`, `main.ts`, `main.js`, `/task/task`) | 1–255 characters, no NUL or backslash; §3.2 | entry file (source languages) or binary path (Go) |
| `defaults` | object | – | `{}` | strict | default scan settings (below) |
| `defaults.workers` | integer | – | 1 | 1 … `SCANTOR_MAX_WORKERS_PER_SCAN` | runner workers per scan |
| `defaults.processes` | integer | – | 1 | 1 … `SCANTOR_MAX_PROCESSES_PER_WORKER` | connector processes per worker |
| `defaults.timeout` | duration | – | `5m` | 1s … 24h | per-analysis timeout |
| `defaults.maxAttempts` | integer | – | 3 | 1 … 20 | attempts per analysis per round |
| `defaults.backoff.initial` | duration | – | `5s` | ≥ 1s | first retry delay |
| `defaults.backoff.factor` | number | – | 2 | 1 … 10 | growth factor |
| `defaults.backoff.max` | duration | – | `10m` | ≥ `initial`, ≤ 24h | delay cap (also caps `Retry` delays) |
| `defaults.backoff.jitter` | boolean | – | `true` | – | delay uniform in [delay/2, delay] |
| `defaults.resources.cpus` | number | – | 1 | 0.1 … 64 | CPUs **per process** |
| `defaults.resources.memory` | byte size | – | `512MiB` | 64MiB … 64GiB, whole MiB | memory **per process** |
| `defaults.maxAnalysesPerProcess` | integer | – | 1000 | 1 … 1 000 000 | recycle a connector process after this many analyses |
| `defaults.privileged` | boolean | – | `false` | requires the owner's `canRunPrivileged` | Docker-in-Docker workers (sysbox/privileged nodes only, §8.3); not overridable per scan |

Value syntax:

- **duration**: a string of integer amounts with units `ms`, `s`, `m`, `h` (`30s`, `5m`, `1h30m`;
  pattern `^([0-9]+(ms|s|m|h))+$`; no fractions, no bare numbers).
- **byte size**: a string, non-negative integer with optional suffix `KiB`, `MiB`, `GiB`, `TiB`
  (`512MiB`, `2GiB`; pattern `^[0-9]+(KiB|MiB|GiB|TiB)?$`). A bare integer string means bytes.

There is no `template` key: the template a task uses is a property of its code and is reported by
describe (§7). A worker container gets `processes × cpus` CPUs and `processes × memory + 256 MiB` memory
([architecture](architecture.md) §11.2).

### 3.2 Semantic rules (enforced by `check-static`)

| Id | Rule | Error (`phase: static`, `file: scantor.yaml`) |
|---|---|---|
| M1 | YAML parses, has no duplicate keys, ≤ 64 KiB, expands (aliases included) to ≤ 131 072 values, ≤ 1 MiB of scalars and ≤ 4 MiB of instance paths, root is a mapping | `scantor.yaml:4: duplicate key "name"` |
| M2 | JSON Schema validation passes | one error per schema violation with the instance path, e.g. `/defaults/timeout: must match pattern …` |
| M3 | `language` exists in `languages.json` (schema enum and table are kept identical by a unit test) | |
| M4 | source languages: `entry` is relative, normalised (no `.`/`..` segments, no leading `./`), has an extension listed in `languages.json` `extensions`, and exists in the pack as a regular file | `entry "src/main.rs" must end in .ts or .mts` |
| M5 | binary languages: `entry` is a normalised absolute or relative path; existence is checked by describe | |
| M6 | durations parse and respect the bounds of §3.1; `backoff.max ≥ backoff.initial` | `/defaults/backoff/max: 2s is shorter than initial 5s` |
| M7 | `resources.memory` is a whole number of MiB within bounds | |
| M8 | `workers ≤ SCANTOR_MAX_WORKERS_PER_SCAN` and `processes ≤ SCANTOR_MAX_PROCESSES_PER_WORKER` as seen in the pipeline's environment (the orchestrator passes its own values; when unset, as for a native CLI, the binary uses compiled-in defaults equal to the `.env.example` defaults) | `/defaults/processes: 200 exceeds this instance's maximum 64` |
| M9 | with `--expect-name <n>`: `name == n` (the orchestrator passes the task name) | `name "echo2" does not match task "echo"; task names are immutable` |
| M10 | `privileged: true` only with `--allow-privileged` (the orchestrator passes it iff the owner has `canRunPrivileged`; the CLI always passes it for local builds, §9.1) | `privileged tasks require the canRunPrivileged permission` |

Reported line numbers come from the YAML node of the offending value.

### 3.3 Normalisation

The pipeline produces two normalised views (stored on the revision, [data model](data-model.md) §4.2):

- `manifest`: the parsed document as JSON with `entry` defaulted; `defaults` is kept as written (strings
  for durations and sizes).
- `settingsDefaults`: `ScanSettings` without `nodeSelector`, every value filled from the manifest or the
  fallbacks of §3.1, in platform units: `{workers, processes, timeoutMs, maxAttempts, backoff: {initialMs,
  factor, maxMs, jitter}, resources: {cpus, memoryMiB}, maxAnalysesPerProcess, privileged}`.

### 3.4 Examples

Minimal:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/task-manifest.schema.json
scantor: 1
name: echo
language: python
```

Full:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/task-manifest.schema.json
scantor: 1
name: origins-http
language: typescript
description: Fetch the landing page of every origin of a CrUX top list.
entry: main.ts
defaults:
  workers: 4
  processes: 8
  timeout: 2m
  maxAttempts: 3
  backoff:
    initial: 10s
    factor: 2
    max: 10m
    jitter: true
  resources:
    cpus: 0.5
    memory: 768MiB
  maxAnalysesPerProcess: 500
  privileged: false
```

Normalised `settingsDefaults` of the full example:
`{"workers": 4, "processes": 8, "timeoutMs": 120000, "maxAttempts": 3, "backoff": {"initialMs": 10000,
"factor": 2, "maxMs": 600000, "jitter": true}, "resources": {"cpus": 0.5, "memoryMiB": 768},
"maxAnalysesPerProcess": 500, "privileged": false}`.

## 4. Languages and base images

### 4.1 `schemas/languages.json`

The single language table (data, not a schema). The Go binary (`internal/languages`) and the
orchestrator read it; nothing else in the platform contains per-language knowledge.

| Field | Meaning |
|---|---|
| `version` | table format version (1) |
| `commonEditorExtensions` | VS Code extensions for every language (`redhat.vscode-yaml`) |
| `languages.<language>.title` | display name |
| `languages.<language>.base` | base image family (`python`, `js`, `go`); TypeScript and JavaScript share `js` |
| `languages.<language>.image` | base image name without registry prefix and tag (`scantor-base-js`) |
| `languages.<language>.entry` | default manifest `entry` |
| `languages.<language>.entryKind` | `source` (entry is a file in the task folder) or `binary` (entry is built by the Dockerfile) |
| `languages.<language>.extensions` | allowed entry extensions; also used by editors and the UI |
| `languages.<language>.scaffold` | scaffold directory (§12) |
| `languages.<language>.guide` | user guide embedded for `getAuthoringGuide` |
| `languages.<language>.editorExtensions` | VS Code extensions for the scaffold devcontainer, the editor image and the devcontainer of this repo |

Base image reference: `<prefix><image>:<tag>`, with the image-reference rule of
[architecture](architecture.md) §4.2: the pair defaults to the compiled-in `internal/version` values
(`ImagePrefix`, `Version`: `ghcr.io/lonetis/` and the release version for release builds, an empty prefix
and `dev` for development builds); whenever `SCANTOR_IMAGE_TAG` is non-empty, `SCANTOR_IMAGE_PREFIX` /
`SCANTOR_IMAGE_TAG` replace the pair. The orchestrator passes its own values to every `scantor task …`
subprocess, so revisions and test runs build on the deployment's base images; a native CLI normally sets
neither and uses its own version. `GET /api/languages` returns the computed reference as `baseImage`.

### 4.2 Base image ENV contract

Every base image (`connectors/<base>/Dockerfile`) sets `WORKDIR /task` and these variables. The runtime,
the task pipeline and the CLI read them from the image config or the container environment and contain
**no language switch**.

| Variable | `scantor-base-python` | `scantor-base-js` | `scantor-base-go` |
|---|---|---|---|
| `SCANTOR_LANGUAGE` (space-separated languages the image serves) | `python` | `typescript javascript` | `go` |
| `SCANTOR_CONNECTOR_CMD` | `python -m scantor.serve {entry}` | `node /node_modules/@scantor/connector/serve.js {entry}` | `{entry}` |
| `SCANTOR_CHECK_CMD` | `python -m scantor.check {entry}` | `node /node_modules/@scantor/connector/check.js {entry}` | `/opt/scantor/bin/scantor-go-check` |
| `SCANTOR_DEBUG_CMD` | `python -m debugpy --listen 0.0.0.0:5678 --wait-for-client -m scantor.serve {entry}` | `node --inspect-brk=0.0.0.0:9229 /node_modules/@scantor/connector/serve.js {entry}` | `dlv exec --headless --listen=0.0.0.0:2345 --api-version=2 --accept-multiclient {entry}` |
| `SCANTOR_DEBUG_PORT` | `5678` | `9229` | `2345` |

Command templates ([runtime](runtime.md) §3.3): the value is split into arguments on ASCII whitespace; a
double-quoted span is one argument (escapes `\"` and `\\`); there is no shell. The only placeholder is
`{entry}`, replaced in every argument by the manifest entry; a relative entry is relative to the working
directory `/task`, in which every command runs. The debug port is written literally into
`SCANTOR_DEBUG_CMD` and repeated in `SCANTOR_DEBUG_PORT`. The runtime learns the entry from
`revision.entry` in `GET /api/runtime/bootstrap` (worker mode), from `--entry` (describe and check) or
from `entry` in the local-mode spec (§11.3). A Dockerfile may override
these variables (for example `ENV SCANTOR_CONNECTOR_CMD="xvfb-run -a python -m scantor.serve {entry}"`
for headful browsers); static validation emits a warning for every overridden `SCANTOR_*` variable.

`SCANTOR_CHECK_CMD` contract: runs in `/task` without network; prints every error as one line
`<file>:<line>[:<column>]: <message>` (`file` relative to `/task`, 1-based numbers; such lines become
BuildErrors, other output becomes log lines, [runtime](runtime.md) §16); exits 0 when there is no error
and non-zero otherwise. The commands wrap basedpyright (standard
mode, honouring the task's `pyrightconfig.json`/`pyproject.toml`), `tsc --noEmit` (the task's
`tsconfig.json`/`jsconfig.json`, else the connector's default config) and `go vet ./...`. A task that
needs a different strictness configures the tool in its own config file. When the image no longer
contains sources (for example a multi-stage Go build), the check command reports a single warning and
exits 0.

Additional base image environment (not part of the contract, documented for authors):

| Image | Variables |
|---|---|
| python | `PIP_CONSTRAINT=/opt/scantor/constraints.txt`, `UV_CONSTRAINT=/opt/scantor/constraints.txt`, `PYTHONHASHSEED=0`, `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`, `PIP_NO_CACHE_DIR=1`, `PIP_DISABLE_PIP_VERSION_CHECK=1`, `PIP_ROOT_USER_ACTION=ignore` |
| js | none beyond the contract (Node 26 strips TypeScript types natively) |
| go | `GOTOOLCHAIN=local`, `GOFLAGS=-modcacherw`, `GOMODCACHE=/go/pkg/mod` (pre-seeded) |

Every base image ships the system CA bundle (`/etc/ssl/certs/ca-certificates.crt`): the injected runtime
verifies TLS for S3, AMQPS and the template data sources against the system roots (plus `SCANTOR_CA_CERT`,
[nodes](nodes.md) §11), so a base on a slim image that lacks it installs `ca-certificates`.

Base images run as root by default; a task may switch with `USER` (privileged tasks must keep root, §8.3).
The injected runtime binary is world-executable and `/tmp` is world-writable, so any user works. Worker
containers have no tmpfs at `/tmp`: the runtime's work root `/tmp/scantor` lives on the container's
disk-backed writable layer ([runtime](runtime.md) §7.1).

### 4.3 Dependency isolation

User dependencies must never replace or duplicate the connector's own.

| Language | Mechanism | Failure mode |
|---|---|---|
| Python | The connector and its pinned dependencies (pydantic, pydantic-core, typing-extensions, annotated-types, typing-inspection) are installed system-wide; `PIP_CONSTRAINT`/`UV_CONSTRAINT` point at `/opt/scantor/constraints.txt` with the exact pins. | A `requirements.txt` that needs another pydantic fails loudly at `pip install` (build phase). |
| TypeScript/JavaScript | `@scantor/connector` lives at `/node_modules/@scantor/connector` with zod (and its other dependencies) **nested** in its own `node_modules`; it re-exports `z`. Root `/node_modules` also holds `typescript` 6.0.x and `@types/node` for the check. Task code imports `z` only from `@scantor/connector`; scaffolds never list zod or the connector in `package.json`. | describe fails when `/task/node_modules/@scantor/connector` exists (shadowing) or when a schema was not created with the connector's `z` (instance check). |
| Go | The connector module `github.com/lonetis/scantor/connectors/go` (dependencies: stdlib and `github.com/invopop/jsonschema` only) lives at `/opt/scantor/connectors/go`; task `go.mod` files use `replace github.com/lonetis/scantor/connectors/go => /opt/scantor/connectors/go`; `GOMODCACHE` is pre-seeded with the connector's dependencies at the pinned versions so scaffolded tasks build offline; `GOTOOLCHAIN=local` prevents toolchain downloads. | Minimal version selection may raise a connector dependency when the task requires a newer version; semver-compatible by construction. |

The editor image and this repository's devcontainer install the connectors at the same paths so
IntelliSense resolves imports ([editor](editor.md), [development](development.md)).

## 5. Definition API

### 5.1 Common model

Every task defines up to four types and two functions:

| Element | Python | TypeScript / JavaScript | Go | Required |
|---|---|---|---|---|
| task config type | `task_config=` | `taskConfig:` | type parameter `TC` | no (default `Empty`) |
| scan config type | `scan_config=` | `scanConfig:` | `SC` | no (default `Empty`) |
| analysis config type | `analysis_config=` | `analysisConfig:` | `AC` | no (default `Empty`) |
| result type | `result=` | `result:` | `R` | **yes** |
| `schedule(ctx, scanConfig, taskConfig) → stream of AnalysisConfig` | `schedule=` | `schedule` | first argument of `Serve` | no: omitted means template `single` |
| `run(ctx, analysisConfig, taskConfig) → Result` | `run=` | `run` | second argument of `Serve` | **yes** |

- `schedule` runs once per scan in the scheduler worker; `run` runs once per attempt of an analysis in a
  runner worker. `run` never sees the scan config: whatever `run` needs per analysis must be in the
  analysis config, whatever is constant goes into the task config.
- `schedule` must be **deterministic** for a given effective scan config and task config: the scheduler
  resumes by replaying the stream and verifying a hash ([templates](templates.md) §6). Do expensive or
  non-deterministic work in `run`, never in `schedule`. Templates pin their own non-deterministic inputs.
- A template's proxy `schedule` can be passed **unwrapped** (`schedule=tranco.schedule`): describe then
  reports `{kind: "template", template: "tranco"}`, the scheduler runs it natively in the runtime, and the
  task's scan config and analysis config types must be the template's own types (Python: omitted or
  identical; TypeScript/JavaScript: omitted or the template's exported schemas; Go: enforced by type
  inference). Any other use, including calling the proxy inside a custom generator to filter or extend
  it, is **wrapped** and runs through the connector protocol ([templates](templates.md) §3).
- `Empty` is a closed config type with no fields: JSON Schema `{"type": "object", "properties": {},
  "additionalProperties": false}`, value `{}`.
- Without a `schedule` (template `single`) every scan has one analysis whose analysis config is `{}`
  with the analysis config type's defaults filled in. The scan config must then be `Empty`: Python and
  TypeScript/JavaScript raise a definition error at import, and for Go describe fails (§7). The analysis
  config may be the task's own type; describe warns when it rejects `{}`.

### 5.2 `ctx`

`ctx` is passed per call, never global, so per-process multiplexing can be added later.

| Concept | Python | TypeScript / JavaScript | Go | Value in `schedule` |
|---|---|---|---|---|
| scan id | `ctx.scan_id: str` | `ctx.scanId: string` | `ctx.ScanID() string` | same |
| analysis id | `ctx.analysis_id: str \| None` | `ctx.analysisId: string \| null` | `ctx.AnalysisID() string` | `None` / `null` / `""` |
| seq | `ctx.seq: int \| None` | `ctx.seq: number \| null` | `ctx.Seq() int64` | `None` / `null` / `-1` |
| attempt (1-based) | `ctx.attempt: int` | `ctx.attempt: number` | `ctx.Attempt() int` | scheduler start count |
| deadline | `ctx.deadline: float \| None` (epoch seconds), `ctx.remaining() -> float \| None` (seconds) | `ctx.deadline: number \| null` (epoch ms) | `ctx.Deadline()` (`context.Context`) | none |
| cancellation | `ctx.cancelled: bool`; async code receives `asyncio.CancelledError` | `ctx.signal: AbortSignal` | `ctx.Done()` (`context.Context`) | on drain/stop |
| log | `ctx.log(level, message, **fields)` | `ctx.log(level, message, fields?)` | `ctx.Log(level, msg, kv ...any)` | yes |
| progress | `ctx.progress(fraction=None, message=None)` | `ctx.progress(fraction, message?)` | `ctx.Progress(fraction float64, message string)` (fraction < 0 = unknown) | ignored |
| files | `ctx.files.put(name, data, content_type=None) -> FileRef`; `await ctx.files.aput(…)` | `await ctx.files.put(name, data, contentType?)` | `ctx.Files().Put(name, data, contentType)`, `ctx.Files().PutFile(name, path, contentType)` | not allowed (raises `validation`) |
| scratch directory | `ctx.tmp_dir: pathlib.Path` | `ctx.tmpDir: string` | `ctx.TmpDir() string` | yes |

- Log levels: `debug`, `info`, `warning`, `error` (Go constants `scantor.LevelDebug`, `LevelInfo`,
  `LevelWarning`, `LevelError`). Log lines and captured stdout/stderr form the analysis log tail
  ([protocol](protocol.md) §8). `ctx.log` is the documented way to log; plain prints are also captured.
- `files.put` data: Python `bytes` (content), `str` (UTF-8 text content) or `os.PathLike` (an existing
  file); TypeScript `Uint8Array` (content), `string` (UTF-8 text) or `{path: string}`; Go `Put([]byte)` and
  `PutFile(path)`. `name` is 1–255 characters without `/`, `\` and NUL, unique within the analysis
  attempt. `contentType` defaults to `application/octet-stream` (pass it explicitly for images to be
  shown inline) and is at most 255 characters long (Python, TypeScript and JavaScript also reject an
  empty one; Go treats it as the default). `put` writes or copies the content into the execution's
  files directory (later changes to a user path do not matter), waits for the runtime to hash it and
  returns the `FileRef` at once; the runtime uploads the files only after `run` succeeded, so files of
  failed attempts are discarded and uploads do not count toward the timeout ([protocol](protocol.md)
  §5.6). At most `SCANTOR_MAX_FILES_PER_ANALYSIS` files of at most `SCANTOR_MAX_FILE_BYTES` each;
  violations raise a `ScantorError` of type `validation`. Connectors reject a name or content type that
  breaks the rules themselves, before any `file` message is sent (the runtime treats a `file` message
  outside its schema as a protocol violation); the runtime enforces the size and count limits
  ([protocol](protocol.md) §5.6; connectors may check them early).
- `tmp_dir` is empty at the start of each call, private to it, under the runtime's work root
  `/tmp/scantor` (disk-backed, not a tmpfs), and deleted afterwards.

### 5.3 `FileRef`

A file reference `{id, name, size, sha256, contentType}` ([data model](data-model.md) §4.6). Every
connector provides a `FileRef` type whose JSON Schema carries `"x-scantor": "file"`; results contain
FileRefs (directly, nested, or in arrays) and the UI renders them as download links. Python exposes the
attribute `content_type` and serialises it as `contentType` (pydantic `serialize_by_alias`).

### 5.4 Errors

| Raised from `run` | Error `type` | Retryable | Effect |
|---|---|---|---|
| `Fatal(message)` | `fatal` | no | the analysis fails now |
| `Retry(message, delay?)` | `retry` | yes | next attempt after `delay` (default: backoff), clamped to [1 s, `backoff.max`]; counts toward `maxAttempts` |
| invalid analysis/task config, invalid or non-JSON result | `validation` | no | fails now; `details.issues` lists the paths |
| a native model validation error raised by task code (pydantic `ValidationError`, a zod error) | `validation` | no | fails now; the same input cannot pass on a retry |
| any other exception, Go `error`, Go panic | `taskError` | yes | next attempt after the backoff delay; the stack is kept |
| `ScantorError` from `ctx.files` or a template stream, uncaught | `validation` stays `validation`; other types become `taskError` | per type | e.g. `validation` for a file over the size limit |
| deadline exceeded | `timeout` | yes | process group killed and process recycled |
| process exit, OOM kill | `crash` | yes | process recycled |

In `schedule`: `Fatal` fails scheduling (the scan ends `failed` after the published analyses finish);
`Retry` and other exceptions restart the scheduler after the delay or backoff, at most
`SCANTOR_SCHEDULER_MAX_RESTARTS` times; `validation` errors fail scheduling. Retry delay units: Python
seconds (`float` or `datetime.timedelta`), TypeScript/JavaScript milliseconds, Go `time.Duration`;
milliseconds on the wire. A delay that cannot be sent fails where the `Retry` is created, so the error
points at task code: Python raises `TypeError` for a non-number and `ValueError` for NaN or ±infinity
(a negative delay counts as 0), TypeScript/JavaScript throw a `RangeError` for a negative or non-finite
delay. Classification and the full `ScantorError` are owned by the runtime
([runtime](runtime.md), [protocol](protocol.md) §7).

### 5.5 Sync and async

| Language | `run` | `schedule` | Cancellation |
|---|---|---|---|
| Python | `def` or `async def` returning the Result (instance or `dict`) | generator, async generator, or function returning an iterable / async iterable | async code: `CancelledError` at the next `await`; sync code: `ctx.cancelled` becomes `True` |
| TypeScript / JavaScript | function returning the Result or a Promise of it | generator, async generator, or function returning an iterable / async iterable / array | `ctx.signal` aborts; pass it to `fetch` and other APIs |
| Go | `func(ctx, ac, tc) (R, error)` | `func(ctx, sc, tc) iter.Seq2[AC, error]` | `ctx.Done()` |

Cancellation fires at `ctx.deadline` (the connector's own timer) and when the runtime sends `cancel`
(drain, stop). The runtime kills the process group at the deadline, so cleanup must not rely on running
after it: budget with `ctx.deadline`/`ctx.remaining()` ([protocol](protocol.md) §10.4). Each connector
process handles one call at a time in protocol v1, so blocking synchronous code is fine.
Yielded or returned values may be native model instances or plain objects/dicts; the connector validates
them with the declared model and serialises them in JSON mode.

### 5.6 Python

Package `scantor` (connector `connectors/python`, installed in `scantor-base-python`). The entry is a
module that defines a module-level `task`. The launcher puts the entry's directory first on `sys.path`,
imports the entry and reads the attribute `task`.

```python
# Public surface of the scantor package (signatures)
class Config(pydantic.BaseModel):            # model_config = ConfigDict(extra="forbid")
    ...
class Empty(Config): ...                     # no fields

TC = TypeVar("TC", bound=pydantic.BaseModel, default=Empty)   # PEP 696 defaults: an omitted type is Empty
SC = TypeVar("SC", bound=pydantic.BaseModel, default=Empty)
AC = TypeVar("AC", bound=pydantic.BaseModel, default=Empty)
R = TypeVar("R", bound=pydantic.BaseModel)

class FileRef(pydantic.BaseModel):           # frozen; JSON Schema "x-scantor": "file"
    id: str; name: str; size: int; sha256: str; content_type: str  # JSON: contentType

class Files:
    def put(self, name: str, data: bytes | str | os.PathLike[str], content_type: str | None = None) -> FileRef: ...
    async def aput(self, name: str, data: bytes | str | os.PathLike[str], content_type: str | None = None) -> FileRef: ...

class Context:
    scan_id: str; analysis_id: str | None; seq: int | None; attempt: int
    deadline: float | None; tmp_dir: pathlib.Path; files: Files
    @property
    def cancelled(self) -> bool: ...
    def remaining(self) -> float | None: ...
    def log(self, level: Literal["debug", "info", "warning", "error"], message: str, **fields: Any) -> None: ...
    def progress(self, fraction: float | None = None, message: str | None = None) -> None: ...

class Fatal(Exception):
    def __init__(self, message: str) -> None: ...
class Retry(Exception):
    def __init__(self, message: str, delay: float | datetime.timedelta | None = None) -> None: ...
class ScantorError(Exception):               # raised by ctx.files and template streams
    type: str; retryable: bool; message: str

class Task(Generic[TC, SC, AC, R]):
    def __init__(
        self, *,
        result: type[R],
        run: Callable[[Context, AC, TC], R | Awaitable[R]],
        task_config: type[TC] | None = None,     # None: Empty
        scan_config: type[SC] | None = None,     # None: Empty, or the unwrapped template's own type
        analysis_config: type[AC] | None = None, # None: Empty, or the unwrapped template's own type
        schedule: Callable[[Context, SC, TC], Iterable[AC] | AsyncIterable[AC]] | None = None,
    ) -> None: ...
```

Rules: config types derive from `scantor.Config` (describe fails when a config root accepts unknown
keys, §6.2); the result type is any `pydantic.BaseModel`; `pydantic.SecretStr` marks secrets; `run` and
`schedule` may also return or yield plain dicts (§5.5);
`Task(...)` raises `TypeError` at import for a missing `result`/`run` or non-model types. basedpyright
(standard mode) checks the signatures: a wrong return type, wrong parameter types and swapped parameters
are errors.

Minimal (template `single`):

```python
import scantor
from pydantic import BaseModel


class TaskConfig(scantor.Config):
    greeting: str = "Hello"


class Result(BaseModel):
    text: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(text=f"{task_config.greeting}, world!")


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
```

Full (wrapped Tranco schedule, async run, secret, files, retries; `requirements.txt` contains
`httpx>=0.28.1,<1`):

```python
from collections.abc import Iterator

import httpx
from pydantic import BaseModel, SecretStr

import scantor
from scantor.templates import tranco


class TaskConfig(scantor.Config):
    user_agent: str = "scantor-example/1.0"
    api_token: SecretStr = SecretStr("")          # writeOnly: masked in every API response
    save_body: bool = True


class ScanConfig(tranco.ScanConfig):              # template fields plus our own
    skip_tlds: list[str] = ["cn"]


class AnalysisConfig(scantor.Config):
    url: str
    rank: int


class Result(BaseModel):
    status: int
    title: str | None
    body: scantor.FileRef | None


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    for item in tranco.schedule(ctx, scan_config):  # wrapped: streamed from the runtime
        if item.domain.rsplit(".", 1)[-1] not in scan_config.skip_tlds:
            yield AnalysisConfig(url=f"https://{item.domain}/", rank=item.rank)


async def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    headers = {"user-agent": task_config.user_agent}
    if task_config.api_token.get_secret_value():
        headers["authorization"] = f"Bearer {task_config.api_token.get_secret_value()}"
    async with httpx.AsyncClient(timeout=ctx.remaining(), follow_redirects=True) as client:
        try:
            response = await client.get(analysis_config.url, headers=headers)
        except httpx.ConnectError as exc:
            raise scantor.Fatal(f"cannot connect: {exc}")      # no point retrying
    if response.status_code == 429:
        raise scantor.Retry("rate limited", delay=float(response.headers.get("retry-after", "60")))
    ctx.log("info", "fetched", status=response.status_code, bytes=len(response.content))
    body = await ctx.files.aput("body.html", response.content, "text/html") if task_config.save_body else None
    title = response.text.split("<title>", 1)[-1].split("</title>", 1)[0].strip() if "<title>" in response.text else None
    return Result(status=response.status_code, title=title, body=body)


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
```

### 5.7 TypeScript

Package `@scantor/connector` (connector `connectors/js`, at `/node_modules/@scantor/connector` in
`scantor-base-js`). The entry's `default` export is the value returned by `defineTask`. TypeScript runs
through Node 26 native type stripping (no build step): only erasable syntax is allowed (no `enum`, no
`namespace`, no parameter properties), enforced by `erasableSyntaxOnly` in the scaffold `tsconfig.json`.
Local imports use the `.ts` extension (`allowImportingTsExtensions`). The connector itself is the
exception: Node refuses to strip types under `node_modules`, so `scantor-base-js` (and the editor image)
ship it as JavaScript plus declarations (`dist/`) compiled by `tsc` from `connectors/js/src/*.ts`. The
repository's own tests run the sources directly through the package export condition `scantor-source`
(`node --conditions=scantor-source`), which the installed `package.json` drops.

```ts
// Public surface of @scantor/connector (type parameters simplified)
export { z } from "zod";                                   // the only zod instance task code may use
export function config<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape, z.core.$strict>; // = z.strictObject
export const Empty: z.ZodObject<{}, z.core.$strict>;
export function secret(): z.ZodString;                     // z.string().meta({ writeOnly: true })
export const FileRef: z.ZodObject<{ id: z.ZodString; name: z.ZodString; size: z.ZodNumber; sha256: z.ZodString; contentType: z.ZodString }>; // meta {"x-scantor": "file"}
export type FileRef = z.output<typeof FileRef>;

export type LogLevel = "debug" | "info" | "warning" | "error";
export interface Context {
  readonly scanId: string;
  readonly analysisId: string | null;
  readonly seq: number | null;
  readonly attempt: number;
  readonly deadline: number | null;                        // epoch ms
  readonly signal: AbortSignal;
  readonly tmpDir: string;
  readonly files: { put(name: string, data: Uint8Array | string | { path: string }, contentType?: string): Promise<FileRef> };
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  progress(fraction: number | null, message?: string): void;
}

export class Fatal extends Error { constructor(message: string); }
export class Retry extends Error { constructor(message: string, delayMs?: number); }
export class ScantorError extends Error { readonly type: string; readonly retryable: boolean; }
export class TaskDefinitionError extends TypeError {}       // thrown by defineTask for an invalid definition

type ConfigSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;
export function defineTask<
  TC extends ConfigSchema = typeof Empty,
  SC extends ConfigSchema = typeof Empty,
  AC extends ConfigSchema = typeof Empty,
  R extends z.ZodType = z.ZodType,
>(definition: {
  taskConfig?: TC;
  scanConfig?: SC;
  analysisConfig?: AC;
  result: R;
  schedule?: (ctx: Context, scanConfig: z.output<SC>, taskConfig: z.output<TC>) =>
    Iterable<z.input<AC>> | AsyncIterable<z.input<AC>>;
  run: (ctx: Context, analysisConfig: z.output<AC>, taskConfig: z.output<TC>) => z.input<R> | Promise<z.input<R>>;
}): TaskDefinition<TC, SC, AC, R>;
```

Templates: `import { tranco } from "@scantor/connector/templates"` gives `tranco.ScanConfig`,
`tranco.AnalysisConfig` (strict zod schemas) and `tranco.schedule`. Rules: config schemas are built with
`config()` (or `z.strictObject`); `z.object` at a config root fails describe (it strips unknown keys); the
result may use `z.object`; without a `schedule`, `scanConfig` must be omitted (§5.1). tsc 6.0 checks the
definition: a wrong field in `run`, a wrong yielded type and a wrong return type are errors.

Minimal:

```ts
import { config, defineTask, z } from "@scantor/connector";

export default defineTask({
  taskConfig: config({ greeting: z.string().default("Hello") }),
  result: z.object({ text: z.string() }),
  run: (ctx, analysisConfig, taskConfig) => ({ text: `${taskConfig.greeting}, world!` }),
});
```

Full (unwrapped CrUX template, fetch with cancellation, files, secret, retries):

```ts
import { config, defineTask, FileRef, Fatal, Retry, secret, z } from "@scantor/connector";
import { crux } from "@scantor/connector/templates";

export default defineTask({
  taskConfig: config({
    userAgent: z.string().default("scantor-example/1.0"),
    proxyToken: secret().default(""),
    maxBodyBytes: z.number().int().min(0).max(10_000_000).default(1_000_000),
  }),
  scanConfig: crux.ScanConfig,
  analysisConfig: crux.AnalysisConfig,
  result: z.object({
    status: z.number().int(),
    finalUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    body: FileRef.nullable(),
  }),
  schedule: crux.schedule, // unwrapped: runs natively in the scheduler
  async run(ctx, analysisConfig, taskConfig) {
    const headers: Record<string, string> = { "user-agent": taskConfig.userAgent };
    if (taskConfig.proxyToken) headers["proxy-authorization"] = `Bearer ${taskConfig.proxyToken}`;
    let response: Response;
    try {
      response = await fetch(analysisConfig.origin, { headers, redirect: "follow", signal: ctx.signal });
    } catch (error) {
      if (ctx.signal.aborted) throw error;                     // cancelled: the runtime classifies it
      throw new Fatal(`fetch failed: ${(error as Error).message}`);
    }
    if (response.status === 429) throw new Retry("rate limited", 60_000);
    const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, taskConfig.maxBodyBytes);
    ctx.log("info", "fetched", { status: response.status, bytes: bytes.length });
    return {
      status: response.status,
      finalUrl: response.url,
      headers: Object.fromEntries(response.headers),
      body: bytes.length > 0 ? await ctx.files.put("body.html", bytes, "text/html") : null,
    };
  },
});
```

### 5.8 JavaScript

Same package and API as TypeScript. JavaScript entries start with `// @ts-check` and the scaffold ships
`jsconfig.json` with `checkJs: true`, so `tsc` (the check phase) infers and checks the same types from the
schema objects; no JSDoc is needed for the definition itself.

Minimal:

```js
// @ts-check
import { config, defineTask, z } from "@scantor/connector";

export default defineTask({
  taskConfig: config({ greeting: z.string().default("Hello") }),
  result: z.object({ text: z.string() }),
  run: (ctx, analysisConfig, taskConfig) => ({ text: `${taskConfig.greeting}, world!` }),
});
```

Full (custom generator wrapping the `range` template, sync run, files from a path):

```js
// @ts-check
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, defineTask, FileRef, Fatal, z } from "@scantor/connector";
import { range } from "@scantor/connector/templates";

export default defineTask({
  taskConfig: config({ exponent: z.number().int().min(0).max(64).default(2) }),
  scanConfig: config({ start: z.number().int().default(1), end: z.number().int().default(11), onlyOdd: z.boolean().default(false) }),
  analysisConfig: config({ base: z.number().int() }),
  result: z.object({ power: z.string(), report: FileRef }),
  async *schedule(ctx, scanConfig) {
    for await (const item of range.schedule(ctx, { start: scanConfig.start, end: scanConfig.end, step: 1 })) {
      if (!scanConfig.onlyOdd || item.value % 2 !== 0) yield { base: item.value };
    }
  },
  async run(ctx, analysisConfig, taskConfig) {
    if (analysisConfig.base < 0) throw new Fatal("negative bases are not supported"); // retrying cannot help
    const power = (BigInt(analysisConfig.base) ** BigInt(taskConfig.exponent)).toString(); // big ints as strings
    const path = join(ctx.tmpDir, "report.txt");
    await writeFile(path, `${analysisConfig.base}^${taskConfig.exponent} = ${power}\n`);
    return { power, report: await ctx.files.put("report.txt", { path }) };
  },
});
```

### 5.9 Go

Module `github.com/lonetis/scantor/connectors/go`, package `scantor` (at `/opt/scantor/connectors/go` in
`scantor-base-go`). The Dockerfile builds the binary named by `entry` (default `/task/task`); its `main`
calls `scantor.Serve` or `scantor.ServeRun`, which block until the runtime shuts the process down and
then exit the process.

```go
package scantor // import "github.com/lonetis/scantor/connectors/go"

type Empty struct{}                          // {"type":"object","properties":{},"additionalProperties":false}
type Secret string                           // {"type":"string","writeOnly":true}
type FileRef struct {                        // schema carries "x-scantor": "file"
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

type Level string

const (
	LevelDebug   Level = "debug"
	LevelInfo    Level = "info"
	LevelWarning Level = "warning"
	LevelError   Level = "error"
)

type Files interface {
	Put(name string, data []byte, contentType string) (FileRef, error) // contentType "" = application/octet-stream
	PutFile(name, path, contentType string) (FileRef, error)
}

type Context interface {
	context.Context                          // Deadline(), Done(), Err()
	ScanID() string
	AnalysisID() string                      // "" in schedule
	Seq() int64                              // -1 in schedule
	Attempt() int
	TmpDir() string
	Log(level Level, msg string, kv ...any)
	Progress(fraction float64, message string) // fraction < 0 = unknown
	Files() Files
}

func Fatal(msg string) error
func Fatalf(format string, args ...any) error
func Retry(msg string, delay time.Duration) error // delay 0 = use the backoff
type Error struct {                               // returned by Files and template streams
	Type      string
	Message   string
	Retryable bool
}

func Serve[TC, SC, AC, R any](
	schedule func(ctx Context, scanConfig SC, taskConfig TC) iter.Seq2[AC, error],
	run func(ctx Context, analysisConfig AC, taskConfig TC) (R, error),
)
func ServeRun[TC, R any](run func(ctx Context, analysisConfig Empty, taskConfig TC) (R, error)) // = Serve(single.Schedule, run)
```

Rules:

- Type parameters are inferred from the two functions, including an uninstantiated generic template
  function (`scantor.Serve(tranco.Schedule, run)`). Errors wrapped with `%w` are recognised
  (`errors.As`). Panics in `run` or `schedule` are recovered and reported as `taskError` with the stack.
- Schemas are reflected with `invopop/jsonschema` (configs: `RequiredFromJSONSchemaTags: true`, so fields
  are optional unless tagged `jsonschema:"required"`; result: every non-`omitempty` field is required;
  all structs are closed). Defaults and bounds use tags (`jsonschema:"default=Hello,minLength=1"`); tag
  defaults are converted to the field's Go type, and `default=null` (pointer fields), `default=[]`
  (slices) and `default={}` (structs, maps) are supported; a default that does not convert is a
  definition error. Pointer fields are nullable (`type: [X, "null"]`).
- Go structs have no native defaults or constraints, so the connector fills missing defaults from the
  schema it exports (the semantics of §6.3) and validates every config, yielded analysis config,
  template item and result against that schema with a built-in validator for the subset of §6.4, then
  decodes with `DisallowUnknownFields`. Nil slices and maps are sent as `[]` and `{}` where the schema
  expects a non-nullable array or object.
- `Serve` with a nil schedule (explicit type arguments) is template `single`, like `ServeRun`.
- Template config structs use `omitempty` on every field whose zero value is not a valid value, so a
  partially filled struct passed to a wrapped template call gets the canonical defaults.
- Templates live in `github.com/lonetis/scantor/connectors/go/templates/<name>` with `ScanConfig`,
  `AnalysisConfig` and a generic `Schedule[TC any]`. Unwrapped use is detected by the function symbol
  (`runtime.FuncForPC`) belonging to that package. The proxy of `range` lives at `templates/range` but
  its package is named `ranges`, because `range` is a Go keyword.
- `Files.Put`/`PutFile` with an empty content type send `null` (= `application/octet-stream`, §5.2).

Minimal:

```go
package main

import scantor "github.com/lonetis/scantor/connectors/go"

type TaskConfig struct {
	Greeting string `json:"greeting" jsonschema:"default=Hello"`
}

type Result struct {
	Text string `json:"text"`
}

func run(ctx scantor.Context, _ scantor.Empty, tc TaskConfig) (Result, error) {
	return Result{Text: tc.Greeting + ", world!"}, nil
}

func main() { scantor.ServeRun(run) }
```

Full (unwrapped CIDR template, TCP port probe):

```go
package main

import (
	"errors"
	"net"
	"strconv"
	"syscall"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/templates/cidr"
)

type TaskConfig struct {
	Ports     []int `json:"ports,omitempty" jsonschema:"maxItems=64,description=ports to probe (default 80 and 443)"`
	TimeoutMs int   `json:"timeoutMs" jsonschema:"default=2000,minimum=100,maximum=60000"`
}

type Result struct {
	Open   []int `json:"open"`
	Closed []int `json:"closed"`
}

func run(ctx scantor.Context, ac cidr.AnalysisConfig, tc TaskConfig) (Result, error) {
	if ac.Prefix != 32 && ac.Prefix != 128 {
		return Result{}, scantor.Fatal("this task probes single addresses; leave prefix unset")
	}
	ports := tc.Ports
	if len(ports) == 0 {
		ports = []int{80, 443}
	}
	res := Result{Open: []int{}, Closed: []int{}}
	dialer := net.Dialer{Timeout: time.Duration(tc.TimeoutMs) * time.Millisecond}
	for _, port := range ports {
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(ac.IP, strconv.Itoa(port)))
		switch {
		case err == nil:
			conn.Close()
			res.Open = append(res.Open, port)
		case errors.Is(err, syscall.ENETUNREACH):
			return Result{}, scantor.Retry("network unreachable", 30*time.Second)
		default:
			res.Closed = append(res.Closed, port)
		}
	}
	ctx.Log(scantor.LevelInfo, "probed", "ip", ac.IP, "open", len(res.Open))
	return res, nil
}

func main() { scantor.Serve(cidr.Schedule, run) }
```

Wrapping a template in Go (custom schedule):

```go
func schedule(ctx scantor.Context, sc ScanConfig, tc TaskConfig) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for item, err := range tranco.Schedule(ctx, sc.ScanConfig, tc) { // embedded tranco.ScanConfig
			if err != nil {
				yield(AnalysisConfig{}, err)
				return
			}
			if !strings.HasSuffix(item.Domain, ".cn") && !yield(AnalysisConfig{URL: "https://" + item.Domain + "/"}, nil) {
				return // stopping early cancels the template stream
			}
		}
	}
}
```

## 6. Config schemas

### 6.1 Export mode

| Type | Mode | Python | TypeScript / JavaScript | Go |
|---|---|---|---|---|
| task config, scan config, analysis config | **input** (validation): fields with defaults are not `required` | `model_json_schema(mode="validation")` | `z.toJSONSchema(s, {io: "input", target: "draft-2020-12", unrepresentable: "throw"})` | invopop, `RequiredFromJSONSchemaTags: true` |
| result | **output** (serialization) | `model_json_schema(mode="serialization")` | `z.toJSONSchema(s, {io: "output", target: "draft-2020-12", unrepresentable: "throw"})` | invopop, `RequiredFromJSONSchemaTags: false` |

All schemas are JSON Schema draft 2020-12. The runtime normalises them (§7): sets `$schema`, removes
`$id`, keeps local `$defs`/`$ref`.

The TypeScript/JavaScript connector post-processes zod's output before export: a nullable union
`anyOf: [X, {type: "null"}]` becomes `type: [X, "null"]` with X's keywords unless X has `enum`, `const`,
`$ref` or a combinator, and the `pattern` zod emits next to an asserted format (§6.4) is dropped
(patterns added with `.regex()` stay). The template schemas then equal the canonical ones exactly, and the
RE2-based Go validator never sees zod's lookahead patterns. The Go connector post-processes invopop's
output too: the root is inlined, `$defs` names are unique, pointer fields are nullable and tag defaults
are typed (§5.9).

### 6.2 Unknown keys

Config roots must reject unknown keys (`additionalProperties: false`), so a typo such as `limt: 100`
fails at scan start instead of silently running the default. The connector config bases guarantee it:
`scantor.Config` (pydantic `extra="forbid"`), `config()` (`z.strictObject`), Go reflection with closed
structs plus `DisallowUnknownFields`. describe **fails** when the root of `taskConfig`, `scanConfig` or
`analysisConfig` allows unknown keys and **warns** for nested open objects (for example a nested plain
`pydantic.BaseModel`). Result schemas may be open.

### 6.3 Defaults and effective configs

The effective config is the input after validation against the revision schema with defaults filled.
The scan stores only effective configs, and every connector call receives complete objects.

| Where | Validator | Defaults |
|---|---|---|
| scan start (`startScan`), test runs | orchestrator: ajv (`ajv/dist/2020`) with `ajv-formats`, `useDefaults: true`, `discriminator: true`, unknown formats ignored | filled |
| UI forms (browser, feedback only) | `@cfworker/json-schema` ([ui](ui.md) §6.1) | not filled |
| `scantor dev run`, local mode input | Go: `santhosh-tekuri/jsonschema/v6` with format assertions, plus `internal/schema.ApplyDefaults` | filled |
| wrapped template calls | runtime: canonical template schema | filled |
| every `run`/`schedule` call | connector native model (authoritative; the Go connector validates against its exported schema, §5.9) | native (Go: `ApplyDefaults` semantics) |

Default semantics (ajv 8 `useDefaults: true`; `ApplyDefaults` and the Go connector are identical,
pinned by the `internal/schema` and `connectors/go` tests against the same ajv output): wherever a
`properties` keyword is evaluated against an object, every property that is missing and has a
`default` gets a deep copy of the default, and the property's subschema is then evaluated (and filled)
against the inserted value. Evaluation follows `properties`, `items`, present `prefixItems` entries,
`additionalProperties` (for keys not listed in `properties`), `allOf` and local `$ref`. Defaults inside
`anyOf`/`oneOf`/`not`/`if`/`then`/`else` are never applied, missing tuple items (`prefixItems`) are
never filled, and `null` values are kept. describe fails when a `default` does not validate against its
own subschema. Configs should give every field a default so `{}` is valid (scaffolds do).

The runtime checks only that payloads are well-formed JSON within the size limits; the connector is the
authoritative validator of everything user code consumes and produces ([architecture](architecture.md)
D19).

### 6.4 Supported JSON Schema subset

ajv and the Go validator support this subset; describe warns (with the schema location) for anything
else. The UI form renderer ([ui](ui.md) §6.2) renders every construct of the table as a form widget,
including discriminated unions (a select over the discriminator values, then the selected branch's
fields), and edits anything outside the subset as a JSON subtree; a `oneOf`/`anyOf` whose members are
all `{const, title?}` is rendered like `enum` with the titles as labels.

| Construct | Notes |
|---|---|
| `type`: `object`, `string`, `number`, `integer`, `boolean`, `array`; `null` only in nullable unions (`type: [X, "null"]` or `anyOf: [X, {type: null}]`) | |
| object: `properties`, `required`, `additionalProperties` (`false`, `true` or a schema for maps), `propertyNames` (a string schema for map keys) | |
| string: `minLength`, `maxLength`, `pattern` (ECMA-262 subset that is also valid RE2), `format` | asserted formats: `date`, `date-time`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uuid`, `regex`; other formats (e.g. pydantic's `password`) are annotations |
| number/integer: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | integers outside ±(2^53 − 1) are not portable (warning) |
| `enum`, `const`; `oneOf`/`anyOf` whose members are all `{const, title?}` (titled options) | |
| array: `items`, `minItems`, `maxItems`, `uniqueItems` | `prefixItems` (tuples) → warning |
| nested objects, local `$ref` to `#/$defs/…` (non-recursive) | recursion → warning |
| discriminated unions: `oneOf`/`anyOf` whose branches are objects sharing a property with distinct `const` values; the OpenAPI `discriminator` keyword is accepted as an annotation | |
| annotations: `title`, `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `x-scantor` | |
| everything else (`allOf`, `not`, `if`/`then`/`else`, `patternProperties`, `dependentSchemas`, …) | warning |

### 6.5 Secrets (`writeOnly`)

A config field with `writeOnly: true` is a secret: pydantic `SecretStr`, `secret()` in TypeScript and
JavaScript, `scantor.Secret` (or tag `jsonschema:"writeOnly=true"`) in Go. describe records their instance
paths in `secretPaths`; the orchestrator encrypts the values at rest, replaces them with `"***"` in every
API, export and MCP response, and only `GET /api/runtime/bootstrap` (and the local-mode input of a test
run) carries the plaintext ([security](security.md)). User code receives the real value. Secrets in the
analysis config or result are masked in responses the same way.

describe removes every `default` that carries a secret: the default of a `writeOnly` property, also when
`writeOnly` sits in one of its `anyOf`/`oneOf` branches or a referenced definition (pydantic `SecretStr |
None`), and the default of an object or array whose value contains a `writeOnly` member. Connectors
export such defaults masked (pydantic: `"**********"`), as `null` or as written (a Go `default=` tag),
and filling defaults would store that value as the secret. An omitted secret therefore stays absent from
the effective config, and the connector applies the task's own default when it decodes the config: the
pydantic field default, zod's `.default()` or the Go `default=` tag (the zero value without one).

The orchestrator takes a secret only from the request, whatever the stored description says: when it
fills defaults (§6.3), a secret that the request does not contain is removed again together with the
outermost member the defaults added. A secret sent as `"***"` (a masked response fed back) is a
`configInvalid` issue at its path; `restartScan` reuses the stored secrets instead.

### 6.6 `x-scantor` annotations

| Value | Where | Meaning |
|---|---|---|
| `"file"` | object schema in the result | a FileRef; recorded in `fileRefPaths`; the UI renders a download link |
| `"upload"` | string (or nullable string) field in the task or scan config | an upload id (`POST /api/uploads`); recorded in `uploadPaths`; the scan start checks ownership and existence; templates (`list`) read the upload. User code receives the id only (no fetch API in v1). |

## 7. Describe output

`scantor runtime describe` (§9.5) spawns one connector process, performs the handshake, sends `describe`
and turns the connector's `description` into the describe output (`schemas/describe.schema.json`,
stored as `revisions.description` and `testRuns.description`):

```json
{
  "protocolVersion": 1,
  "connector": { "language": "python", "version": "1.4.0" },
  "schemas": {
    "taskConfig": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": { "greeting": { "type": "string", "default": "Hello", "title": "Greeting" }, "apiToken": { "type": "string", "format": "password", "writeOnly": true, "title": "Apitoken" } }, "additionalProperties": false },
    "scanConfig": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {}, "additionalProperties": false },
    "analysisConfig": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {}, "additionalProperties": false },
    "result": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": { "text": { "type": "string" }, "gallery": { "type": "array", "items": { "$ref": "#/$defs/FileRef" } } }, "required": ["text", "gallery"], "$defs": { "FileRef": { "type": "object", "x-scantor": "file", "properties": { "id": { "type": "string" }, "name": { "type": "string" }, "size": { "type": "integer" }, "sha256": { "type": "string" }, "contentType": { "type": "string" } }, "required": ["id", "name", "size", "sha256", "contentType"], "additionalProperties": false } } }
  },
  "schedule": { "kind": "template", "template": "single" },
  "secretPaths": { "taskConfig": ["/apiToken"], "scanConfig": [], "analysisConfig": [], "result": [] },
  "uploadPaths": { "taskConfig": [], "scanConfig": [] },
  "fileRefPaths": ["/gallery/*"],
  "warnings": []
}
```

Derivation by the runtime (one Go implementation, `internal/runtime/describe`; the mode itself is
specified in [runtime](runtime.md) §16, and the steps below are normative for its output):

1. `protocolVersion` from the handshake, `connector` from `hello`; `connector.language` must equal the
   manifest language (checked by the pipeline: mismatch is a describe error).
2. For an unwrapped template (`schedule.kind == "template"`), replace `schemas.scanConfig` and
   `schemas.analysisConfig` with `$defs.scanConfig`/`$defs.analysisConfig` of
   `schemas/templates/<name>.json` embedded in the binary; the connector's own exports must match the
   canonical properties, types and defaults (mismatch → warning naming the field; enforced strictly by
   conformance tests, [protocol](protocol.md) §12). Exception `single` (schedule omitted, §5.1): only the
   scan config is replaced, and an exported scan config with properties is a describe error; the task's
   own analysis config is kept (conformance D1), since every analysis receives `{}` filled with its
   defaults.
3. Normalise every schema: set `$schema` to draft 2020-12, drop `$id`, drop `default` from `writeOnly`
   properties (§6.5), verify the root is `type: object`, verify each schema is ≤ 256 KiB.
4. Check unknown-key closure (§6.2), defaults (§6.3) and the subset (§6.4).
5. Walk each schema (following local `$ref`, all branches of `oneOf`/`anyOf`, `items` as `*`,
   `additionalProperties` schemas as `*`) and collect instance paths (RFC 6901, at most 256 per list,
   depth ≤ 16) of `writeOnly: true` → `secretPaths`, `"x-scantor": "upload"` in task and scan config →
   `uploadPaths`, `"x-scantor": "file"` in the result → `fileRefPaths`.
6. Merge connector warnings, static-validation warnings and subset warnings into `warnings` (≤ 100). For
   template `single`, the runtime adds the warning about an analysis config that rejects `{}` after its
   defaults (§5.1) when the connector did not report it (the Go connector does not).

describe errors (`phase: describe`, revision `failed`): protocol version not supported; import error or
invalid definition (message and stack from the connector's handshake `error`); entry or binary missing;
config root open; result root not an object; a default that violates its schema; an unwrapped template
with foreign config types; a schema over 256 KiB or path lists over their limits; JavaScript connector
shadowing or a foreign zod instance; language mismatch; timeout.

## 8. Dockerfile

### 8.1 Minimal Dockerfiles

Python:

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

TypeScript and JavaScript:

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
```

Go:

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG SCANTOR_GCFLAGS=""
RUN go build -gcflags="${SCANTOR_GCFLAGS}" -o /task/task .
```

`SCANTOR_BASE` is always supplied by the pipeline as the base image pinned by digest. `SCANTOR_GCFLAGS`
is set to `all=-N -l` only by `scantor dev debug`. No other build arguments exist.

### 8.2 Policy

Implemented once in Go (`internal/taskpipe/dockerfile`) with BuildKit's parser
(`github.com/moby/buildkit/frontend/dockerfile/parser` and `instructions.Parse`), so every rule sees what
BuildKit will execute. Violations are `static` errors with `file: "Dockerfile"`, the instruction's line,
and the rule id in the message.

| Id | Rule | Why |
|---|---|---|
| D1 | The Dockerfile parses, is ≤ 256 KiB, has ≤ 32 stages and ≤ 1000 instructions. | bounded work |
| D2 | No parser directives `# syntax=` or `# check=` (an `# escape=` directive is allowed). | a custom frontend runs an arbitrary image with full LLB access |
| D3 | `ARG SCANTOR_BASE` is declared before the first `FROM`, without a default value. | the pipeline always supplies it |
| D4 | The final stage is `FROM ${SCANTOR_BASE}` (or `$SCANTOR_BASE`), directly or through earlier stage names that lead to it. Earlier stages may use other allowed images. | the final image must carry the connector and ENV contract |
| D5 | Every image reference in `FROM`, `COPY --from=` and `RUN --mount=…,from=` is an earlier stage name or index, `${SCANTOR_BASE}`, `scratch` (BuildKit's empty image, spelled exactly so; never pulled) or a literal reference (a numeric `--from`/`from=` that is not the index of an earlier stage is rejected, never read as the Docker Hub image `library/<n>`): no `$` other than `SCANTOR_BASE`; a valid normalised reference; not a bare image id (`sha256:…` or 64 hex characters); its registry host is not `localhost`, `*.localhost`, `host.docker.internal`, an IP literal in a loopback, unspecified (`0.0.0.0`, `::`), private, link-local or unique-local range, the internal registry service name (`registry`, any port), the host of `SCANTOR_REGISTRY_PUBLIC_HOST` or the host of `SCANTOR_PUBLIC_URL`; its repository path does not start with `tasks/` (case-insensitive, on any host, including Docker Hub). | BuildKit prefers local images, so `COPY --from=localhost:5000/tasks/<victim>` would read another user's image ([security](security.md) BLD-2) |
| D6 | No `--platform` flag on `FROM`. | single-architecture builds; the revision records the built platform |
| D7 | `ADD` sources are local paths only: no `http://`, `https://`, `git@`, `git://` or `*.git` URLs, no `--checksum`, no `--keep-git-dir`. | the daemon fetches ADD URLs from the host network namespace |
| D8 | `RUN --mount` types `bind` and `tmpfs` only (`cache`, `secret`, `ssh` rejected); no `RUN --network=` other than `default`; no `RUN --security=`. | cache mounts are shared across users; host network and insecure entitlements |
| D9 | No `LABEL` key matching `^(traefik\.\|com\.docker\.compose\.\|scantor\.)` (case-insensitive) and no `LABEL` key containing `$` (ARG expansion would bypass the pattern). The pattern is `forbiddenImageLabelKeys` of `schemas/managed-labels.json`. | image labels become container labels (route hijack); the post-build label check (§9.4) and managed labels at run time are further layers ([security](security.md) LBL-1…LBL-3) |
| D10 | No `ARG` whose name starts with `BUILDKIT_` (case-insensitive), as written or without its shell quoting and escapes (`ARG "BUILDKIT_X"`, `ARG BUILD\KIT_X`). | frontend and builder knobs |
| D11 | No `ONBUILD` and no `VOLUME`. | ONBUILD hides deferred instructions; anonymous volumes leak worker disk |
| W1 | `ENTRYPOINT`, `CMD`, `HEALTHCHECK` and `STOPSIGNAL` are ignored (the runtime is the entrypoint) — warning. | |
| W2 | `ENV` overriding a `SCANTOR_*` variable — warning naming it. | allowed, e.g. to wrap the connector command |
| W3 | No `.dockerignore` — warning. | |

Build-time rules outside the Dockerfile: only public base and builder images can be pulled (no registry
credentials are ever passed into a build; the base image is pre-pulled); external images must not carry
`ONBUILD` triggers and the built image must not carry forbidden labels (both checked in the `build` phase,
§9.4); `RUN` steps run on the daemon's default build network with the node egress deny list applied
([nodes](nodes.md)).

### 8.3 Privileged tasks (Docker-in-Docker)

A task with `defaults.privileged: true` (owner needs `canRunPrivileged`, M10) runs its workers only on
nodes whose `SCANTOR_NODE_DIND` is `sysbox` or `privileged` ([nodes](nodes.md) §6.9). The node sets
`SCANTOR_DIND=1` in such workers; the runtime then starts the inner `dockerd` from `PATH` before the AMQP
connection and the connector processes, waits until `/var/run/docker.sock` answers (at most 60 s), and
only then proceeds; without `dockerd` in the image, or when it does not become ready, the worker fails
with a clear bootstrap error that appears as a crash loop on the scan page ([runtime](runtime.md) §4.4).
User code reaches the inner daemon through the default socket (`DOCKER_HOST` unset) and can detect DinD
by `SCANTOR_DIND=1`.

- Base images contain no Docker engine. A task that needs Docker installs it in its Dockerfile, for
  example on the Debian-based base images `RUN apt-get update && apt-get install -y --no-install-recommends
  docker.io && rm -rf /var/lib/apt/lists/*`; the authoring guides (`docs/guide/`) explain it.
- The final image must keep running as root (no `USER` switch), because the runtime starts `dockerd`.
- Describe and check containers, test runs and `scantor dev run` are never privileged and never get
  `SCANTOR_DIND`: Docker-dependent code must not run at import time, and Docker use in `run` is exercised
  by a (small) scan.

## 9. Task pipeline

### 9.1 Commands

| Command | Input | Does |
|---|---|---|
| `scantor task pack <dir> [-o <file\|->]` | folder | deterministic tar.gz (§9.2); prints the pack summary |
| `scantor task check-static <dir\|tgz\|-> [--expect-name <n>] [--allow-privileged]` | folder or pack | pack (if a folder), manifest rules (§3.2), required files (§2), Dockerfile policy (§8.2) |
| `scantor task build <dir\|tgz\|-> --tag <ref> [--push [--push-gate <fd>]] [--expect-name <n>] [--allow-privileged] [--skip-check] [--reuse-existing] [--debug-build] [--events ndjson\|text]` | folder or pack | pack → static → build → describe → check → push; `--reuse-existing` skips the image build when an image tagged `--tag` already exists locally (used for content-addressed draft tags); `--push-gate` makes the push wait for a go-ahead (§9.7) |

All three write events (§9.8) to stdout (`--events text` renders them for humans; the CLI default when
stdout is a terminal) and exit with §9.9 codes. They need no platform credentials except `--push`
(§9.7). Consumers:

| Consumer | Invocation |
|---|---|
| orchestrator `revisionBuild` job | the revision's stored S3 snapshot `snapshots/<taskId>/<packSha256>.tar.gz` (taken by `publishRevision`, §10) is streamed into `scantor task build - --tag localhost:${SCANTOR_REGISTRY_PORT}/tasks/<taskId>:<revisionId> --push --push-gate 3 --expect-name <task> [--allow-privileged] --events ndjson` (subprocess of the orchestrator, host Docker socket, fd 3 = the push-gate pipe) |
| orchestrator `testRun` job | same with `--tag tasks/<taskId>:draft-<packSha256> --skip-check --reuse-existing` and no `--push` |
| `scantor validate [dir]` | `task build --allow-privileged` with tag `scantor-dev/<name>:<packSha256[0:12]>`, no push, local Docker (local builds run on the user's own Docker; publish re-checks the manifest with the owner's `canRunPrivileged` on the server) |
| `scantor dev run` / `scantor dev debug` | as validate (including `--allow-privileged`) with `--skip-check` (`dev debug` adds `--debug-build`), then local mode (§11.4) |
| `scantor push [dir]` | `task pack` locally, then `POST /api/tasks/upload` (the server runs the full pipeline); inside the editor (`SCANTOR_WORKSPACE` set and the folder inside it) only `POST …/revisions` |

Hidden commands of the binary (omitted from `--help` and from the generated CLI reference
`docs/guide/cli.md`): `scantor task pack | check-static | build` (this section), `scantor workspace …`
(the workspace helpers, [editor](editor.md) §9), `scantor runtime …` ([runtime](runtime.md)), `scantor
node egress-apply` (run inside the egress helper container, [nodes](nodes.md) §9), `scantor conformance
--language <language>` and `scantor conformance exec --case <id> --fixture <fixture> --entry <entry>
--language <language>` (the connector conformance harness, [protocol](protocol.md) §12, [testing](testing.md)
§5), and `scantor docs cli` (writes the cobra-generated CLI reference; run by `just docs`,
[development](development.md)).

### 9.2 `pack`

The pack is the build context, the revision snapshot and the unit of change detection.

- File set: walk the folder; apply `.dockerignore` with Docker semantics (`moby/patternmatcher`,
  including `!` exceptions); always include `scantor.yaml`, `Dockerfile` and `.dockerignore` even if
  matched; always exclude `.git/` and `.scantor/` at any depth.
- Entry types: regular files (mode normalised to `0755` if any execute bit is set, else `0644`),
  directories (`0755`), and symlinks whose target is relative and resolves inside the root (stored as
  symlinks, never dereferenced). Each target is resolved against the pack's own entries the way the
  kernel resolves it, following symlinks to symlinks, so a chain such as `x -> .` with `s -> x/..` that
  leaves the root is rejected although every target stays inside it lexically; a component that is no
  entry is read lexically. Absolute or escaping symlinks, symlink loops, hardlinks to outside files,
  devices, FIFOs and sockets are errors.
- Deterministic tar: entries sorted by path (bytewise), each directory before its contents; uid/gid 0,
  empty uname/gname, mtime 0, PAX headers only for names that need them (with fixed fields); USTAR
  otherwise.
- Pack hash: `packSha256` = SHA-256 (hex) of the **uncompressed** tar stream, so compressor changes
  between binary versions never change it. The tar.gz uses gzip with header mtime 0, no name and OS byte
  255; its size is `packBytes`.
- Caps, counted while streaming: `SCANTOR_TASK_MAX_FILES` entries, `SCANTOR_TASK_MAX_BYTES` uncompressed,
  `SCANTOR_TASK_MAX_PACK_BYTES` compressed. Exceeding a cap is a `pack` error naming the cap.
- Summary: `{packSha256, packBytes, fileCount, bytes}` (`fileCount` counts regular files).
- Reading a pack (`tgz` input) applies the same entry rules and recomputes the hash.

The workspace hash shown as "unpublished changes" and the revision `source.packSha256` are both this
hash ([data model](data-model.md) §4.1).

### 9.3 `check-static`

In order, collecting all errors of a step before stopping: manifest (M1–M10), required files (§2),
Dockerfile policy (D1–D11, warnings W1–W3). Output: errors and warnings as events; on success the
normalised `manifest`, `settingsDefaults`, `language` and `privileged` (§3.3) in the result.

### 9.4 `build` phases

| # | Phase (`BuildError.phase`) | Step |
|---|---|---|
| 1 | `pack` | pack (folder input) or read and verify (pack input) |
| 2 | `static` | check-static |
| 3 | `build` | resolve and pre-pull the base image (§4.1): pull when absent locally (anonymous); pin: development references (no registry and no namespace, such as `scantor-base-python:dev`) are passed by tag without any lookup; any other reference is pinned as `SCANTOR_BASE=<repository>@<digest>` when the daemon's anonymous distribution inspect (20 s timeout) finds that repo digest in the registry, else passed by tag; for a tag reference the local image id is recorded as `digest` (BuildKit resolves digest references against the registry, and the containerd image store gives local builds repo digests too, so a repo digest alone does not prove the image is in the registry). Build with BuildKit through the Engine API (`ImageBuild`, `Version: BuilderBuildKit`, context = the pack, `Dockerfile`, build args `SCANTOR_BASE` and with `--debug-build` `SCANTOR_GCFLAGS=all=-N -l`, `PullParent: false`, no auth configs, no labels, native platform, tag `--tag`), decoding the BuildKit status stream (`moby.buildkit.trace`) into log events. Before the build, every literal external image reference of the Dockerfile (D5) is pulled anonymously when absent and inspected: a non-empty `Config.OnBuild` is an error naming the image and its Dockerfile line ([security](security.md) BLD-7). Timeout `SCANTOR_BUILD_TIMEOUT` (the request context is cancelled, which cancels the build). Then `ImageInspect`: size ≤ `SCANTOR_MAX_IMAGE_BYTES`; no key of the effective `Config.Labels` (which include labels inherited from external stages) matches the D9 pattern (error naming the label, [security](security.md) LBL-3); platform `{os, arch, variant?}`. After the build, when `SCANTOR_BUILD_CACHE_MAX_BYTES` is set, prune the build cache to that size. |
| 4 | `describe` | describe container (§9.5) → describe output (§7); error events are errors; at most 200 are reported |
| 5 | `check` | check container (§9.5) unless `--skip-check`; error-severity diagnostics are errors with `file`/`line`/`column`; at most 200 are reported |
| 6 | `push` | only with `--push` (§9.7) |
| – | `platform` | Docker unreachable, unexpected daemon errors, internal failures |

A failing phase stops the pipeline; the final event is always a `result` (§9.8).

### 9.5 Describe and check containers

| Property | Value |
|---|---|
| name, labels | `scantor-b-<uuid>`, managed labels with `scantor.kind=build` ([architecture](architecture.md) §7) |
| image | the image id just built |
| entrypoint | `/scantor/scantor runtime describe --entry <entry>` or `/scantor/scantor runtime check --entry <entry>` (runtime injected, §9.6; `entry` from the normalised manifest) |
| security | the worker hardening profile ([nodes](nodes.md)) with no added capabilities; never privileged, even for privileged tasks |
| network | `none` |
| resources | memory = max(1 GiB, manifest per-process memory + 256 MiB) (type checkers need headroom), CPUs = max(1, per-process cpus), pids limit 256; no tmpfs (scratch on the writable layer, as in workers) |
| environment | image environment only; no tokens, no platform URLs |
| timeout | `SCANTOR_DESCRIBE_TIMEOUT` per container, then kill; error `describe exceeded <d>` / `check exceeded <d>`. It must exceed the runtime's own limits (describe: hello 30 s + ready 120 s + description 60 s; check: 300 s, [runtime](runtime.md) §16) so those report first with precise messages |
| cleanup | removed (with anonymous volumes) after its output is collected |

The container's stdout carries task-pipeline events written by the runtime only (`{"phase", "type":
"log"|"error"|"result", …}`, [runtime](runtime.md) §16); connector stdout/stderr and check-tool output
arrive as `log` events. describe ends with `{"phase":"describe","type":"result","description":{…}}`,
check with `{"phase":"check","type":"result","ok","exitCode","skipped"}` (`skipped: true` when
`SCANTOR_CHECK_CMD` is empty); failures are `error` events with BuildErrors and exit code 2. The pipeline
adds `v`, `seq` and `at` and merges them into its own stream (§9.8).

### 9.6 Runtime injection

Every consumer that runs a task image (node daemon, describe/check, test runs, `dev run`) creates the
container with entrypoint `["/scantor/scantor", "runtime", "<mode>", …]`, copies a static linux `scantor`
binary to `/scantor/scantor` with `CopyToContainer` (a tar with the directory `scantor/` mode 0755 and the
file `scantor/scantor` mode 0755, uid/gid 0, extracted at `/`), then starts it. The binary is the
consumer's own executable when it runs on linux with the daemon's architecture; otherwise (native CLI on
macOS, cross-architecture daemons) the linux binary for the daemon's architecture is extracted once from
the scantor image `<prefix>scantor:<tag>` (the image-reference rule of §4.1; `/usr/local/bin/scantor`, via
a created but never started container and `CopyFromContainer`) and cached in the user cache directory
under `scantor/runtime/<image id>-linux-<arch>` (keyed by the local image id, so a rebuilt `dev` image is
extracted again). Base images contain no runtime; the only cross-version contract
is the connector protocol, negotiated in `hello` ([protocol](protocol.md) §4).

### 9.7 Push by digest

`--push` pushes `--tag` (`localhost:${SCANTOR_REGISTRY_PORT}/tasks/<taskId>:<revisionId>`) with
`ImagePush`, authenticating as the registry `orchestrator` credential (Basic `orchestrator:<password>`,
[auth](auth.md) §10.4). Least privilege: the orchestrator derives the password itself (HKDF label
`registry-push`, [architecture](architecture.md) §9) and passes only that value to the subprocess, in
the environment variable `SCANTOR_REGISTRY_PUSH_PASSWORD` (never on the command line). `SCANTOR_SECRET`
is never passed to the task pipeline. The variable is internal to this subprocess call and is not a
deployment setting; `--push` without it fails at start with a `platform` error (exit 3).

Registry GC handshake ([deployment](deployment.md) §14.1). With `--push-gate <fd>` the binary, once every phase
before `push` succeeded, emits the event `{"phase":"push","type":"log","stream":"pipeline","text":"waiting
for push gate"}` and blocks until it reads one line from `<fd>`: `push` starts the push; end of file or
any other line ends the pipeline with a `push` error (`push gate closed`). The `revisionBuild` job
answers the event with the handshake: (a) set `cursor.phase = "push"` (write concern majority); (b) if
the `registryGc` lock is held, set `cursor.phase = "waitRegistry"`, wait 10 s and go back to (a); (c)
write `push\n` to the gate. The job's `cursor.phase` values are therefore `build` (from the start until
the gate event), `push`, `waitRegistry` and `finalize` (set on the `result` event, while the revision is
updated); registry GC never runs while a push is in flight, and builds wait for GC only at their push
phase. A job requeued by a stopping orchestrator or after a lease expiry puts the revision back to
`queued` and starts from scratch ([data model](data-model.md) §4.12, §6.4).

The digest is taken from the push stream's final aux message `{"Tag", "Digest", "Size"}` when the daemon
sends one, else from its final status line `<tag>: digest: <digest> size: <n>` (Docker 29 with the
containerd image store sends only the line; there it is the index digest). The result records
`image: {repository: "tasks/<taskId>", tag: "<revisionId>", digest, bytes, platform}`. Scans and
assignments always reference `<registry host>/tasks/<taskId>@<digest>`; tags exist only for listing and
garbage collection. The local image is kept (the built-in node pulls it from the same daemon at no cost).
Push failures are `push` errors with exit code 3.

### 9.8 Events and structured errors

NDJSON, one event per line, in order:

| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | event format version |
| `seq` | int | 0-based, consecutive |
| `at` | string | ISO 8601 UTC with milliseconds |
| `phase` | `pack`\|`static`\|`build`\|`describe`\|`check`\|`push`\|`platform` | phase that produced the event |
| `type` | `log`\|`error`\|`result` | |
| `stream` | `pipeline`\|`build`\|`stdout`\|`stderr`\|`check` | `log` only: origin of the text |
| `level` | `info`\|`warning` | `log` only (default `info`) |
| `text` | string ≤ 16 KiB | `log` only; longer output is split |
| `error` | BuildError | `error` only |
| `result` | BuildResult | `result` only; always the last event |

BuildError (also `revisions.errors[]`, `testRuns.errors[]`): `{phase, file?, line?, column?, message}`
with `file` relative to the task root, `line`/`column` 1-based, `message` ≤ 4 KiB. `phase` is one of the
pipeline phases above; test runs additionally use `config` (input validation, §11.1) and `schedule`
(scheduling failure in local mode, §11.3).

BuildResult: `{ok, pack, manifest, settingsDefaults, language, privileged, baseImage: {ref, digest},
image: {ref, id, repository?, tag?, digest?, bytes, platform: {os, arch, variant?}} | null, description |
null, errors: BuildError[], warnings: string[], durationsMs: {<phase>: ms}}`; fields of phases that did
not run are null.

```json
{"v":1,"seq":0,"at":"2026-10-21T09:01:01.010Z","phase":"pack","type":"log","stream":"pipeline","text":"packed 9 files, 14336 bytes, sha256 a3f1…9c"}
{"v":1,"seq":1,"at":"2026-10-21T09:01:01.020Z","phase":"static","type":"log","stream":"pipeline","level":"warning","text":"Dockerfile:7: CMD is ignored; the runtime is the entrypoint (W1)"}
{"v":1,"seq":2,"at":"2026-10-21T09:01:02.400Z","phase":"build","type":"log","stream":"build","text":"#6 [3/4] RUN pip install --no-cache-dir -r requirements.txt"}
{"v":1,"seq":3,"at":"2026-10-21T09:01:30.100Z","phase":"describe","type":"log","stream":"stderr","text":"importing main.py"}
{"v":1,"seq":4,"at":"2026-10-21T09:01:41.000Z","phase":"check","type":"error","error":{"phase":"check","file":"main.py","line":14,"column":12,"message":"Argument of type \"int\" cannot be assigned to parameter \"text\" of type \"str\" (reportArgumentType)"}}
{"v":1,"seq":5,"at":"2026-10-21T09:01:41.010Z","phase":"check","type":"result","result":{"ok":false,"errors":[{"phase":"check","file":"main.py","line":14,"column":12,"message":"Argument of type \"int\" cannot be assigned to parameter \"text\" of type \"str\" (reportArgumentType)"}],"warnings":["Dockerfile:7: CMD is ignored; the runtime is the entrypoint (W1)"],"pack":{"packSha256":"a3f1…9c","packBytes":4211,"fileCount":9,"bytes":14336},"language":"python","privileged":false,"image":null,"durationsMs":{"pack":10,"static":10,"build":28500,"describe":11200,"check":9800}}}
```

The orchestrator stores the events as the build log (`build-logs/<revisionId>.ndjson`,
`getRevisionBuildLog` line = `seq + 1`), copies `result.errors` to `revisions.errors` and the result
fields to the revision.

### 9.9 Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | the task content is invalid: `pack`, `static`, `build` (including build timeout and image size), `describe` or `check` errors |
| 3 | platform failure: `push`, `platform` (Docker unreachable, internal error) |

These are the CLI's global exit codes (0 ok, 1 analysis failures, 2 validation, 3 platform); `1` is used
by `dev run` and by the commands that wait for a scan (`scans start --wait`, `scans get --wait`, `scans
watch`) when the scan failed or was cancelled, the circuit breaker paused it, or it completed with failed
or lost analyses.

### 9.10 Limits

| Limit | Value |
|---|---|
| files / uncompressed bytes / compressed bytes per pack | `SCANTOR_TASK_MAX_FILES` / `SCANTOR_TASK_MAX_BYTES` / `SCANTOR_TASK_MAX_PACK_BYTES` |
| path | ≤ 1024 bytes, segment ≤ 255 bytes |
| manifest | 64 KiB |
| Dockerfile | 256 KiB, 32 stages, 1000 instructions |
| build duration | `SCANTOR_BUILD_TIMEOUT` |
| concurrent builds (orchestrator, revision and test-run builds together, FIFO) | `SCANTOR_BUILD_CONCURRENCY` |
| image size | `SCANTOR_MAX_IMAGE_BYTES` |
| build cache after each build | `SCANTOR_BUILD_CACHE_MAX_BYTES` |
| describe / check duration each | `SCANTOR_DESCRIBE_TIMEOUT` |
| schema size / describe output | 256 KiB per schema / 1 MiB total |
| describe / check errors reported | 200 each (later error events are counted in one log line) |
| event text | 16 KiB per event; build log 10 MiB (then one truncation event, later log events dropped, errors and the result kept) |

## 10. Revisions

- **Numbering**: `publishRevision` and `uploadTask` atomically increment `tasks.revisionSeq`
  (`findOneAndUpdate` with `$inc`); the new value is the revision `number`. Numbers are never reused;
  failed builds consume numbers. References: `echo@3`, `echo@latest` (highest-numbered `ready`), `echo` (=
  `@latest`), or the revision id ([api](api.md) §1.4).
- **Snapshot at publish**: `publishRevision` (also the publish step of `uploadTask`) streams helper
  `scantor workspace snapshot` to S3 (`snapshots/<taskId>/<packSha256>.tar.gz`) before it de-duplicates,
  allocates the number and inserts the revision, so `packSha256` and `snapshotKey` are known at insert.
  The `revisionBuild` job builds from the stored snapshot, never from the live workspace: edits after the
  publish and rebuilds after an expired job lease use exactly the published source. Test runs snapshot
  the live workspace (§11.1).
- **De-duplication**: publishing when a `queued`, `building` or `ready` revision of the task has the same
  `packSha256` returns that revision. A `failed` revision does not de-duplicate (a transient failure can
  be retried by publishing again).
- **Immutability**: the snapshot (`snapshots/<taskId>/<packSha256>.tar.gz`), manifest, description,
  settings defaults and image digest of a ready revision never change.
- **Provenance** (`revisions.source`):

| Field | Value |
|---|---|
| `kind` | `upload` when published by `uploadTask`/`scantor push` from outside the editor; `git` when the task has `source.git` and the snapshot equals the workspace right after the last import/pull (`packSha256 == tasks.source.git.packSha256`); `workspace` otherwise |
| `packSha256`, `packBytes`, `fileCount` | pack summary |
| `git` | present whenever the task has `source.git`: `{url, ref, path, commit, dirty}` with `dirty = packSha256 != tasks.source.git.packSha256` |

- **Platform**: `image.platform` from `ImageInspect`; placement only uses nodes of that architecture.
  `baseImage: {ref, digest}` records the pinned base.

## 11. Test runs

### 11.1 Flow

`POST /api/tasks/{task}/test-runs` (`testTask`; MCP `test_task`; CLI `scantor dev run --remote`, and
automatically inside the editor where `SCANTOR_DEV_MODE=remote`; the UI test-run panel) executes the
**current workspace** without publishing:

1. Insert `testRuns` (`queued`) and a `testRun` job ([data model](data-model.md) §4.3, §6.5).
2. Helper `scantor workspace snapshot` streams the pack into `scantor task build - --tag
   tasks/<taskId>:draft-<packSha256> --skip-check --reuse-existing --expect-name <task>
   [--allow-privileged]` (`building`; skipped straight to describe when the draft image exists,
   `draftImage.cached: true`). Static checks and describe always run, so the description reflects the
   current runtime. Draft images are never pushed; the test run executes exactly what a publish would
   build.
3. Validate the inputs with ajv against the described schemas (`useDefaults`). Failures end the test run
   `failed` with one BuildError per issue: `{phase: "config", message: "taskConfig /greeting: must be
   string"}`.
4. Start the test-run container (§11.2) (`running`); stream its events as SSE (`streamTestRun`) and store
   them (`test-runs/<id>/log.ndjson`), analyses (`testRunAnalyses`) and files (`test-runs/<id>/files/…`,
   uploaded by the job after `CopyFromContainer` of `/scantor/out`).
5. `completed` when local mode finishes (whatever the analysis outcomes), `failed` on build, describe,
   config, schedule or platform errors and on the total timeout `SCANTOR_TEST_RUN_TIMEOUT`, `cancelled` by
   `cancelTestRun` or the deletion of the task. A cancel stops the job at whatever step it is in: the
   test-run container is removed when it was not started yet (also during its creation, the injection
   copy or the start) and killed otherwise. `wait` returns at these states.

Inputs: `taskConfig`, `scanConfig`, `analysisConfig` (when given, `run` is called once with it and
`schedule` is skipped), `limit` (1–50, default 5), `maxAttempts` (1–5, default 1), `timeoutMs` (per
analysis, default from the manifest). `processes` is always 1. Concurrency `SCANTOR_TEST_RUN_CONCURRENCY`;
retention `SCANTOR_TEST_RUN_RETENTION_DAYS`. The reconciler removes draft images older than
`SCANTOR_DRAFT_IMAGE_RETENTION` (by image creation time) that no queued or running test run uses.

### 11.2 Test-run container

`scantor-t-<testRunId>` on `scantor-egress` (internet only, no platform services), managed labels with
`scantor.kind=testRun` and `scantor.user=<userId>` (`schemas/managed-labels.json`), the worker hardening
profile (never privileged, no `SCANTOR_DIND`, §8.3), memory = manifest per-process memory + 256 MiB,
CPUs = per-process cpus, `PidsLimit` 4096 (fixed: the container runs analyses like a worker, and the
orchestrator does not read the node-daemon variable `SCANTOR_NODE_PIDS_LIMIT`; [security](security.md)
SB-1), runtime injected with entrypoint `/scantor/scantor runtime local --spec /scantor/in/spec.json` (the
spec and referenced uploads are part of the injection tar, [runtime](runtime.md) §3.1), events on stdout,
files in `/scantor/out`. Template data sources (Tranco, CrUX) are fetched from
inside this container, never by the orchestrator.

### 11.3 Local mode

Test runs and `scantor dev run`/`dev debug` use the runtime's local mode; its spec, behaviour, output
events and exit codes are defined in [runtime](runtime.md) §15. The consumers fill the spec as follows:

| Spec field | Test run (`testRun` job) | `scantor dev run` |
|---|---|---|
| `runId` | the test-run id | `local` |
| `entry` | normalised manifest entry | same |
| `taskConfig`, `scanConfig`, `analysisConfig` | effective configs (ajv with defaults; secrets in plaintext) | effective configs (`internal/schema`) |
| `limit`, `maxAttempts`, `timeoutMs` | request values (defaults 5, 1, manifest timeout) | flags (defaults 5, 1, manifest timeout) |
| `processes` | 1 | 1 (`dev debug`: forced 1) |
| `backoff`, `maxAnalysesPerProcess` | `settingsDefaults` | `settingsDefaults` |
| `totalTimeoutMs` | `SCANTOR_TEST_RUN_TIMEOUT` minus the time already spent | none |
| `debug` | false | true for `dev debug` |
| `dataSources` | orchestrator `SCANTOR_TRANCO_URL`, `SCANTOR_CRUX_URL` | the same variables if set, else compiled-in defaults |
| `uploads` | referenced uploads, copied from S3 into the injection tar | not supported: a config referencing an upload fails with a clear message |
| `resolved` | `{}` | `{}` |
| `limits` | instance limits | compiled-in defaults |

The `testRun` job maps the events to `testRunAnalyses`, the S3 log and the SSE stream; template
resolutions are reported as `resolved` events. A scheduling failure becomes a BuildError with `phase:
"schedule"`.

### 11.4 `scantor dev run`

`scantor dev run [dir] [--task-config <json|@file|->] [--scan-config …] [--analysis-config …] [--limit 5]
[--max-attempts 1] [--timeout <duration>] [--remote] [-o json]`:

- local (default, or `SCANTOR_DEV_MODE=local`): build as validate with `--skip-check` against the local
  Docker daemon, describe, validate and fill configs (`internal/schema`), run the local-mode container
  with no bind mounts (spec copied in, `/scantor/out` copied out), stream events, write files to
  `.scantor/out/<timestamp>/files/…` as the invoking user. Data sources default to the compiled-in URLs,
  overridable with `SCANTOR_TRANCO_URL`/`SCANTOR_CRUX_URL`.
- remote (`--remote` or `SCANTOR_DEV_MODE=remote`): a test run always executes the task's workspace, so
  remote mode first syncs the folder into it with `uploadTask?publish=false` (same 409 `workspaceDirty`
  rule, `--force` to override; skipped inside the editor, where the folder is the workspace), then calls
  `testTask`, follows `streamTestRun` and downloads the files.
- Exit codes: 0 all analyses succeeded, 1 some failed, 2 validation (pipeline, config or connector
  start), 3 platform ([runtime](runtime.md) §15.4). In remote mode the test run records a connector that
  cannot start, and a scan config the connector rejects, as a `schedule` error (§11.3), so these
  exit 1 there.

`scantor dev debug` = `dev run` with `processes=1`, `--limit 1` default, `--debug-build`, `debug: true`,
and the debug port published on `127.0.0.1:${SCANTOR_DEBUG_PORT}` (local Docker only). Scaffold launch
configurations attach to it (§12).

## 12. Scaffolds

### 12.1 Layout and rendering

```
scaffolds/<language>/
├── files/                    copied into the task root; *.tmpl files are rendered and lose the suffix
└── entry/<template>.<ext>.tmpl   one per template in schemas/templates/ plus "custom"; rendered to the default entry
```

The entry file of a `source` language is its default `entry` (`main.py`); a `binary` language (Go,
entry `/task/task`) gets `main` plus its first extension (`main.go`), which its Dockerfile builds.

Rendering uses Go `text/template` with delimiters `[[` `]]` and data `{Name, Description, Language,
Template, Version, BaseImage, ManifestSchemaURL, GuideURL}` (`Version` = scantor version, `BaseImage` =
full base image reference, `ManifestSchemaURL` =
`https://raw.githubusercontent.com/lonetis/scantor/<ref>/schemas/task-manifest.schema.json` and `GuideURL`
= `https://github.com/lonetis/scantor/blob/<ref>/<guide>` with the language's `guide` from
`languages.json`, where `<ref>` is `v<Version>` for release versions and `main` for any other version,
such as `dev` or an untagged build like `1.4.0-3-gabc1234`, which has no tag). Go `go.mod`/`go.sum` of
the scaffold are stored as `go.mod.tmpl`/`go.sum.tmpl` because `go:embed` silently skips directories
containing a `go.mod` (the example tasks under `tasks/` are not embedded and keep real
`go.mod`/`go.sum`). Unit tests assert that every language of `languages.json` has a non-empty embedded
scaffold with an entry for every template and `custom`.

| File | python | typescript | javascript | go |
|---|---|---|---|---|
| `scantor.yaml` | ✓ (modeline, name, language, description) | ✓ | ✓ | ✓ |
| `Dockerfile` | §8.1 | §8.1 | §8.1 | §8.1 |
| entry | `main.py` | `main.ts` | `main.js` | `main.go` |
| dependencies | `requirements.txt` (comment only) | `package.json`, `package-lock.json` (no dependencies) | same | `go.mod` (`module task`, `go 1.27`, `require` + `replace` of the connector), `go.sum` |
| type checking | `pyrightconfig.json` (`typeCheckingMode: standard`, `pythonVersion: 3.14`) | `tsconfig.json` (`target es2024`, `module`/`moduleResolution nodenext`, `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `skipLibCheck`) | `jsconfig.json` (`checkJs`, `strict`, `noEmit`, `module nodenext`) | – |
| `.dockerignore` | `.git/ .scantor/ __pycache__/ *.pyc .venv/ .DS_Store` | `.git/ .scantor/ node_modules/ .DS_Store` | same | `.git/ .scantor/ /task .DS_Store` |
| `.gitignore` | `.scantor/ __pycache__/ .venv/` | `.scantor/ node_modules/` | same | `.scantor/ /task` |
| `.devcontainer/devcontainer.json` | `build: {dockerfile: "../Dockerfile", context: "..", args: {SCANTOR_BASE: "<BaseImage>"}}`, `workspaceFolder: /task`, bind mount of the folder at `/task`, extensions from `languages.json` + common, `yaml.schemas` mapping | ✓ | ✓ | ✓ |
| `.vscode/launch.json` | attach debugpy `localhost:5678`, `pathMappings` `${workspaceFolder}` ↔ `/task` | attach Node `localhost:9229`, `localRoot ${workspaceFolder}`, `remoteRoot /task` | same | attach dlv `localhost:2345` (`mode: remote`), `substitutePath` `${workspaceFolder}` ↔ `/task` |
| `.vscode/tasks.json` | `scantor: validate` (`scantor validate .`), `scantor: dev run`, `scantor: dev debug`, `scantor: push` | ✓ | ✓ | ✓ |
| `.vscode/settings.json` | `yaml.schemas` (ManifestSchemaURL → `scantor.yaml`), `files.exclude` `.scantor` | ✓ | ✓ | ✓ |
| `AGENTS.md` | §12.3 | ✓ | ✓ | ✓ |

Entry per template: `single` (no schedule; Go `ServeRun`), each other template unwrapped with the
template's types, and `custom` (a generator stub yielding three analysis configs from a scan config field
`count`). All scaffold outputs publish unchanged; CI renders every language × template, runs
`scantor validate`, and `scantor dev run --limit 2` against fixture data sources ([testing](testing.md)).

The example tasks in `tasks/` are ordinary task folders (the guides include their code). Together they
cover every language of `schemas/languages.json` and every template of `schemas/templates/`, used
unwrapped or wrapped; `tests/e2e/examples.spec.ts` publishes and scans each of them and fails for an
example without an entry ([testing](testing.md) §8.3). A new language or template therefore also needs
an example (or an extended one).

### 12.2 Init flow

- CLI: `scantor init [dir] --language <l> [--template <t>] [--name <n>] [--description <d>]`. `dir`
  defaults to `./<name>`; `name` defaults to the slugified base name of `dir`; `template` defaults to
  `single`. Refuses an existing non-empty directory. Prints the next steps (`scantor dev run <dir>`).
- Server: `createTask {name, language, template, description?}` runs helper `scantor workspace scaffold
  --task <n> --language <l> --template <t> [--description <d>]` into `<userId>/<name>/` ([editor](editor.md)
  §9.4), which uses the same renderer. `GET /api/scaffolds` lists `{language, templates: [...templates, "custom"]}`.
- UI wizard: source (scaffold, git, upload) → language cards (`languages.json`) → template cards
  (`schemas/templates/*.json`: title, description, example analysis config) or "Custom schedule" → name
  and description → task page with "Open in editor", "Test run" and "Publish" ([ui](ui.md)).

### 12.3 `AGENTS.md` (rendered)

```markdown
# [[.Name]] — a scantor task ([[.Language]])

This folder is a scantor task. The definition lives in `main.<ext>`; `scantor.yaml` is the manifest.

Commands:
- `scantor validate .` — static checks, image build, describe and type check (as on publish)
- `scantor dev run . --limit 5` — build and run locally (add `--remote` to run on the platform)
- `scantor dev debug .` — run one analysis and wait for a debugger
- `scantor push .` — upload and publish a revision
- `scantor scans start [[.Name]]@latest` — start a scan of the latest revision

Rules: keep `name` in scantor.yaml unchanged; `schedule` must be deterministic; put large outputs in
`ctx.files`; raise `Fatal` for permanent and `Retry` for transient failures.

Guide: [[.GuideURL]]
```

## 13. Workspace

- **Single source of truth**: `workspace/<taskName>/` (volume `scantor-workspaces`, subpath `<userId>`)
  is the only input to revisions and test runs. The orchestrator process never reads or writes it; every
  operation is a `scantor workspace <op>` helper container ([architecture](architecture.md) §4.1,
  [security](security.md)).
- **Writers**: the editor (code-server, owner only), MCP/REST file routes (`writeTaskFiles`,
  `deleteTaskFile`: helper `write-files`/`delete-files` with the same path rules as extraction), git pull,
  and upload/push (replace). Concurrent writers are last-write-wins per file; there is no locking.
- **Change detection**: helpers that touch a workspace recompute its pack hash (§9.2) and update
  `tasks.workspace` (`packSha256`, `fileCount`, `bytes`, `checkedAt`). `dirty` = the workspace hash
  differs from `latestRevision.packSha256` (the last published content, whatever its build outcome; see
  §15 decision 4). The UI shows "unpublished changes" when dirty.
- **Upload/push** (`uploadTask`, `scantor push`): the uploaded pack is extracted into a staging area by
  helper `extract` (archive rules and caps: no absolute paths, `..`, NUL, backslashes, symlinks, hardlinks
  or devices; `SCANTOR_TASK_MAX_FILES`, `SCANTOR_TASK_MAX_BYTES`, `SCANTOR_WORKSPACE_MAX_BYTES`), the
  manifest `name` selects or creates the task, and helper `commit` replaces the task folder atomically
  (mechanics in [editor](editor.md) §9.5–§9.6). Conflict policy, decided by the orchestrator from the
  current workspace hash before it calls `commit --expect <current hash>` (so a concurrent edit still
  fails):

| Workspace state | Result |
|---|---|
| task or workspace folder does not exist | no conflict |
| workspace hash == uploaded hash | no conflict (nothing changes) |
| workspace hash == `latestRevision.packSha256` (published) or == `tasks.workspace.lastSyncSha256` (unchanged since the last upload, git import or pull) | no conflict (nothing that exists only in the workspace is lost) |
| otherwise (editor or MCP edits since the last publish or sync, or a scaffolded workspace that differs) | 409 `workspaceDirty` unless `force=true` (`--expect any`) |

  After the commit `tasks.workspace.lastSyncSha256` = the uploaded hash (git import and pull set it too;
  editor and file-route writes never do), so repeated `scantor push --no-publish` and
  `scantor dev run --remote` cycles from the same folder do not conflict. Then a revision is published
  unless `publish=false`. A packed upload that contains symlinks (allowed by pack) is rejected by
  extraction; such tasks are edited in place instead.
- **Inside the editor**: `scantor push` detects `SCANTOR_WORKSPACE` and a folder inside it and only calls
  `publishRevision`; `scantor dev run` uses remote mode (`SCANTOR_DEV_MODE=remote`).
- **Downloads**: `downloadTaskWorkspace` returns the deterministic pack of the workspace (helper
  `snapshot`); `downloadRevisionSource` the stored snapshot.

## 14. Git import and pull

The git helpers, their exact git commands, URL rules (https only, no userinfo, public addresses unless
`SCANTOR_GIT_ALLOW_PRIVATE=true`, pinned resolution) and credential passing (`GIT_CONFIG_*` env only) are
specified in [editor](editor.md) §9.7. The task-level semantics:

- **Import** (`POST /api/tasks/import-git {url, ref = "HEAD", path = ".", credentialId?, select?}`): a
  shallow fetch of `ref` (branch, tag, full commit or `HEAD`), no submodules; every `scantor.yaml` under
  `path` (depth ≤ 6) is a candidate, validated and summarised. One valid candidate is imported; several
  return `200 {imported: [], candidates: [{path, name, language, exists}]}` until `select` names the paths.
  Each selected folder becomes `<userId>/<name>/` (without `.git`, archive rules apply: a symlink or special
  file is 422 `invalidPath`, a folder over the caps 413 `payloadTooLarge`) and a task with
  `source: {kind: "git", template: null, git: {url, ref, path, credentialId?, commit, packSha256,
  pulledAt}}` (409 `alreadyExists` for a taken name); `lastSyncSha256 = packSha256`.
- **Pull** (`POST /api/tasks/{task}/git/pull {force = false}`), fast-forward only: 409 `gitDiverged` when the
  workspace changed since the last import/pull (`workspace hash != source.git.packSha256`) or the remote
  history is not a fast-forward of `source.git.commit`, unless `force`. Otherwise the folder is replaced,
  `source.git.{commit, packSha256, pulledAt}` and `lastSyncSha256` are updated, and the response reports
  `{previousCommit, commit, changed}`. Pull never publishes.
- Revisions of git tasks record `source.git` (§10). `.git` never enters a workspace or a pack.

## 15. Decisions made in this document

Flagged for lead review:

1. **Pack hash over the uncompressed tar** (§9.2), not the tar.gz, so gzip implementation changes never
   alter hashes (affects the glossary definition of "pack" in [architecture](architecture.md)).
2. **Final stage descends from `${SCANTOR_BASE}`** (D4) instead of "first FROM", which allows builder
   stages; `--platform`, `ONBUILD`, `VOLUME` and `BUILDKIT_*` args are rejected (D6, D10, D11).
3. **Describe fails on open config roots** and warns on open nested objects (§6.2); describe also fails
   on invalid defaults.
4. **Conflict and dirty checks compare with `latestRevision`** (any state) instead of
   `latestReadyRevision`: the snapshot of every published revision is stored, so nothing is lost, and a
   failed build does not block the next `scantor push`. The upload conflict check also accepts
   `tasks.workspace.lastSyncSha256` (new field: hash after the last upload, git import or pull).
5. **Unwrapped templates require the template's own config types**, and describe substitutes the
   canonical template schemas (§7 step 2).
6. **Manifest durations and sizes are strings only** (`5m`, `512MiB`).
7. **`SCANTOR_CHECK_CMD` prints errors as `<file>:<line>[:<column>]: <message>` lines** (the connector
   wrappers normalise basedpyright and tsc output; the format [runtime](runtime.md) §16 parses); check
   errors fail the publish; strictness is tuned in the task's own type-checker config. Test runs and
   `dev run` skip the check. Command templates have the single placeholder `{entry}`.
8. **ctx extras**: `seq` and `progress()` are part of `ctx` in every language; `progress` feeds the
   in-flight list (`busy[].progress`).
9. **Go `ServeRun`** expresses "no schedule = single" in Go.
10. **Local-mode spec mapping** (§11.3): test runs use `processes: 1`, copy referenced uploads into the
    container, and bound `totalTimeoutMs` by `SCANTOR_TEST_RUN_TIMEOUT`; the CLI does not support uploads.
11. **New variables** `SCANTOR_DESCRIBE_TIMEOUT` and `SCANTOR_DRAFT_IMAGE_RETENTION`; the native CLI also
    honours `SCANTOR_TRANCO_URL` and `SCANTOR_CRUX_URL`, and `SCANTOR_IMAGE_PREFIX`/`SCANTOR_IMAGE_TAG`
    whenever `SCANTOR_IMAGE_TAG` is non-empty, as overrides of compiled-in defaults (accepted: the CLI env
    surface beyond `SCANTOR_URL`/`SCANTOR_TOKEN`, credentials still only from those two).
12. **Git import sets `lastSyncSha256`** like uploads and pulls (git mechanics are in [editor](editor.md)).
13. **Secret defaults are dropped** from described schemas (§6.5); **BuildError phases `config` and
    `schedule`** are added for test runs; `scantor task build --reuse-existing` implements draft-image
    reuse.
14. **`scantor dev run --remote` outside the editor** first syncs the folder into the workspace
    (`uploadTask?publish=false`), because test runs always execute the workspace.
15. **Push gate** (§9.7): `scantor task build --push-gate <fd>` makes the push wait for the
    `revisionBuild` job's registry GC handshake ([deployment](deployment.md) §14.1), so only the push phase,
    not the whole build, is serialised with registry GC. The push credential reaches the subprocess only
    as the derived password `SCANTOR_REGISTRY_PUSH_PASSWORD` (lead ruling: least privilege, never
    `SCANTOR_SECRET`).
16. **`schemas/managed-labels.json`** (owned with this document) holds the fixed managed labels, the
    identity labels per kind (including `scantor.op` on helpers and the kind `network`), the name prefixes
    and the forbidden image-label pattern used by D9 and the post-build check.
17. **Privileged tasks** (§8.3): the runtime starts `dockerd` when `SCANTOR_DIND=1` (lead ruling); task
    images install Docker themselves and keep the root user; test runs and `dev run` never use DinD.
18. **Defaults follow ajv 8's actual `useDefaults`** (§6.3), including inside `items`,
    `additionalProperties` and `allOf`, because Go's `ApplyDefaults` must equal ajv; the
    `internal/schema` tests pin the behaviour against ajv's output.
19. **Template `single` keeps the task's analysis config** (§5.1, §7): every analysis receives `{}` with
    the analysis config's defaults (conformance D1), while the scan config must be `Empty`.
20. **Native model validation errors raised by task code are `validation`** (§5.4, conformance T4): the
    same input fails again, so they are not retried.
21. **The Go connector validates against its own exported schema** (§5.9), because Go structs carry no
    constraints or defaults; the TypeScript/JavaScript connector normalises zod's export (§6.1).

## 16. Future extensions

| Extension | How the design accommodates it |
|---|---|
| `ctx.memo`, `ctx.expectTotal` | `ctx` is per call and versioned through the protocol; `scheduling.resolved` is a keyed map; `stats.expectedTotal` exists |
| Multi-architecture task builds (buildx) | revisions record `platform`; D6 can allow `--platform` once builds emit an index per platform |
| Build arguments and build secrets | the pipeline owns the build-arg list; D8 can rewrite `--mount=type=cache` ids per user (`<userId>/<id>`) and accept secrets from the credentials store |
| Private base/builder images | registry credentials can be served through a BuildKit session restricted to allow-listed hosts |
| Per-task capability allowlist (`NET_RAW`, `NET_ADMIN`) | a `defaults.capabilities` manifest key mapped to the worker `capAdd` allowlist ([nodes](nodes.md)) |
| `ctx.uploads.open(id)` for user code | `uploadPaths` already identifies upload fields; bootstrap already carries presigned upload URLs for the scheduler |
| Additional languages | a connector + base image with the ENV contract, a `languages.json` row and a scaffold ([development](development.md)) |
| Separate builder nodes | `scantor task build` is stateless and self-contained; a builder node runs it behind the same job kinds |
| Cron/recurring scans | revisions are immutable and referenced by `name@N`, so a schedule record can pin or follow `@latest` |
| Per-process multiplexing | `ctx` is never global; protocol messages carry request ids and `parent` |
| Organisation-shared tasks | ownership checks live in one helper; workspaces are keyed by owner subpath |
| Privileged test runs (Docker-in-Docker in test runs and `dev run`) | the test-run container uses the worker profile, so it can adopt the DinD profile of [nodes](nodes.md) §6.9 and `SCANTOR_DIND=1` on a dedicated DinD-capable daemon |
