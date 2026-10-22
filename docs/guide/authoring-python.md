# Authoring tasks in Python

A Python task is a module that assigns `task = scantor.Task(...)`. Configs and results are
[pydantic](https://docs.pydantic.dev) models; basedpyright checks your functions against them, and the
connector derives their JSON Schemas, validates every value that enters or leaves your code and speaks
the connector protocol with the scantor runtime. This guide covers the Python specifics; templates, the
manifest and errors are explained in [templates](templates.md), [manifest](manifest.md) and
[errors and retries](errors-and-retries.md).

## Task folder

```
my-task/
├── scantor.yaml         manifest (name, language: python, defaults)
├── Dockerfile           FROM ${SCANTOR_BASE}, installs requirements.txt
├── main.py              the definition: models, schedule, run, task
├── requirements.txt     your pip requirements (none in the scaffold)
├── pyrightconfig.json   type checking (scantor validate and publishing run basedpyright)
├── .dockerignore        .git/ .scantor/ __pycache__/ *.pyc .venv/ .DS_Store
└── …                    any other modules, data files and tests
```

`scantor init my-task --language python --template tranco` (or the "New task" wizard) creates a folder
that publishes unchanged, including `.devcontainer/`, `.vscode/` (validate, dev run, dev debug and push
tasks plus a debugpy attach configuration) and `AGENTS.md`. The manifest's `entry` defaults to
`main.py`. The connector imports the entry with its folder first on `sys.path`, so `import helpers`
finds `helpers.py` next to it.

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

The base image `scantor-base-python` (Debian trixie, Python 3.14) has the connector installed
system-wide, together with debugpy for `scantor dev debug` and basedpyright for the type check. Add
`RUN apt-get …` lines for system packages as you need them; builder stages are allowed as long as the
final stage is `FROM ${SCANTOR_BASE}`. `CMD` and `ENTRYPOINT` are ignored: the runtime starts your
code.

Dependencies:

- List your packages in `requirements.txt` with version ranges, for example `httpx>=0.28.1,<1`.
- Never list `scantor` or `pydantic`. The base image pins the connector's dependencies (pydantic,
  pydantic-core, typing-extensions, annotated-types, typing-inspection) and debugpy through
  `PIP_CONSTRAINT` (and `UV_CONSTRAINT`, if you install uv), so a requirement that needs other versions
  of them fails the image build with a pip resolution error instead of breaking the connector at run
  time.

## Defining a task

The [`echo`](../../tasks/echo) example is the smallest task: no schedule, so every scan has exactly
one analysis.

<!-- scantor:include tasks/echo/main.py -->
```python
"""echo: the smallest task. Each scan has one analysis that echoes a message from the task config.

There is no schedule, so the template `single` creates exactly one analysis with an empty analysis config.
"""

from pydantic import BaseModel

import scantor


class TaskConfig(scantor.Config):
    text: str = "Hello, World!"


class Result(BaseModel):
    echo: str


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    ctx.log("info", "echoing", length=len(task_config.text))
    return Result(echo=task_config.text)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
```
<!-- scantor:include:end -->

| Argument | Type | Purpose |
|---|---|---|
| `task_config=` | `scantor.Config` subclass, default `scantor.Empty` | behaviour parameters, constant for all analyses of a scan |
| `scan_config=` | `scantor.Config` subclass, default `scantor.Empty` | input of `schedule` |
| `analysis_config=` | `scantor.Config` subclass, default `scantor.Empty` | input of one `run`, produced by `schedule` |
| `result=` | any `pydantic.BaseModel` subclass (required) | what one successful analysis returns |
| `schedule=` | `schedule(ctx, scan_config, task_config)`: generator, async generator, or a function returning an iterable or async iterable | yields analysis configs; omitted: every scan runs exactly one analysis (template `single`) |
| `run=` | `run(ctx, analysis_config, task_config)`: `def` or `async def` returning the result (required) | one attempt of one analysis |

`schedule` runs once per scan, `run` once per attempt of an analysis. `run` never sees the scan config:
put whatever an analysis needs into the analysis config and whatever is constant into the task config.
The parameters are validated model instances with defaults filled in; what you return or yield may be a
model instance or a plain `dict`, which is validated with the declared model. `scantor.Task(...)`
raises `TypeError` when the module is imported if `result` or `run` is missing, a type is not a pydantic
model, or `run`'s annotations name other models than the ones passed; the publish then fails at
describe.

`scantor.Task` is generic, so basedpyright checks the definition: a `run` that returns the wrong model,
takes the task config where the analysis config belongs, or cannot accept what `schedule` yields is a
type error, and a type error fails the publish (see [type checking](#type-checking)).

The runtime starts several connector processes per worker (`processes`), each handling one call at a
time, so module-level state (a cache, a client) is per process and lives for many analyses.

A complete task: the [`origins`](../../tasks/origins) example iterates a Tranco top list in its own
schedule, skips some top-level domains, and fetches every origin with httpx (`requirements.txt`:
`httpx>=0.28.1,<1`).

<!-- scantor:include tasks/origins/main.py -->
```python
"""origins: fetch every origin of a Tranco top list and record its HTTP status and response headers.

The schedule wraps the template `tranco`: it iterates the list, skips domains by top-level domain and
turns each domain into an origin. The network access happens in `run`, never in `schedule`, which must
stay deterministic.
"""

from collections.abc import Iterator
from typing import Literal

import httpx
from pydantic import BaseModel, Field

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    user_agent: str = Field(
        default="scantor-origins/1.0 (+https://github.com/lonetis/scantor)", description="User-Agent of every request."
    )
    timeout_seconds: float = Field(default=10, gt=0, le=300, description="Timeout of one request.")
    follow_redirects: bool = Field(default=True, description="Follow redirects to the final URL.")


class ScanConfig(templates.tranco.ScanConfig):
    """The tranco template's fields plus our own filters."""

    scheme: Literal["https", "http"] = Field(default="https", description="Scheme of the fetched origins.")
    skip_tlds: list[str] = Field(default=[], description='Top-level domains to skip, for example ["cn"].')


class AnalysisConfig(scantor.Config):
    origin: str
    rank: int


class Result(BaseModel):
    origin: str
    rank: int
    status: int | None
    final_url: str | None
    headers: dict[str, str]
    error: str | None


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    skipped = {tld.lower().lstrip(".") for tld in scan_config.skip_tlds}
    for item in templates.tranco.schedule(ctx, scan_config):  # wrapped: streamed from the runtime
        if item.domain.rsplit(".", 1)[-1] not in skipped:
            yield AnalysisConfig(origin=f"{scan_config.scheme}://{item.domain}", rank=item.rank)


async def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    origin, rank = analysis_config.origin, analysis_config.rank
    remaining = ctx.remaining()
    timeout = task_config.timeout_seconds if remaining is None else min(task_config.timeout_seconds, remaining)
    headers = {"user-agent": task_config.user_agent}
    async with httpx.AsyncClient(
        headers=headers, timeout=timeout, follow_redirects=task_config.follow_redirects
    ) as client:
        try:
            # Only the status and the headers are recorded, so the body is never downloaded.
            async with client.stream("GET", origin) as response:
                status, final_url, response_headers = response.status_code, str(response.url), dict(response.headers)
        except httpx.TransportError as exc:
            # An unreachable origin is a measurement result, not a failure of the task.
            ctx.log("warning", "request failed", origin=origin, error=repr(exc))
            return Result(
                origin=origin, rank=rank, status=None, final_url=None, headers={}, error=f"{type(exc).__name__}: {exc}"
            )
    if status == 429:
        retry_after = response_headers.get("retry-after", "")
        raise scantor.Retry("rate limited", delay=float(retry_after) if retry_after.isdigit() else None)
    ctx.log("info", "fetched", origin=origin, status=status)
    return Result(origin=origin, rank=rank, status=status, final_url=final_url, headers=response_headers, error=None)


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
```
<!-- scantor:include:end -->

## Config and result models

Configs derive from `scantor.Config`; results are any `pydantic.BaseModel`. The connector exports their
JSON Schemas with pydantic (configs in validation mode, results in serialization mode), so pydantic's
field syntax is the schema language:

- Configs reject unknown keys (`scantor.Config` sets `extra="forbid"`), so a typo such as
  `"limt": 100` fails when the scan starts instead of silently using the default. Nested config models
  should derive from `scantor.Config` too; describe warns about nested models that accept unknown keys.
- Give every config field a default, so that `{}` is a valid config and the forms in the UI start
  filled in. A field without a default is required.
- Constraints and documentation come from `Field(...)`: `ge`, `le`, `gt`, `lt`, `multiple_of`,
  `min_length`, `max_length`, `pattern`, `description`, `title`, `examples`. `Literal[...]` becomes an
  enum; `X | None` is nullable. Field names are the JSON names; use `Field(alias="camelCase")` if you
  want other names in the API.
- Stay within the JSON Schema subset the platform validates and renders: objects, strings, numbers,
  booleans, arrays, enums, nullable fields, nested models and discriminated unions. Tuples, recursive
  models and `allOf`-style constructs produce describe warnings and are edited as raw JSON in the UI.
- `pydantic.SecretStr` marks a secret (`writeOnly`): it is encrypted at rest and shown as `***` in every
  response; your code reads it with `.get_secret_value()`. Secrets that your code writes into logs or
  results cannot be masked. An omitted secret keeps its Python default.
- Results must serialise to JSON: `NaN`, infinities and bytes are rejected with a `validation` error.
  Results are limited in size; store large data as [files](#files).

Every value is checked: configs before your code sees them, analysis configs your schedule yields and
results your run returns before they leave the process. A violation fails the call with a `validation`
error whose issues name the paths.

Types the connector provides:

| Type | Meaning |
|---|---|
| `scantor.Config` | base of every config model (`extra="forbid"`) |
| `scantor.Empty` | a config without fields: `{}` |
| `scantor.FileRef` | a reference to a file stored with `ctx.files`; results may contain FileRefs anywhere (fields, nested models, lists), and the UI renders them as download links. The attribute `content_type` is `contentType` in JSON. |

## The context

Every call gets a `ctx` (`scantor.Context`):

| Member | In `run` | In `schedule` |
|---|---|---|
| `ctx.scan_id` | scan id (`local` in `scantor dev run`, the test-run id in test runs) | same |
| `ctx.analysis_id`, `ctx.seq` | `<scanId>-<seq>`, the 0-based position in the schedule | `None` |
| `ctx.attempt` | 1-based attempt of the analysis | scheduler start count |
| `ctx.deadline` | epoch seconds at which the attempt ends (the scan's `timeout`) | `None` |
| `ctx.remaining()` | seconds until the deadline (`None` without one) | `None` |
| `ctx.cancelled` | `True` once the call is cancelled (deadline, or the worker drains or stops) | same |
| `ctx.tmp_dir` | empty scratch directory (`pathlib.Path`), deleted after the call | same |
| `ctx.log(level, message, **fields)` | log line with structured fields | same |
| `ctx.progress(fraction, message)` | progress 0…1 (`None` = unknown), shown for running analyses | ignored |
| `ctx.files.put(...)`, `await ctx.files.aput(...)` | file storage | raises a `validation` error |

Log levels are `"debug"`, `"info"`, `"warning"` and `"error"`; whatever `print` and other code write
to stdout or stderr is captured too and appears in the analysis log.

### Sync and async

`run` may be `def` or `async def`, and `schedule` a generator, an async generator or a function that
returns an iterable. Each process handles one call at a time, so blocking code is fine. Async code is
cancelled at the deadline and when the worker drains or stops: `asyncio.CancelledError` is raised at
the next `await`, as in the [`sleep`](../../tasks/sleep) example:

<!-- scantor:excerpt tasks/sleep/main.py -->
```python
    while remaining > 0:
        step = min(1.0, remaining)
        await asyncio.sleep(step)  # raises asyncio.CancelledError when the analysis is cancelled
        remaining -= step
```

Synchronous code cannot be interrupted; check `ctx.cancelled` in long loops and stop by raising. At
the deadline the runtime kills the process, so cleanup must not rely on running afterwards: budget long
work with `ctx.remaining()`, for example as a request timeout (as `origins` does).

## Files

```python
shot = ctx.files.put("shot.png", png_bytes, "image/png")       # bytes
notes = ctx.files.put("notes.txt", "hello\n", "text/plain")    # str, stored as UTF-8
report = ctx.files.put("report.json", report_path)              # os.PathLike: copies the file now
shot = await ctx.files.aput("shot.png", png_bytes, "image/png")  # in async code
```

Large or binary outputs belong in files, not in the result. `put` copies the content and returns the
final `scantor.FileRef` at once; store it in the result. The files are uploaded only after `run`
succeeded, so files of failed attempts disappear, and the upload does not count toward the timeout.
Names are 1–255 characters without `/`, `\` and NUL and unique within the attempt. The content type
defaults to `application/octet-stream`; pass `image/png`, `image/jpeg`, `image/gif` or `image/webp` for
images that should open inline. Violated rules and platform limits (`SCANTOR_MAX_FILE_BYTES`,
`SCANTOR_MAX_FILES_PER_ANALYSIS`) raise a `scantor.ScantorError` of type `validation`.

The [`files`](../../tasks/files) example stores files by content and by path and references them from
nested models and lists:

<!-- scantor:excerpt tasks/files/main.py -->
```python
class Attachments(BaseModel):
    data: scantor.FileRef
    image: scantor.FileRef


class Result(BaseModel):
    item: str
    length: int
    data: scantor.FileRef
    image: scantor.FileRef
    notes: scantor.FileRef
    nested: Attachments
    gallery: list[scantor.FileRef]


def run(ctx: scantor.Context, analysis_config: templates.list.AnalysisConfig, task_config: TaskConfig) -> Result:
    item = analysis_config.item
    document = json.dumps({"item": item, "index": analysis_config.index, "upper": item.upper()}, indent=2)
    data = ctx.files.put("data.json", document, "application/json")
    image = ctx.files.put("image.png", PIXEL, "image/png")  # image types are shown inline in the UI

    # A file written to the scratch directory is stored by path; its content is copied at once.
    notes_path = ctx.tmp_dir / "notes.txt"
    notes_path.write_text(f"Notes on {item}\n", encoding="utf-8")
    notes = ctx.files.put("notes.txt", notes_path, "text/plain")
```

## Errors and retries

| `run` raises | Error type | Effect |
|---|---|---|
| `scantor.Fatal(message)` | `fatal` | the analysis fails now, without retries |
| `scantor.Retry(message, delay=None)` | `retry` | another attempt after `delay` seconds (a `float` or a `datetime.timedelta`; `None` = the scan's backoff), clamped to [1 s, backoff max]; counts toward `maxAttempts` |
| any other exception | `taskError` | another attempt after the backoff; the traceback is kept |
| a `scantor.ScantorError` of type `validation` (from files or templates), a `pydantic.ValidationError` | `validation` | fails now |
| invalid config or result | `validation` | fails now; the issues name the paths |
| deadline exceeded | `timeout` | retried; the process is replaced |
| the process exits or runs out of memory | `crash` | retried; the process is replaced |

The [`throws`](../../tasks/throws) example produces each outcome on demand (task config `mode`):

<!-- scantor:excerpt tasks/throws/main.py -->
```python
    match task_config.mode:
        case "error":
            raise RuntimeError("demo exception in run")  # taskError: retried after the backoff
        case "fatal":
            raise scantor.Fatal("demo fatal error")  # fails now, no further attempts
        case "retry":
            raise scantor.Retry("demo retry", delay=task_config.retry_delay)  # retried after the delay
        case "flaky" if ctx.attempt <= task_config.fail_attempts:
            raise RuntimeError(f"demo failure in attempt {ctx.attempt}")
        case "timeout":
            # Ignores ctx.cancelled on purpose: the runtime ends the analysis at its deadline (timeout).
            time.sleep((ctx.remaining() or 3600) + 60)
        case "crash":
            os._exit(3)  # the process dies (crash) and is replaced
```

Raise `Fatal` when retrying cannot help (an invalid input, a permanent refusal) and `Retry` for
transient conditions that announce their own delay (rate limits). In `schedule`, `Fatal` and
`validation` errors fail scheduling, while other errors restart the scheduler with backoff. See
[errors and retries](errors-and-retries.md) for the scan-level view.

## Schedules and templates

A schedule yields analysis configs. It must be deterministic: the same scan config and task config
always yield the same analysis configs in the same order, because the scheduler resumes after a
restart by replaying the stream and verifying it. Do anything slow or random in `run`. The base image
sets `PYTHONHASHSEED=0`, so even iterating a `set` of strings gives the same order in every process;
sorting is still the clearer choice. The scaffold's custom schedule:

<!-- scantor:excerpt scaffolds/python/entry/custom.py.tmpl -->
```python
def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    # Must be deterministic: the same configs always yield the same analyses in the same order.
    for n in range(scan_config.count):
        yield AnalysisConfig(n=n)
```

Templates are ready-made schedules (see [templates](templates.md)). `scantor.templates` has one module
per template with the models `ScanConfig` and `AnalysisConfig` and the proxy `schedule`:

| Template | Module | Scan config fields | Analysis config fields |
|---|---|---|---|
| `single` | `templates.single` | none | none |
| `list` | `templates.list` | `items`, `upload`, `offset`, `limit` | `item`, `index` |
| `range` | `templates.range` | `start`, `end`, `step` | `value` |
| `repeat` | `templates.repeat` | `times` | `iteration` |
| `tranco` | `templates.tranco` | `list`, `subdomains`, `offset`, `limit` | `domain`, `rank` |
| `crux` | `templates.crux` | `country`, `month`, `bucket` | `origin`, `rank` |
| `cidr` | `templates.cidr` | `cidrs`, `exclude`, `prefix`, `max_analyses` (JSON `maxAnalyses`) | `ip`, `prefix`, `version` |

Import the package, `from scantor import templates`, and use `templates.range` and `templates.list`
through it: `from scantor.templates import range` would hide the builtin `range` (importing `tranco`,
`crux`, `cidr` or `repeat` by name is fine).

**Unwrapped.** Pass the proxy itself, `schedule=templates.repeat.schedule`, and the scheduler runs the
template natively: the scan's size is known up front and the scan page shows where the data came from.
The scan config and analysis config are then the template's own: omit them or pass the template's
models. From the [`sleep`](../../tasks/sleep) example:

<!-- scantor:excerpt tasks/sleep/main.py -->
```python
async def run(
    ctx: scantor.Context, analysis_config: templates.repeat.AnalysisConfig, task_config: TaskConfig
) -> Result:
    ...


task = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.repeat.schedule, run=run)
```

**Wrapped.** To filter or reshape a template, iterate the proxy in your own schedule, with `for` in a
generator or `async for` in an async generator. To extend the template's scan config, subclass its
`ScanConfig` and add fields, as `origins` does with `ScanConfig(templates.tranco.ScanConfig)`; the proxy
accepts the subclass (or a plain `dict`) and sends only the template's own fields. The items stream from
the runtime while you consume them; leaving the loop early (`break`, `return`) stops the stream.
Template errors (for example a list that cannot be downloaded) are raised as `scantor.ScantorError` at
the next iteration; let them propagate and scheduling is retried or failed accordingly. Calling a proxy
in `run` raises a `validation` error.

## Type checking

The `check` phase of a publish (and `scantor validate`) runs basedpyright in the built image with your
`pyrightconfig.json`; the scaffold's file selects `standard` mode for Python 3.14. Every error fails
the publish and is reported with its file and line. Tune the strictness in `pyrightconfig.json` (or
`[tool.basedpyright]` in a `pyproject.toml`); without either file the check uses `standard` mode. Test
runs and `scantor dev run` skip the check, so run `scantor validate .` before pushing.

## Develop, debug and publish

| Command | Does |
|---|---|
| `scantor validate .` | static checks, image build, describe and basedpyright exactly as on publish |
| `scantor dev run . --limit 5` | build and run locally (schedule, then up to 5 analyses); `--task-config`, `--scan-config` and `--analysis-config` take JSON; files land in `.scantor/out/`; `--remote` runs on the platform |
| `scantor dev debug .` | start one analysis under debugpy on `localhost:5678`, waiting for the debugger before your module is imported |
| `scantor push .` | upload and publish a revision |

For example, `scantor dev run tasks/echo --task-config '{"text": "hi"}'` runs the one analysis of
`echo`, whose result is `{"echo": "hi"}`. In the browser editor `scantor dev run` runs on the platform.

Debugging with VS Code: run `scantor dev debug .` (or the task "scantor: dev debug"), then start the
scaffold's launch configuration "scantor: attach to dev debug" (debugpy attach to `localhost:5678`,
`${workspaceFolder}` mapped to `/task`). Set breakpoints before attaching; module-level code runs right
after the debugger attaches. There is no deadline while debugging, so you can pause as long as you
need. The scaffold's `.devcontainer/` opens the folder inside the task's own image, where the connector,
your requirements and the interpreter (`/usr/local/bin/python`) resolve exactly as in a worker.

## Docker inside a task

Tasks with `defaults.privileged: true` run on Docker-in-Docker nodes and need the owner's
`canRunPrivileged` permission. The base image contains no Docker engine; install it in the Dockerfile
and keep the root user:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*
```

The runtime starts the inner Docker daemon before your process and sets `SCANTOR_DIND=1`; use the
default socket (for example with the `docker` package from `requirements.txt`). Describe, test runs and
`scantor dev run` never run privileged, so do not touch Docker at import time.
