import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The test environment (docs/testing.md §7.6). This is the only module that reads process.env; the runner's
// entrypoint exports the variables (and writes them to /etc/profile.d/scantor-test.sh for `just test-exec`).
// A missing variable fails loudly: the suite only runs inside the dockerized runner.

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The runner mounts the repository read-only at /src; a checkout has it next to tests/. */
const repoDir = existsSync('/src/docker-compose.prod.yml') ? '/src' : resolve(testsDir, '..')
/** Files the runner writes for the stack: the generated .env, the test CA, remote-node.json. */
const stackDir = '/run/scantor-test'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run the suite through \`just test-e2e\` or \`just test-exec\` (docs/testing.md §3)`)
  }
  return value
}

function positiveInteger(name: string): number {
  const raw = required(name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return value
}

export interface TestEnv {
  /** SCANTOR_PUBLIC_URL of the test stack, for example https://scantor.localhost */
  publicUrl: string
  /** SCANTOR_EDITOR_URL of the test stack */
  editorUrl: string
  /** the Traefik domain: the host of the public URL */
  domain: string
  /** `<publicUrl>/mcp` */
  mcpUrl: string
  admin: { email: string; password: string }
  /** SCANTOR_SECRET of the test stack (white-box key derivations, helpers/keys.ts) */
  secret: string
  /** Playwright workers (SCANTOR_TEST_WORKERS) */
  testWorkers: number
  ci: boolean
  /** PEM file of the throwaway test CA (NODE_EXTRA_CA_CERTS) */
  caCertFile: string
  paths: {
    tests: string
    repo: string
    stack: string
    /** storage states, the OpenAPI document and the limiter state */
    auth: string
    limiter: string
    adminState: string
    openapi: string
    /** id, name and token of the joined remote node */
    remoteNode: string
  }
}

function load(): TestEnv {
  const publicUrl = required('SCANTOR_PUBLIC_URL').replace(/\/+$/, '')
  const auth = join(testsDir, '.auth')
  return {
    publicUrl,
    editorUrl: required('SCANTOR_EDITOR_URL').replace(/\/+$/, ''),
    domain: new URL(publicUrl).hostname,
    mcpUrl: `${publicUrl}/mcp`,
    admin: { email: required('SCANTOR_ADMIN_EMAIL'), password: required('SCANTOR_ADMIN_PASSWORD') },
    secret: required('SCANTOR_SECRET'),
    testWorkers: positiveInteger('SCANTOR_TEST_WORKERS'),
    ci: process.env.CI === 'true' || process.env.CI === '1',
    caCertFile: required('NODE_EXTRA_CA_CERTS'),
    paths: {
      tests: testsDir,
      repo: repoDir,
      stack: stackDir,
      auth,
      limiter: join(auth, 'limiter'),
      adminState: join(auth, 'admin.json'),
      openapi: join(auth, 'openapi.json'),
      remoteNode: join(stackDir, 'remote-node.json'),
    },
  }
}

export const env: TestEnv = load()

/** The Playwright worker index of this process (TEST_WORKER_INDEX), or 0 outside a worker (global setup). */
export function workerIndex(): number {
  return Number(process.env.TEST_WORKER_INDEX ?? '0')
}

/**
 * The environment of a child process: the runner's environment plus `extra`, or (with `inherit: false`) only PATH
 * and HOME plus `extra`, so the scantor CLI sees exactly the variables a test gives it.
 */
export function childEnv(extra: Record<string, string> = {}, options: { inherit?: boolean } = {}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (options.inherit !== false || key === 'PATH' || key === 'HOME')) base[key] = value
  }
  return { ...base, ...extra }
}
