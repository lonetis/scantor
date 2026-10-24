import { describe, expect, it } from 'vitest'
import { evaluateStartupGuard, isLoopbackAddress, isLoopbackHost, type StartupGuardInput } from '../../server/utils/startup-guard'

// security.md §6.11 CFG-2: the full truth table of public mode × offenders × allow flag, plus the same-origin rule.

const STRONG = 'f3a9c1d2e4b5a6978877665544332211aabbccdd'

/** An environment whose core secrets are all long and random. */
function strongEnv(): Record<string, string> {
  return {
    SCANTOR_SECRET: STRONG,
    SCANTOR_MONGO_PASSWORD: STRONG,
    SCANTOR_RABBITMQ_PASSWORD: STRONG,
    SCANTOR_S3_SECRET_KEY: STRONG,
    SCANTOR_MONGO_EXPRESS_PASSWORD: STRONG,
    SCANTOR_MONGO_EXPRESS_SECRET: STRONG,
    SCANTOR_MONGO_ANALYTICS_PASSWORD: STRONG,
  }
}

function input(overrides: Partial<StartupGuardInput> = {}): StartupGuardInput {
  return {
    publicUrl: 'http://localhost:3000',
    editorUrl: 'http://localhost:3001',
    bindAddress: '127.0.0.1',
    adminBindAddress: '127.0.0.1',
    composeProfiles: [],
    analyticsUser: false,
    allowInsecureDefaults: false,
    env: strongEnv(),
    ...overrides,
  }
}

describe('loopback helpers', () => {
  it.each(['localhost', 'LOCALHOST', 'scantor.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])('%s is a loopback host', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each(['example.com', 'localhost.example.com', '10.0.0.1', '0.0.0.0', '128.0.0.1', '::', 'mylocalhost'])('%s is not a loopback host', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })

  it('only addresses count for bind addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('localhost')).toBe(false)
  })
})

describe('evaluateStartupGuard', () => {
  const publicTriggers: [string, Partial<StartupGuardInput>][] = [
    ['public URL host', { publicUrl: 'https://scantor.example.com' }],
    ['editor URL host', { editorUrl: 'https://editor.example.com' }],
    ['traefik profile', { composeProfiles: ['traefik'] }],
    ['bind address', { bindAddress: '0.0.0.0' }],
    ['admin bind address', { adminBindAddress: '10.0.0.5' }],
  ]

  it('is local with loopback URLs and bind addresses', () => {
    expect(evaluateStartupGuard(input()).publicMode).toBe(false)
    expect(evaluateStartupGuard(input({ publicUrl: 'http://scantor.localhost:8080', editorUrl: 'http://editor.scantor.localhost' })).publicMode).toBe(
      false,
    )
  })

  it.each(publicTriggers)('becomes public through the %s', (_name, overrides) => {
    expect(evaluateStartupGuard(input(overrides)).publicMode).toBe(true)
  })

  it.each(publicTriggers)('accepts strong secrets in public mode (%s)', (_name, overrides) => {
    expect(evaluateStartupGuard(input(overrides)).outcome).toBe('ok')
  })

  it.each(publicTriggers)('refuses an -insecure-dev value of any variable in public mode (%s)', (_name, overrides) => {
    const result = evaluateStartupGuard(input({ ...overrides, env: { ...strongEnv(), SOMETHING_ELSE: 'value-insecure-dev' } }))
    expect(result.outcome).toBe('abort')
    expect(result.offenders).toEqual(['SOMETHING_ELSE'])
  })

  it('refuses short core secrets and a short admin password in public mode', () => {
    const env = { ...strongEnv(), SCANTOR_RABBITMQ_PASSWORD: 'short', SCANTOR_ADMIN_PASSWORD: 'also-short' }
    const result = evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', env }))
    expect(result.outcome).toBe('abort')
    expect(result.offenders).toEqual(['SCANTOR_ADMIN_PASSWORD', 'SCANTOR_RABBITMQ_PASSWORD'])
  })

  it('treats an unset core secret as too short', () => {
    const { SCANTOR_SECRET: _omitted, ...env } = strongEnv()
    expect(evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', env })).offenders).toEqual(['SCANTOR_SECRET'])
  })

  it('allows an empty admin password', () => {
    const env = { ...strongEnv(), SCANTOR_ADMIN_PASSWORD: '' }
    expect(evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', env })).outcome).toBe('ok')
  })

  it('checks the analytics password length only while the analytics user exists', () => {
    const env = { ...strongEnv(), SCANTOR_MONGO_ANALYTICS_PASSWORD: 'short' }
    expect(evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', env })).outcome).toBe('ok')
    const enabled = evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', env, analyticsUser: true }))
    expect(enabled.outcome).toBe('abort')
    expect(enabled.offenders).toEqual(['SCANTOR_MONGO_ANALYTICS_PASSWORD'])
  })

  it('warns instead of aborting with SCANTOR_ALLOW_INSECURE_DEFAULTS', () => {
    const env = { ...strongEnv(), SCANTOR_MONGO_EXPRESS_SECRET: 'mongo-express-secret-insecure-dev' }
    const result = evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', allowInsecureDefaults: true, env }))
    expect(result.outcome).toBe('warn')
    expect(result.offenders).toEqual(['SCANTOR_MONGO_EXPRESS_SECRET'])
  })

  it('only reports development secrets in a local deployment', () => {
    const result = evaluateStartupGuard(input({ env: { SCANTOR_SECRET: 'scantor-secret-insecure-dev' } }))
    expect(result.outcome).toBe('development')
    expect(result.publicMode).toBe(false)
  })

  it('always refuses a same-origin editor URL, even with the allow flag', () => {
    const result = evaluateStartupGuard(input({ editorUrl: 'http://localhost:3000/', allowInsecureDefaults: true }))
    expect(result.outcome).toBe('abort')
    expect(result.sameOrigin).toBe(true)
  })

  it('names variables but never values', () => {
    const secret = 'super-secret-value-insecure-dev'
    const result = evaluateStartupGuard(input({ publicUrl: 'https://scantor.example.com', env: { ...strongEnv(), SCANTOR_SECRET: secret } }))
    expect(result.message).toContain('SCANTOR_SECRET')
    expect(result.message).not.toContain(secret)
  })
})
