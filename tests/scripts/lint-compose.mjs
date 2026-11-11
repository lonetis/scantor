#!/usr/bin/env node
// Compose rules (docs/testing.md §11, `just lint-compose`, part of `just lint`):
//
//   - the infrastructure services are identical in docker-compose.dev.yml and docker-compose.prod.yml;
//   - the compose rules of docs/security.md hold: Traefik with exposedbydefault=false, the compose-project constraint and
//     api.insecure=false; admin GUIs and MongoDB published only on SCANTOR_ADMIN_BIND_ADDRESS; the MongoDB TCP router
//     only with SCANTOR_EXPOSE_MONGO; mongo-express read-only; mongod --noscripting and --slowOpSampleRate 0 (slow
//     operations are logged with their documents, session tokens included); RabbitMQ with the management plugin
//     only (its Prometheus endpoint answers without credentials, also on scantor-sandbox); memory limits on the
//     orchestrator, mongo and rabbitmq; the orchestrator never mounts scantor-workspaces; the orchestrator and
//     Traefik get `env_file: .env`;
//   - no compose file (including the test runner's and the test stack override) gives a variable a default, except the
//     image prefix fallback `${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}`; an alternative value (`${VAR:+…}`, only when
//     VAR is set) is no default and stays allowed;
//   - every persistent mount of the infrastructure services takes its source from its data-location variable
//     (`${SCANTOR_MONGO_DATA}:/data/db`, …; docs/deployment.md §5.1), so each service's data can live at a host path;
//   - mongo and rabbitmq run as their own users, and mongo, rabbitmq and rustfs start only after the one-shot
//     data-init, which mounts their data locations and makes them writable for those users;
//   - every service of every compose file defines a healthcheck (and does not disable it), except a one-shot service:
//     `restart: "no"`, and every service that depends on it waits for `service_completed_successfully`.
//
// Needs the `yaml` package (tests/node_modules). Exports the rule function for security/compose-lint.spec.ts.
import { isDeepStrictEqual } from 'node:util'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const INFRASTRUCTURE_SERVICES = ['data-init', 'mongo', 'rabbitmq', 'rustfs', 'registry', 'mongo-express', 'traefik']

/** Persistent mounts of the infrastructure services: service → container path → the variable naming its source. */
export const DATA_MOUNTS = {
  mongo: { '/data/db': 'SCANTOR_MONGO_DATA', '/data/configdb': 'SCANTOR_MONGO_CONFIG_DATA' },
  rabbitmq: { '/var/lib/rabbitmq': 'SCANTOR_RABBITMQ_DATA' },
  rustfs: { '/data': 'SCANTOR_RUSTFS_DATA' },
  registry: { '/var/lib/registry': 'SCANTOR_REGISTRY_DATA' },
  traefik: { '/acme': 'SCANTOR_TRAEFIK_ACME_DATA' },
  'data-init': {
    '/data/mongo': 'SCANTOR_MONGO_DATA',
    '/data/mongo-config': 'SCANTOR_MONGO_CONFIG_DATA',
    '/data/rabbitmq': 'SCANTOR_RABBITMQ_DATA',
    '/data/rustfs': 'SCANTOR_RUSTFS_DATA',
  },
}

/** Services that run as their own user (no root entrypoint chown) on the data data-init prepared. */
const SERVICE_USERS = { mongo: 'mongodb', rabbitmq: 'rabbitmq' }
const AFTER_DATA_INIT = ['mongo', 'rabbitmq', 'rustfs']

/** Container ports of admin GUIs and MongoDB that must only be published on the admin bind address. */
const ADMIN_PORTS = { mongo: [27017], rabbitmq: [15672], rustfs: [9001], 'mongo-express': [8081] }

const ALLOWED_DEFAULT = '${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}'

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])

/** Problems of one parsed production-style compose file (dev or prod). */
function serviceRules(name, compose) {
  const problems = []
  const services = compose.services ?? {}
  const traefik = services.traefik
  if (!traefik) {
    problems.push(`${name}: no traefik service`)
  } else {
    const command = asList(traefik.command).map(String)
    for (const flag of [
      '--providers.docker.exposedbydefault=false',
      '--providers.docker.constraints=Label(`com.docker.compose.project`,`scantor`)',
      '--api.insecure=false',
    ]) {
      if (!command.includes(flag)) problems.push(`${name}: traefik lacks ${flag}`)
    }
  }
  for (const [service, ports] of Object.entries(ADMIN_PORTS)) {
    for (const mapping of asList(services[service]?.ports).map(String)) {
      const target = Number(mapping.split(':').pop()?.split('/')[0])
      if (ports.includes(target) && !mapping.startsWith('${SCANTOR_ADMIN_BIND_ADDRESS}:')) {
        problems.push(`${name}: ${service} publishes ${target} without \${SCANTOR_ADMIN_BIND_ADDRESS} (${mapping})`)
      }
    }
  }
  const mongoLabels = asList(services.mongo?.labels).map(String)
  if (mongoLabels.some((l) => l.startsWith('traefik.tcp.routers.mongo')) && !mongoLabels.includes('traefik.enable=${SCANTOR_EXPOSE_MONGO}')) {
    problems.push(`${name}: the MongoDB TCP router must be enabled only by traefik.enable=\${SCANTOR_EXPOSE_MONGO}`)
  }
  const expressEnv = asList(services['mongo-express']?.environment).map(String)
  if (!expressEnv.includes('ME_CONFIG_OPTIONS_READONLY=${SCANTOR_MONGO_EXPRESS_READONLY}')) {
    problems.push(`${name}: mongo-express must set ME_CONFIG_OPTIONS_READONLY=\${SCANTOR_MONGO_EXPRESS_READONLY}`)
  }
  if (!asList(services.mongo?.command).map(String).includes('--noscripting')) problems.push(`${name}: mongod must run with --noscripting`)
  const mongoCommand = asList(services.mongo?.command).map(String)
  const sampleRate = mongoCommand.indexOf('--slowOpSampleRate')
  if (sampleRate < 0 || mongoCommand[sampleRate + 1] !== '0') problems.push(`${name}: mongod must run with --slowOpSampleRate 0`)
  if (!asList(services.rabbitmq?.environment).map(String).includes('RABBITMQ_ENABLED_PLUGINS=rabbitmq_management')) {
    problems.push(`${name}: rabbitmq must enable only the management plugin (RABBITMQ_ENABLED_PLUGINS=rabbitmq_management)`)
  }
  for (const service of ['orchestrator', 'mongo', 'rabbitmq']) {
    if (services[service] && !services[service].mem_limit) problems.push(`${name}: ${service} has no mem_limit`)
  }
  for (const volume of asList(services.orchestrator?.volumes)) {
    const source = typeof volume === 'string' ? volume.split(':')[0] : volume?.source
    if (source === 'scantor-workspaces') problems.push(`${name}: the orchestrator must never mount scantor-workspaces`)
  }
  for (const service of ['orchestrator', 'traefik']) {
    if (services[service] && !asList(services[service].env_file).some((f) => (typeof f === 'string' ? f : f?.path) === '.env')) {
      problems.push(`${name}: ${service} must have env_file .env`)
    }
  }
  for (const [service, user] of Object.entries(SERVICE_USERS)) {
    if (services[service] && services[service].user !== user) problems.push(`${name}: ${service} must run as user ${user}`)
  }
  for (const service of AFTER_DATA_INIT) {
    if (services[service] && services[service].depends_on?.['data-init']?.condition !== 'service_completed_successfully') {
      problems.push(`${name}: ${service} must depend on data-init with condition service_completed_successfully`)
    }
  }
  for (const [service, mounts] of Object.entries(DATA_MOUNTS)) {
    const volumes = asList(services[service]?.volumes).map((volume) => (typeof volume === 'string' ? volume : `${volume?.source}:${volume?.target}`))
    for (const [target, variable] of Object.entries(mounts)) {
      if (!volumes.includes(`\${${variable}}:${target}`)) problems.push(`${name}: ${service} must mount ${target} from \${${variable}}`)
    }
  }
  return problems
}

/**
 * A one-shot service runs once and exits: `restart: "no"`, at least one dependent, and every dependent waits for
 * `service_completed_successfully`, so nothing waits for it to become healthy.
 */
function isOneShot(services, service) {
  if (services[service]?.restart !== 'no') return false
  const conditions = Object.values(services)
    .map((definition) => (Array.isArray(definition?.depends_on) ? null : definition?.depends_on?.[service]))
    .filter((dependency) => dependency !== undefined)
  return conditions.length > 0 && conditions.every((dependency) => dependency?.condition === 'service_completed_successfully')
}

/** Services without an enabled healthcheck (`test` given, not `NONE`, not `disable: true`), one-shot services aside. */
function healthcheckProblems(name, compose) {
  const problems = []
  const services = compose.services ?? {}
  for (const [service, definition] of Object.entries(services)) {
    if (!definition?.healthcheck && isOneShot(services, service)) continue
    const healthcheck = definition?.healthcheck
    const test = asList(healthcheck?.test).map(String)
    if (!healthcheck || healthcheck.disable === true || test.length === 0 || test[0] === 'NONE') problems.push(`${name}: ${service} has no healthcheck`)
  }
  return problems
}

/** `${VAR:-x}`, `${VAR-x}`, `${VAR:?x}` … anywhere except the image prefix fallback; `${VAR:+x}` is no default. */
function defaultProblems(name, text) {
  const problems = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*(:?[-?=])[^}]*\}/g)) {
      if (match[0] !== ALLOWED_DEFAULT) problems.push(`${name}:${index + 1}: no defaults in compose files (${match[0]})`)
    }
  })
  return problems
}

export function lintCompose(repo = root) {
  const problems = []
  const read = (file) => readFileSync(join(repo, file), 'utf8')
  const dev = parse(read('docker-compose.dev.yml'))
  const prod = parse(read('docker-compose.prod.yml'))
  for (const service of INFRASTRUCTURE_SERVICES) {
    if (!isDeepStrictEqual(dev.services?.[service], prod.services?.[service])) {
      problems.push(`the ${service} service differs between docker-compose.dev.yml and docker-compose.prod.yml`)
    }
  }
  problems.push(...serviceRules('docker-compose.dev.yml', dev), ...serviceRules('docker-compose.prod.yml', prod))
  const composeFiles = readdirSync(repo).filter((n) => /^docker-compose\..+\.yml$/.test(n))
  for (const file of [...composeFiles, 'tests/docker/stack.tests.yml']) {
    const text = read(file)
    problems.push(...defaultProblems(file, text), ...healthcheckProblems(file, parse(text)))
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = lintCompose()
  if (problems.length > 0) {
    console.error(`Compose files: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log('Compose files: ok')
}
