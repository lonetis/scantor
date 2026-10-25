import { describe, expect, it } from 'vitest'
import { analyticsUserEnabled, CONFIG_VARIABLES, ConfigError, parseConfig } from '../../server/utils/config'
import { envExample } from '../helpers/repo'

describe('parseConfig', () => {
  it('reads only variables documented in .env.example', () => {
    const documented = new Set(Object.keys(envExample()))
    const missing = CONFIG_VARIABLES.filter((name) => !documented.has(name))
    expect(missing).toEqual([])
  })

  it('uses the .env.example defaults for unset variables', () => {
    const example = envExample()
    const fromExample = Object.fromEntries(CONFIG_VARIABLES.map((name) => [name, example[name]]))
    const { config: defaults, warnings } = parseConfig({})
    expect(warnings).toEqual([])
    expect(parseConfig(fromExample).config).toEqual(defaults)
  })

  it('parses the value syntax of docs/architecture.md §10', () => {
    const { config } = parseConfig({
      SCANTOR_PUBLIC_URL: 'https://scantor.example.com/',
      SCANTOR_EDITOR_URL: 'https://editor.scantor.example.com',
      SCANTOR_COMPONENTS: ' api , reconciler,api ',
      SCANTOR_QUERY_MAX_TIME: '1m30s',
      SCANTOR_MAX_REQUEST_BYTES: '2MiB',
      SCANTOR_TRUST_PROXY: 'true',
      SCANTOR_TRUSTED_PROXIES: 'Traefik, 10.0.0.0/8 ,fd00::/8,192.0.2.1,traefik',
      SCANTOR_WORKER_CAP_ADD: '',
      SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS: 'https://app.example.com, https://other.example.com/',
      SCANTOR_AMQP_PUBLIC_URL: 'amqps://amqp.example.com:443',
      SCANTOR_DOMAIN: 'Scantor.Example.com',
      SCANTOR_CA_CERT: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
      SCANTOR_ALLOW_INSECURE_TRANSPORT: 'true',
    })
    expect(config.publicUrl).toBe('https://scantor.example.com')
    expect(config.editorUrl).toBe('https://editor.scantor.example.com')
    expect(config.components).toEqual(['api', 'reconciler'])
    expect(config.queryMaxTimeMs).toBe(90_000)
    expect(config.maxRequestBytes).toBe(2 * 1024 ** 2)
    expect(config.trustProxy).toBe(true)
    expect(config.trustedProxies).toEqual(['traefik', '10.0.0.0/8', 'fd00::/8', '192.0.2.1'])
    expect(config.workerCapAdd).toEqual([])
    expect(config.mcpAllowedRedirectOrigins).toEqual(['https://app.example.com', 'https://other.example.com'])
    expect(config.amqpPublicUrl).toBe('amqps://amqp.example.com:443')
    expect(config.domain).toBe('scantor.example.com')
    expect(config.caCert).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')
    expect(config.allowInsecureTransport).toBe(true)
    expect(config.adminEmail).toBeNull()
  })

  it.each([
    ['SCANTOR_PUBLIC_URL', 'not a url'],
    ['SCANTOR_PUBLIC_URL', 'https://scantor.example.com/app'],
    ['SCANTOR_PUBLIC_URL', 'https://user:pw@scantor.example.com'],
    ['SCANTOR_PUBLIC_URL', 'ftp://scantor.example.com'],
    ['SCANTOR_EDITOR_URL', 'https://editor.example.com/?x=1'],
    ['SCANTOR_BIND_ADDRESS', 'localhost'],
    ['SCANTOR_ADMIN_BIND_ADDRESS', '127.0.0'],
    ['SCANTOR_TRUST_PROXY', 'yes'],
    ['SCANTOR_TRUSTED_PROXIES', 'traefik, not a host!'],
    ['SCANTOR_TRUSTED_PROXIES', '10.0.0.0/33'],
    ['SCANTOR_TRUSTED_PROXIES', 'fd00::/129'],
    ['SCANTOR_TRUSTED_PROXIES', 'traefik/8'],
    ['SCANTOR_ALLOW_INSECURE_DEFAULTS', '1'],
    ['SCANTOR_ALLOW_INSECURE_TRANSPORT', 'yes'],
    ['SCANTOR_GIT_ALLOW_PRIVATE', 'TRUE'],
    ['SCANTOR_MONGO_EXPRESS_READONLY', 'True'],
    ['SCANTOR_PASSKEY_RP_ID', 'not a host!'],
    ['SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS', 'http://app.example.com'],
    ['SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS', 'https://app.example.com/callback'],
    ['SCANTOR_COMPONENTS', 'api,scheduler'],
    ['SCANTOR_COMPONENTS', ''],
    ['SCANTOR_WORKER_CAP_ADD', 'SYS_ADMIN'],
    ['SCANTOR_SECRET', ''],
    ['SCANTOR_CA_CERT', 'not a certificate'],
    ['SCANTOR_AMQP_INTERNAL_URL', 'amqp://rabbitmq:5672/scantor'],
    ['SCANTOR_REGISTRY_PUBLIC_HOST', 'https://registry.example.com'],
  ])('aborts on an invalid security-relevant value: %s=%j', (variable, value) => {
    let error: unknown
    try {
      parseConfig({ [variable]: value })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).issues.map((issue) => issue.variable)).toContain(variable)
    expect((error as ConfigError).message).not.toContain(value === '' ? '\u0000' : `=${value}`)
  })

  it.each([
    ['SCANTOR_QUERY_MAX_TIME', '30', 'queryMaxTimeMs', 30_000],
    ['SCANTOR_MAX_REQUEST_BYTES', '10MB', 'maxRequestBytes', 10 * 1024 ** 2],
    ['SCANTOR_LOG_LEVEL', 'verbose', 'logLevel', 'info'],
    ['SCANTOR_BUILD_CONCURRENCY', '0', 'buildConcurrency', 2],
    ['SCANTOR_BREAKER_RATIO', '1.5', 'breakerRatio', 0.95],
    ['SCANTOR_EDITOR_API_KEY_TTL', '7d', 'editorApiKeyTtlMs', 168 * 3_600_000],
  ] as const)('falls back to the default with a warning for %s=%j', (variable, value, key, expected) => {
    const { config, warnings } = parseConfig({ [variable]: value })
    expect(config[key]).toBe(expected)
    expect(warnings.map((warning) => warning.variable)).toEqual([variable])
  })

  it('requires SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD together', () => {
    expect(() => parseConfig({ SCANTOR_ADMIN_EMAIL: 'admin@example.com' })).toThrow(ConfigError)
    expect(() => parseConfig({ SCANTOR_ADMIN_PASSWORD: 'a-long-enough-password' })).toThrow(ConfigError)
    const { config } = parseConfig({ SCANTOR_ADMIN_EMAIL: 'Admin@Example.com', SCANTOR_ADMIN_PASSWORD: 'a-long-enough-password' })
    expect(config.adminEmail).toBe('admin@example.com')
    expect(config.adminPassword).toBe('a-long-enough-password')
  })

  it('requires SCANTOR_PASSKEY_RP_ID to be the host or a registrable suffix of it', () => {
    const publicUrl = 'https://scantor.example.com'
    expect(parseConfig({ SCANTOR_PUBLIC_URL: publicUrl, SCANTOR_PASSKEY_RP_ID: 'scantor.example.com' }).config.passkeyRpId).toBe(
      'scantor.example.com',
    )
    expect(parseConfig({ SCANTOR_PUBLIC_URL: publicUrl, SCANTOR_PASSKEY_RP_ID: 'example.com' }).config.passkeyRpId).toBe('example.com')
    expect(() => parseConfig({ SCANTOR_PUBLIC_URL: publicUrl, SCANTOR_PASSKEY_RP_ID: 'other.com' })).toThrow(ConfigError)
    expect(() => parseConfig({ SCANTOR_PUBLIC_URL: publicUrl, SCANTOR_PASSKEY_RP_ID: 'com' })).toThrow(ConfigError)
  })
})

describe('analyticsUserEnabled', () => {
  // docs/deployment.md §4.3: the read-only analytics user exists while the MongoDB TCP router or a read-only
  // mongo-express connects with it; mongo-express is read-only by default.
  it('is on by default, for the read-only mongo-express', () => {
    const { config } = parseConfig({})
    expect(config.mongoExpressReadonly).toBe(true)
    expect(config.exposeMongo).toBe(false)
    expect(analyticsUserEnabled(config)).toBe(true)
  })

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])('exposeMongo=%s, mongoExpressReadonly=%s → %s', (exposeMongo, mongoExpressReadonly, expected) => {
    const { config } = parseConfig({ SCANTOR_EXPOSE_MONGO: String(exposeMongo), SCANTOR_MONGO_EXPRESS_READONLY: String(mongoExpressReadonly) })
    expect(analyticsUserEnabled(config)).toBe(expected)
  })
})
