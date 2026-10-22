# scantor

scantor is a self-hosted platform that runs your own scanning tasks at large scale on many machines,
including machines behind firewalls. You write a task in Python, TypeScript, JavaScript or Go, with typed
configs and a typed result. You test it and publish it as an immutable revision, then start scans that fan
out into millions of analyses across your nodes. Results are inspected, queried and exported through the
web UI, the `scantor` CLI, the REST API or an LLM agent over MCP.

## Features

- **Tasks in four languages**: Python (pydantic), TypeScript and JavaScript (zod), Go (structs). Configs
  and results are typed, validated and rendered as forms in the UI. Each task builds into its own Docker
  image, so any dependency or system package works.
- **Templates**: ready-made schedules for single runs, lists and uploaded files, integer ranges,
  repetitions, the Tranco and CrUX top lists and CIDR ranges. Use them as they are or wrap them to filter
  and extend them.
- **Three ways to author**: a browser editor (VS Code in the browser), the CLI with your own editor and
  local Docker, or an LLM agent through the built-in MCP server.
- **Test before you publish**: test runs on the platform or locally, immutable numbered revisions
  (`echo@3`), and every publish check (manifest, Dockerfile policy, type check) available locally.
- **Scale out**: workers run on the master and on any number of remote nodes. Nodes connect outbound
  only, so they work behind NAT and firewalls. Pools and labels choose where a scan runs.
- **Live control**: pause, resume, scale workers and processes while a scan runs, cancel, retry failed
  analyses, restart.
- **Robust execution**: retries with backoff, per-analysis timeouts, crash recovery, a circuit breaker
  that pauses failing scans, and conditions that explain why a scan is not progressing.
- **Results**: typed results with file attachments, MongoDB queries and aggregations over a scan's
  analyses, JSONL and CSV exports.
- **Multi-user**: accounts with passkeys, API keys, per-user isolation and an admin area for users and
  nodes.
- **Self-hosted with Docker Compose**: prebuilt images on GHCR and optional Traefik with automatic
  wildcard TLS.

## Getting Started

### Configuration

All configuration is done through environment variables in `.env`. Every variable, its default and how to
obtain secrets and tokens are documented in [`.env.example`](.env.example). Create `.env` with:

```sh
just init
```

`just init` copies `.env.example` to `.env` (or adds the variables that `.env` lacks) and replaces every
`-insecure-dev` secret with a random value. Without `just`, copy the file and replace each `-insecure-dev`
value with the output of `openssl rand -hex 24`.

### Development Setup

Requirements: Docker Engine 29 or newer with the compose and buildx plugins, and
[just](https://github.com/casey/just). No other toolchain is needed on the host.

```sh
just up        # build every image from source and start docker-compose.dev.yml
just logs      # follow the logs (just logs orchestrator for one service)
just down      # stop the stack; data volumes are kept
```

`just up` prints the dashboard URL (`http://localhost:3000`), the editor URL and a one-time setup link
for the first admin account. The dev stack in [`docker-compose.dev.yml`](docker-compose.dev.yml)
hot-reloads the web app; `just up` again picks up changes to the Go code. `just --list` shows all
recipes.

The repository also has a [devcontainer](.devcontainer/devcontainer.json) with the complete toolchain and
its own Docker daemon, so the same recipes work inside it.

### Production Setup

Requirements: a Linux host (amd64 or arm64) with Docker Engine 29 or newer and the compose plugin.
[`docker-compose.prod.yml`](docker-compose.prod.yml) pulls prebuilt images from GHCR; nothing is built on
the host.

```sh
git clone https://github.com/lonetis/scantor.git && cd scantor
just init                     # creates .env with random secrets
$EDITOR .env                  # URLs, SCANTOR_IMAGE_TAG=<version>, optionally the first admin
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs orchestrator | grep /setup   # first-admin link
```

`just prod-up` runs `init`, `pull` and `up -d` in one go. To update, run `git pull` and `just init`
(which adds new variables), then `pull` and `up -d` again.

**TLS with Traefik (recommended for public deployments).** Set `COMPOSE_PROFILES=traefik` and follow the
"TRAEFIK & TLS" section of `.env.example`: a domain with DNS records for `<domain>` and `*.<domain>`, a
wildcard certificate from Let's Encrypt through the DNS-01 challenge (Cloudflare by default, with an API
token; other DNS providers work too) and `https` URLs. Every public endpoint is then served on port 443.
A deployment that is reachable from the network refuses to start while any secret still has its
insecure development value.

**Remote nodes.** Any Docker host can add capacity. As an admin, create a node under **Admin → Nodes**
(or with `scantor nodes create <name>`) and run the `docker run` command it shows on the node host. The
node connects outbound over HTTPS and needs no open ports. See [remote nodes](docs/guide/remote-nodes.md)
for TLS, private networks, pools and Docker-in-Docker.

## Concepts

| Term | Meaning |
|---|---|
| **task** | A folder with a manifest `scantor.yaml`, a `Dockerfile` and an entry file. The code defines the config and result types and two functions: `schedule`, which yields analysis configs, and `run`, which turns one analysis config into one result. |
| **revision** | An immutable, numbered build of a task (`echo@3`; `echo@latest` is the newest ready one). Scans always run a revision. |
| **template** | A ready-made `schedule`: `single`, `list`, `range`, `repeat`, `tranco`, `crux` or `cidr`. |
| **scan** | One execution of a revision with a task config, a scan config and scan settings. |
| **analysis** | One unit of work of a scan, identified as `<scanId>-<seq>`. It ends with a typed result or an error. |
| **worker** | A container that runs a revision's image for one scan: one scheduler, plus as many runners as the scan's `workers` setting. Each worker runs several connector processes (`processes`), each handling one analysis at a time. |
| **node** | A Docker host that runs workers. The master has a built-in node; remote nodes add more. |

A task has three config levels, each a typed object whose fields should all have defaults:

| Config | Given | Passed to | Example |
|---|---|---|---|
| **task config** | once per scan | every `schedule` and `run` call | request timeout, user agent |
| **scan config** | once per scan | `schedule` | which list, how many entries |
| **analysis config** | yielded by `schedule`, one per analysis | `run` | one domain |

**Scan settings** are the platform side of a scan: `workers`, `processes`, the timeout and retries of an
analysis, and the CPU and memory of each process. Their defaults come from the manifest; every scan can
override them.

## The CLI

The `scantor` CLI authors, validates, publishes and runs tasks and inspects scans and results. Install it
in one of three ways:

| Option | Install |
|---|---|
| native binary (Linux, macOS) | download `scantor-<os>-<arch>` (`darwin` or `linux`, `amd64` or `arm64`) from the [releases](https://github.com/lonetis/scantor/releases), make it executable and put it on your `PATH` as `scantor` |
| Docker shim | `curl -fsSLo ~/.local/bin/scantor https://github.com/lonetis/scantor/releases/latest/download/scantor.sh && chmod +x ~/.local/bin/scantor` runs the CLI image with the current directory mounted |
| from this repository | `just cli <command>` runs the CLI of the dev stack |

The CLI reads its credentials only from two environment variables. Create an API key on the **CLI & MCP
access** page of the web UI, which also shows ready-to-paste lines:

```sh
export SCANTOR_URL=https://scantor.example.com
export SCANTOR_TOKEN=sk_scantor_…
scantor whoami
```

`validate`, `dev run` and `dev debug` build and run tasks with your local Docker. The browser editor has
the CLI preinstalled and configured. Every command and flag is in the [CLI reference](docs/guide/cli.md).

## Writing a task

Create a task folder from a scaffold of a language and a template (`custom` for your own schedule):

```sh
scantor init my-task --language python --template custom
```

The web UI (**New task**, from a scaffold, a git repository or an uploaded folder) and the MCP tool
`create_task` do the same. The scaffold publishes unchanged. Its `main.py` defines a task with its own
schedule:

```python
from collections.abc import Iterator

from pydantic import BaseModel, Field

import scantor


class TaskConfig(scantor.Config):
    greeting: str = "Hello"


class ScanConfig(scantor.Config):
    count: int = Field(default=3, ge=0, le=1000, description="Number of analyses.")


class AnalysisConfig(scantor.Config):
    n: int


class Result(BaseModel):
    text: str


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    # Must be deterministic: the same configs always yield the same analyses in the same order.
    for n in range(scan_config.count):
        yield AnalysisConfig(n=n)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    ctx.log("info", "analysing", n=analysis_config.n)
    return Result(text=f"{task_config.greeting}, number {analysis_config.n}!")


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
```

Next to it are the manifest and the Dockerfile:

```yaml
# scantor.yaml
scantor: 1
name: my-task
language: python
defaults:        # optional scan settings defaults
  workers: 2
  processes: 4
  timeout: 2m
```

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

Keep `schedule` deterministic and do network requests in `run`. Raise `Fatal` for permanent failures
and `Retry` for transient ones, store large outputs as files with `ctx.files`, and record expected
outcomes (an unreachable host) in the result instead of failing. The authoring guide of each language
([Python](docs/guide/authoring-python.md), [TypeScript](docs/guide/authoring-typescript.md),
[JavaScript](docs/guide/authoring-javascript.md), [Go](docs/guide/authoring-go.md)) covers the
definition API, the context, files, errors, type checking and debugging; the
[templates](docs/guide/templates.md), [manifest](docs/guide/manifest.md) and
[errors and retries](docs/guide/errors-and-retries.md) guides cover the rest. The
[example tasks](tasks/) use every language and template.

## The local dev loop

```sh
scantor validate my-task                  # every publish check: manifest, Dockerfile, build, describe, type check
scantor dev run my-task --limit 3         # build and run locally: schedule, then up to 3 analyses
scantor dev run my-task --task-config '{"greeting": "Hi"}' --scan-config '{"count": 5}'
scantor dev run my-task --remote          # the same as a test run on the platform, without local Docker
scantor dev debug my-task                 # run one analysis under a debugger (the scaffold has a VS Code launch configuration)
scantor push my-task -m "count numbers" --wait   # upload and publish a revision
```

`dev run` prints results and logs and copies produced files to `.scantor/out/` in the task folder. `push`
creates the task on the platform (the manifest `name` identifies it) and publishes `my-task@1`, then
`my-task@2` and so on. In the browser editor, `scantor dev run` runs as a test run and `scantor push`
publishes the workspace; the task page of the web UI offers the same test runs and publishing.

## Starting and managing scans

```sh
scantor scans start my-task@latest --scan-config '{"count": 1000}' --workers 4 --processes 8
scantor scans watch <scan>                # live progress until the scan finishes
scantor scans list --state running,paused
```

Configs are JSON objects given inline, as `@file` or `-` (stdin); fields you omit take their defaults.
Settings come from the manifest; `--workers`, `--processes` and `--settings '<json>'` override them. Scans
above the instance's confirmation threshold need `--confirm`. For the `list` template, upload a file
first with `scantor uploads create domains.txt` and pass `{"upload": "<id>"}` as the scan config.

| Action | CLI | Effect |
|---|---|---|
| pause, resume | `scantor scans pause <scan>`, `scantor scans resume <scan>` | stop and continue consuming analyses; nothing is lost |
| scale | `scantor scans scale <scan> --workers 8 --processes 4` | changes a running scan live |
| cancel | `scantor scans cancel <scan>` | stops the scan for good; results so far are kept |
| retry failed | `scantor scans retry-failed <scan>` | runs failed and lost analyses again in the same scan |
| restart | `scantor scans restart <scan>` | starts a new scan with the same revision, configs and settings |
| delete | `scantor scans delete <scan>` | removes a finished scan with its results and files |
| diagnose | `scantor scans conditions <scan>`, `scantor scans events <scan>`, `scantor scans worker logs <scan> <worker>` | why a scan does not progress, its timeline, a worker's log |

In the web UI, **New scan** offers the same as forms generated from the revision's config types, with a
size estimate for template schedules. The scan page shows progress, statistics and conditions, and has
tabs for results, a query console, workers, events and exports, plus buttons for every action above.

## Results

Every analysis records its config, its typed result or error, its attempts, the tail of its log and its
files.

```sh
scantor analyses list <scan> --status failed,lost
scantor analyses get <scanId>-<seq>
scantor analyses query <scan> --filter '{"result.status": {"$gte": 500}}' --projection '{"config": 1, "result.status": 1}'
scantor analyses aggregate <scan> --pipeline '[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]'
scantor files get <scanId>-<seq> <file id>
scantor export <scan> --format csv --fields seq,config,result --file results.csv
scantor export <scan> --background --file results.jsonl   # large scans
```

Queries and aggregations are MongoDB filters and pipelines over the analyses of one scan; operators that
run code or read other data are rejected. Exports are JSONL or CSV, optionally filtered and limited to
some fields; background exports appear on the scan's **Exports** tab and in `scantor exports list`. The
REST API is described at `<your scantor URL>/api/docs`.

## Using scantor with LLM agents

scantor has a built-in MCP server at `<your scantor URL>/mcp`. With it an agent such as Claude Code
writes a task, tests and publishes it, runs scans and analyses the results with your account and
permissions. Connect Claude Code with OAuth:

```sh
claude mcp add --transport http scantor https://scantor.example.com/mcp
```

or with an API key (`--header "Authorization: Bearer $SCANTOR_TOKEN"`). The [MCP guide](docs/guide/mcp.md)
covers other clients, access levels, the tools and the agent loop.

This repository is also a Claude Code plugin marketplace. The `scantor` plugin adds two skills, one for
developing tasks and one for running scans and analysing results, and connects the MCP server from the
`SCANTOR_URL` and `SCANTOR_TOKEN` environment variables:

```sh
export SCANTOR_URL=https://scantor.example.com SCANTOR_TOKEN=sk_scantor_…   # before starting Claude Code
claude plugin marketplace add lonetis/scantor
claude plugin install scantor@scantor
```

Inside Claude Code the same works with `/plugin marketplace add lonetis/scantor` and
`/plugin install scantor@scantor`.

## User guides

All guides are in [`docs/guide/`](docs/guide/README.md). They are also built into the CLI and served to
MCP clients.

| Guide | Read it to |
|---|---|
| Authoring in [Python](docs/guide/authoring-python.md), [TypeScript](docs/guide/authoring-typescript.md), [JavaScript](docs/guide/authoring-javascript.md), [Go](docs/guide/authoring-go.md) | write a task |
| [Templates](docs/guide/templates.md) | use and wrap the built-in schedules |
| [Manifest](docs/guide/manifest.md) | write `scantor.yaml` and size workers |
| [Errors and retries](docs/guide/errors-and-retries.md) | understand failures and recover from them |
| [CLI reference](docs/guide/cli.md) | look up every command and flag |
| [MCP](docs/guide/mcp.md) | connect agents |
| [Remote nodes](docs/guide/remote-nodes.md) | add Docker hosts as nodes |
