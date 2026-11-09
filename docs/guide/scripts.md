# Scripts

A script evaluates the results and files of your scans. It is a small Python folder that you edit in the
browser editor, push with the CLI or write through MCP. Each **script run** builds the folder as it is
at that moment, starts one container on the master and calls your `run(ctx, config)` with the scans you
selected. The run streams their analyses with typed results, reads their files, stores output files
(CSV, JSON, anything) and returns a JSON summary. A run can take days: it reports progress, saves
checkpoints, and a restart with resume continues where it stopped. Scripts have no revisions: every run
uses the current folder.

Scripts are written in Python (module `scantor.script` of the connector), whatever language the task of
the scan was written in: results are JSON, and you describe them with a pydantic model.

## Script folder

```
files-report/
├── scantor-script.yaml   manifest (name, language: python, defaults)
├── Dockerfile            FROM ${SCANTOR_BASE}, installs requirements.txt
├── main.py               the definition: config and result models, run, script
├── models.py             the task's result model, copied from the task
├── requirements.txt      your pip requirements
├── pyrightconfig.json    type checking in the editor
├── .dockerignore         .git/ .scantor/ __pycache__/ *.pyc .venv/ .DS_Store
└── …                     any other modules and data files
```

Create a script with "New script" on the Scripts page, `scantor scripts create files-report`, the MCP
tool `create_script`, or locally with `scantor scripts init files-report`. The scaffold is a working
example: it counts the succeeded analyses of the first scan in worker processes, reports progress,
checkpoints, writes a CSV output and returns a summary. It also adds a `.gitignore` and an `AGENTS.md`
with notes for coding agents. In the browser editor, your scripts are the folders under `.scripts/` of
your workspace, next to your tasks. A script and a task may have the same name.

The `Dockerfile` follows the rules of task Dockerfiles: `ARG SCANTOR_BASE` and a final stage
`FROM ${SCANTOR_BASE}`, here the Python base image with pydantic and the connector (including
`scantor.script`) installed. Never list `scantor` or `pydantic` in `requirements.txt`. The working
directory is `/task`. The image is built on the master when a run starts and stays there; a run of an
unchanged folder reuses it. Install everything your code needs in the `Dockerfile`: the build can
download packages, the run cannot ([environment and limits](#environment-and-limits)).

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

## Manifest

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lonetis/scantor/main/schemas/script-manifest.schema.json
scantor: 1
name: files-report
language: python
description: Reads every file of a scan of the example task files and writes a CSV and a JSON report.
entry: main.py
defaults:
  timeoutMs: 7200000
  resources:
    cpus: 2
    memoryMiB: 2048
```

| Field | Meaning |
|---|---|
| `scantor` | always `1` |
| `name` | the script name: lowercase letters, digits and `-`, unique among your scripts, equal to the folder name |
| `language` | `python` |
| `description` | shown in the UI, the CLI and MCP (at most 1024 characters) |
| `entry` | the file that defines `script`, default `main.py` |
| `defaults.timeoutMs` | total duration of a run in milliseconds, at least 1000; without it the instance maximum `SCANTOR_SCRIPT_RUN_TIMEOUT` |
| `defaults.resources.cpus` | CPUs of the run's container, default 1; `ctx.cpus` tells your code |
| `defaults.resources.memoryMiB` | memory of your code in MiB, at least 256, default 1024; the container gets 256 MiB more |

A run can override every default (run form, `--timeout`, `--cpus`, `--memory`, or `settings` in MCP),
up to the instance limits `SCANTOR_SCRIPT_RUN_TIMEOUT`, `SCANTOR_SCRIPT_RUN_MAX_CPUS` and
`SCANTOR_SCRIPT_RUN_MAX_MEMORY`. Unknown keys are errors. The browser editor validates the manifest
as you type; elsewhere, the modeline above binds the JSON Schema.

## Defining a script

The script below reads a scan of the example task [`files`](../../tasks/files), which stores seven
files with every analysis and references them from its result. It is the script the end-to-end tests
run.

<!-- scantor:excerpt tests/fixtures/scripts/files-report/models.py -->
```python
from pydantic import BaseModel

import scantor


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
```

`models.py` holds the task's result model, copied from the task's `main.py` together with the models it
uses. For a task in another language, write the pydantic model of its JSON result, or leave the model
out and read results as dicts.

<!-- scantor:excerpt tests/fixtures/scripts/files-report/main.py -->
```python
import csv
import io
import shutil

from pydantic import BaseModel, Field

import scantor
from models import Result
from scantor.script import Analysis, Script, ScriptContext

CSV_NAME = "files.csv"
HEADER = ["seq", "item", "files", "bytes", "upper"]


class Config(scantor.Config):
    workers: int = Field(default=8, ge=1, le=64, description="Threads that read files in parallel.")


class Row(BaseModel):
    seq: int
    item: str
    files: int
    bytes: int
    upper: str


class Summary(BaseModel):
    scan: str
    analyses: int
    files: int
    bytes: int
    resumed: bool


def inspect(analysis: Analysis[Result]) -> Row:
    """Read every file of one analysis (each checked against its SHA-256); runs in worker threads."""
    result = analysis.result
    if result is None:
        raise ValueError(f"analysis {analysis.id} has no result")
    sizes = [len(analysis.read_bytes(ref)) for ref in analysis.files]
    data = analysis.read_json(result.data)
    return Row(seq=analysis.seq, item=result.item, files=len(sizes), bytes=sum(sizes), upper=data["upper"])


def run(ctx: ScriptContext, config: Config) -> Summary:
    scan = ctx.scans[0]
    state = ctx.resume_state or {"after_seq": None, "analyses": 0, "files": 0, "bytes": 0}
    total = min(ctx.limit, scan.counts.succeeded) if ctx.limit else scan.counts.succeeded
    previous = next((out for out in ctx.resume_outputs if out.name in {CSV_NAME, f"{CSV_NAME}.partial"}), None)

    stream = ctx.analyses(scan, result=Result, status="succeeded", after_seq=state["after_seq"])
    rows = ctx.map(inspect, stream, workers=config.workers, ordered=True)
    with ctx.outputs.open(CSV_NAME) as file:
        if previous is not None:
            shutil.copyfileobj(io.TextIOWrapper(previous.open(), encoding="utf-8", newline=""), file)
        writer = csv.writer(file)
        if previous is None:
            writer.writerow(HEADER)
        for row in rows:
            writer.writerow([row.seq, row.item, row.files, row.bytes, row.upper])
            state["analyses"] += 1
            state["files"] += row.files
            state["bytes"] += row.bytes
            state["after_seq"] = rows.watermark
            ctx.progress(state["analyses"], total, f"{state['files']} files read")
            ctx.checkpoint(state)

    summary = Summary(
        scan=scan.name,
        analyses=state["analyses"],
        files=state["files"],
        bytes=state["bytes"],
        resumed=ctx.resume_state is not None,
    )
    ctx.outputs.put("summary.json", summary.model_dump_json(indent=2), "application/json")
    ctx.log("report written", analyses=summary.analyses, files=summary.files)
    return summary


script = Script(run=run, config=Config, result=Summary)
```

The entry assigns `script = scantor.script.Script(...)`:

| Argument | Type | Purpose |
|---|---|---|
| `run=` | `run(ctx, config)`: `def` or `async def` (required) | the script; returns the result |
| `config=` | `scantor.Config` subclass, default `scantor.Empty` | the run's parameters, validated before `run` is called; an invalid config fails the run with a `validation` error |
| `result=` | `pydantic.BaseModel` subclass, optional | what `run` returns (a model instance or a dict), validated and stored as the run's result; without it `run` returns None or any JSON value |

`Script(...)` raises `scantor.DefinitionError` when the module is imported if `run` cannot take
`(ctx, config)`, a type is not a pydantic model, or a model has a secret field (`SecretStr`,
`writeOnly`): scripts keep configs and results as given, so secrets go through [secrets](#secrets).
basedpyright checks the definition like a task's: a `run` that returns the wrong model is a type error.
When a run starts, the script reports its config and result JSON Schemas. From then on, as long as the
folder content stays the same, the run form shows a form for the config, and a new run with an invalid
config is refused at once (`configInvalid`, with the issues) instead of failing in its container.

The API is synchronous. An `async def run` works (use async libraries in it), but the stream, file and
output calls block while they wait.

## The context

| Member | Meaning |
|---|---|
| `ctx.scans` | the run's scans (`Scan`), in the order they were selected |
| `ctx.scan(id_or_name)` | one of them by id or name |
| `ctx.analyses(scan, ...)` | the analyses of a scan as a typed stream ([reading analyses](#reading-analyses)) |
| `ctx.count(scan, status=...)` | how many analyses a scan has (with one of the statuses) |
| `ctx.aggregate(scan, pipeline, limit=...)` | an aggregation pipeline over a scan's analyses, like `aggregate_analyses`; returns the documents, `.truncated` when cut at the limit |
| `ctx.map(fn, items, ...)` | `fn` over many items in threads and worker processes ([parallelism](#parallelism)) |
| `ctx.outputs` | output files: `ctx.outputs.put(...)`, `ctx.outputs.open(...)` ([outputs](#outputs)) |
| `ctx.progress(done, total=None, message=None)` | progress shown on the run page, sent at most once per second |
| `ctx.checkpoint(state)` | JSON state for a restart with resume ([long runs](#long-runs)) |
| `ctx.resume_state`, `ctx.resume_outputs` | the last checkpoint and the outputs of the run this run resumes; `None` and `[]` otherwise |
| `ctx.secrets` | the run's secrets by name ([secrets](#secrets)) |
| `ctx.log(message, **fields)` | a line `message key=value …` in the run log; `print` works as well |
| `ctx.cpus` | the run's CPUs, at least 1: a good `processes=` |
| `ctx.limit` | the sample size of a sample run ([sample runs](#sample-runs)), `None` for a full run |
| `ctx.deadline`, `ctx.remaining()` | when the run times out (epoch seconds) and the seconds left |
| `ctx.cancelled`, `ctx.check_cancelled()` | whether the run is being stopped; raise `Cancelled` if it is |
| `ctx.run_id`, `ctx.script_name` | the run's id and the script's name |

A `Scan` has `id`, `name`, `state`, `task_name`, `revision_number`, `max_seq`, `counts` (analyses by
status: `total`, `succeeded`, `failed`, `lost`, `cancelled`, `pending`, `retrying`), `result_schema`,
`analysis_config_schema`, `created_at` and `completed_at`, as they were when the run started. A run may
read a scan that is still running: it reads the analyses that exist when the stream gets to them, and
the run log says so.

`ctx.count` of a finished scan answers from `scan.counts` without asking the platform. On a running scan
it runs a query, like every `ctx.aggregate`, and queries have a time limit: on a scan with millions of
analyses they can fail with a `ScriptError` of code `queryTimeout`, which is not retried because the
same query would time out again. Use `scan.counts` instead (the counts when the run started, approximate
while the scan runs), or count while you stream the analyses.

## Reading analyses

```python
stream = ctx.analyses(
    scan,                          # a Scan, its id or its name
    result=Result,                 # the task's result model; omitted: dicts
    analysis_config=ItemConfig,    # the task's analysis config model; omitted: dicts
    status="succeeded",            # one status or a list
    filter={"result.length": {"$gte": 10}},
    fields=None,                   # a list of fields, "all", or None for the default set
    after_seq=None,                # start after this seq
    until_seq=None,                # stop after this seq
    file_urls=True,
    invalid="raise",               # or "skip"
)
for analysis in stream:
    ...
```

The stream delivers the analyses in seq order, every analysis exactly once. A dropped connection, an
orchestrator restart or a transient database error is resumed where it stopped; you do not notice it.
`filter` takes the query operators of `query_analyses`, `status` uses the status index. Iterate a stream
once; call `ctx.analyses(...)` again for another pass.

| Analysis field | Meaning |
|---|---|
| `id`, `seq`, `scan_id` | `<scanId>-<seq>`, its position in the scan, the scan |
| `status` | `succeeded`, `failed`, `lost`, `cancelled`, `pending` or `retrying` |
| `attempt`, `round` | the attempt that produced the outcome, the retry round |
| `config` | the analysis config (`analysis_config=` model or dict) |
| `result` | the result (`result=` model or dict) of a succeeded analysis, else None |
| `error` | an `AnalysisError` (`type`, `message`, `retryable`, `phase`, `stack`, …) of a failed analysis |
| `files` | the analysis's files (`FileRef`) |
| `attempts`, `timings`, `log_tail` | only with `fields="all"` |

`fields` limits what is sent, for large results: `fields=["result.title"]`. `id`, `seq`, `status`,
`attempt` and `round` are always included, and `files` while `file_urls` is true. A partial result
rarely matches the full result model, so leave `result` out or give a smaller model. An analysis that
does not match the models raises a `pydantic.ValidationError` naming the analysis; `invalid="skip"`
logs it and continues (`stream.skipped` counts them).

`stream.watermark` is the highest seq up to which every matching analysis has been delivered (-1
before the first), `stream.count` the number received (skipped ones included), `stream.limited` tells
whether a sample run cut the stream, and `stream.complete` whether it reached its end. Store the
watermark in a checkpoint and pass it back as `after_seq` to continue there.

Untyped results are dicts, with the task's FileRefs already turned into `scantor.FileRef` objects.

## Files

The files of an analysis are read through the analysis:

```python
analysis.read_bytes(result.report)          # bytes, checked against the file's SHA-256
analysis.read_text("notes.txt")             # a file by name, decoded (encoding="utf-8")
analysis.read_json(result.data)             # parsed JSON
analysis.read_json(result.data, Headers)    # validated as a pydantic model
with analysis.open(result.image) as image:  # a binary stream, for large files
    header = image.read(16)
analysis.download(result.image, "/tmp/image.png")  # streamed to disk, checked
ref = analysis.file("notes.txt")            # the FileRef
```

A file is a `FileRef` of the result, a FileRef dict, or a file id or name, and always a file of that
analysis. A content that does not match its SHA-256 raises `ScriptError` with code `integrity`. The
stream sends a presigned URL with every file; an expired URL is renewed automatically, so a long
computation between two reads of the same analysis is fine. With `file_urls=False` the URLs are fetched
when you read a file.

## Parallelism

`ctx.map(fn, items, ...)` calls `fn` on every item and iterates the results:

```python
def check(analysis: Analysis[Result]) -> bool:          # module level: runs in worker processes
    if analysis.result is None or analysis.result.report is None:
        return False
    return "content-security-policy" in analysis.read_json(analysis.result.report).get("headers", {})


results = ctx.map(check, stream, processes=ctx.cpus, workers=16, errors="collect")
for ok in results:
    ...
```

| Argument | Meaning |
|---|---|
| `workers=16` | threads per process; they overlap the waiting for files |
| `processes=1` | worker processes for CPU-bound work (Python runs one thread at a time per process); `ctx.cpus` uses the run's CPUs |
| `ordered=False` | results in completion order; `True` keeps the order of the items |
| `errors="raise"` | the first exception of `fn` stops the map and is raised; `"collect"` records failures in `results.errors` as `(analysis id or index, message)` and continues |
| `max_errors=100` | with `"collect"`, more failures than this raise `ScriptError` |

At most about `processes × workers × 2` items are in flight, so memory stays flat however large the
scan is. With an analysis stream, `results.watermark` is the highest seq with every analysis up to it
handed out to your loop (or collected as an error): checkpoint it instead of `stream.watermark`. When
you write rows or count results and checkpoint the watermark, pass `ordered=True`: in completion order,
results past the watermark are already written and counted, and a resumed run would see them again.

An analysis that does not match the stream's models stops the map with its `pydantic.ValidationError`,
also with `errors="collect"` and in worker processes; `invalid="skip"` on the stream skips it instead.

With `processes > 1`, every worker process imports your entry again and receives the analyses as raw
lines, which it validates itself. Therefore:

- `fn` must be a module-level function (no lambda, no nested function); `ctx.map` raises `TypeError`
  otherwise.
- `fn`'s results (and plain items) are pickled: return simple values or models.
- Importing the entry must not do work: keep everything in `run`, as in the examples.

## Long runs

`ctx.progress(done, total, message)` shows progress on the run page, the CLI and MCP.
`ctx.checkpoint(state)` saves any JSON value of up to 1 MiB: it is copied when you call it, saved at most
every ten seconds, and the latest one is saved when the run ends, also when it fails, is cancelled or
times out. Call both as often as you like.

A restart with resume of a run that has ended starts a new run of the script's current folder with the
same scans, config, secrets and settings ("Resume" on the run page, `scantor scripts runs restart <run-id> --resume`, or the MCP tool
`restart_script_run` with `"resume": true`). In it, `ctx.resume_state` is the last checkpoint of the
old run and `ctx.resume_outputs` its outputs, including partial ones: the example above continues
after the stored watermark and copies the rows the old run had written. A restart without resume
starts from scratch.

When a run is stopped (cancelled, timed out, or the master shuts down), your code gets SIGTERM: the
next stream line, map result or `ctx.check_cancelled()` raises `scantor.script.Cancelled`. It is a
`BaseException`, so `except Exception` does not catch it. Open outputs are stored as `<name>.partial`,
the checkpoint is saved, and after 50 seconds the process is killed. Call `ctx.check_cancelled()` in
long loops of your own. Runs survive orchestrator restarts: the container keeps running, and every
call to the platform is retried for up to ten minutes.

## Sample runs

A sample run reads at most `limit` analyses per stream: "Try on 100 analyses" on the script page,
`scantor scripts run … --limit 100`, or `"settings": {"limit": 100}` in MCP. `ctx.limit` is the limit,
`stream.limited` tells that it cut a stream. Try a new script on a sample before you run it on millions
of analyses; MCP clients must ask you before they start a full run.

## Outputs

```python
output = ctx.outputs.put("summary.json", summary.model_dump_json(), "application/json")

with ctx.outputs.open("rows.csv") as file:        # text; "wb" for bytes
    writer = csv.writer(file)
    for row in rows:
        writer.writerow(row)
```

`ctx.outputs.put(name, data, content_type=None)` stores bytes, a `str` (as UTF-8) or the file at a
`pathlib.Path`. `ctx.outputs.open(name, mode="w", encoding="utf-8", newline="", content_type=None)`
streams: parts are uploaded while you write, so an output never has to fit in memory or on disk. The
output is stored when the `with` block ends; when the block ends with an exception or `Cancelled`, what
was written is stored as `<name>.partial`, also when an upload failed (for example at the run's output
limit), and the exception propagates. Names are 1 to 255 characters without `/`, `\` or NUL and
unique within a run; an output is never empty. Without `content_type`, the name's extension decides
(`report.csv` is `text/csv`), else `application/octet-stream`.

Outputs are listed on the run page with download links; the CLI downloads them with
`scantor scripts runs outputs get <run-id> <output-id>`, and agents read them with
`read_script_run_output`. Their size counts toward your storage quota; `SCANTOR_SCRIPT_RUN_MAX_OUTPUTS`
and `SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES` limit a run.

## Secrets

Give a run secrets when you start it: the key/value fields of the run form, `--secret API_KEY=value` or
`--secret API_KEY=@file` in the CLI, or `"secrets": {"API_KEY": "…"}` in MCP. Names are uppercase
(`API_KEY`), at most 32 per run with values of up to 8 KiB. They are stored encrypted, reused by
restarts, never shown again (the run lists their names only), and reach your code only as
`ctx.secrets["API_KEY"]`. The run log, the run's error and its progress message replace a secret value
of six or more characters with `***`; still, do not print secrets or anything derived from them.

## Logs and errors

Everything your code prints goes to the run log, together with the image build, the platform's own
lines (stream `system`, for example `the script exited with code 0`) and the SDK's messages
(`scantor: …`). Follow it on the run page, with `scantor scripts runs logs <run-id> --follow` or
`get_script_run_logs`. A run keeps the start of its log and the latest lines up to
`SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES`; very chatty output is cut, with a note of the dropped lines.

A run ends `completed` (with the result) or `failed` with an error:

| Error type | Cause |
|---|---|
| `scriptError` | an exception escaped `run`, or the entry failed to import; the message and stack are shown |
| `validation` | the config or the result does not match its model, or the result is too large (`SCANTOR_MAX_RESULT_BYTES`), or the definition is invalid |
| `timeout` | the run exceeded its timeout |
| `crash` | the process exited without reporting, for example killed when it ran out of memory |
| `platform` | the platform could not run it, for example the run was interrupted for too long |

When the image build fails (Dockerfile, manifest, `pip install`), the run fails with its build errors,
each with the file and line. A cancelled run ends `cancelled`.

## Environment and limits

A run's container has the CPUs and memory of its settings and reaches only the platform: there is no
internet access and no access to workers or other services, so a script evaluates what your scans
stored and cannot contact scan targets. It runs your image with `/task` as the working directory and
`python -m scantor.script <entry>` (the base image's `SCANTOR_SCRIPT_CMD`). Runs share the master with
the platform: the instance limits how many run at once, and a further run waits `queued`.

| Limit | Value |
|---|---|
| scans per run | 20 |
| run duration | `defaults.timeoutMs` or the run setting, at most `SCANTOR_SCRIPT_RUN_TIMEOUT` |
| CPUs, memory | at most `SCANTOR_SCRIPT_RUN_MAX_CPUS`, `SCANTOR_SCRIPT_RUN_MAX_MEMORY` |
| config | a JSON object of at most `SCANTOR_MAX_SCAN_CONFIG_BYTES` |
| result | JSON of at most `SCANTOR_MAX_RESULT_BYTES` |
| checkpoint | JSON of at most 1 MiB |
| outputs | `SCANTOR_SCRIPT_RUN_MAX_OUTPUTS` files, `SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES` in total |
| log | `SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES` |
| secrets | 32 per run, 8 KiB each |
| finished runs | kept for `SCANTOR_SCRIPT_RUN_RETENTION_DAYS` days (0: forever), outputs included |

## Running scripts

**Web UI.** The Scripts page lists your scripts. A script's page has the files (with "Open in editor"),
the run form (scans, config, secrets, timeout, CPUs and memory; "Try on 100 analyses" or "Run on all")
and the history of its runs. A run's page shows its state, progress, log, result, outputs and errors,
with "Cancel script run", "Run again" and "Resume". On a scan's page, "Run script" picks one of your
scripts and opens its run form with that scan selected.

**CLI.** `scantor push` and `scantor scripts push` upload a script folder (one with
`scantor-script.yaml`); `scantor scripts run` pushes a folder and starts a run:

```bash
scantor scripts init files-report
scantor scripts run files-report --scan <scan-id> --limit 100 --follow
scantor scripts run files-report --scan <scan-id> --secret API_KEY=@key.txt --follow
scantor scripts runs list files-report
scantor scripts runs get <run-id>
scantor scripts runs logs <run-id> --follow
scantor scripts runs restart <run-id> --resume
scantor scripts runs outputs get <run-id> <output-id> --file files.csv
scantor scripts runs cancel <run-id>
```

The argument of `scantor scripts run` is a script folder (a directory with `scantor-script.yaml`, or
the current directory when no argument is given), which is uploaded first, or else a script name or
id. `--follow` prints the log until the run ends and exits 0 when it completed, 1 when it failed or was
cancelled, 3 when it failed for a platform reason. Ctrl-C stops following, not the run (exit 3;
`--cancel-on-interrupt` cancels the run instead). `--yes` confirms a run that needs a confirmation. In
the editor's terminal, inside `.scripts/<name>/`, `scantor scripts run --scan <scan-id>` runs the folder
as it is. `scantor scripts runs outputs get` saves an output under its name unless `--file` says
otherwise, and checks its size and SHA-256.

**MCP.** An agent writes and runs scripts with `create_script`, `write_script_files`,
`start_script_run`, `get_script_run`, `get_script_run_logs` and `read_script_run_output`; this guide is
the resource `scantor://guide/scripts`:

1. `create_script {"name": "files-report", "description": "…"}`, then `read_script_file` and
   `write_script_files` to change `main.py` and `models.py`.
2. `start_script_run {"script": "files-report", "scans": ["<scan-id>"], "settings": {"limit": 100}}`
   to try it on a sample, then `get_script_run {"scriptRunId": "…", "wait": 50}` until it ended.
3. On a failure, read `error`, `errors` and `logTail` (or `get_script_run_logs`), fix the files and
   start again.
4. A full run (no `limit`) answers `confirmationRequired` with the scans' analysis counts: the agent
   asks you and repeats the call with `"confirm": true`.
5. `read_script_run_output {"scriptRunId": "…", "outputId": "…"}` reads an output.

**Notifications.** To get a push notification when a run completes or fails, select "Script run
completed" and "Script run failed" (`scriptRunCompleted`, `scriptRunFailed`) in the Notifications
section of your account page ([push notifications](errors-and-retries.md#push-notifications)).
