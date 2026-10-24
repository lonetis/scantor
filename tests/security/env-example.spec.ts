import { ENV_LINT_FILES, loadEnvLint, RepoCopy } from '../helpers/authz-lint'
import { expect, test } from '../fixtures'

// Thin wrapper over the rule function of tests/scripts/lint-env.mjs (docs/testing.md §11, §14 decision 12): the
// checkout's `.env.example` passes, and each rule fails on a throwaway copy of the inputs in which exactly that rule
// is broken. The Go sources are linked into the copy (read only); a negative case for Go config loaders adds its own
// package next to them. `just lint` runs the same function.

const EXAMPLE = '.env.example'

/** Variables that are not configuration (internal contract, base-image ENV contract, connector protocol). */
const NOT_CONFIGURATION = [
  'SCANTOR_WORKER_TOKEN',
  'SCANTOR_DIND',
  'SCANTOR_REGISTRY_PUSH_PASSWORD',
  'SCANTOR_LANGUAGE',
  'SCANTOR_CONNECTOR_CMD',
  'SCANTOR_CHECK_CMD',
  'SCANTOR_DEBUG_CMD',
  'SCANTOR_DEBUG_PORT',
  'SCANTOR_PROTOCOL_IN_FD',
  'SCANTOR_PROTOCOL_OUT_FD',
  'SCANTOR_PROTOCOL_VERSIONS',
  'SCANTOR_PROCESS_INDEX',
]

/**
 * A copy of lint-env's inputs: the changeable files copied and the Go trees linked read-only. With `ownGo` the copy
 * gets empty Go trees of its own instead, so a case can add a Go file without touching the checkout.
 */
async function envCopy(options: { ownGo?: boolean } = {}): Promise<RepoCopy> {
  if (!options.ownGo) return RepoCopy.create(ENV_LINT_FILES, ['cmd', 'internal'])
  const copy = await RepoCopy.create(ENV_LINT_FILES)
  await copy.write('cmd/.keep', '')
  await copy.write('internal/.keep', '')
  return copy
}

/** Sets the value of one assignment in the copied .env.example. */
async function setValue(copy: RepoCopy, name: string, value: string): Promise<void> {
  await copy.replace(EXAMPLE, new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`)
}

/** A source of variables read by code, with how a probe variable is added to it. */
interface ReaderCase {
  source: string
  file: string
  /** the case writes Go code, so the copy needs its own Go trees */
  go?: boolean
  add(copy: RepoCopy, name: string): Promise<void>
}

const READERS: ReaderCase[] = [
  {
    source: 'a Go config loader',
    file: 'internal/zz-authz-probe/config.go',
    go: true,
    add: (copy, name) =>
      copy.write('internal/zz-authz-probe/config.go', `package probe\n\nfunc LoadConfig(getenv func(string) string) string {\n\treturn getenv("${name}")\n}\n`),
  },
  {
    source: 'a direct Go environment read',
    file: 'cmd/zz-authz-probe/main.go',
    go: true,
    add: (copy, name) => copy.write('cmd/zz-authz-probe/main.go', `package main\n\nimport "os"\n\nfunc main() { _ = os.Getenv("${name}") }\n`),
  },
  {
    source: "the orchestrator's config loader",
    file: 'orchestrator/server/utils/config.ts',
    add: (copy, name) => copy.append('orchestrator/server/utils/config.ts', `// probe: readEnv('${name}')`),
  },
  {
    source: 'a compose interpolation',
    file: 'docker-compose.dev.yml',
    add: (copy, name) => copy.append('docker-compose.dev.yml', `# \${${name}}`),
  },
  {
    source: 'the test stack override',
    file: 'tests/docker/stack.tests.yml',
    add: (copy, name) => copy.append('tests/docker/stack.tests.yml', `# \${${name}}`),
  },
  {
    source: 'a recipe',
    file: 'justfile',
    add: (copy, name) => copy.append('justfile', `# uses ${name}`),
  },
  {
    source: "the test stack's settings",
    file: 'tests/docker/stack.env',
    add: (copy, name) => copy.append('tests/docker/stack.env', `${name}=1`),
  },
  {
    source: "the suite's environment helper",
    file: 'tests/helpers/env.ts',
    add: (copy, name) => copy.append('tests/helpers/env.ts', `// probe: required('${name}')`),
  },
]

/** The shipped secure defaults (docs/security.md): a value that breaks each and the problem it gives. */
const SECURE_DEFAULTS: { name: string; bad: string; expected: string }[] = [
  { name: 'SCANTOR_BIND_ADDRESS', bad: '0.0.0.0', expected: 'a loopback address (CFG-3)' },
  { name: 'SCANTOR_ADMIN_BIND_ADDRESS', bad: '192.168.1.10', expected: 'a loopback address (BLD-11)' },
  { name: 'SCANTOR_NODE_DIND', bad: 'rootless', expected: 'disabled (PRIV-1)' },
  { name: 'SCANTOR_BUILTIN_NODE_DIND', bad: 'privileged', expected: 'disabled (PRIV-1)' },
  { name: 'SCANTOR_MONGO_EXPRESS_READONLY', bad: 'false', expected: 'true (GUI-4)' },
  { name: 'SCANTOR_EXPOSE_MONGO', bad: 'true', expected: 'false' },
  { name: 'SCANTOR_NODE_EGRESS_DENY', bad: 'fd00:ec2::254/128,100.100.100.200/32', expected: 'a list covering 169.254.0.0/16 and fd00:ec2::254/128' },
  { name: 'SCANTOR_NODE_EGRESS_DENY', bad: '169.254.0.0/16,100.100.100.200/32', expected: 'a list covering 169.254.0.0/16 and fd00:ec2::254/128' },
]

test.describe('lint-env', () => {
  // No session is needed: without this the worker's tenant would be created (and signed in) for nothing.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the checkout passes every rule', { tag: ['@OPS-003', '@OPS-004', '@OPS-005'] }, async ({ env }) => {
    const { lintEnv, NOT_CONFIGURATION: allowlist } = await loadEnvLint()
    expect([...allowlist].sort()).toEqual([...NOT_CONFIGURATION].sort())
    expect(lintEnv(env.paths.repo)).toEqual([])
  })

  test('a variable read by code but missing from .env.example fails', { tag: ['@OPS-003'] }, async () => {
    const { lintEnv } = await loadEnvLint()
    const copy = await envCopy()
    try {
      await copy.replace(EXAMPLE, /^SCANTOR_PUBLIC_URL=.*\n/m, '')
      expect(lintEnv(copy.root)).toEqual([expect.stringMatching(/^SCANTOR_PUBLIC_URL \(read by .+\) is missing from \.env\.example$/)])
    } finally {
      await copy.dispose()
    }
  })

  for (const reader of READERS) {
    test(`a variable read by ${reader.source} must be documented`, { tag: ['@OPS-003'] }, async () => {
      const { lintEnv, variablesReadByCode } = await loadEnvLint()
      const copy = await envCopy({ ownGo: reader.go })
      const probe = 'SCANTOR_AUTHZ_PROBE_UNDOCUMENTED'
      try {
        await reader.add(copy, probe)
        expect(variablesReadByCode(copy.root).get(probe)).toBe(reader.file)
        expect(lintEnv(copy.root)).toEqual([`${probe} (read by ${reader.file}) is missing from .env.example`])
        // Documenting it in .env.example fixes the problem.
        await copy.append(EXAMPLE, `# probe variable of the test\n${probe}=`)
        expect(lintEnv(copy.root)).toEqual([])
      } finally {
        await copy.dispose()
      }
    })
  }

  test('a non-empty PASSWORD or SECRET default must end in -insecure-dev', { tag: ['@OPS-003'] }, async () => {
    const { lintEnv, parseEnvExample } = await loadEnvLint()
    const copy = await envCopy()
    try {
      const entries = parseEnvExample(await copy.read(EXAMPLE))
      expect(entries.get('SCANTOR_ADMIN_PASSWORD')?.value, 'an empty default passes').toBe('')
      await setValue(copy, 'SCANTOR_SECRET', 'a-real-looking-secret')
      await setValue(copy, 'SCANTOR_RABBITMQ_PASSWORD', 'rabbitmq-password')
      const problems = lintEnv(copy.root)
      expect(problems).toEqual([
        `.env.example:${entries.get('SCANTOR_SECRET')!.line}: the default of SCANTOR_SECRET must be empty or end in -insecure-dev`,
        `.env.example:${entries.get('SCANTOR_RABBITMQ_PASSWORD')!.line}: the default of SCANTOR_RABBITMQ_PASSWORD must be empty or end in -insecure-dev`,
      ])
    } finally {
      await copy.dispose()
    }
  })

  for (const { name, bad, expected } of SECURE_DEFAULTS) {
    test(`the shipped ${name}=${bad} breaks a secure default`, { tag: ['@OPS-004'] }, async () => {
      const { lintEnv, parseEnvExample } = await loadEnvLint()
      const copy = await envCopy()
      try {
        const line = parseEnvExample(await copy.read(EXAMPLE)).get(name)!.line
        await setValue(copy, name, bad)
        expect(lintEnv(copy.root)).toEqual([`.env.example:${line}: ${name}=${bad} must be ${expected}`])
      } finally {
        await copy.dispose()
      }
    })
  }

  test('a secure-default variable missing from .env.example fails', { tag: ['@OPS-004'] }, async () => {
    const { lintEnv } = await loadEnvLint()
    const copy = await envCopy()
    try {
      await copy.replace(EXAMPLE, /^SCANTOR_EXPOSE_MONGO=.*\n/m, '')
      expect(lintEnv(copy.root)).toContain('SCANTOR_EXPOSE_MONGO is missing from .env.example')
    } finally {
      await copy.dispose()
    }
  })

  for (const name of ['SCANTOR_MONGO_PASSWORD', 'SCANTOR_RABBITMQ_PASSWORD']) {
    test(`the comment of ${name} must carry the first-initialisation note`, { tag: ['@OPS-004'] }, async () => {
      const { lintEnv, parseEnvExample } = await loadEnvLint()
      const copy = await envCopy()
      try {
        const entry = parseEnvExample(await copy.read(EXAMPLE)).get(name)!
        expect(entry.comment).toMatch(/first init/i)
        // The same comment without the note.
        await copy.replace(EXAMPLE, entry.comment, entry.comment.replace(/\s*\(?first init(ialisation)? only\)?/gi, ''))
        expect(lintEnv(copy.root)).toEqual([`.env.example:${entry.line}: the comment of ${name} must say it applies at the FIRST INIT ONLY`])
      } finally {
        await copy.dispose()
      }
    })
  }

  for (const name of NOT_CONFIGURATION) {
    test(`${name} must not appear in .env.example`, { tag: ['@OPS-005'] }, async () => {
      const { lintEnv, parseEnvExample } = await loadEnvLint()
      const copy = await envCopy()
      try {
        await copy.append(EXAMPLE, `\n# not configuration\n${name}=`)
        const line = parseEnvExample(await copy.read(EXAMPLE)).get(name)!.line
        expect(lintEnv(copy.root)).toEqual([`.env.example:${line}: ${name} is not configuration and must not be listed`])
      } finally {
        await copy.dispose()
      }
    })
  }
})
