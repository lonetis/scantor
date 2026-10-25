import { parseDocument } from 'yaml'
import { COMPOSE_FILES, loadComposeLint, RepoCopy } from '../helpers/authz-lint'
import { expect, test } from '../fixtures'

// Thin wrapper over the rule function of tests/scripts/lint-compose.mjs (docs/testing.md §11, §14 decision 12): the
// compose files of the checkout pass, and each rule fails on a throwaway copy of the compose files in which exactly
// that rule is broken. `just lint-compose` runs the same function.

const PROD = 'docker-compose.prod.yml'
const DEV = 'docker-compose.dev.yml'
const STACK = 'tests/docker/stack.tests.yml'

/** The infrastructure services that must be identical in the dev and prod compose files. */
const INFRASTRUCTURE = ['mongo', 'rabbitmq', 'rustfs', 'registry', 'mongo-express', 'traefik'] as const

/** Edits one service of a compose file through the YAML document model (anchors and formatting are kept). */
async function editService(copy: RepoCopy, file: string, service: string, edit: (path: (string | number)[], doc: ReturnType<typeof parseDocument>) => void) {
  const doc = parseDocument(await copy.read(file))
  edit(['services', service], doc)
  await copy.write(file, doc.toString())
}

interface RuleCase {
  title: string
  /** breaks the rule in the throwaway copy */
  breakRule(copy: RepoCopy): Promise<void>
  /** the problem lint-compose must report */
  problem: string | RegExp
}

const RULES: RuleCase[] = [
  {
    title: 'Traefik exposes containers by default',
    breakRule: (copy) => copy.replace(PROD, '--providers.docker.exposedbydefault=false', '--providers.docker.exposedbydefault=true'),
    problem: `${PROD}: traefik lacks --providers.docker.exposedbydefault=false`,
  },
  {
    title: 'Traefik lacks the compose-project constraint',
    breakRule: (copy) => copy.replace(PROD, /\n\s+- --providers\.docker\.constraints=[^\n]+/, ''),
    problem: `${PROD}: traefik lacks --providers.docker.constraints=Label(\`com.docker.compose.project\`,\`scantor\`)`,
  },
  {
    title: 'Traefik serves its API insecurely',
    breakRule: (copy) => copy.replace(PROD, '--api.insecure=false', '--api.insecure=true'),
    problem: `${PROD}: traefik lacks --api.insecure=false`,
  },
  {
    title: 'the RabbitMQ management GUI is published on the public bind address',
    breakRule: (copy) =>
      copy.replace(
        PROD,
        '"${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_RABBITMQ_MANAGEMENT_PORT}:15672"',
        '"${SCANTOR_BIND_ADDRESS}:${SCANTOR_RABBITMQ_MANAGEMENT_PORT}:15672"',
      ),
    problem: /^docker-compose\.prod\.yml: rabbitmq publishes 15672 without \$\{SCANTOR_ADMIN_BIND_ADDRESS\}/,
  },
  {
    title: 'MongoDB is published on the public bind address',
    breakRule: (copy) => copy.replace(PROD, '"${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_MONGO_PORT}:27017"', '"0.0.0.0:${SCANTOR_MONGO_PORT}:27017"'),
    problem: /^docker-compose\.prod\.yml: mongo publishes 27017 without \$\{SCANTOR_ADMIN_BIND_ADDRESS\}/,
  },
  {
    title: 'mongo-express is published on the public bind address',
    breakRule: (copy) =>
      copy.replace(PROD, '"${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_MONGO_EXPRESS_PORT}:8081"', '"${SCANTOR_BIND_ADDRESS}:${SCANTOR_MONGO_EXPRESS_PORT}:8081"'),
    problem: /^docker-compose\.prod\.yml: mongo-express publishes 8081 without \$\{SCANTOR_ADMIN_BIND_ADDRESS\}/,
  },
  {
    title: 'the RustFS console is published on the public bind address',
    breakRule: (copy) =>
      copy.replace(
        PROD,
        '"${SCANTOR_ADMIN_BIND_ADDRESS}:${SCANTOR_RUSTFS_CONSOLE_PORT}:9001"',
        '"${SCANTOR_BIND_ADDRESS}:${SCANTOR_RUSTFS_CONSOLE_PORT}:9001"',
      ),
    problem: /^docker-compose\.prod\.yml: rustfs publishes 9001 without \$\{SCANTOR_ADMIN_BIND_ADDRESS\}/,
  },
  {
    title: 'the MongoDB TCP router is enabled without SCANTOR_EXPOSE_MONGO',
    breakRule: (copy) => copy.replace(PROD, 'traefik.enable=${SCANTOR_EXPOSE_MONGO}', 'traefik.enable=true'),
    problem: `${PROD}: the MongoDB TCP router must be enabled only by traefik.enable=\${SCANTOR_EXPOSE_MONGO}`,
  },
  {
    title: 'mongo-express is writable',
    breakRule: (copy) => copy.replace(PROD, 'ME_CONFIG_OPTIONS_READONLY=${SCANTOR_MONGO_EXPRESS_READONLY}', 'ME_CONFIG_OPTIONS_READONLY=false'),
    problem: `${PROD}: mongo-express must set ME_CONFIG_OPTIONS_READONLY=\${SCANTOR_MONGO_EXPRESS_READONLY}`,
  },
  {
    title: 'mongod runs without --noscripting',
    breakRule: (copy) => copy.replace(PROD, '"--noscripting", ', ''),
    problem: `${PROD}: mongod must run with --noscripting`,
  },
  {
    title: 'mongod logs slow operations',
    breakRule: (copy) => copy.replace(PROD, '"--slowOpSampleRate", "0", ', ''),
    problem: `${PROD}: mongod must run with --slowOpSampleRate 0`,
  },
  {
    title: 'RabbitMQ enables its Prometheus plugin',
    breakRule: (copy) => copy.replace(PROD, 'RABBITMQ_ENABLED_PLUGINS=rabbitmq_management\n', 'RABBITMQ_ENABLED_PLUGINS=rabbitmq_management,rabbitmq_prometheus\n'),
    problem: `${PROD}: rabbitmq must enable only the management plugin (RABBITMQ_ENABLED_PLUGINS=rabbitmq_management)`,
  },
  ...(['orchestrator', 'mongo', 'rabbitmq'] as const).map<RuleCase>((service) => ({
    title: `the ${service} service has no memory limit`,
    breakRule: (copy) => editService(copy, PROD, service, (path, doc) => doc.deleteIn([...path, 'mem_limit'])),
    problem: `${PROD}: ${service} has no mem_limit`,
  })),
  {
    title: 'the orchestrator mounts scantor-workspaces',
    breakRule: (copy) => editService(copy, PROD, 'orchestrator', (path, doc) => doc.addIn([...path, 'volumes'], 'scantor-workspaces:/workspaces')),
    problem: `${PROD}: the orchestrator must never mount scantor-workspaces`,
  },
  ...(['orchestrator', 'traefik'] as const).map<RuleCase>((service) => ({
    title: `the ${service} service has no env_file .env`,
    breakRule: (copy) => editService(copy, PROD, service, (path, doc) => doc.deleteIn([...path, 'env_file'])),
    problem: `${PROD}: ${service} must have env_file .env`,
  })),
  {
    title: 'a production compose variable has a default',
    breakRule: (copy) => copy.replace(PROD, 'mem_limit: ${SCANTOR_ORCHESTRATOR_MEMORY_LIMIT}', 'mem_limit: ${SCANTOR_ORCHESTRATOR_MEMORY_LIMIT:-2g}'),
    problem: /^docker-compose\.prod\.yml:\d+: no defaults in compose files \(\$\{SCANTOR_ORCHESTRATOR_MEMORY_LIMIT:-2g\}\)$/,
  },
  {
    title: 'a variable of the test stack override has a default',
    breakRule: (copy) => copy.replace(STACK, 'scantor-test-fixtures:${SCANTOR_IMAGE_TAG}', 'scantor-test-fixtures:${SCANTOR_IMAGE_TAG-dev}'),
    problem: /^tests\/docker\/stack\.tests\.yml:\d+: no defaults in compose files \(\$\{SCANTOR_IMAGE_TAG-dev\}\)$/,
  },
]

test.describe('lint-compose', () => {
  // No session is needed: without this the worker's tenant would be created (and signed in) for nothing.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the compose files of the checkout pass every rule', { tag: ['@OPS-001', '@OPS-002'] }, async ({ env }) => {
    const { lintCompose, INFRASTRUCTURE_SERVICES } = await loadComposeLint()
    expect(INFRASTRUCTURE_SERVICES).toEqual([...INFRASTRUCTURE])
    expect(lintCompose(env.paths.repo)).toEqual([])
  })

  test('only the image prefix fallback is allowed as a default', { tag: ['@OPS-002'] }, async ({ env }) => {
    const { lintCompose } = await loadComposeLint()
    const prod = await RepoCopy.create(COMPOSE_FILES)
    try {
      expect(await prod.read(PROD), 'the production file uses the allowed fallback').toContain('${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}')
      await prod.replace(PROD, '${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}scantor-orchestrator', '${SCANTOR_IMAGE_PREFIX-docker.io/lonetis/}scantor-orchestrator')
      expect(lintCompose(prod.root)).toEqual([
        expect.stringMatching(/^docker-compose\.prod\.yml:\d+: no defaults in compose files \(\$\{SCANTOR_IMAGE_PREFIX-docker\.io\/lonetis\/\}\)$/),
      ])
    } finally {
      await prod.dispose()
    }
    expect(lintCompose(env.paths.repo)).toEqual([])
  })

  for (const service of INFRASTRUCTURE) {
    test(`a difference in the ${service} service between dev and prod fails`, { tag: ['@OPS-001'] }, async () => {
      const { lintCompose } = await loadComposeLint()
      const copy = await RepoCopy.create(COMPOSE_FILES)
      try {
        await editService(copy, DEV, service, (path, doc) => doc.setIn([...path, 'container_name'], `${service}-drifted`))
        expect(lintCompose(copy.root)).toEqual([`the ${service} service differs between docker-compose.dev.yml and docker-compose.prod.yml`])
      } finally {
        await copy.dispose()
      }
    })
  }

  for (const rule of RULES) {
    test(`fails when ${rule.title}`, { tag: ['@OPS-002'] }, async () => {
      const { lintCompose } = await loadComposeLint()
      const copy = await RepoCopy.create(COMPOSE_FILES)
      try {
        await rule.breakRule(copy)
        const problems = lintCompose(copy.root)
        expect(problems).toContainEqual(typeof rule.problem === 'string' ? rule.problem : expect.stringMatching(rule.problem))
      } finally {
        await copy.dispose()
      }
    })
  }
})
