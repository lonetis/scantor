import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { childEnv, env } from './env'

// The scantor CLI against the test stack (docs/testing.md §7.8). By default it runs the runner's own binary
// (/usr/local/bin/scantor, built from this checkout into the runner image) with the inner dockerd for local builds
// and runs; `image: true` runs the CLI of the stack's scantor:dev image through the shim pattern of scantor.sh
// instead (the working directory mounted at the same path, the inner Docker socket). Both use the locally built
// images (empty prefix, tag dev) and trust the test CA. Returns the exit code and output; `json` holds the parsed
// output of `-o json` (one value, or an array for NDJSON).

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
  /** parsed stdout when it is JSON or NDJSON, otherwise undefined */
  json: unknown
}

export interface CliOptions {
  /** API key for SCANTOR_TOKEN (the tenant's `apiKey`); omitted for local-only commands */
  token?: string
  /** working directory (default: the tests folder); paths in args are relative to it */
  cwd?: string
  /** extra environment, for example SCANTOR_DEV_MODE */
  env?: Record<string, string>
  timeoutMs?: number
  /** run the scantor:dev image instead of the runner's binary */
  image?: boolean
  input?: string
}

/** The template data sources of the test stack, for local runs (`scantor dev run` of tranco and crux tasks). */
export const FIXTURE_DATA_SOURCES = {
  SCANTOR_TRANCO_URL: `http://fixtures.${env.domain}:8089/tranco`,
  SCANTOR_CRUX_URL: `http://fixtures.${env.domain}:8089/crux`,
}

function parseOutput(stdout: string): unknown {
  const text = stdout.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split('\n').filter(Boolean)
    try {
      return lines.map((line) => JSON.parse(line) as unknown)
    } catch {
      return undefined
    }
  }
}

export function scantor(args: string[], options: CliOptions = {}): Promise<CliResult> {
  const cwd = options.cwd ?? env.paths.tests
  const cliEnv: Record<string, string> = {
    SCANTOR_URL: env.publicUrl,
    SCANTOR_IMAGE_PREFIX: '',
    SCANTOR_IMAGE_TAG: 'dev',
    SCANTOR_CA_CERT: readFileSync(env.caCertFile, 'utf8'),
    ...FIXTURE_DATA_SOURCES,
    ...(options.token ? { SCANTOR_TOKEN: options.token } : {}),
    ...options.env,
  }
  let file = '/usr/local/bin/scantor'
  let argv = args
  if (options.image) {
    file = 'docker'
    const passEnv = Object.keys(cliEnv).flatMap((key) => ['-e', key])
    argv = [
      'run',
      '--rm',
      '-i',
      '--init',
      '-v',
      `${cwd}:${cwd}`,
      '-w',
      cwd,
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      ...passEnv,
      'scantor:dev',
      ...args,
    ]
  }
  return new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
      { cwd, env: childEnv(cliEnv, { inherit: false }), timeout: options.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr), json: parseOutput(String(stdout)) })
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}
