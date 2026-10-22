import { isIPv4 } from 'node:net'

// Startup guard, security.md §6.11 CFG-2 (authoritative algorithm). Pure: the caller passes the effective URLs
// and addresses from the parsed configuration plus the whole environment for the `-insecure-dev` suffix scan.
// Only variable names ever leave this module, never values.

export const INSECURE_SUFFIX = '-insecure-dev'
export const MIN_SECRET_LENGTH = 16

const CORE_SECRETS = [
  'SCANTOR_SECRET',
  'SCANTOR_MONGO_PASSWORD',
  'SCANTOR_RABBITMQ_PASSWORD',
  'SCANTOR_S3_SECRET_KEY',
  'SCANTOR_MONGO_EXPRESS_PASSWORD',
  'SCANTOR_MONGO_EXPRESS_SECRET',
] as const

export interface StartupGuardInput {
  publicUrl: string
  editorUrl: string
  bindAddress: string
  adminBindAddress: string
  composeProfiles: string[]
  exposeMongo: boolean
  allowInsecureDefaults: boolean
  env: Record<string, string | undefined>
}

export type StartupGuardOutcome =
  /** nothing to report */
  | 'ok'
  /** development secrets in a local deployment: log at info */
  | 'development'
  /** insecure secrets in a public deployment, allowed by SCANTOR_ALLOW_INSECURE_DEFAULTS: warn per name */
  | 'warn'
  /** refuse to start */
  | 'abort'

export interface StartupGuardResult {
  outcome: StartupGuardOutcome
  publicMode: boolean
  /** SCANTOR_EDITOR_URL has the same origin as SCANTOR_PUBLIC_URL (always fatal) */
  sameOrigin: boolean
  /** names of offending variables, sorted */
  offenders: string[]
  /** a log message naming variables only */
  message: string
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function inLoopbackV4(address: string): boolean {
  return isIPv4(address) && address.split('.')[0] === '127'
}

export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host.toLowerCase())
  return h === 'localhost' || h.endsWith('.localhost') || inLoopbackV4(h) || h === '::1'
}

export function isLoopbackAddress(address: string): boolean {
  const a = stripBrackets(address.trim())
  return inLoopbackV4(a) || a === '::1'
}

export function evaluateStartupGuard(input: StartupGuardInput): StartupGuardResult {
  const publicUrl = new URL(input.publicUrl)
  const editorUrl = new URL(input.editorUrl)

  if (publicUrl.origin === editorUrl.origin) {
    return {
      outcome: 'abort',
      publicMode: false,
      sameOrigin: true,
      offenders: [],
      message: 'SCANTOR_EDITOR_URL must have its own origin (it equals the origin of SCANTOR_PUBLIC_URL)',
    }
  }

  const publicMode =
    !isLoopbackHost(publicUrl.hostname) ||
    !isLoopbackHost(editorUrl.hostname) ||
    input.composeProfiles.includes('traefik') ||
    !isLoopbackAddress(input.bindAddress) ||
    !isLoopbackAddress(input.adminBindAddress)

  const offenders = new Set<string>()
  for (const [name, value] of Object.entries(input.env)) {
    if (typeof value === 'string' && value.endsWith(INSECURE_SUFFIX)) offenders.add(name)
  }
  const coreSecrets: string[] = [...CORE_SECRETS]
  if (input.exposeMongo) coreSecrets.push('SCANTOR_MONGO_ANALYTICS_PASSWORD')
  for (const name of coreSecrets) {
    if ((input.env[name] ?? '').length < MIN_SECRET_LENGTH) offenders.add(name)
  }
  const adminPassword = input.env.SCANTOR_ADMIN_PASSWORD ?? ''
  if (adminPassword !== '' && adminPassword.length < MIN_SECRET_LENGTH) offenders.add('SCANTOR_ADMIN_PASSWORD')

  const names = [...offenders].sort()
  if (names.length === 0) {
    return { outcome: 'ok', publicMode, sameOrigin: false, offenders: [], message: '' }
  }
  if (!publicMode) {
    return {
      outcome: 'development',
      publicMode,
      sameOrigin: false,
      offenders: names,
      message: `development secrets in use: ${names.join(', ')}`,
    }
  }
  if (input.allowInsecureDefaults) {
    return {
      outcome: 'warn',
      publicMode,
      sameOrigin: false,
      offenders: names,
      message: `insecure secrets in a public deployment (allowed by SCANTOR_ALLOW_INSECURE_DEFAULTS): ${names.join(', ')}`,
    }
  }
  return {
    outcome: 'abort',
    publicMode,
    sameOrigin: false,
    offenders: names,
    message: `refusing to start: insecure secrets in a public deployment: ${names.join(', ')} (run \`just init\`)`,
  }
}
