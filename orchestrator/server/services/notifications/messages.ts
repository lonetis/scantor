import type { EventLevel } from '#shared/utils/enums'
import type { NotificationTrigger } from '#shared/utils/notifications'
import type { NtfyMessage, NtfyPriority } from './ntfy'

/*
 * The text of a notification (docs/api.md §4.3): a title naming the subject, the event's message (or a result
 * summary for a completed scan), a priority by the event's level, emoji tags and a link into the dashboard. Pure, so
 * the job looks the subject up first and passes it in.
 */

/** The event fields a notification job carries (its params; docs/data-model.md §4.12). */
export interface NotificationEvent {
  id: string
  type: string
  level: EventLevel
  message: string
  scanId?: string
  taskId?: string
  revisionId?: string
  scriptId?: string
  scriptRunId?: string
  nodeId?: string
  data?: Record<string, unknown>
}

export interface ScanSubject {
  name: string | null
  stats: { succeeded: number; failed: number; lost: number; cancelled: number }
}

export interface MessageContext {
  /** SCANTOR_PUBLIC_URL */
  publicUrl: string
  /** the event's scan, when it still exists */
  scan: ScanSubject | null
}

export const LEVEL_PRIORITY: Record<EventLevel, NtfyPriority> = { info: 3, warning: 4, error: 5 }
const TAG = 'scantor'
const MAX_TITLE_LENGTH = 200

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function scanLabel(event: NotificationEvent, scan: ScanSubject | null): string {
  if (scan?.name) return `Scan "${scan.name}"`
  return `Scan ${(event.scanId ?? '').slice(0, 8)}`
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString('en-US')} ${noun}`
}

function completedSummary(scan: ScanSubject | null): string {
  if (!scan) return 'The scan completed.'
  const parts = [count(scan.stats.succeeded, 'succeeded'), count(scan.stats.failed, 'failed')]
  if (scan.stats.lost > 0) parts.push(count(scan.stats.lost, 'lost'))
  return `${parts.join(', ')}.`
}

const SCAN_STATE_TAGS: Record<string, string> = { completed: 'white_check_mark', failed: 'x', cancelled: 'no_entry', paused: 'pause_button' }

export function buildNotificationMessage(trigger: NotificationTrigger, event: NotificationEvent, context: MessageContext): NtfyMessage {
  const priority = LEVEL_PRIORITY[event.level]
  const base = context.publicUrl
  const scanClick = event.scanId ? `${base}/scans/${event.scanId}` : base
  let message: Omit<NtfyMessage, 'priority'>
  switch (trigger) {
    case 'scanFinished': {
      const to = String(event.data?.to ?? 'finished')
      message = {
        title: `${scanLabel(event, context.scan)} ${to}`,
        message: to === 'completed' ? completedSummary(context.scan) : event.message,
        tags: [SCAN_STATE_TAGS[to] ?? 'information_source', TAG],
        click: scanClick,
      }
      break
    }
    case 'scanPaused':
      message = { title: `${scanLabel(event, context.scan)} paused`, message: event.message, tags: [SCAN_STATE_TAGS.paused!, TAG], click: scanClick }
      break
    case 'scanProblem':
      message = {
        title: `${scanLabel(event, context.scan)}: ${String(event.data?.type ?? 'problem')}`,
        message: event.message,
        tags: ['warning', TAG],
        click: scanClick,
      }
      break
    case 'revisionBuilt': {
      const ready = event.type === 'revision.ready'
      const number = event.data?.number
      const taskUrl = event.taskId ? `${base}/tasks/${event.taskId}` : base
      message = {
        title: ready ? 'Revision ready' : 'Revision build failed',
        message: event.message,
        tags: [ready ? 'package' : 'x', TAG],
        click: event.taskId && typeof number === 'number' ? `${taskUrl}/revisions/${number}` : taskUrl,
      }
      break
    }
    case 'scriptRunCompleted':
    case 'scriptRunFailed': {
      const completed = trigger === 'scriptRunCompleted'
      const scriptName = typeof event.data?.scriptName === 'string' ? event.data.scriptName : 'script'
      const scriptUrl = event.scriptId ? `${base}/scripts/${event.scriptId}` : `${base}/scripts`
      message = {
        title: `Script run of "${scriptName}" ${completed ? 'completed' : 'failed'}`,
        message: event.message,
        tags: [completed ? 'white_check_mark' : 'x', TAG],
        click: event.scriptId && event.scriptRunId ? `${scriptUrl}/runs/${event.scriptRunId}` : scriptUrl,
      }
      break
    }
    case 'nodeAvailability': {
      const offline = event.type === 'node.offline'
      message = {
        title: offline ? 'Node offline' : 'Node online',
        message: event.message,
        tags: [offline ? 'red_circle' : 'green_circle', TAG],
        click: event.nodeId ? `${base}/admin/nodes/${event.nodeId}` : `${base}/admin/nodes`,
      }
      break
    }
  }
  return { ...message, title: truncate(message.title, MAX_TITLE_LENGTH), priority }
}

export function testNotificationMessage(publicUrl: string): NtfyMessage {
  return {
    title: 'scantor test notification',
    message: `Notifications of ${publicUrl} reach this topic.`,
    priority: LEVEL_PRIORITY.info,
    tags: ['bell', TAG],
    click: publicUrl,
  }
}
