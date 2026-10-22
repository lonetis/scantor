#!/usr/bin/env node
// `.env.example` rules (docs/testing.md §11, part of `just lint`):
//
//   1. every SCANTOR_* variable read by code (Go LoadConfigs, the orchestrator's config.ts, compose interpolations,
//      recipes, the test stack's settings and helpers) is documented in .env.example;
//   2. the variables that are not configuration (internal contract, base-image ENV contract, connector protocol) never
//      appear in it; the check fails in both directions;
//   3. a non-empty default of a variable whose name contains PASSWORD or SECRET ends in -insecure-dev;
//   4. the shipped values keep the secure defaults, and the database root passwords carry the first-init note.
//
// Dependency-free (runs in a plain node container). Exports the rule function for security/env-example.spec.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Not configuration: set by scantor itself for its own processes; must never appear in .env.example. */
export const NOT_CONFIGURATION = new Set([
  // internal contract (docs/architecture.md §10)
  'SCANTOR_WORKER_TOKEN',
  'SCANTOR_DIND',
  'SCANTOR_REGISTRY_PUSH_PASSWORD',
  // base-image ENV contract
  'SCANTOR_LANGUAGE',
  'SCANTOR_CONNECTOR_CMD',
  'SCANTOR_CHECK_CMD',
  'SCANTOR_DEBUG_CMD',
  'SCANTOR_DEBUG_PORT',
  // connector protocol (docs/protocol.md)
  'SCANTOR_PROTOCOL_IN_FD',
  'SCANTOR_PROTOCOL_OUT_FD',
  'SCANTOR_PROTOCOL_VERSIONS',
  'SCANTOR_PROCESS_INDEX',
])

/** Shipped values that keep a secure default (docs/security.md): name → [check, what it must be]. */
const SECURE_DEFAULTS = {
  SCANTOR_BIND_ADDRESS: [(v) => isLoopback(v), 'a loopback address (CFG-3)'],
  SCANTOR_ADMIN_BIND_ADDRESS: [(v) => isLoopback(v), 'a loopback address (BLD-11)'],
  SCANTOR_NODE_DIND: [(v) => v === 'disabled', 'disabled (PRIV-1)'],
  SCANTOR_BUILTIN_NODE_DIND: [(v) => v === 'disabled', 'disabled (PRIV-1)'],
  SCANTOR_MONGO_EXPRESS_READONLY: [(v) => v === 'true', 'true (GUI-4)'],
  SCANTOR_EXPOSE_MONGO: [(v) => v === 'false', 'false'],
  SCANTOR_NODE_EGRESS_DENY: [
    (v) => v.split(',').includes('169.254.0.0/16') && v.split(',').includes('fd00:ec2::254/128'),
    'a list covering 169.254.0.0/16 and fd00:ec2::254/128',
  ],
}

/** Variables whose comment must say that they apply at the first initialisation only. */
const FIRST_INIT = ['SCANTOR_MONGO_PASSWORD', 'SCANTOR_RABBITMQ_PASSWORD']

function isLoopback(value) {
  return value === 'localhost' || value === '::1' || /^127\.\d+\.\d+\.\d+$/.test(value)
}

/** KEY → {value, comment, line} of every assignment in .env.example (the comment block right above it). */
export function parseEnvExample(text) {
  const entries = new Map()
  let comment = []
  text.split('\n').forEach((line, index) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match) {
      entries.set(match[1], { value: match[2], comment: comment.join('\n'), line: index + 1 })
      comment = []
    } else if (line.startsWith('#')) {
      comment.push(line)
    } else {
      comment = []
    }
  })
  return entries
}

function walk(dir, accept) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'testdata' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, accept))
    else if (accept(entry.name)) out.push(path)
  }
  return out
}

/** Every SCANTOR_* variable read by code, with the first place that reads it. */
export function variablesReadByCode(repo = root) {
  const found = new Map()
  const scan = (file, pattern) => {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) if (!found.has(match[1])) found.set(match[1], relative(repo, file))
  }
  // Go: every name in a component's config loader (a config.go with LoadConfig), and direct environment reads.
  for (const file of [...walk(join(repo, 'cmd'), (n) => n.endsWith('.go')), ...walk(join(repo, 'internal'), (n) => n.endsWith('.go'))]) {
    if (file.endsWith('_test.go')) continue
    if (file.endsWith('/config.go') && readFileSync(file, 'utf8').includes('func LoadConfig(')) scan(file, /"(SCANTOR_[A-Z0-9_]*[A-Z0-9])"/g)
    scan(file, /(?:Getenv|LookupEnv)\("(SCANTOR_[A-Z0-9_]+)"\)/g)
  }
  scan(join(repo, 'orchestrator', 'server', 'utils', 'config.ts'), /['"`](SCANTOR_[A-Z0-9_]+)['"`]/g)
  const composeFiles = readdirSync(repo)
    .filter((n) => /^docker-compose\..+\.yml$/.test(n))
    .map((n) => join(repo, n))
  for (const file of [...composeFiles, join(repo, 'tests', 'docker', 'stack.tests.yml')]) scan(file, /\$\{(SCANTOR_[A-Z0-9_]+)/g)
  scan(join(repo, 'justfile'), /\b(SCANTOR_[A-Z0-9_]+)\b/g)
  scan(join(repo, 'tests', 'docker', 'stack.env'), /^(SCANTOR_[A-Z0-9_]+)=/gm)
  scan(join(repo, 'tests', 'helpers', 'env.ts'), /['"](SCANTOR_[A-Z0-9_]+)['"]/g)
  return found
}

export function lintEnv(repo = root) {
  const problems = []
  const entries = parseEnvExample(readFileSync(join(repo, '.env.example'), 'utf8'))

  for (const [name, file] of variablesReadByCode(repo)) {
    if (NOT_CONFIGURATION.has(name)) continue
    if (!entries.has(name)) problems.push(`${name} (read by ${file}) is missing from .env.example`)
  }
  for (const [name, entry] of entries) {
    if (NOT_CONFIGURATION.has(name)) problems.push(`.env.example:${entry.line}: ${name} is not configuration and must not be listed`)
    if (/PASSWORD|SECRET/.test(name) && entry.value !== '' && !entry.value.endsWith('-insecure-dev')) {
      problems.push(`.env.example:${entry.line}: the default of ${name} must be empty or end in -insecure-dev`)
    }
  }
  for (const [name, [check, expected]] of Object.entries(SECURE_DEFAULTS)) {
    const entry = entries.get(name)
    if (!entry) problems.push(`${name} is missing from .env.example`)
    else if (!check(entry.value)) problems.push(`.env.example:${entry.line}: ${name}=${entry.value} must be ${expected}`)
  }
  for (const name of FIRST_INIT) {
    const entry = entries.get(name)
    if (entry && !/first init/i.test(entry.comment))
      problems.push(`.env.example:${entry.line}: the comment of ${name} must say it applies at the FIRST INIT ONLY`)
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = lintEnv()
  if (problems.length > 0) {
    console.error(`.env.example: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log('.env.example: ok')
}
