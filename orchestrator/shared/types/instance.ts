import type { ToolTarget, UserRole } from '../utils/enums'

// Health, setup and instance information (docs/api.md §4.1, §4.2).

export type ComponentHealth = 'ok' | 'down'

export interface Health {
  status: 'ok' | 'degraded'
  version: string
  components: {
    mongo: ComponentHealth
    rabbitmq: ComponentHealth
    s3: ComponentHealth
    registry: ComponentHealth
  }
  alarms: string[]
}

export interface SetupStatus {
  needsSetup: boolean
  passkeysEnabled: boolean
  mcpUrl: string | null
}

export interface SetupPasskeyToken {
  token: string
  expiresIn: number
}

export interface InstanceFeatures {
  passkeys: boolean
  mcp: boolean
  mcpOAuth: boolean
  editor: boolean
}

export interface InstanceLimits {
  maxWorkersPerScan: number
  maxProcessesPerWorker: number
  maxResultBytes: number
  maxFileBytes: number
  scanConfirmThreshold: number
  waitMaxSeconds: number
}

export interface AdminToolItem {
  target: ToolTarget
  title: string
  url: string | null
}

export interface InstanceInfo {
  version: string
  publicUrl: string
  editorUrl: string
  mcpUrl: string | null
  registryPublicHost: string
  cliImage: string
  features: InstanceFeatures
  limits: InstanceLimits
  user: { id: string; role: UserRole }
  /** Present only for callers with effective admin power. */
  adminTools?: { enabled: boolean; items: AdminToolItem[] }
}
