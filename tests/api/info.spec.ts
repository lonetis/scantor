import Ajv2020 from 'ajv/dist/2020.js'
import type { ItemList } from '#shared/types/common'
import type { Node } from '#shared/types/nodes'
import { TOOL_TARGETS } from '#shared/utils/enums'
import { ApiClient, ok } from '../helpers/api-client'
import { createKey, parseByteSize, stackValue, startEditorKey, stopEditor, TestUsers, withAuthTenants } from '../helpers/api-auth'
import { scantor } from '../helpers/cli'
import { stackEnv } from '../helpers/docker'
import { newApiContext } from '../helpers/users'
import { expect, test as base } from '../fixtures'

const test = withAuthTenants(base)

// Instance information and the OpenAPI document (docs/api.md §1.1, §4.1, docs/auth.md §11): what GET /api/info
// tells each kind of caller, the image tag rule, the admin tool links, secret hygiene, the served OpenAPI document
// and the route-meta values that must survive Nitro's static extraction (also as MCP tool descriptions).

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

/** `<SCANTOR_IMAGE_PREFIX>scantor:<tag>` with the tag rule of docs/api.md §4.1. */
function expectedCliImage(version: string): string {
  const tag = RELEASE_VERSION.test(version) ? version : stackValue('SCANTOR_IMAGE_TAG')
  return `${stackValue('SCANTOR_IMAGE_PREFIX')}scantor:${tag}`
}

const TOOL_PATHS: Record<(typeof TOOL_TARGETS)[number], string> = {
  rabbitmq: '/',
  'mongo-express': '/',
  rustfs: '/rustfs/console/',
  traefik: '/dashboard/',
}

test.describe('instance info', () => {
  test('GET /api/info needs credentials and describes the instance', { tag: ['@PLAT-003'] }, async ({ anonApi, api, apiKeyApi, user, env }) => {
    const anonymous = await anonApi.getInstanceInfo()
    expect(anonymous.status).toBe(401)
    expect((anonymous.body as unknown as { error: { code: string } }).error.code).toBe('unauthorized')

    const info = ok(await api.getInstanceInfo(), 'getInstanceInfo')
    expect(Object.keys(info).sort()).toEqual(
      ['cliImage', 'editorUrl', 'features', 'limits', 'mcpUrl', 'publicUrl', 'registryPublicHost', 'user', 'version'].sort(),
    )
    const health = ok(await anonApi.getHealth(), 'getHealth')
    expect(info.version).toBe(health.version)
    expect(info.publicUrl).toBe(env.publicUrl)
    expect(info.editorUrl).toBe(env.editorUrl)
    expect(info.mcpUrl).toBe(env.mcpUrl)
    expect(info.registryPublicHost).toBe(stackValue('SCANTOR_REGISTRY_PUBLIC_HOST'))
    expect(info.cliImage).toBe(expectedCliImage(info.version))
    expect(info.features).toEqual({ passkeys: true, mcp: true, mcpOAuth: true, editor: true })
    expect(info.limits).toEqual({
      maxWorkersPerScan: Number(stackValue('SCANTOR_MAX_WORKERS_PER_SCAN')),
      maxProcessesPerWorker: Number(stackValue('SCANTOR_MAX_PROCESSES_PER_WORKER')),
      maxResultBytes: parseByteSize(stackValue('SCANTOR_MAX_RESULT_BYTES')),
      maxFileBytes: parseByteSize(stackValue('SCANTOR_MAX_FILE_BYTES')),
      scanConfirmThreshold: Number(stackValue('SCANTOR_SCAN_CONFIRM_THRESHOLD')),
      waitMaxSeconds: 120,
    })
    expect(info.user).toEqual({ id: user.id, role: 'user' })

    // An API key sees the same document.
    expect(ok(await apiKeyApi.getInstanceInfo(), 'getInstanceInfo')).toEqual(info)
  })

  test('scantor whoami and scantor instance print the account and the instance', { tag: ['@PLAT-003'] }, async ({ api, user, env }) => {
    const info = ok(await api.getInstanceInfo(), 'getInstanceInfo')
    const instance = await scantor(['instance', '-o', 'json'], { token: user.apiKey })
    expect(instance.exitCode, instance.stderr).toBe(0)
    expect(instance.json).toEqual(info)

    const whoami = await scantor(['whoami', '-o', 'json'], { token: user.apiKey })
    expect(whoami.exitCode, whoami.stderr).toBe(0)
    const account = ok(await api.getAccount(), 'getAccount')
    expect(whoami.json).toEqual({ url: env.publicUrl, ...account })

    const human = await scantor(['instance'], { token: user.apiKey })
    expect(human.exitCode, human.stderr).toBe(0)
    for (const value of [info.version, info.publicUrl, info.editorUrl, info.cliImage, `${user.id} (user)`]) expect(human.stdout).toContain(value)
  })

  test('the CLI image and the node join command use the image tag rule', { tag: ['@PLAT-004'] }, async ({ adminApi, anonApi }) => {
    const version = ok(await anonApi.getHealth(), 'getHealth').version
    const image = expectedCliImage(version)
    expect(ok(await adminApi.getInstanceInfo(), 'getInstanceInfo').cliImage).toBe(image)

    // The join command of the shared remote node (read only) runs the same image.
    const nodes = ok(await adminApi.call<ItemList<Node>>('listNodes', { query: { pool: 'remote' } }), 'listNodes')
    const remote = nodes.items.find((node) => node.name === 'remote-1')
    expect(remote, 'remote-1 exists').toBeTruthy()
    const join = ok(await adminApi.call<{ dockerRun: string; compose: string }>('getNodeJoin', { path: { nodeId: remote!.id } }), 'getNodeJoin')
    expect(join.dockerRun).toMatch(new RegExp(` ${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} node$`))
    expect(join.compose).toContain(`image: ${image}`)
  })
})

test.describe('admin tools in the instance info', () => {
  const users = new TestUsers()
  test.afterEach(async ({ adminApi }) => users.cleanup(adminApi))

  test('adminTools lists the Traefik tool URLs for an admin session', { tag: ['@PLAT-005'] }, async ({ adminApi, env }) => {
    const info = ok(await adminApi.getInstanceInfo(), 'getInstanceInfo')
    expect(info.user.role).toBe('admin')
    expect(info.adminTools?.enabled).toBe(true)
    const scheme = new URL(env.publicUrl).protocol
    const port = new URL(env.publicUrl).port
    expect(info.adminTools?.items.map((item) => item.target)).toEqual([...TOOL_TARGETS])
    for (const item of info.adminTools!.items) {
      expect(item.title, item.target).toEqual(expect.any(String))
      expect(item.url, item.target).toBe(`${scheme}//${item.target}.${env.domain}${port ? `:${port}` : ''}${TOOL_PATHS[item.target]}`)
    }
  })

  test('adminTools follows effective admin power: default key yes, editor key and users no', { tag: ['@PLAT-005'] }, async ({ adminApi, api, openapi }) => {
    test.setTimeout(180_000)
    expect(ok(await api.getInstanceInfo(), 'getInstanceInfo')).not.toHaveProperty('adminTools')

    const admin = await users.signedIn(adminApi, openapi, { prefix: 'info-admin', role: 'admin' })
    const key = await createKey(admin.api, 'info-default')
    const keyContext = await newApiContext({ headers: { Authorization: `Bearer ${key.key}` } })
    try {
      const viaKey = ok(await new ApiClient(keyContext, openapi).getInstanceInfo(), 'getInstanceInfo')
      expect(viaKey.user).toEqual({ id: admin.id, role: 'admin' })
      expect(viaKey.adminTools?.enabled).toBe(true)
    } finally {
      await keyContext.dispose()
    }

    // The editor key of an admin acts as a plain user (docs/auth.md §5.6).
    const editorKey = await startEditorKey(admin.api, admin.id)
    const editorContext = await newApiContext({ headers: { 'x-api-key': editorKey } })
    try {
      const viaEditor = ok(await new ApiClient(editorContext, openapi).getInstanceInfo(), 'getInstanceInfo')
      expect(viaEditor.user).toEqual({ id: admin.id, role: 'admin' })
      expect(viaEditor).not.toHaveProperty('adminTools')
    } finally {
      await editorContext.dispose()
      await stopEditor(admin.api)
    }
  })

  test('the instance info never contains secret values', { tag: ['@PLAT-006'] }, async ({ adminApi, api }) => {
    const raw = [(await adminApi.getInstanceInfo()).raw.toString('utf8'), (await api.getInstanceInfo()).raw.toString('utf8')].join('\n')
    const secretNames = /(SECRET|PASSWORD|TOKEN|_KEY|CREDENTIAL|CA_CERT)/
    const secrets = Object.entries(stackEnv()).filter(([name, value]) => secretNames.test(name) && value.replace(/^"|"$/g, '').length >= 8)
    expect(secrets.map(([name]) => name)).toEqual(expect.arrayContaining(['SCANTOR_SECRET', 'SCANTOR_ADMIN_PASSWORD']))
    for (const [name, value] of secrets) expect(raw, `${name} leaks into /api/info`).not.toContain(value.replace(/^"|"$/g, ''))
    // No credential shapes either: API keys, node, worker, setup or internal tokens, JWTs, private keys.
    for (const shape of [/sk_scantor_/, /snt_[A-Za-z0-9_-]{20}/, /swt_/, /sst_/, /sic_/, /eyJ[A-Za-z0-9_-]{10,}\./, /PRIVATE KEY/])
      expect(raw).not.toMatch(shape)
  })
})

test.describe('OpenAPI document', () => {
  test('the document is public, OpenAPI 3.1 and lists only operations', { tag: ['@OAS-001'] }, async ({ anonApi }) => {
    const response = await anonApi.request.get('/api/docs/openapi.json', { headers: { Authorization: 'Bearer not-a-credential' } })
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/json/)
    const document = (await response.json()) as {
      openapi: string
      info: { title: string; version: string }
      paths: Record<string, Record<string, Record<string, unknown>>>
      components?: { schemas?: Record<string, unknown> }
    }
    expect(document.openapi).toMatch(/^3\.1\.\d+$/)
    expect(document.info.title).toEqual(expect.any(String))
    expect(document.info.version).toBe(ok(await anonApi.getHealth(), 'getHealth').version)

    const paths = Object.keys(document.paths)
    expect(paths.length).toBeGreaterThan(50)
    expect(paths).not.toContain('')
    for (const path of paths) {
      expect(path, 'every path is an /api route').toMatch(/^\/api\//)
      expect(path).not.toMatch(/^\/api\/auth(\/|$)/)
      expect(path).not.toMatch(/^\/(mcp|\.well-known|__nuxt)/)
      expect(path, 'no Nitro catch-all parameter').not.toMatch(/\{(all|_|\.\.\.)/)
    }

    const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']
    const ids = new Set<string>()
    for (const [path, item] of Object.entries(document.paths)) {
      const operations = Object.entries(item).filter(([key]) => methods.includes(key))
      expect(operations.length, `${path} has operations`).toBeGreaterThan(0)
      for (const [method, operation] of operations) {
        const id = operation.operationId
        expect(id, `${method} ${path} has an operationId`).toEqual(expect.any(String))
        expect(ids.has(id as string), `${id} is unique`).toBe(false)
        ids.add(id as string)
        expect(operation.responses, `${id} has responses`).toBeTruthy()
      }
    }

    // Every reference resolves and every schema compiles as JSON Schema 2020-12 (the dialect of OpenAPI 3.1).
    const text = JSON.stringify(document)
    const refs = new Set([...text.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1]!))
    for (const ref of refs) {
      expect(ref, 'local reference').toMatch(/^#\//)
      const target = ref
        .slice(2)
        .split('/')
        .reduce<unknown>((node, segment) => (node as Record<string, unknown> | undefined)?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], document)
      expect(target, `${ref} resolves`).toBeTruthy()
    }
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    ajv.addSchema({ ...document, $id: 'oas-001.json' })
    for (const name of Object.keys(document.components?.schemas ?? {})) {
      expect(() => ajv.compile({ $ref: `oas-001.json#/components/schemas/${name}` }), name).not.toThrow()
    }
  })

  test('route-meta descriptions survive extraction into OpenAPI and the MCP tools', { tag: ['@OAS-004'] }, async ({ openapi, mcpKey }) => {
    const names = ['startScan', 'listTasks', 'listTemplates', 'listTaskFiles', 'uploadTask', 'getRegistryToken', 'createRegistryToken']
    const document = openapi.document as unknown as { paths: Record<string, Record<string, { description?: unknown; summary?: unknown }>> }
    const descriptions = new Map<string, string>()
    for (const name of names) {
      const op = openapi.get(name)
      const description = document.paths[op.path]![op.method]!.description
      expect(typeof description, `${name} has a description`).toBe('string')
      expect((description as string).trim().length, name).toBeGreaterThan(40)
      descriptions.set(name, description as string)
    }

    const { tools } = await mcpKey.listTools()
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    for (const name of names) {
      const op = openapi.get(name)
      if (op.extensions['x-mcp'] !== true) continue
      const toolName = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
      const tool = tools.find((t) => t.name === toolName)
      expect(tool, `MCP tool ${toolName}`).toBeTruthy()
      expect(normalize(tool!.description ?? ''), `${toolName} carries the operation description`).toContain(normalize(descriptions.get(name)!))
    }
    // At least the MCP-exposed ones were compared.
    expect(names.filter((name) => openapi.get(name).extensions['x-mcp'] === true)).toEqual(
      expect.arrayContaining(['startScan', 'listTasks', 'listTemplates', 'listTaskFiles']),
    )
  })

  test('the queryAnalyses sort schema accepts 1 and -1', { tag: ['@OAS-004'] }, async ({ openapi }) => {
    const op = openapi.get('queryAnalyses')
    const schema = op.requestBody?.content?.['application/json']?.schema as Record<string, unknown> | undefined
    expect(schema, 'queryAnalyses has a JSON request body').toBeTruthy()
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    ajv.addSchema({ ...openapi.document, $id: 'oas-004.json' })
    const pointer = op.path.replaceAll('~', '~0').replaceAll('/', '~1')
    const body = ajv.compile({ $ref: `oas-004.json#/paths/${pointer}/post/requestBody/content/application~1json/schema` })
    for (const direction of [1, -1]) {
      const valid = body({ filter: {}, sort: { seq: direction } })
      expect(valid, `sort ${direction}: ${JSON.stringify(body.errors)}`).toBe(true)
    }
  })
})
