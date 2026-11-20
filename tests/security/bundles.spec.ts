import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import type { BundleInfo } from '#shared/types/bundles'
import { downloadArchive, ensureBundle, readArchive, removeArchive, type ByteSink, type DownloadedArchive } from '../helpers/bundles'
import { stackEnv } from '../helpers/docker'
import { env } from '../helpers/env'
import { stackKeys, type KeyLabel } from '../helpers/keys'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The contents of a bundle archive (docs/security.md §6.21 BDL-1, BDL-2, BDL-6): the archive is read like `docker
// load` reads it, every entry and the decompressed content of every layer are searched for what must never leave the
// master (keys derived from SCANTOR_SECRET, the stack's secrets and API keys, its host names, internal URLs and registry
// repositories, the ids of the owner, the task and the revision, a secret of one of the task's scans and the temporary
// tags of the bundle step), and the image names, the image config and /scantor/bundle.json are checked.

const test = withSecurityTenants(base)

const BUNDLE_TIMEOUT_MS = 600_000

/** Every key label of helpers/keys.ts (the `satisfies` keeps the list complete). */
const KEY_LABELS = Object.keys({
  'better-auth': true,
  'registry-signing': true,
  'registry-push': true,
  'registry-http': true,
  'worker-token': true,
  amqp: true,
  credentials: true,
  'config-secrets': true,
  'tools-cookie': true,
  'editor-cookie': true,
  'builtin-node': true,
  'mongo-query': true,
  'script-run-token': true,
} satisfies Record<KeyLabel, true>) as KeyLabel[]

/** The runtime healthcheck of long-running runtime containers (Go container.RuntimeHealthcheck, docs/nodes.md). */
const RUNTIME_HEALTHCHECK = {
  Test: ['CMD', '/scantor/scantor', 'runtime', 'healthcheck'],
  Interval: 30e9,
  Timeout: 10e9,
  StartPeriod: 120e9,
  StartInterval: 5e9,
  Retries: 3,
}

/** Label keys an image must not carry (docs/security.md LBL-2, LBL-3). */
const FORBIDDEN_LABEL = /^(scantor\.|com\.docker\.compose\.|traefik\.)/i

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

interface Needle {
  label: string
  bytes: Buffer
}

/** A prefix whose occurrence is a finding only when the bytes after it match `rest` (for values of a known shape). */
interface Shape {
  label: string
  prefix: Buffer
  rest: RegExp
}

/** Searches byte streams for needles and shapes; occurrences that span chunks are found through an overlap. */
class Finder {
  readonly findings = new Set<string>()
  private readonly overlap = 256

  constructor(
    private readonly needles: Needle[],
    private readonly shapes: Shape[],
  ) {
    for (const needle of needles) if (needle.bytes.length < 8 || needle.bytes.length > this.overlap) throw new Error(`unsuitable needle ${needle.label}`)
  }

  sink(where: string): ByteSink {
    let carry = Buffer.alloc(0)
    return {
      update: (chunk) => {
        const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
        this.search(data, where)
        carry = Buffer.from(data.subarray(Math.max(0, data.length - this.overlap)))
      },
      end: () => {},
    }
  }

  private search(data: Buffer, where: string): void {
    for (const needle of this.needles) if (data.indexOf(needle.bytes) >= 0) this.findings.add(`${needle.label} in ${where}`)
    for (const shape of this.shapes) {
      for (let at = data.indexOf(shape.prefix); at >= 0; at = data.indexOf(shape.prefix, at + 1)) {
        const after = data.subarray(at + shape.prefix.length, at + shape.prefix.length + 64).toString('latin1')
        if (shape.rest.test(after)) this.findings.add(`${shape.label} in ${where}: ${JSON.stringify(shape.prefix.toString('latin1') + after.slice(0, 48))}`)
      }
    }
  }
}

/** What must never reach a bundle of the task of `ids`, owned by `owner`. */
function forbidden(ids: { owner: string; apiKey: string; task: string; revision: string; scan: string; scanSecret: string }): {
  needles: Needle[]
  shapes: Shape[]
} {
  const stack = stackEnv()
  const needles: Needle[] = []
  const add = (label: string, value: string | Buffer | undefined) => {
    if (value === undefined || value.length === 0) return
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    if (!needles.some((needle) => needle.bytes.equals(bytes))) needles.push({ label, bytes })
  }

  // Keys derived from SCANTOR_SECRET in every encoding the platform uses, and the secret itself.
  const keys = stackKeys()
  for (const label of KEY_LABELS) {
    const key = keys.derive(label)
    add(`the ${label} key`, key)
    add(`the ${label} key (hex)`, key.toString('hex'))
    add(`the ${label} key (base64url)`, key.toString('base64url'))
    add(`the ${label} key (base64)`, key.toString('base64'))
  }
  add('the built-in node token', keys.builtinNodeToken())
  add('SCANTOR_SECRET', env.secret)
  // The stack's other secrets (passwords and keys of MongoDB, RabbitMQ, RustFS, the admin, …).
  for (const [key, value] of Object.entries(stack)) {
    if (/(SECRET|PASSWORD|TOKEN|_KEY)$/.test(key) && value.length >= 12) add(key, value)
  }
  // Host names, internal URLs and the registry repository of the master.
  add('the stack domain (SCANTOR_DOMAIN)', stack.SCANTOR_DOMAIN)
  add('SCANTOR_REGISTRY_PUBLIC_HOST', stack.SCANTOR_REGISTRY_PUBLIC_HOST)
  add('the registry repository of tasks', `localhost:${stack.SCANTOR_REGISTRY_PORT || '5000'}/tasks`)
  for (const key of ['SCANTOR_INTERNAL_URL', 'SCANTOR_MONGO_URL', 'SCANTOR_AMQP_INTERNAL_URL', 'SCANTOR_S3_INTERNAL_URL', 'SCANTOR_RABBITMQ_MANAGEMENT_URL']) {
    if ((stack[key] ?? '').length >= 12) add(key, stack[key])
  }
  // The owner, the task, the revision and a scan of it, with that scan's secret.
  add("the owner's user id", ids.owner)
  add("the owner's API key", ids.apiKey)
  add('the task id', ids.task)
  add('the revision id', ids.revision)
  add('the scan id', ids.scan)
  add("the scan's secret", ids.scanSecret)

  const shapes: Shape[] = [
    { label: 'an API key', prefix: Buffer.from('sk_scantor_'), rest: /^(editor_)?[A-Za-z0-9_-]{20,}/ },
    { label: 'a temporary tag of the bundle step', prefix: Buffer.from('scantor-bundle/'), rest: new RegExp(`^${UUID}`) },
  ]
  return { needles, shapes }
}

const json = <T>(data: Buffer | undefined, what: string): T => {
  if (!data) throw new Error(`the archive has no ${what}`)
  return JSON.parse(data.toString('utf8')) as T
}

interface SaveManifest {
  Config: string
  RepoTags: string[] | null
  Layers: string[]
}

interface ImageConfig {
  config: {
    Entrypoint?: string[] | null
    Cmd?: string[] | null
    WorkingDir?: string
    Labels?: Record<string, string> | null
    Healthcheck?: Record<string, unknown>
  }
}

test(
  'a bundle archive holds no secrets, ids or stack names, names only localhost/scantor/<task>:<n> and has the bundle entrypoint, healthcheck and info',
  { tag: ['@BUNDLE-007'] },
  async ({ api, user, shared, scans }) => {
    test.setTimeout(BUNDLE_TIMEOUT_MS)
    const { task, revision } = await shared.fixture('bundle-probe')
    // A scan with a secret first, so the master holds a sealed config-secrets blob of the task.
    const scanSecret = `bundle-scan-secret-${randomBytes(16).toString('hex')}`
    const scan = await scans.start({ revision: revision.ref, taskConfig: { token: scanSecret }, scanConfig: { items: ['x'] } })
    await scans.wait(scan.id)

    const bundle = await ensureBundle(api, task.name, revision.number)
    const image = `localhost/scantor/${task.name}:${revision.number}`
    expect(bundle.image).toBe(image)

    let archive: DownloadedArchive | undefined
    try {
      archive = await downloadArchive(bundle)
      const { needles, shapes } = forbidden({
        owner: user.id,
        apiKey: user.apiKey,
        task: task.id,
        revision: revision.id,
        scan: scan.id,
        scanSecret,
      })
      const finder = new Finder(needles, shapes)
      const contents = await readArchive(archive.path, { scan: (where) => finder.sink(where), wanted: ['scantor/bundle.json', 'scantor/scantor'] })
      finder.sink('the entry names').update(Buffer.from(contents.names.join('\n')))

      // BDL-1, BDL-6: nothing of the master, the owner or the task's scans in any byte of the archive.
      expect([...finder.findings], 'values that must never reach a bundle').toEqual([])
      expect(contents.layers.length, 'the archive has layers').toBeGreaterThan(1)

      // BDL-2: the image is named only localhost/scantor/<task>:<n> (manifest.json, index.json, repositories).
      const manifests = json<SaveManifest[]>(contents.small.get('manifest.json'), 'manifest.json')
      expect(manifests).toHaveLength(1)
      expect(manifests[0]!.RepoTags).toEqual([image])
      const index = contents.small.get('index.json')
      if (index) {
        const annotations = json<{ manifests: { annotations?: Record<string, string> }[] }>(index, 'index.json').manifests.map((m) => m.annotations ?? {})
        expect(annotations.length).toBeGreaterThan(0)
        for (const annotation of annotations) {
          expect(annotation['io.containerd.image.name'], JSON.stringify(annotation)).toBe(image)
          expect(annotation['org.opencontainers.image.ref.name'], JSON.stringify(annotation)).toBe(String(revision.number))
        }
      }
      const repositories = contents.small.get('repositories')
      if (repositories) {
        const named = json<Record<string, Record<string, string>>>(repositories, 'repositories')
        expect(Object.keys(named)).toEqual([`localhost/scantor/${task.name}`])
        expect(Object.keys(named[`localhost/scantor/${task.name}`]!)).toEqual([String(revision.number)])
      }

      // The image config: bundle mode as entrypoint, the runtime healthcheck, /work, and only harmless labels.
      const config = json<ImageConfig>(contents.small.get(manifests[0]!.Config), `the image config ${manifests[0]!.Config}`).config
      expect(config.Entrypoint).toEqual(['/scantor/scantor', 'runtime', 'bundle'])
      expect(config.Cmd ?? []).toEqual([])
      expect(config.WorkingDir).toBe('/work')
      expect(config.Healthcheck).toEqual(RUNTIME_HEALTHCHECK)
      const labels = config.Labels ?? {}
      expect(Object.keys(labels).filter((key) => FORBIDDEN_LABEL.test(key))).toEqual([])
      expect(labels['org.opencontainers.image.title']).toBe(revision.ref)

      // /scantor/bundle.json and the runtime binary sit in one layer of the image's own.
      const info = contents.files.get('scantor/bundle.json')
      const binary = contents.files.get('scantor/scantor')
      expect(info, '/scantor/bundle.json').toBeDefined()
      expect(binary, '/scantor/scantor').toBeDefined()
      expect(binary!.layer).toBe(info!.layer)
      expect(manifests[0]!.Layers).toContain(info!.layer)
      expect(binary!.size).toBeGreaterThan(1 << 20)

      // /scantor/bundle.json validates against schemas/bundle.schema.json and describes exactly this revision.
      const schema = JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'bundle.schema.json'), 'utf8')) as object
      const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(schema)
      const parsed = JSON.parse(info!.data.toString('utf8')) as BundleInfo
      expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
      expect(parsed).toMatchObject({
        v: 1,
        image,
        ref: revision.ref,
        task: task.name,
        revision: revision.number,
        language: 'python',
        entry: 'main.py',
        platform: bundle.platform,
      })
      // The schema defaults and settings defaults of the manifest (tests/fixtures/tasks/bundle-probe/scantor.yaml).
      expect(parsed.settings).toEqual({
        processes: 1,
        timeoutMs: 60_000,
        maxAttempts: 3,
        backoff: { initialMs: 1000, factor: 2, maxMs: 2000, jitter: false },
        resources: { cpus: 0.5, memoryMiB: 256 },
        maxAnalysesPerProcess: 1000,
      })
      expect(parsed.description.secretPaths).toEqual({ taskConfig: ['/token'], scanConfig: [], analysisConfig: [], result: ['/token'] })
      const token = (parsed.description.schemas.taskConfig as { properties: Record<string, Record<string, unknown>> }).properties.token
      expect(token, 'the secret field').toBeDefined()
      expect(Object.keys(token!), 'a secret has no default in the bundle').not.toContain('default')
    } finally {
      await removeArchive(archive)
    }
  },
)
