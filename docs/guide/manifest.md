# The task manifest `scantor.yaml`

Every task folder has a manifest named exactly `scantor.yaml` at its root. It names the task, selects
its language and sets the defaults for the scans of the task: how many workers and processes, the
timeout and retries of each analysis, and the resources of each process. Everything else about a task,
including its template and its config types, lives in its code. The manifest is strict YAML: unknown
keys and duplicate keys are errors.

Minimal:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lonetis/scantor/main/schemas/task-manifest.schema.json
scantor: 1
name: echo
language: python
```

Full:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lonetis/scantor/main/schemas/task-manifest.schema.json
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

The first line binds the JSON Schema
[`schemas/task-manifest.schema.json`](../../schemas/task-manifest.schema.json) for completion and
validation in editors with a YAML language server. `scantor init` writes it with the schema of your
scantor version (`…/scantor/v<version>/schemas/…`). The browser editor and the scaffold's devcontainer
also map the schema to `scantor.yaml` offline. The schema itself must never be referenced with a
`$schema` key inside the document: that is an unknown key.

## Fields

| Field | Required | Default | Rules | Meaning |
|---|---|---|---|---|
| `scantor` | yes | – | always `1` | manifest format version |
| `name` | yes | – | lowercase letters, digits and inner hyphens, 1–64 characters; not a uuid and not `upload`, `import-git`, `new` or `latest` | the task name, unique among your tasks; it can never change |
| `language` | yes | – | `python`, `typescript`, `javascript` or `go` | selects the base image and the default entry |
| `description` | no | none | ≤ 500 characters | shown in the web UI, the CLI and to MCP clients |
| `entry` | no | `main.py`, `main.ts`, `main.js`, or `/task/task` for Go | relative path of a file in the folder with the language's extension (`.py`; `.ts`, `.mts`; `.js`, `.mjs`); for Go the path of the binary your Dockerfile builds | the module that defines the task |
| `defaults` | no | `{}` | see below | default scan settings |

There is no `template` key: whether a task uses a template is decided by its code (see
[templates](templates.md)). The name in the manifest is the task name on the platform: `scantor push`
creates or updates the task of that name, and a task that exists keeps its name forever.

## `defaults`

| Field | Default | Bounds | Meaning |
|---|---|---|---|
| `workers` | 1 | 1 … instance maximum (`scantor instance`) | runner workers (containers) per scan |
| `processes` | 1 | 1 … instance maximum | connector processes per worker; each runs one analysis at a time |
| `timeout` | `5m` | `1s` … `24h` | time limit of one attempt of an analysis |
| `maxAttempts` | 3 | 1 … 20 | attempts per analysis, including the first |
| `backoff.initial` | `5s` | ≥ `1s` | delay before the second attempt |
| `backoff.factor` | 2 | 1 … 10 | growth of the delay per attempt |
| `backoff.max` | `10m` | ≥ `initial`, ≤ `24h` | upper bound of a delay, also of the delay a `Retry` asks for |
| `backoff.jitter` | `true` | – | randomise each delay within [delay/2, delay] |
| `resources.cpus` | 1 | 0.1 … 64 | CPUs **per process** |
| `resources.memory` | `512MiB` | `64MiB` … `64GiB`, whole MiB | memory **per process** |
| `maxAnalysesPerProcess` | 1000 | 1 … 1 000 000 | replace a connector process after this many analyses (limits leaks) |
| `privileged` | `false` | needs the `canRunPrivileged` permission | run workers with Docker-in-Docker on nodes that support it |

Value syntax:

- **Durations** are integer amounts with the units `ms`, `s`, `m` and `h`, combinable: `500ms`, `30s`,
  `5m`, `1h30m`. Fractions (`1.5m`) and bare numbers (`90`) are rejected.
- **Sizes** are integers with an optional binary suffix `KiB`, `MiB`, `GiB` or `TiB`: `256MiB`, `2GiB`.
  A bare number means bytes. `MB` and `GB` are rejected.

The delay before attempt n + 1 is `min(backoff.max, backoff.initial × backoff.factor^(n−1))`; with
jitter a random value between half of it and all of it. With the defaults the second attempt waits 2.5–5 s
and the third 5–10 s. [Errors and retries](errors-and-retries.md) explains which errors are retried.

## Sizing workers

`resources` are per process. A worker container gets `processes × cpus` CPUs and
`processes × memory + 256 MiB` of memory; a scan runs up to `workers × processes` analyses at once.

| Workload | Suggested shape |
|---|---|
| network-bound (HTTP, DNS): mostly waiting | many processes with small resources, for example `processes: 8`, `cpus: 0.25`, `memory: 256MiB` |
| CPU-bound (parsing, crypto) | `cpus: 1` per process, processes about the CPUs you want per worker, more workers for more throughput |
| memory-heavy (headless browsers) | `processes: 1`–`2` with enough `memory`; a process killed for memory shows up as a `crash` with `oomKilled` |

Workers are placed only on nodes with enough free CPUs and memory for the whole container, so a very
large worker can wait for capacity (the scan condition `workersPending`, reason
`insufficientCapacity`).

## Defaults and scan settings

When a revision is published, `defaults` become the revision's settings defaults, converted to platform
units. Every scan starts from them, and every value except `privileged` can be overridden when the scan
starts:

| Manifest (`defaults`) | Scan settings | Override when starting a scan |
|---|---|---|
| `workers`, `processes` | `workers`, `processes` | `--workers`, `--processes`; also later with `scantor scans scale` |
| `timeout: 2m` | `timeoutMs: 120000` | `--settings '{"timeoutMs": 120000}'` |
| `maxAttempts` | `maxAttempts` | `--settings '{"maxAttempts": 5}'` |
| `backoff: {initial: 10s, factor: 2, max: 10m, jitter: true}` | `backoff: {initialMs: 10000, factor: 2, maxMs: 600000, jitter: true}` | `--settings '{"backoff": {…}}'` |
| `resources: {cpus: 0.5, memory: 768MiB}` | `resources: {cpus: 0.5, memoryMiB: 768}` | `--settings '{"resources": {…}}'` |
| `maxAnalysesPerProcess` | `maxAnalysesPerProcess` | `--settings` |
| – | `nodeSelector: {pool, labels}` (pool `shared` by default) | `--settings '{"nodeSelector": {"pool": "remote"}}'` |
| `privileged` | `privileged` | never: it comes from the revision |

The options are those of `scantor scans start`; the web UI has the same fields under "Advanced
settings" of the scan form, and the MCP tool `start_scan` takes them as `settings`. The settings of a
running scan cannot change, except `workers` and `processes`.

## Rules checked on publish

`scantor validate`, `scantor push`, test runs and every publish check the manifest before anything is
built. Each problem is reported with its line and column, for example:

| Problem | Message |
|---|---|
| duplicate key | `scantor.yaml:3:1: duplicate key "name" (first defined at line 2)` |
| unknown key | `scantor.yaml:4:11: unknown key "template"` |
| schema violation | `scantor.yaml:10:13: /defaults/resources/memory: '512MB' does not match pattern '^[0-9]+(KiB|MiB|GiB|TiB)?$'` |
| out of bounds | `scantor.yaml:7:12: /defaults/timeout: 48h is outside 1s … 24h` |
| inconsistent backoff | `scantor.yaml:7:10: /defaults/backoff/max: 2s is shorter than initial 5s` |
| memory not in whole MiB | `scantor.yaml:9:13: /defaults/resources/memory: 100KiB is not a whole number of MiB` |
| above the instance maximum | `scantor.yaml:10:14: /defaults/processes: 200 exceeds this instance's maximum 64` |
| wrong entry extension | `scantor.yaml:4:8: entry "src/main.ts" must end in .py` |
| renamed task | `scantor.yaml:2:7: name "echo" does not match task "echo2"; task names are immutable` |
| privileged without permission | `scantor.yaml:6:15: privileged tasks require the canRunPrivileged permission` |

Other rules: the manifest is at most 64 KiB, anchors and aliases may expand it to at most 131 072
values, 1 MiB of text and 4 MiB of key paths, its root is a mapping, and for Python, TypeScript and
JavaScript the entry must exist in the folder as a regular file (`./` and `..` are not allowed in the
path). For Go the entry binary must exist in the built image, which describe checks. A local
`scantor validate` accepts `privileged: true`; the permission is checked when you publish.

## Changing the manifest

Edit `scantor.yaml` like any other file and publish: the change applies to the new revision. Scans
always use the settings they started with, so running and finished scans are not affected, and
`scantor scans restart` copies the settings of the scan it restarts. To rename a task, create a new task
with the new name.
