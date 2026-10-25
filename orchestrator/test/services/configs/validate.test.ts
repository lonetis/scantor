import { describe, expect, it } from 'vitest'
import {
  issueFromAjvError,
  rebindConfigSecrets,
  restoreConfigSecrets,
  validateConfig,
  validateConfigs,
} from '../../../server/services/configs/validate'
import type { DescriptionDoc } from '../../../server/types/documents'
import { ApiError } from '../../../server/utils/errors'
import { createKeyring } from '../../../server/utils/keys'
import { configSecretAad, decryptSecret, MASK } from '../../../server/utils/secrets'

// Effective configs (docs/tasks.md §6.3–§6.5; docs/api.md §5.1 step 6): ajv 2020 with useDefaults, request-body JSON
// pointers in 422 configInvalid, writeOnly values encrypted (AAD bound to the owning document) and masked.

const keys = createKeyring('test-secret-for-configs')
const binding = { collection: 'scans', id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f' }

function description(schemas: Partial<DescriptionDoc['schemas']>, secretPaths: Partial<DescriptionDoc['secretPaths']> = {}): DescriptionDoc {
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  return {
    protocolVersion: 1,
    connector: { language: 'python', version: '1.4.0' },
    schemas: { taskConfig: empty, scanConfig: empty, analysisConfig: empty, result: { type: 'object' }, ...schemas },
    schedule: { kind: 'custom' },
    secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: [], ...secretPaths },
    uploadPaths: { taskConfig: [], scanConfig: [] },
    fileRefPaths: [],
    warnings: [],
  }
}

async function issuesOf(promise: Promise<unknown>): Promise<{ path: string; message: string }[]> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).data?.code).toBe('configInvalid')
    expect((error as ApiError).statusCode).toBe(422)
    return ((error as ApiError).data?.details?.issues ?? []) as { path: string; message: string }[]
  }
  throw new Error('expected configInvalid')
}

const taskConfigSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    greeting: { type: 'string', default: 'Hello' },
    retries: { type: 'integer', minimum: 0, default: 2 },
    http: {
      type: 'object',
      default: {},
      properties: { timeoutMs: { type: 'integer', default: 5000 }, headers: { type: 'array', items: { type: 'string', maxLength: 5 }, default: [] } },
      additionalProperties: false,
    },
    mode: { anyOf: [{ type: 'object', properties: { fast: { type: 'boolean', default: true } } }, { type: 'null' }], default: null },
    contact: { type: 'string', format: 'email' },
    secret: { type: 'string', format: 'password' },
  },
  required: [],
  additionalProperties: false,
}

describe('validateConfigs: defaults', () => {
  it('fills defaults at every evaluated properties keyword, not inside anyOf, and keeps null', async () => {
    const result = await validateConfigs(description({ taskConfig: taskConfigSchema }), { taskConfig: { greeting: 'Hi', mode: null } }, binding, keys)
    expect(result.effective.taskConfig).toEqual({ greeting: 'Hi', retries: 2, http: { timeoutMs: 5000, headers: [] }, mode: null })
    expect(result.effective.scanConfig).toEqual({})
    expect(result.effective.analysisConfig).toBeUndefined()
  })

  it('validates missing task and scan configs as {} and never mutates the input', async () => {
    const input = { scanConfig: { } }
    const result = await validateConfigs(description({ taskConfig: taskConfigSchema }), input, binding, keys)
    expect(result.effective.taskConfig).toMatchObject({ greeting: 'Hello', retries: 2 })
    expect(input).toEqual({ scanConfig: {} })
  })

  it('validates the analysis config only when given', async () => {
    const schemas = { analysisConfig: { type: 'object', properties: { origin: { type: 'string', default: 'https://example.org' } }, additionalProperties: false } }
    const result = await validateConfigs(description(schemas), { analysisConfig: {} }, binding, keys)
    expect(result.effective.analysisConfig).toEqual({ origin: 'https://example.org' })
    expect(result.secrets.analysisConfig).toEqual({})
  })
})

describe('validateConfigs: issues', () => {
  it('reports JSON pointers into the request body', async () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, count: { type: 'integer', maximum: 10 }, headers: { type: 'array', items: { type: 'string' } } },
      required: ['name'],
      additionalProperties: false,
    }
    const issues = await issuesOf(
      validateConfigs(description({ taskConfig: schema, scanConfig: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } }), {
        taskConfig: { count: 11, headers: ['a', 3] },
        scanConfig: { limt: 100 },
      }, binding, keys),
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: '/taskConfig/name', message: 'is required' },
        { path: '/taskConfig/count', message: expect.stringContaining('10') },
        { path: '/taskConfig/headers/1', message: expect.stringContaining('string') },
        { path: '/scanConfig/limt', message: 'is not allowed (unknown property)' },
      ]),
    )
  })

  it('rejects a config that is not an object at the config root', async () => {
    const issues = await issuesOf(validateConfigs(description({}), { taskConfig: [] as unknown as Record<string, unknown> }, binding, keys))
    expect(issues[0]?.path).toBe('/taskConfig')
  })

  it('asserts the formats of the subset and ignores the others', async () => {
    const schema = taskConfigSchema
    expect(await issuesOf(validateConfigs(description({ taskConfig: schema }), { taskConfig: { contact: 'not-an-email' } }, binding, keys))).toEqual([
      { path: '/taskConfig/contact', message: expect.stringContaining('email') },
    ])
    await expect(validateConfigs(description({ taskConfig: schema }), { taskConfig: { contact: 'a@example.org', secret: 'anything' } }, binding, keys)).resolves.toBeDefined()
  })

  it.each([
    ['date', '2026-02-29', false],
    ['date', '2028-02-29', true],
    ['date-time', '2026-10-21T10:00:00.000Z', true],
    ['date-time', '2026-10-21 10:00', false],
    ['time', '23:59:60Z', true],
    ['duration', 'P1DT2H', true],
    ['duration', 'P', false],
    ['hostname', 'example.org', true],
    ['hostname', '-bad-.org', false],
    ['ipv4', '10.0.0.1', true],
    ['ipv4', '10.0.0.256', false],
    ['ipv6', '::1', true],
    ['uri', 'https://example.org/a?b=c', true],
    ['uri', 'example.org', false],
    ['uuid', '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f', true],
    ['uuid', '5e1f0c2d', false],
    ['regex', '^a+$', true],
    ['regex', '(', false],
  ])('format %s: %s is %s', (format, value, valid) => {
    const result = validateConfig('taskConfig', { type: 'object', properties: { v: { type: 'string', format } } }, { v: value })
    expect(result.issues.length === 0).toBe(valid)
  })

  it('caps the issue list at 100', async () => {
    const properties = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`f${index}`, { type: 'string' }]))
    const schema = { type: 'object', properties, required: Object.keys(properties) }
    const issues = await issuesOf(validateConfigs(description({ taskConfig: schema }), {}, binding, keys))
    expect(issues).toHaveLength(100)
  })

  it('reports an unusable revision schema as an issue of that config', async () => {
    const issues = await issuesOf(validateConfigs(description({ taskConfig: { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } } }), {}, binding, keys))
    expect(issues[0]).toMatchObject({ path: '/taskConfig', message: expect.stringContaining('unusable') })
  })

  it('refuses revisions without describe output', async () => {
    const issues = await issuesOf(validateConfigs(null, {}, binding, keys))
    expect(issues).toHaveLength(1)
  })

  it('maps ajv errors to pointers', () => {
    expect(issueFromAjvError('scanConfig', { keyword: 'required', instancePath: '/a', schemaPath: '', params: { missingProperty: 'b/c' } })).toEqual({
      path: '/scanConfig/a/b~1c',
      message: 'is required',
    })
  })
})

describe('validateConfig: patterns (security.md RES-13)', () => {
  const stringWith = (pattern: string) => ({ type: 'object', properties: { v: { type: 'string', pattern } } })

  it('matches a nested-quantifier pattern in linear time', () => {
    const started = performance.now()
    const result = validateConfig('scanConfig', stringWith('^(a+)+$'), { v: `${'a'.repeat(5000)}!` })
    // V8's backtracking RegExp needs seconds for 30 characters of this input; RE2 needs milliseconds for 5000.
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.issues).toEqual([{ path: '/scanConfig/v', message: 'must match pattern "^(a+)+$"' }])
    expect(validateConfig('scanConfig', stringWith('^(a+)+$'), { v: 'a'.repeat(5000) }).issues).toEqual([])
  })

  it('searches unanchored and keeps the ECMA-262 escapes of the subset', () => {
    expect(validateConfig('scanConfig', stringWith('[0-9]{5}'), { v: 'zip 12345 x' }).issues).toEqual([])
    expect(validateConfig('scanConfig', stringWith('^\\u0041\\d$'), { v: 'A1' }).issues).toEqual([])
    expect(validateConfig('scanConfig', stringWith('^\\p{L}+$'), { v: 'äöü' }).issues).toEqual([])
    expect(validateConfig('scanConfig', stringWith('^[^/\\\\]+$'), { v: 'a/b' }).issues).toHaveLength(1)
  })

  it('keeps patterns apart that share an ajv instance', () => {
    expect(validateConfig('scanConfig', stringWith('^x$'), { v: 'x' }).issues).toEqual([])
    expect(validateConfig('scanConfig', stringWith('^y$'), { v: 'x' }).issues).toHaveLength(1)
  })

  it('applies to patternProperties', () => {
    const schema = { type: 'object', patternProperties: { '^(a+)+$': { type: 'integer' } } }
    const started = performance.now()
    expect(validateConfig('scanConfig', schema, { [`${'a'.repeat(5000)}!`]: 'x', aaa: 'x' }).issues).toEqual([
      { path: '/scanConfig/aaa', message: 'must be integer' },
    ])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('reports a pattern outside RE2 (lookaround, backreference) as an unusable schema', () => {
    for (const pattern of ['^(?=a)a$', '(a)\\1']) {
      const result = validateConfig('scanConfig', stringWith(pattern), { v: 'a' })
      expect(result.issues).toEqual([{ path: '/scanConfig', message: expect.stringContaining("the revision's scanConfig schema is unusable") }])
    }
  })
})

describe('validateConfigs: discriminated unions', () => {
  const union = {
    type: 'object',
    properties: {
      target: {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'url' }, url: { type: 'string', format: 'uri' } }, required: ['kind', 'url'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'host' }, host: { type: 'string' }, port: { type: 'integer', default: 443 } }, required: ['kind', 'host'], additionalProperties: false },
        ],
        discriminator: { propertyName: 'kind' },
      },
    },
    additionalProperties: false,
  }

  it('validates the selected branch', async () => {
    await expect(validateConfigs(description({ taskConfig: union }), { taskConfig: { target: { kind: 'url', url: 'https://a.example' } } }, binding, keys)).resolves.toBeDefined()
    const issues = await issuesOf(validateConfigs(description({ taskConfig: union }), { taskConfig: { target: { kind: 'host' } } }, binding, keys))
    expect(issues.some((issue) => issue.path.startsWith('/taskConfig/target'))).toBe(true)
  })

  it('treats a discriminator ajv cannot use as an annotation', async () => {
    const loose = { type: 'object', properties: { target: { oneOf: [{ type: 'string' }, { type: 'integer' }], discriminator: { propertyName: 'kind' } } } }
    await expect(validateConfigs(description({ taskConfig: loose }), { taskConfig: { target: 'x' } }, binding, keys)).resolves.toBeDefined()
  })
})

describe('validateConfigs: writeOnly secrets', () => {
  const schema = {
    type: 'object',
    properties: {
      apiKey: { type: 'string', writeOnly: true },
      tokens: { type: 'object', additionalProperties: { type: 'string', writeOnly: true } },
      accounts: { type: 'array', items: { type: 'object', properties: { user: { type: 'string' }, password: { type: 'string', writeOnly: true } } } },
      plain: { type: 'string', default: 'visible' },
    },
    additionalProperties: false,
  }
  const secretPaths = { taskConfig: ['/apiKey', '/tokens/*', '/accounts/*/password'] }

  it('encrypts every secret by concrete pointer and masks it in the stored config', async () => {
    const taskConfig = { apiKey: 'k-123', tokens: { a: 't-a', b: 't-b' }, accounts: [{ user: 'u', password: 'p-0' }, { user: 'v' }] }
    const result = await validateConfigs(description({ taskConfig: schema }, secretPaths), { taskConfig }, binding, keys)
    expect(result.masked.taskConfig).toEqual({ apiKey: MASK, tokens: { a: MASK, b: MASK }, accounts: [{ user: 'u', password: MASK }, { user: 'v' }], plain: 'visible' })
    expect(Object.keys(result.secrets.taskConfig).sort()).toEqual(['/accounts/0/password', '/apiKey', '/tokens/a', '/tokens/b'])
    expect(result.effective.taskConfig.apiKey).toBe('k-123')
    const aad = configSecretAad('scans', binding.id, 'taskConfig', '/apiKey')
    expect(JSON.parse(decryptSecret(result.secrets.taskConfig['/apiKey']!, 'config-secrets', aad, keys))).toBe('k-123')
    expect(JSON.stringify(result.secrets)).not.toContain('k-123')
  })

  it('stores nothing for an omitted secret', async () => {
    const result = await validateConfigs(description({ taskConfig: schema }, secretPaths), { taskConfig: { plain: 'x' } }, binding, keys)
    expect(result.secrets.taskConfig).toEqual({})
    expect(result.masked.taskConfig).toEqual({ plain: 'x' })
  })

  it('restores the plaintext only with the same binding', async () => {
    const result = await validateConfigs(description({ taskConfig: schema }, secretPaths), { taskConfig: { apiKey: 'k-123', tokens: { a: 't-a' } } }, binding, keys)
    const restored = restoreConfigSecrets(result.masked, result.secrets, binding, keys)
    expect(restored.taskConfig).toEqual(result.effective.taskConfig)
    expect(() => restoreConfigSecrets(result.masked, result.secrets, { collection: 'scans', id: 'other' }, keys)).toThrow(/cannot be decrypted/)
    expect(() => restoreConfigSecrets(result.masked, result.secrets, binding, createKeyring('another-secret'))).toThrow(/cannot be decrypted/)
  })

  it('never takes a secret from a default, and removes the outermost member the defaults added', async () => {
    // A description stored before describe dropped such defaults (pydantic exports SecretStr defaults masked).
    const stored = {
      type: 'object',
      properties: {
        token: { anyOf: [{ type: 'string', writeOnly: true }, { type: 'null' }], default: '**********' },
        empty: { anyOf: [{ type: 'string', writeOnly: true }, { type: 'null' }], default: null },
        creds: {
          type: 'object',
          properties: { user: { type: 'string', default: 'u' }, key: { type: 'string', writeOnly: true, default: '**********' } },
          default: { user: 'u', key: '**********' },
        },
        plain: { type: 'string', default: 'visible' },
      },
      additionalProperties: false,
    }
    const paths = { taskConfig: ['/token', '/empty', '/creds/key'] }
    const omitted = await validateConfigs(description({ taskConfig: stored }, paths), { taskConfig: {} }, binding, keys)
    expect(omitted.effective.taskConfig).toEqual({ plain: 'visible' })
    expect(omitted.secrets.taskConfig).toEqual({})

    const partial = await validateConfigs(description({ taskConfig: stored }, paths), { taskConfig: { creds: { user: 'v' } } }, binding, keys)
    expect(partial.effective.taskConfig).toEqual({ creds: { user: 'v' }, plain: 'visible' })

    const given = await validateConfigs(description({ taskConfig: stored }, paths), { taskConfig: { token: 't-1', empty: null, creds: { key: 'k-1' } } }, binding, keys)
    expect(given.effective.taskConfig).toEqual({ token: 't-1', empty: null, creds: { user: 'u', key: 'k-1' }, plain: 'visible' })
    expect(Object.keys(given.secrets.taskConfig).sort()).toEqual(['/creds/key', '/empty', '/token'])
  })

  it('rejects the mask "***" sent back as a secret value', async () => {
    const issues = await issuesOf(
      validateConfigs(description({ taskConfig: schema }, secretPaths), { taskConfig: { apiKey: MASK, tokens: { a: 't-a', b: MASK }, plain: MASK } }, binding, keys),
    )
    expect(issues).toEqual([
      { path: '/taskConfig/apiKey', message: expect.stringContaining('mask') },
      { path: '/taskConfig/tokens/b', message: expect.stringContaining('mask') },
    ])
  })

  it('re-encrypts secrets for a restart clone', async () => {
    const result = await validateConfigs(description({ taskConfig: schema }, secretPaths), { taskConfig: { apiKey: 'k-123' } }, binding, keys)
    const clone = { collection: 'scans', id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11' }
    const rebound = rebindConfigSecrets(result.secrets, binding, clone, keys)
    expect(rebound.taskConfig['/apiKey']).not.toBe(result.secrets.taskConfig['/apiKey'])
    expect(restoreConfigSecrets(result.masked, rebound, clone, keys).taskConfig.apiKey).toBe('k-123')
  })
})
