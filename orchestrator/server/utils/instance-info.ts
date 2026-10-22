import type { AdminToolItem, InstanceInfo } from '#shared/types/instance'
import { TOOL_TARGETS, type ToolTarget } from '#shared/utils/enums'
import { resolveMcpConfig, resolvePasskeyConfig } from './auth-policy'
import type { Config } from './config'
import type { UserPrincipal } from './principal'
import { clientImageTag, scantorVersion } from './version'

// `GET /api/info` (docs/api.md §4.1): everything instance-specific the SPA and the CLI need. Secrets are never
// part of it (security.md SEC-7).

export const WAIT_MAX_SECONDS = 120

export const TOOL_TITLES: Record<ToolTarget, string> = {
  rabbitmq: 'RabbitMQ management',
  'mongo-express': 'mongo-express',
  rustfs: 'RustFS console',
  traefik: 'Traefik dashboard',
}

/** The fixed Traefik tool hosts and paths of docs/auth.md §11. */
export const TOOL_PATHS: Record<ToolTarget, string> = {
  rabbitmq: '/',
  'mongo-express': '/',
  rustfs: '/rustfs/console/',
  traefik: '/dashboard/',
}

/** `<scheme>://<target>.<domain>[:<port>]<path>` with the scheme and port of SCANTOR_PUBLIC_URL. */
export function toolUrl(config: Pick<Config, 'publicUrl' | 'domain'>, target: ToolTarget): string | null {
  if (!config.domain) return null
  const publicUrl = new URL(config.publicUrl)
  const port = publicUrl.port ? `:${publicUrl.port}` : ''
  return `${publicUrl.protocol}//${target}.${config.domain}${port}${TOOL_PATHS[target]}`
}

export function buildInstanceInfo(config: Config, principal: UserPrincipal): InstanceInfo {
  const mcp = resolveMcpConfig(config)
  const info: InstanceInfo = {
    version: scantorVersion,
    publicUrl: config.publicUrl,
    editorUrl: config.editorUrl,
    mcpUrl: mcp.enabled ? mcp.resource : null,
    registryPublicHost: config.registryPublicHost,
    cliImage: `${config.imagePrefix}scantor:${clientImageTag(scantorVersion, config.imageTag)}`,
    features: {
      passkeys: resolvePasskeyConfig(config).enabled,
      mcp: mcp.enabled,
      mcpOAuth: mcp.oauth,
      editor: config.components.includes('api'),
    },
    limits: {
      maxWorkersPerScan: config.maxWorkersPerScan,
      maxProcessesPerWorker: config.maxProcessesPerWorker,
      maxResultBytes: config.maxResultBytes,
      maxFileBytes: config.maxFileBytes,
      scanConfirmThreshold: config.scanConfirmThreshold,
      waitMaxSeconds: WAIT_MAX_SECONDS,
    },
    user: { id: principal.user.id, role: principal.user.role },
  }
  if (principal.isAdmin) {
    const items: AdminToolItem[] = TOOL_TARGETS.map((target) => ({ target, title: TOOL_TITLES[target], url: toolUrl(config, target) }))
    info.adminTools = { enabled: config.domain !== null, items }
  }
  return info
}
