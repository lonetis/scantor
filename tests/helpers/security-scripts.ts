import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Script, ScriptRun } from '#shared/types/scripts'
import { TERMINAL_SCRIPT_RUN_STATES, type ScriptRunState } from '#shared/utils/enums'
import { ok, type ApiClient } from './api-client'
import { CONTAINERS, docker, DockerError, stackEnv } from './docker'
import { stackKeys } from './keys'
import { containerImage, pollFor, sleep } from './security'
import { unique } from './unique'

// Script folders and script-run helpers of the authorization matrix and the security specs (docs/testing.md §8.5,
// §8.6; docs/scripts.md): the matrix's `authz` script, the security specs' `probe` script, which looks at the
// platform from inside its script-run container, runs and their tokens, and requests sent from a throwaway container
// on the scripts network (the only network whose peers the script runtime API answers).

/** The internal network of script-run containers (docs/scripts.md, compose `scantor-scripts`). */
export const SCRIPTS_NETWORK = 'scantor-scripts'

const DOCKERFILE = 'ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n'
const DOCKERIGNORE = '.git\n__pycache__\n.scantor\n'

function manifest(name: string, description: string): string {
  return `scantor: 1\nname: ${name}\nlanguage: python\ndescription: ${JSON.stringify(description)}\n`
}

/** The output the `authz` script stores. */
export const AUTHZ_SCRIPT_OUTPUT = 'report.json'

/**
 * `authz`: the authorization matrix's script (authz/seed.setup.ts). It reads nothing: it reports progress, saves a
 * checkpoint, stores one JSON output and returns the ids of its scans, so a completed run has every part an operation
 * can address (output, source, log, checkpoint, result).
 */
export function authzScriptFiles(name: string): Record<string, string> {
  return {
    'scantor-script.yaml': manifest(name, 'Authorization matrix fixture: stores one output and returns its scans.'),
    Dockerfile: DOCKERFILE,
    '.dockerignore': DOCKERIGNORE,
    'main.py': `"""${name}: the authorization matrix's script; one output, progress, a checkpoint and a result."""

import json

from pydantic import BaseModel

import scantor
from scantor.script import Script, ScriptContext


class Summary(BaseModel):
    scans: list[str]


def run(ctx: ScriptContext, config: scantor.Empty) -> Summary:
    scans = [scan.id for scan in ctx.scans]
    ctx.progress(1, 1, "authz matrix")
    ctx.checkpoint({"scans": scans})
    ctx.outputs.put("${AUTHZ_SCRIPT_OUTPUT}", json.dumps({"scans": scans}), "application/json")
    ctx.log("authz matrix report written")
    return Summary(scans=scans)


script = Script(run=run, result=Summary)
`,
  }
}

// ── the probe script ────────────────────────────────────────────────────────────────────────────────

/** One HTTP request the probe sends to SCANTOR_URL from inside its container. */
export interface ProbeRequest {
  name: string
  method?: 'GET' | 'POST' | 'PUT'
  /** absolute path with query, for example /api/script-runtime/bootstrap */
  path: string
  /** `own` (the run's token), `none`, `tampered` (the run's token with a wrong MAC) or `secret:<NAME>` (a run secret) */
  auth?: string
  body?: unknown
  /** return the parsed body: the JSON document, or `{analyses, end}` of an NDJSON stream */
  keep?: boolean
}

/** A TCP connection the probe tries (3 s timeout). */
export interface ProbeTarget {
  name: string
  host: string
  port: number
}

export interface ProbeConfig {
  requests?: ProbeRequest[]
  targets?: ProbeTarget[]
  /** read every analysis of every scan of the run through the SDK (`fields='all'`) */
  read_analyses?: boolean
  /** print this run secret to stdout (the log must mask it) */
  print_secret?: string
  /** wait this long (checking for a cancel) before returning, so a test can inspect the running container */
  hold_seconds?: number
}

export interface ProbeAnswer {
  status: number
  code: string | null
  body: unknown
  error: string | null
}

export interface ProbeResult {
  answers: Record<string, ProbeAnswer>
  /** `error` is the errno name (ECONNREFUSED means a path to the host exists), `TimeoutError` or `gaierror` */
  connections: Record<string, { reachable: boolean; error: string | null }>
  /** /proc/self/status capability and privilege lines, oom_score_adj, the uid and whether a Docker socket exists */
  process: Record<string, string>
  analyses: Record<string, unknown>[]
}

/**
 * `probe`: the security specs' script. Inside its script-run container it sends the requests of its config with the
 * chosen credential, tries the TCP targets, reads its own process limits, optionally reads every analysis through the
 * SDK and prints a secret, then holds. It never returns a secret value (bodies are kept only when asked).
 */
export function probeScriptFiles(name: string): Record<string, string> {
  return {
    'scantor-script.yaml': manifest(name, 'Security fixture: probes the platform from inside a script-run container.'),
    Dockerfile: DOCKERFILE,
    '.dockerignore': DOCKERIGNORE,
    'main.py': `"""${name}: looks at the platform from inside a script-run container (tests/helpers/security-scripts.ts)."""

import errno
import http.client
import json
import os
import socket
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from pydantic import BaseModel, Field

import scantor
from scantor.script import Script, ScriptContext

PROCESS_KEYS = {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"}


class Request(BaseModel):
    name: str
    method: str = "GET"
    path: str
    auth: str = "own"
    body: Any = None
    keep: bool = False


class Target(BaseModel):
    name: str
    host: str
    port: int


class Config(scantor.Config):
    requests: list[Request] = Field(default_factory=list)
    targets: list[Target] = Field(default_factory=list)
    read_analyses: bool = False
    print_secret: str | None = None
    hold_seconds: float = Field(default=0, ge=0, le=600)


class Answer(BaseModel):
    status: int
    code: str | None = None
    body: Any = None
    error: str | None = None


class Connection(BaseModel):
    reachable: bool
    error: str | None = None


class Result(BaseModel):
    answers: dict[str, Answer]
    connections: dict[str, Connection]
    process: dict[str, str]
    analyses: list[dict[str, Any]]


def authorization(ctx: ScriptContext, auth: str) -> str | None:
    token = os.environ["SCANTOR_SCRIPT_TOKEN"]
    if auth == "own":
        return token
    if auth == "none":
        return None
    if auth == "tampered":
        # The first character of the MAC: the last one of a base64url SHA-256 also carries unused bits.
        at = token.index(".") + 1
        return token[:at] + ("B" if token[at] == "A" else "A") + token[at + 1 :]
    if auth.startswith("secret:"):
        return ctx.secrets[auth.removeprefix("secret:")]
    raise ValueError(f"unknown auth {auth!r}")


def without_operators(value: Any) -> Any:
    """The value without object keys that start with $ (the bootstrap's JSON Schemas): a result may not have them."""
    if isinstance(value, dict):
        return {key: without_operators(item) for key, item in value.items() if not str(key).startswith("$")}
    if isinstance(value, list):
        return [without_operators(item) for item in value]
    return value


def parse(request: Request, status: int, content_type: str, raw: bytes) -> Answer:
    code: str | None = None
    body: Any = None
    if "ndjson" in content_type:
        lines = [json.loads(line) for line in raw.splitlines() if line.strip()]
        errors = [line["error"] for line in lines if "error" in line]
        code = errors[0].get("code") if errors else None
        if request.keep:
            body = {
                "analyses": [line["analysis"] for line in lines if "analysis" in line],
                "end": next((line["end"] for line in lines if "end" in line), None),
            }
    elif "json" in content_type and raw:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
            code = parsed["error"].get("code")
        if request.keep:
            body = parsed
            run = parsed.get("scriptRun") if isinstance(parsed, dict) else None
            if isinstance(run, dict) and isinstance(run.get("secrets"), dict):
                # The bootstrap carries the run's secret values: keep their names only.
                run["secrets"] = sorted(run["secrets"])
    return Answer(status=status, code=code, body=without_operators(body))


def send(ctx: ScriptContext, request: Request) -> Answer:
    base = urllib.parse.urlsplit(os.environ["SCANTOR_URL"])
    factory = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
    connection = factory(base.hostname or "", base.port, timeout=30)
    headers = {"Accept": "application/json"}
    value = authorization(ctx, request.auth)
    if value is not None:
        headers["Authorization"] = f"Bearer {value}"
    data = None
    if request.body is not None:
        data = json.dumps(request.body).encode()
        headers["Content-Type"] = "application/json"
    try:
        connection.request(request.method, request.path, body=data, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        return parse(request, response.status, response.getheader("Content-Type") or "", raw)
    except OSError as exc:
        return Answer(status=0, error=f"{type(exc).__name__}: {exc}")
    finally:
        connection.close()


def connect(target: Target) -> Connection:
    try:
        with socket.create_connection((target.host, target.port), timeout=3):
            return Connection(reachable=True)
    except OSError as exc:
        name = errno.errorcode.get(exc.errno) if isinstance(exc.errno, int) else None
        return Connection(reachable=False, error=name or type(exc).__name__)


def process() -> dict[str, str]:
    status: dict[str, str] = {}
    with open("/proc/self/status", encoding="utf-8") as file:
        for line in file:
            key, _, value = line.partition(":")
            if key in PROCESS_KEYS:
                status[key] = value.strip()
    with open("/proc/self/oom_score_adj", encoding="utf-8") as file:
        status["oom_score_adj"] = file.read().strip()
    status["uid"] = str(os.getuid())
    status["docker_socket"] = str(os.path.exists("/var/run/docker.sock")).lower()
    return status


def run(ctx: ScriptContext, config: Config) -> Result:
    if config.print_secret is not None:
        print(f"secret {config.print_secret}: {ctx.secrets[config.print_secret]}", flush=True)
    answers = {request.name: send(ctx, request) for request in config.requests}
    with ThreadPoolExecutor(max_workers=16) as pool:
        connections = dict(zip([target.name for target in config.targets], pool.map(connect, config.targets), strict=True))
    analyses: list[dict[str, Any]] = []
    if config.read_analyses:
        for scan in ctx.scans:
            analyses.extend(analysis.model_dump(mode="json", by_alias=True) for analysis in ctx.analyses(scan, fields="all"))
    deadline = time.monotonic() + config.hold_seconds
    while time.monotonic() < deadline:
        ctx.check_cancelled()
        time.sleep(0.2)
    return Result(answers=answers, connections=connections, process=process(), analyses=analyses)


script = Script(run=run, config=Config, result=Result)
`,
  }
}

// ── scripts and runs ────────────────────────────────────────────────────────────────────────────────

/** Creates a script (the scaffold) and overwrites it with `files`. */
export async function createScriptWithFiles(api: ApiClient, name: string, files: Record<string, string>): Promise<Script> {
  const created = ok(await api.call<Script>('createScript', { body: { name } }), 'createScript')
  ok(await api.call('writeScriptFiles', { path: { script: created.id }, body: { files } }), 'writeScriptFiles')
  return ok(await api.call<Script>('getScript', { path: { script: created.id } }), 'getScript')
}

export interface StartScriptRunBody {
  scans: string[]
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  settings?: { timeoutMs?: number; resources?: { cpus?: number; memoryMiB?: number }; limit?: number }
  confirm?: boolean
}

/** Starts a run of a script (201), retrying a 429 (the user's wait or run slots) for up to a minute. */
export async function startScriptRun(api: ApiClient, script: string, body: StartScriptRunBody): Promise<ScriptRun> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const response = await api.call<ScriptRun>('startScriptRun', { path: { script }, body })
    if (response.status !== 429 || Date.now() > deadline) return ok(response, 'startScriptRun')
    await sleep(2_000)
  }
}

const isTerminal = (state: ScriptRunState) => (TERMINAL_SCRIPT_RUN_STATES as readonly string[]).includes(state)

/** Long-polls getScriptRun until the run is terminal (a run waits for the stack's run slots and its build). */
export async function waitForScriptRun(api: ApiClient, scriptRunId: string, timeoutMs = 300_000): Promise<ScriptRun> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)))
    const run = ok(await api.call<ScriptRun>('getScriptRun', { path: { scriptRunId }, query: { wait } }), 'getScriptRun')
    if (isTerminal(run.state)) return run
    if (Date.now() > deadline) throw new Error(`script run ${scriptRunId} is still ${run.state} after ${timeoutMs / 1000} s: ${JSON.stringify(run.errors)}`)
  }
}

/** Polls getScriptRun every second until the run is `running` (its container started); fails when it ended first. */
export async function waitForRunningScriptRun(api: ApiClient, scriptRunId: string, timeoutMs = 300_000): Promise<ScriptRun> {
  let last: ScriptRun | undefined
  return pollFor(
    async () => {
      last = ok(await api.call<ScriptRun>('getScriptRun', { path: { scriptRunId } }), 'getScriptRun')
      if (isTerminal(last.state))
        throw new Error(`script run ${scriptRunId} ended ${last.state} before it was seen running: ${JSON.stringify(last.error ?? last.errors)}`)
      return last.state === 'running' ? last : undefined
    },
    timeoutMs,
    () => `script run ${scriptRunId} is not running within ${timeoutMs / 1000} s (last state ${last?.state})`,
  )
}

/**
 * Waits until a run is terminal and its representation stopped changing (the job writes the last log lines, the
 * script's pointer and the event right after the terminal state), so two reads compare equal.
 */
export async function waitForSettledScriptRun(api: ApiClient, scriptRunId: string, timeoutMs = 300_000): Promise<ScriptRun> {
  let previous = JSON.stringify(await waitForScriptRun(api, scriptRunId, timeoutMs))
  const deadline = Date.now() + 60_000
  for (;;) {
    await sleep(2_000)
    const run = ok(await api.call<ScriptRun>('getScriptRun', { path: { scriptRunId } }), 'getScriptRun')
    const current = JSON.stringify(run)
    if (current === previous) return run
    if (Date.now() > deadline) throw new Error(`script run ${scriptRunId} keeps changing after it ended`)
    previous = current
  }
}

/** Cancels a run that is still active (409 means it just ended, 404 that it is gone). */
export async function cancelScriptRunIfActive(api: ApiClient, scriptRunId: string): Promise<void> {
  const response = await api.call<ScriptRun>('getScriptRun', { path: { scriptRunId } })
  if (response.status === 404 || isTerminal(response.body.state)) return
  const cancelled = await api.call('cancelScriptRun', { path: { scriptRunId } })
  if (![200, 404, 409].includes(cancelled.status))
    throw new Error(`cancelScriptRun ${scriptRunId} answered ${cancelled.status}: ${JSON.stringify(cancelled.body)}`)
}

/** The run's `ssr_` token, derived from the stack's secret like the orchestrator does (never shown by the API). */
export function scriptRunToken(run: Pick<ScriptRun, 'id' | 'scriptId' | 'userId'>): string {
  return stackKeys().scriptRunToken({ scriptRunId: run.id, scriptId: run.scriptId, userId: run.userId })
}

/** The name of a run's container (docs/scripts.md). */
export const scriptRunContainer = (scriptRunId: string) => `scantor-s-${scriptRunId}`

/** Ids of every container (running or not) labelled as the run's container. */
export async function scriptRunContainers(scriptRunId: string): Promise<string[]> {
  const { stdout } = await docker(['ps', '-aq', '--filter', `label=scantor.script-run=${scriptRunId}`])
  return stdout.split('\n').filter(Boolean)
}

// ── requests from the scripts network ───────────────────────────────────────────────────────────────

/** A request sent to SCANTOR_INTERNAL_URL from a throwaway container on scantor-scripts. */
export interface NetworkRequest {
  method: string
  /** absolute path with query */
  path: string
  headers?: Record<string, string>
  /** the body as sent (JSON text) */
  body?: string
}

export interface NetworkAnswer {
  status: number
  /** `error.code` of an error envelope */
  code: string | null
  error?: string
}

const FETCH_SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs'
const requests = JSON.parse(readFileSync('/tmp/requests.json', 'utf8'))
const answers = []
for (const request of requests) {
  try {
    const response = await fetch(process.env.SCANTOR_URL + request.path, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    })
    const text = await response.text()
    let code = null
    try {
      code = JSON.parse(text)?.error?.code ?? null
    } catch {}
    answers.push({ status: response.status, code })
  } catch (error) {
    answers.push({ status: 0, code: null, error: String(error) })
  }
}
writeFileSync('/tmp/answers.json', JSON.stringify(answers))
`

/**
 * Sends requests to the orchestrator's internal URL from a throwaway container on scantor-scripts (the orchestrator
 * image's node, label scantor.test=true, removed afterwards): the peer check of the script runtime API accepts it
 * like a script-run container, so only the credential decides. Returns one answer per request, in order.
 */
export async function fetchFromScriptsNetwork(requests: NetworkRequest[]): Promise<NetworkAnswer[]> {
  const image = await containerImage(CONTAINERS.orchestrator)
  const url = (stackEnv().SCANTOR_INTERNAL_URL ?? 'http://orchestrator:3000').replace(/\/+$/, '')
  const name = unique('scantor-test-scripts-net')
  const dir = await mkdtemp(join(tmpdir(), 'scripts-net-'))
  try {
    await writeFile(join(dir, 'requests.json'), JSON.stringify(requests))
    await docker([
      'create',
      '--name',
      name,
      '--label',
      'scantor.test=true',
      '--network',
      SCRIPTS_NETWORK,
      '--env',
      `SCANTOR_URL=${url}`,
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-e',
      FETCH_SCRIPT,
    ])
    await docker(['cp', join(dir, 'requests.json'), `${name}:/tmp/requests.json`])
    await docker(['start', name])
    const exitCode = Number((await docker(['wait', name], { timeoutMs: 300_000 })).stdout.trim())
    if (exitCode !== 0) {
      const logs = await docker(['logs', name], { allowFailure: true })
      throw new DockerError(['run', '…', 'node', '-e', '…'], { exitCode, stdout: logs.stdout, stderr: logs.stderr })
    }
    await docker(['cp', `${name}:/tmp/answers.json`, join(dir, 'answers.json')])
    return JSON.parse(await readFile(join(dir, 'answers.json'), 'utf8')) as NetworkAnswer[]
  } finally {
    await docker(['rm', '-f', name], { allowFailure: true })
    await rm(dir, { recursive: true, force: true })
  }
}
