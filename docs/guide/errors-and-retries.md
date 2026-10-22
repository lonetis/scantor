# Errors and retries

Every failure in scantor, whether your code raised it, an analysis ran out of time, a process crashed or
the platform had a problem, is recorded as one structured error with a type that decides what happens
next. This guide explains the error types, how to raise them from your code, how attempts, backoff,
timeouts and crashes work, how scans protect themselves from failing en masse, how to run failed
analyses again, and where errors show up in the web UI, the CLI, the API and MCP.

## The error object

```json
{
  "type": "timeout",
  "message": "run exceeded 30000 ms",
  "retryable": true,
  "phase": "run",
  "attempt": 2,
  "stack": null,
  "details": null,
  "at": "2026-10-21T10:01:30.000Z"
}
```

| Field | Meaning |
|---|---|
| `type` | the classification below |
| `message` | at most 4 KiB (longer messages are cut with `…`) |
| `retryable` | whether the type is retried; a retryable error that used up its attempts keeps `true` |
| `phase` | where it happened: `run`, `validate` (a value was rejected), `schedule`, `upload`, `publish`, `bootstrap`, `platform` or `ingest` |
| `attempt` | the attempt it belongs to |
| `stack` | your stack trace or traceback, when there is one (at most 16 KiB) |
| `details` | type-specific data, for example the issues of a `validation` error or `{exitCode, signal, oomKilled}` of a `crash` |

## Error types

| Type | Cause | Retried |
|---|---|---|
| `taskError` | any exception or error your code raised that is not one of the types below | yes |
| `retry` | your code raised `Retry`, optionally with a delay | yes |
| `fatal` | your code raised `Fatal`: retrying cannot help | no |
| `validation` | a config or result was rejected (the issues name the paths), a file broke a rule or limit, a template input was invalid | no |
| `timeout` | the attempt exceeded the scan's `timeout` | yes |
| `crash` | the connector process exited, was killed or ran out of memory, or broke the connector protocol | yes |
| `platform` | infrastructure: uploads, publishing, worker start-up, analyses lost by the platform | transient problems are not attempts: the work goes back to the queue (condition `workerErrors`); deterministic ones (for example a full storage quota) fail the analysis |
| `cancelled` | the work was aborted (a worker drained or stopped, a test run was cancelled or ran out of time) | not an attempt; never stored as a scan result |

## Raising errors in your code

| | Python | TypeScript, JavaScript | Go |
|---|---|---|---|
| fail now, no retries | `raise scantor.Fatal("message")` | `throw new Fatal("message")` | `return R{}, scantor.Fatal("message")` or `scantor.Fatalf("lookup %s: %w", ip, err)` |
| retry after the backoff | `raise scantor.Retry("message")` | `throw new Retry("message")` | `return R{}, scantor.Retry("message", 0)` |
| retry after a delay | `raise scantor.Retry("rate limited", delay=30)` (seconds or `timedelta`) | `throw new Retry("rate limited", 30_000)` (milliseconds) | `scantor.Retry("rate limited", 30*time.Second)` |
| ordinary failure, retried | any other exception | any other error | any other `error`, or a panic |

Choose deliberately:

- **`Fatal`** when the input can never succeed: an invalid address, a permanent refusal, a parameter
  combination your task does not support. It saves the remaining attempts.
- **`Retry`** for transient conditions, especially those that announce their own delay (HTTP 429 with
  `Retry-After`). The delay is clamped to between 1 s and the scan's `backoff.max`, without jitter.
- **Let other errors propagate** for unexpected failures: they are retried with backoff, and the stack
  is kept for debugging.
- **Return a result, not an error,** when the failure is what you measure. An unreachable origin is a
  finding of an HTTP scan, so the [`origins`](../../tasks/origins) and
  [`http-status`](../../tasks/http-status) examples record it in the result instead of failing.

Values are validated on the way in and out: a task config or analysis config that does not match its
schema, a result that does not match the result schema or cannot be serialised to JSON, or a native
validation error raised by your code (a pydantic `ValidationError`, a zod error) is a `validation`
error. Results larger than the instance limit are rejected too; store large data as files. The
[`throws`](../../tasks/throws) example produces every outcome on demand. The per-language details are in
the authoring guides for [Python](authoring-python.md#errors-and-retries),
[TypeScript](authoring-typescript.md#errors-and-retries),
[JavaScript](authoring-javascript.md#errors-and-retries) and [Go](authoring-go.md#errors-and-retries).

## Attempts and backoff

An analysis gets up to `maxAttempts` attempts (default 3, set in the [manifest](manifest.md#defaults)
or per scan). After a retryable failure it waits, then runs again, possibly on another worker:

```
delay after attempt n = min(backoff.max, backoff.initial × backoff.factor^(n−1))
with jitter: a random value in [delay/2, delay]
Retry with a delay: clamp(delay, 1s, backoff.max), no jitter
```

With the defaults (`5s`, factor 2, max `10m`, jitter on) the second attempt starts 2.5–5 s after the
first failed, the third 5–10 s after the second. Timeouts and crashes count toward `maxAttempts` like
every other retried error.

The status of an analysis tells where it is:

| Status | Meaning |
|---|---|
| `pending` | created by the schedule, not finished yet |
| `retrying` | an attempt failed and the next one is waiting for its backoff; `error` is the latest error |
| `succeeded` | finished with a result |
| `failed` | finished with a final `error` (not retryable, or attempts used up) |
| `lost` | the platform lost it: no message remained and no worker processed it (see [stalled scans](#stalled-scans-and-lost-analyses)) |
| `cancelled` | the scan was cancelled before the analysis finished |

Every analysis keeps its 10 most recent attempts (`attempts`: number, round, timing, error, worker and
node) and the log tail of its final attempt (`logTail`, the last 32 KiB of your log lines and captured
stdout and stderr). Files of failed attempts are discarded.

Work that is interrupted without being your code's fault is not an attempt: when a worker drains (pause,
scale-in), its container dies or loses its connection, the analysis goes back to the queue and runs
again with the same attempt number. Duplicate executions are possible and are deduplicated; a later
success beats an earlier failure.

## Timeouts

`timeout` (default `5m`) limits each attempt. Your code sees the deadline (`ctx.deadline`, Python also
`ctx.remaining()`, Go `ctx.Deadline()`) and a cancellation signal (Python `ctx.cancelled` and
`asyncio.CancelledError` in async code, TypeScript and JavaScript `ctx.signal`, Go `ctx.Done()`). At the
deadline the runtime kills the connector process group without a grace period, records a `timeout`
error and replaces the process. Budget long work with the remaining time, for example as a request
timeout, and pass the signal to your HTTP client. Cleanup code never runs after the deadline.

Other time limits:

| Limit | What happens |
|---|---|
| a `schedule` that yields nothing for `timeout` while the platform waits for its next item | `timeout`, the scheduler restarts |
| a test run longer than the instance's test-run limit (10 minutes by default) | the test run ends `failed` |
| an image build longer than the instance's build limit | the revision ends `failed` (phase `build`) |
| `--timeout` of the CLI's waiting commands (`--wait`, `scans watch`) | the CLI stops waiting (exit 3); the scan or build is not affected |

## Crashes and out-of-memory

A connector process that exits, is killed or writes invalid protocol messages produces a `crash`
(`details: {exitCode, signal, oomKilled}`) and is replaced; the analysis is retried. Each process uses
`resources.memory`; the kernel kills a connector process that exceeds its container's memory first, so
the worker survives. Repeated `crash` errors with `oomKilled: true` mean the task needs more memory per
process or fewer processes.

When a whole worker container keeps exiting, the scan gets the condition `crashLoop` with the exit
code, the OOM flag, the restart count and the end of the container log, and the node restarts the
container with a growing delay (5 s up to 5 min). An analysis that kills every worker that receives it
is given up after the instance's delivery limit (10 deliveries by default) and stored as `failed` with a
non-retryable `crash`: "every worker that received this analysis died while processing it".

## Errors in `schedule`

The schedule runs once per scan, in the scheduler worker.

| Error in `schedule` | Effect |
|---|---|
| `Fatal`, `validation` (including template input errors and a scan above the instance maximum) | scheduling fails; the analyses already created still run, then the scan ends `failed` with the condition `schedulingFailed` |
| `Retry`, other exceptions, `timeout`, `crash`, template download errors | the scheduler restarts with the scan's backoff and resumes where it stopped (condition `schedulerRestarting`); after more than 3 restarts (instance setting) scheduling fails |

On a restart the schedule is replayed and the platform verifies that it yields exactly the same analysis
configs as before. A schedule that depends on time, randomness or the network fails with
`schedule() is not deterministic`. Keep `schedule` a pure function of the scan config and the task
config, and do everything else in `run`. Test runs and `scantor dev run` report schedule failures as
errors with phase `schedule`.

## Scan-level safeguards

### Circuit breaker

When almost every recent attempt of a scan fails, the scan pauses itself instead of burning through
all analyses: by default, when at least 100 attempts within 5 minutes finished and 95 % of them failed
(failed attempts that are retried count as failures). The scan becomes `paused` with the reason
"failure rate" and the condition `breakerTripped`. Look at the errors, fix the cause (a target that
blocks you, a broken credential, a bug, which needs a new revision and a new scan) and resume the scan,
which starts a fresh window. The thresholds are instance settings.

### Stalled scans and lost analyses

If a running scan has finished scheduling but nothing is left to process and analyses are still
missing (for example after an operator purged a queue), the platform waits 5 minutes (instance
setting), records the missing analyses as `lost` (a `platform` error), raises the condition `stalled`
and completes the scan. Lost analyses that kept their config can be retried with retry-failed.

### Conditions

Conditions explain why a scan is not progressing. They appear in the scan's health panel, in
`scantor scans conditions <scan>` and in the `conditions` of the scan (API, MCP `get_scan`):

| Condition | Meaning | What to do |
|---|---|---|
| `workersPending` | workers cannot be placed; `reasons` say why (`noNodes`, `archMismatch`, `selectorMismatch`, `insufficientCapacity`, `userMaxWorkers`, `dindUnavailable`, `diskLow`, `pullLimit`) | wait, lower `resources` or `workers`, fix `nodeSelector`, ask an admin for capacity |
| `crashLoop` | a worker container keeps exiting | read the log tail; raise memory if `oomKilled` |
| `imagePullFailed` | a node cannot pull the task image | admin: registry reachability and TLS on that node ([remote nodes](remote-nodes.md#troubleshooting)) |
| `workerErrors` | a worker reports platform errors (uploads, publishing, start-up) | usually transient; persistent ones need an admin |
| `schedulerRestarting` | the schedule failed and restarts | read the error; it fails for good after the restart limit |
| `schedulingFailed` | scheduling failed; the scan ends `failed` | fix the scan config or the task, then start a new scan |
| `breakerTripped` | the circuit breaker paused the scan | fix the cause, then resume |
| `stalled` | analyses were recorded as `lost` | retry-failed |
| `brokerAlarm`, `topologyFailed`, `clockSkew` | platform problems | admin |

A scan whose analyses failed still ends `completed`: `failed` as a scan state means that scheduling
failed. Check `stats.failed` and `stats.lost` (or `scantor scans get`).

## Retrying failed analyses

**Retry failed** runs every `failed` or `lost` analysis that has a stored config again, in a new round
of the same scan: the round number goes up, attempts start again at 1 with the full `maxAttempts`, and
results land in the same scan, so successful analyses are kept. Cancelled analyses are not retried.

| Surface | How |
|---|---|
| web UI | scan page, "Retry failed" |
| CLI | `scantor scans retry-failed <scan>`, then `scantor scans watch <scan>` |
| MCP | `retry_failed_analyses {"scanId": "…"}` |

It is allowed once scheduling has finished (or failed) and no other retry is in progress, in the states
`running`, `completed`, `failed` and `cancelled`; the scan returns to `running`. With nothing to retry it
answers `nothingToRetry`. It does not run the schedule again, so a scan whose scheduling failed ends
`failed` again.

**Restart** (`scantor scans restart <scan>`, MCP `restart_scan`) starts a new scan with the same
revision, configs and settings, optionally with other workers or processes; template inputs such as
`latest` are resolved again. Use it to run everything again, including cancelled analyses.

Both use the scan's revision. To pick up a fix in your code, publish a new revision and start a new scan
from it.

## Build, test-run and request errors

**Publishing and test runs.** A failed revision or test run carries `errors[]`, each
`{phase, file?, line?, column?, message}`:

| Phase | Typical cause |
|---|---|
| `pack` | an invalid path or file type in the folder, size limits |
| `static` | the [manifest](manifest.md#rules-checked-on-publish), missing files, a Dockerfile rule |
| `build` | the image build failed (a dependency could not be installed), build timeout or image size limit |
| `describe` | importing your entry failed or the task definition is invalid |
| `check` | a type error (basedpyright, `tsc`, `go vet`) |
| `push` | the registry was not reachable (a platform error: publish again) |
| `config` | test runs: a task, scan or analysis config does not match its schema |
| `schedule` | test runs: the schedule failed |

The full log is in the revision's build log (`scantor revisions logs <task>@<n>`); a failed analysis of
a test run has its own `error` and `logTail`.

**Requests.** The REST API answers errors as
`{"error": {"code": "…", "message": "…", "details": {…}}}` with an HTTP status. The codes you meet
most:

| Code | HTTP | Meaning |
|---|---|---|
| `validationFailed` | 400 | the request itself is malformed; `details.issues` |
| `notFound` | 404 | does not exist, or belongs to someone else |
| `invalidState` | 409 | the operation is not allowed in the current state; `details: {state, allowed}` |
| `revisionNotReady` | 409 | the revision is still building or failed |
| `nothingToRetry` | 409 | retry-failed found no failed or lost analysis with a config |
| `workspaceDirty` | 409 | the workspace has unpublished changes; repeat with `force` (`--force`) |
| `configInvalid` | 422 | a config does not match the revision's schema; `details.issues: [{path, message}]` |
| `confirmationRequired` | 422 | the scan is larger than the confirmation threshold; repeat with `confirm: true` (`--confirm`) |
| `scanTooLarge` | 422 | the scan is larger than the instance maximum |
| `tooManyRequests` | 429 | too many simultaneous waits or queries; retry later |
| `unavailable`, `brokerAlarm` | 503 | the platform is starting or overloaded; retry later |

## Where errors appear

| Where | What |
|---|---|
| web UI, scan page | health panel (conditions); results tab filtered by status with error type and message columns; analysis detail with the error (type, phase, retryable, message, details, stack), the attempts and the log; events tab; query console |
| web UI, task page | revision page with the errors and the build log; test-run panel with errors, analyses and the live log |
| CLI | `scantor analyses list <scan> --status failed,lost`, `scantor analyses get <scanId>-<seq>`, `scantor analyses query`, `scantor analyses aggregate`, `scantor scans conditions`, `scantor scans events`, `scantor scans worker logs`, `scantor revisions get`, `scantor revisions logs` |
| API | `GET /api/analyses/{analysisId}`, `POST /api/scans/{scanId}/analyses/query` and `…/aggregate`, `GET /api/scans/{scanId}/conditions` and `…/events` |
| MCP | `get_analysis`, `query_analyses`, `aggregate_analyses`, `get_scan` (conditions), `get_revision` and `get_test_run` (`errors`) |

Count failures by type, then look at examples of the largest class:

```sh
scantor analyses aggregate <scan> --pipeline '[{"$match": {"status": "failed"}}, {"$group": {"_id": "$error.type", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}]'
scantor analyses query <scan> --filter '{"status": "failed", "error.type": "timeout"}' --projection '{"seq": 1, "error.message": 1}' --limit 20
scantor analyses get <scanId>-<seq>
```

Through MCP, error texts, log tails and results are wrapped as `{"untrusted_data": …}`, because they
come from scanned targets and task code ([MCP](mcp.md)).

## Exit codes of the CLI

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | analyses failed: `scantor dev run` with failed analyses; the waiting scan commands when the scan failed, was cancelled, was paused by the circuit breaker or completed with failed or lost analyses |
| 2 | invalid input: usage, configuration, task content, configs, requests the platform rejected |
| 3 | platform failure: Docker, network, server errors, timeouts, interrupts |

With `-o json`, errors are printed as `{"error": {"code": …, "message": …, "exitCode": …}}`. All
commands are in the [CLI reference](cli.md).
