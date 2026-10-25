# Authoring tasks in TypeScript

A TypeScript task is a module whose default export is `defineTask({...})` from `@scantor/connector`.
Configs and results are [zod](https://zod.dev) schemas; TypeScript infers the parameter and return
types of your functions from them, and the connector derives their JSON Schemas, validates every value
that enters or leaves your code and speaks the connector protocol with the scantor runtime. Node 26 runs
`main.ts` directly (type stripping), so there is no build step. This guide covers the TypeScript
specifics; templates, the manifest and errors are explained in [templates](templates.md),
[manifest](manifest.md) and [errors and retries](errors-and-retries.md). JavaScript tasks use the same
API, see [authoring in JavaScript](authoring-javascript.md).

## Task folder

```
my-task/
├── scantor.yaml                     manifest (name, language: typescript, defaults)
├── Dockerfile                       FROM ${SCANTOR_BASE}, installs package.json dependencies
├── main.ts                          the definition: schemas, schedule, run
├── package.json, package-lock.json  your npm dependencies (none in the scaffold)
├── tsconfig.json                    type checking (scantor validate and publishing run tsc)
├── .dockerignore                    .git/ .scantor/ node_modules/ .DS_Store
└── …                                any other modules, data files and tests
```

`scantor init my-task --language typescript --template tranco` (or the "New task" wizard) creates a
folder that publishes unchanged, including `.devcontainer/`, `.vscode/` (validate, dev run, dev debug and
push tasks plus a Node attach configuration) and `AGENTS.md`. The manifest's `entry` defaults to
`main.ts`; `.mts` entries work too.

```dockerfile
ARG SCANTOR_BASE
FROM ${SCANTOR_BASE}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
```

The base image `scantor-base-js` (Debian, Node 26) contains the connector at
`/node_modules/@scantor/connector`, with its own copy of zod, and TypeScript for the type check. Add
`RUN apt-get …` lines for system packages as you need them; builder stages are allowed as long as the
final stage is `FROM ${SCANTOR_BASE}`.

Dependencies:

- Add npm packages with `npm install <package>` (in the devcontainer or the browser editor) and commit
  `package.json` and `package-lock.json`.
- Never add `@scantor/connector` or `zod`: import `z` from `@scantor/connector`. A connector copy in the
  task's `node_modules` makes describe fail, and schemas built with another zod copy are rejected.
- The image installs dependencies with `npm ci --omit=dev`, and the type check runs in that image. Put
  type packages that the check needs (`@types/…`) into `dependencies`.

Node strips the types and runs the file as it is, so `main.ts` and your local modules may only use
erasable syntax: no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly` in the
scaffold's `tsconfig.json` reports them). Import local modules with their `.ts` extension
(`import { parse } from "./parse.ts"`) and types with `import type`. Node does not read `tsconfig.json`,
so path aliases do not work.

## Defining a task

```ts
import { config, defineTask, z } from "@scantor/connector";

export default defineTask({
  taskConfig: config({ greeting: z.string().default("Hello") }),
  result: z.object({ text: z.string() }),
  run: (ctx, analysisConfig, taskConfig) => ({ text: `${taskConfig.greeting}, world!` }),
});
```

| Field | Type | Purpose |
|---|---|---|
| `taskConfig` | config schema, default `Empty` | behaviour parameters, constant for all analyses of a scan |
| `scanConfig` | config schema, default `Empty` | input of `schedule` |
| `analysisConfig` | config schema, default `Empty` | input of one `run`, produced by `schedule` |
| `result` | any zod schema of a JSON object (required) | the output of one successful analysis |
| `schedule(ctx, scanConfig, taskConfig)` | generator, async generator, or a function returning an iterable, async iterable or array | yields analysis configs; omitted: every scan runs exactly one analysis (template `single`) |
| `run(ctx, analysisConfig, taskConfig)` | function returning the result or a Promise of it (required) | one attempt of one analysis |

`schedule` runs once per scan, `run` once per attempt of an analysis. `run` never sees the scan config:
put whatever an analysis needs into the analysis config and whatever is constant into the task config.
The parameters are the parsed values (`z.output` of the schemas, defaults filled in); what you return or
yield is parsed with the schema (`z.input`), so plain objects are fine. `defineTask` checks the
definition when the module is imported: a missing `result` or `run`, a config root that accepts unknown
keys or a schema of another zod copy is reported as a describe error.

The runtime starts several connector processes per worker (`processes`), each handling one call at a
time, so module-level state (a cache, a client) is per process and lives for many analyses.

A complete task: the [`http-status`](../../tasks/http-status) example fetches every origin of a CrUX
top list and compares the status code with the task config's `expectedStatus`.

<!-- scantor:include tasks/http-status/main.ts -->
```ts
// http-status: fetches every origin of a CrUX top list and checks its HTTP status code.
//
// The crux template is passed unwrapped, so the scheduler resolves the list and creates the analyses
// natively. An unreachable or silent origin is a result (status null), not a failure; a rate limit is
// retried.
import { config, defineTask, Retry, z } from "@scantor/connector";
import { crux } from "@scantor/connector/templates";

const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** The delay a 429 response asks for (Retry-After in seconds), or undefined for the scan's backoff. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/** fetch rejects with "fetch failed"; the cause names the network problem (DNS, TLS, refused). */
function networkError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${cause.message}` : cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export default defineTask({
  taskConfig: config({
    expectedStatus: z.number().int().min(100).max(599).default(200).describe("Status code every origin should answer with."),
    followRedirects: z.boolean().default(true).describe("Follow redirects and check the status of the final response."),
    timeoutMs: z.number().int().min(1000).max(50_000).default(15_000).describe("Time limit of one request."),
    userAgent: z.string().default("scantor-http-status/1.0 (+https://github.com/lonetis/scantor)"),
  }),
  scanConfig: crux.ScanConfig,
  analysisConfig: crux.AnalysisConfig,
  result: z.object({
    origin: z.string(),
    rank: z.number().int(),
    status: z.number().int().nullable(),
    matches: z.boolean(),
    finalUrl: z.string().nullable(),
    durationMs: z.number().int(),
    error: z.string().nullable(),
  }),
  schedule: crux.schedule,
  async run(ctx, analysisConfig, taskConfig) {
    const { origin, rank } = analysisConfig;
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    let response: Response;
    try {
      response = await fetch(origin, {
        redirect: taskConfig.followRedirects ? "follow" : "manual",
        headers: { "user-agent": taskConfig.userAgent },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(taskConfig.timeoutMs)]),
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error; // cancelled or out of time: the runtime classifies it
      const message = error instanceof DOMException && error.name === "TimeoutError"
        ? `no response within ${taskConfig.timeoutMs} ms`
        : networkError(error);
      ctx.log("info", "unreachable", { origin, error: message });
      return { origin, rank, status: null, matches: false, finalUrl: null, durationMs: elapsed(), error: message };
    }
    await response.body?.cancel(); // the status is all this task needs
    if (response.status === 429) throw new Retry(`${origin} is rate limiting`, retryAfterMs(response));

    ctx.log("info", "fetched", { origin, status: response.status });
    return {
      origin,
      rank,
      status: response.status,
      matches: response.status === taskConfig.expectedStatus,
      finalUrl: response.url,
      durationMs: elapsed(),
      error: null,
    };
  },
});
```
<!-- scantor:include:end -->

## Config and result schemas

Build schemas with the `z` exported by `@scantor/connector` (zod 4). Configs and results travel as
JSON, and the connector exports their JSON Schemas for the platform: configs in input mode (fields with
a default are optional), results in output mode.

- **Config roots must reject unknown keys**: build them with `config({...})` (the same as
  `z.strictObject`). `z.object` at a config root is rejected, because it silently drops a typo such as
  `limt: 100` instead of failing the scan start. Nested objects may be `z.object` (describe warns, since
  they drop unknown keys) or `z.strictObject`.
- **Give every config field a default** (`.default(…)`), so that `{}` is a valid config and the forms in
  the UI start filled in. The platform sends every call complete configs.
- **Results** may use `z.object`; a field that may be missing uses `.optional()`, one that may be null
  `.nullable()`.
- Values must be representable in JSON Schema and JSON: no `z.date()`, `z.bigint()`, `z.map()`,
  `z.set()` or `.transform()` in results (describe fails). Use strings for dates (`z.iso.datetime()`)
  and for integers beyond ±2^53.
- Constraints become JSON Schema keywords: `.min()`/`.max()` on numbers, strings and arrays, `.int()`,
  `.regex()`, `z.enum([...])`, `z.literal(...)`, `z.record(z.string(), …)`, `z.discriminatedUnion(...)`,
  and the formats `z.email()`, `z.uuid()`, `z.url()`, `z.ipv4()`, `z.ipv6()`, `z.hostname()`,
  `z.iso.date()`, `z.iso.datetime()` and `z.iso.duration()`. `.describe("…")` and `.meta({ title,
  examples })` become the labels and help texts of the UI forms. Tuples (`z.tuple`) and intersections
  work but are shown as raw JSON in the UI.
- Every value is checked against the schema: configs before your code sees them, analysis configs your
  schedule yields and results your run returns before they leave the process. A violation fails the
  call with a `validation` error that lists the paths.

Exports for schemas:

| Export | Meaning |
|---|---|
| `config(shape)` | a closed object schema for task, scan and analysis configs |
| `Empty` | a config without fields: `{}` |
| `secret()` | a string marked `writeOnly`: encrypted at rest, shown as `***` in every response; your code gets the real value. `secret().default("")` makes it optional. Secrets that your code prints into logs or results cannot be masked. |
| `FileRef` | the schema of a reference to a file registered with `ctx.files.put`; results may contain FileRefs anywhere (fields, nested objects, arrays, `FileRef.nullable()`), and the UI renders them as download links. The type `FileRef` is its output type. |

## The context

Every call gets a `ctx` (type `Context`):

| Member | In `run` | In `schedule` |
|---|---|---|
| `ctx.scanId` | scan id (`local` in `scantor dev run`, the test-run id in test runs) | same |
| `ctx.analysisId`, `ctx.seq` | `<scanId>-<seq>`, the 0-based position in the schedule | `null` |
| `ctx.attempt` | 1-based attempt of the analysis | scheduler start count |
| `ctx.deadline` | epoch milliseconds at which the attempt ends (the scan's `timeout`) | `null` |
| `ctx.signal` | an `AbortSignal` that aborts at the deadline and when the worker drains or stops | same, without deadline |
| `ctx.tmpDir` | empty scratch directory, deleted after the call | same |
| `ctx.log(level, message, fields?)` | log line with structured fields | same |
| `ctx.progress(fraction, message?)` | progress 0…1 (`null` = unknown), shown for running analyses | ignored |
| `ctx.files.put(name, data, contentType?)` | file registration | not available |

Pass `ctx.signal` to `fetch` and every other API that accepts one, and rethrow the abort error: the
connector reports the call as cancelled. At the deadline the runtime kills the process, so cleanup must
not rely on running afterwards; budget long work with `ctx.deadline - Date.now()`. Log levels are
`debug`, `info`, `warning` and `error`; `console.log` and `console.error` output is captured too and
appears in the analysis log.

## Files

```ts
const shot = await ctx.files.put("shot.png", pngBytes, "image/png");    // Uint8Array
const notes = await ctx.files.put("notes.txt", "hello\n", "text/plain"); // string, UTF-8
const report = await ctx.files.put("report.json", { path: reportPath }); // copies the file now
```

Large or binary outputs belong in files, not in the result (results are limited in size). `put` copies
the content and resolves to the final `FileRef` at once; store it in the result. The files are uploaded
only after `run` succeeded, so files of failed attempts disappear. Names are 1–255 characters without
`/`, `\` and NUL and unique within the attempt. The content type defaults to
`application/octet-stream` and is 1–255 characters long when given; pass `image/png`, `image/jpeg`,
`image/gif` or `image/webp` for images that should open inline. Violated rules and platform limits
reject with a `ScantorError` of type `validation`.

## Errors and retries

| `run` throws | Error type | Effect |
|---|---|---|
| `new Fatal(message)` | `fatal` | the analysis fails now, without retries |
| `new Retry(message, delayMs?)` | `retry` | another attempt after `delayMs` milliseconds (default: the scan's backoff), clamped to [1 s, backoff max]; counts toward `maxAttempts` |
| any other error | `taskError` | another attempt after the backoff; the stack is kept |
| a `ScantorError` of type `validation` (from files or templates), a zod error | `validation` | fails now |
| invalid config or result | `validation` | fails now; the issues name the paths |
| deadline exceeded | `timeout` | retried; the process is replaced |
| the process exits or runs out of memory | `crash` | retried; the process is replaced |

In `schedule`, `Fatal` and `validation` errors fail scheduling, while other errors restart the
scheduler with backoff. See [errors and retries](errors-and-retries.md) for the scan-level view.

## Schedules and templates

A schedule yields analysis configs. It must be deterministic: the same scan config and task config
always yield the same analysis configs in the same order, because the scheduler resumes after a
restart by replaying the stream and verifying it. Do anything slow or random in `run`.

```ts
export default defineTask({
  scanConfig: config({ count: z.number().int().min(0).max(1000).default(3) }),
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({ square: z.number() }),
  *schedule(ctx, scanConfig) {
    for (let n = 0; n < scanConfig.count; n++) yield { n };
  },
  run: (ctx, analysisConfig) => ({ square: analysisConfig.n ** 2 }),
});
```

Templates are ready-made schedules (see [templates](templates.md)). `@scantor/connector/templates`
exports one namespace per template with the schemas `ScanConfig` and `AnalysisConfig` and the proxy
`schedule`:

| Template | Import | Analysis config fields |
|---|---|---|
| `single` | `single` | none |
| `list` | `list` | `item`, `index` |
| `range` | `range` | `value` |
| `repeat` | `repeat` | `iteration` |
| `tranco` | `tranco` | `domain`, `rank` |
| `crux` | `crux` | `origin`, `rank` |
| `cidr` | `cidr` | `ip`, `prefix`, `version` |

Pass the proxy unwrapped, `schedule: tranco.schedule`, and the scheduler runs the template itself: the
scan's size is known up front and the scan page shows where the data came from. The scan config and
analysis config are then the template's own: omit them or pass `tranco.ScanConfig` and
`tranco.AnalysisConfig` (as `http-status` does).

To filter or reshape a template, iterate it in your own schedule (wrapped). Spread the template's shape
into your scan config to keep its fields and add your own:

```ts
import { config, defineTask, z } from "@scantor/connector";
import { tranco } from "@scantor/connector/templates";

export default defineTask({
  scanConfig: config({ ...tranco.ScanConfig.shape, skipTlds: z.array(z.string()).default(["cn"]) }),
  analysisConfig: config({ url: z.string(), rank: z.number().int() }),
  result: z.object({ status: z.number().int() }),
  async *schedule(ctx, scanConfig) {
    for await (const item of tranco.schedule(ctx, scanConfig)) {
      const tld = item.domain.split(".").at(-1) ?? "";
      if (!scanConfig.skipTlds.includes(tld)) yield { url: `https://${item.domain}/`, rank: item.rank };
    }
  },
  async run(ctx, analysisConfig) {
    const response = await fetch(analysisConfig.url, { signal: ctx.signal });
    return { status: response.status };
  },
});
```

The proxy sends only the template's own fields, and the items stream from the runtime while you
consume them; leaving the loop early (`break`, `return`) stops the stream. Template errors (for example
a list that cannot be downloaded) are thrown as `ScantorError` at the next iteration; let them
propagate and scheduling is retried or failed accordingly.

## Develop, debug and publish

| Command | Does |
|---|---|
| `scantor validate .` | static checks, image build, describe and `tsc` exactly as on publish |
| `scantor dev run . --limit 5` | build and run locally (schedule, then up to 5 analyses); `--task-config`, `--scan-config` and `--analysis-config` take JSON; `--remote` runs on the platform |
| `scantor dev debug .` | start one analysis under the Node inspector on `localhost:9229`, paused before the connector starts |
| `scantor push .` | upload and publish a revision |

The `check` phase of a publish runs `tsc --noEmit` with your `tsconfig.json` inside the built image; a
type error fails the publish. Tune the strictness in `tsconfig.json`, but keep `noEmit`,
`allowImportingTsExtensions` and `erasableSyntaxOnly`. To debug, run `scantor dev debug .` and start
the scaffold's launch configuration "scantor: attach to dev debug" (VS Code, Node attach to port 9229,
sources mapped to `/task`); breakpoints in `main.ts` work because type stripping keeps line and column
numbers. In the browser editor `scantor dev run` runs on the platform.

## Docker inside a task

Tasks with `defaults.privileged: true` run on Docker-in-Docker nodes and need the owner's
`canRunPrivileged` permission. The base image contains no Docker engine; install it in the Dockerfile
and keep the root user:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*
```

The runtime starts the inner Docker daemon before your process; use the default socket. Test runs and
`scantor dev run` never run privileged, so do not touch Docker at import time.
