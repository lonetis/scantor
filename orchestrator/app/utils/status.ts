// Status colors, icons and labels for every state machine of the data model
// (docs/data-model.md §6, docs/ui.md §10). Components never pick status colors themselves.

export type StatusColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export type StatusKind =
  | 'scan'
  | 'scheduling'
  | 'analysis'
  | 'revision'
  | 'testRun'
  | 'worker'
  | 'node'
  | 'export'
  | 'job'
  | 'editor'
  | 'conditionSeverity'
  | 'eventLevel'

export interface StatusMeta {
  color: StatusColor
  icon: string
  /** Always the state value itself, so a badge never relies on color alone. */
  label: string
  /** Pulsing indicator (rendered with `motion-safe:`). */
  pulse: boolean
}

interface StatusStyle {
  color: StatusColor
  icon: string
  pulse?: boolean
}

const STATUS_STYLES = {
  scan: {
    creating: { color: 'info', icon: 'i-lucide-loader-circle' },
    running: { color: 'success', icon: 'i-lucide-circle-play', pulse: true },
    paused: { color: 'warning', icon: 'i-lucide-circle-pause' },
    completed: { color: 'primary', icon: 'i-lucide-circle-check' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
    cancelled: { color: 'neutral', icon: 'i-lucide-ban' },
    deleting: { color: 'neutral', icon: 'i-lucide-trash-2' },
    deleted: { color: 'neutral', icon: 'i-lucide-trash' },
  },
  scheduling: {
    pending: { color: 'neutral', icon: 'i-lucide-clock' },
    running: { color: 'info', icon: 'i-lucide-loader-circle' },
    done: { color: 'success', icon: 'i-lucide-circle-check' },
    retrying: { color: 'warning', icon: 'i-lucide-rotate-cw' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
  },
  analysis: {
    pending: { color: 'neutral', icon: 'i-lucide-clock' },
    retrying: { color: 'warning', icon: 'i-lucide-rotate-cw' },
    succeeded: { color: 'success', icon: 'i-lucide-circle-check' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
    lost: { color: 'warning', icon: 'i-lucide-circle-help' },
    cancelled: { color: 'neutral', icon: 'i-lucide-ban' },
  },
  revision: {
    queued: { color: 'neutral', icon: 'i-lucide-clock' },
    building: { color: 'info', icon: 'i-lucide-loader-circle' },
    ready: { color: 'success', icon: 'i-lucide-circle-check' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
  },
  testRun: {
    queued: { color: 'neutral', icon: 'i-lucide-clock' },
    building: { color: 'info', icon: 'i-lucide-loader-circle' },
    running: { color: 'info', icon: 'i-lucide-circle-play' },
    completed: { color: 'success', icon: 'i-lucide-circle-check' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
    cancelled: { color: 'neutral', icon: 'i-lucide-ban' },
  },
  worker: {
    pending: { color: 'warning', icon: 'i-lucide-clock' },
    assigned: { color: 'info', icon: 'i-lucide-circle-dot' },
    pulling: { color: 'info', icon: 'i-lucide-download' },
    starting: { color: 'info', icon: 'i-lucide-loader-circle' },
    running: { color: 'success', icon: 'i-lucide-circle-play', pulse: true },
    backoff: { color: 'error', icon: 'i-lucide-rotate-ccw' },
    draining: { color: 'warning', icon: 'i-lucide-circle-pause' },
    stopped: { color: 'neutral', icon: 'i-lucide-circle-stop' },
    lost: { color: 'error', icon: 'i-lucide-circle-help' },
  },
  node: {
    pending: { color: 'neutral', icon: 'i-lucide-clock' },
    online: { color: 'success', icon: 'i-lucide-server', pulse: true },
    offline: { color: 'error', icon: 'i-lucide-server-off' },
    revoked: { color: 'neutral', icon: 'i-lucide-shield-off' },
  },
  export: {
    queued: { color: 'neutral', icon: 'i-lucide-clock' },
    running: { color: 'info', icon: 'i-lucide-loader-circle' },
    ready: { color: 'success', icon: 'i-lucide-circle-check' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
    cancelled: { color: 'neutral', icon: 'i-lucide-ban' },
  },
  job: {
    queued: { color: 'neutral', icon: 'i-lucide-clock' },
    running: { color: 'info', icon: 'i-lucide-loader-circle' },
    succeeded: { color: 'success', icon: 'i-lucide-circle-check' },
    failed: { color: 'error', icon: 'i-lucide-circle-x' },
    cancelled: { color: 'neutral', icon: 'i-lucide-ban' },
  },
  editor: {
    starting: { color: 'info', icon: 'i-lucide-loader-circle' },
    running: { color: 'success', icon: 'i-lucide-circle-play', pulse: true },
    stopping: { color: 'warning', icon: 'i-lucide-circle-pause' },
    stopped: { color: 'neutral', icon: 'i-lucide-circle-stop' },
  },
  conditionSeverity: {
    info: { color: 'info', icon: 'i-lucide-info' },
    warning: { color: 'warning', icon: 'i-lucide-triangle-alert' },
    error: { color: 'error', icon: 'i-lucide-circle-alert' },
  },
  eventLevel: {
    info: { color: 'info', icon: 'i-lucide-info' },
    warning: { color: 'warning', icon: 'i-lucide-triangle-alert' },
    error: { color: 'error', icon: 'i-lucide-circle-alert' },
  },
} satisfies Record<StatusKind, Record<string, StatusStyle>>

const UNKNOWN_STYLE: StatusStyle = { color: 'neutral', icon: 'i-lucide-circle-dashed' }

/** Every state of every kind, in state-machine order (filters, tests). */
export const STATUS_STATES = Object.fromEntries(
  Object.entries(STATUS_STYLES).map(([kind, styles]) => [kind, Object.keys(styles)]),
) as unknown as Readonly<Record<StatusKind, readonly string[]>>

export function statusMeta(kind: StatusKind, state: string | null | undefined): StatusMeta {
  const value = state ?? 'unknown'
  const styles: Record<string, StatusStyle> = STATUS_STYLES[kind]
  const style = Object.hasOwn(styles, value) ? styles[value]! : UNKNOWN_STYLE
  return { color: style.color, icon: style.icon, label: value, pulse: style.pulse ?? false }
}

/** Condition severity sort order: errors first. */
export function severityRank(severity: string): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2
}
