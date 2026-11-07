import { describe, expect, it } from 'vitest'
import { buildNotificationMessage, type NotificationEvent, testNotificationMessage } from '../../../server/services/notifications/messages'

// The text of a notification (docs/api.md §4.3): title, body, priority by level, tags and the dashboard link.

const publicUrl = 'https://scantor.example.com'
const scanId = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const stats = { succeeded: 39811, failed: 102, lost: 0, cancelled: 0 }

function event(overrides: Partial<NotificationEvent>): NotificationEvent {
  return { id: 'e1', type: 'scan.stateChanged', level: 'info', message: 'scan running → completed (completed)', scanId, ...overrides }
}

describe('buildNotificationMessage', () => {
  it('summarises a completed scan and links to it', () => {
    const message = buildNotificationMessage('scanFinished', event({ data: { to: 'completed' } }), { publicUrl, scan: { name: 'tranco top 100k', stats } })
    expect(message).toEqual({
      title: 'Scan "tranco top 100k" completed',
      message: '39,811 succeeded, 102 failed.',
      priority: 3,
      tags: ['white_check_mark', 'scantor'],
      click: `${publicUrl}/scans/${scanId}`,
    })
    const withLost = buildNotificationMessage('scanFinished', event({ data: { to: 'completed' } }), {
      publicUrl,
      scan: { name: null, stats: { ...stats, lost: 3 } },
    })
    expect(withLost.title).toBe('Scan 5e1f0c2d completed')
    expect(withLost.message).toBe('39,811 succeeded, 102 failed, 3 lost.')
  })

  it('reports a failed or cancelled scan with the event message and its level', () => {
    const failed = buildNotificationMessage('scanFinished', event({ level: 'error', message: 'the schedule failed: boom', data: { to: 'failed' } }), {
      publicUrl,
      scan: null,
    })
    expect(failed).toMatchObject({ title: 'Scan 5e1f0c2d failed', message: 'the schedule failed: boom', priority: 5, tags: ['x', 'scantor'] })
    const cancelled = buildNotificationMessage('scanFinished', event({ message: 'stalled', data: { to: 'cancelled' } }), { publicUrl, scan: null })
    expect(cancelled.tags[0]).toBe('no_entry')
  })

  it('names the condition of a scan problem and the pause reason', () => {
    const problem = buildNotificationMessage(
      'scanProblem',
      event({ type: 'scan.conditionRaised', level: 'error', message: 'condition crashLoop: exit 137', data: { type: 'crashLoop' } }),
      { publicUrl, scan: { name: 'nightly', stats } },
    )
    expect(problem).toMatchObject({ title: 'Scan "nightly": crashLoop', message: 'condition crashLoop: exit 137', priority: 5, tags: ['warning', 'scantor'] })
    const paused = buildNotificationMessage('scanPaused', event({ level: 'warning', message: '40% of the last 20 attempts failed', data: { to: 'paused' } }), {
      publicUrl,
      scan: { name: 'nightly', stats },
    })
    expect(paused).toMatchObject({ title: 'Scan "nightly" paused', priority: 4, tags: ['pause_button', 'scantor'] })
  })

  it('links revisions and nodes to their pages', () => {
    const taskId = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
    const ready = buildNotificationMessage(
      'revisionBuilt',
      { id: 'e2', type: 'revision.ready', level: 'info', message: 'revision echo@3 is ready', taskId, data: { number: 3 } },
      { publicUrl, scan: null },
    )
    expect(ready).toEqual({
      title: 'Revision ready',
      message: 'revision echo@3 is ready',
      priority: 3,
      tags: ['package', 'scantor'],
      click: `${publicUrl}/tasks/${taskId}/revisions/3`,
    })
    const failed = buildNotificationMessage(
      'revisionBuilt',
      { id: 'e3', type: 'revision.failed', level: 'error', message: 'revision echo@4 failed: x', taskId },
      { publicUrl, scan: null },
    )
    expect(failed).toMatchObject({ title: 'Revision build failed', click: `${publicUrl}/tasks/${taskId}` })
    const offline = buildNotificationMessage(
      'nodeAvailability',
      { id: 'e4', type: 'node.offline', level: 'warning', message: 'node edge-1 sent no status for 60 s; 2 workers lost', nodeId: 'n1' },
      { publicUrl, scan: null },
    )
    expect(offline).toMatchObject({ title: 'Node offline', priority: 4, tags: ['red_circle', 'scantor'], click: `${publicUrl}/admin/nodes/n1` })
  })

  it('bounds long titles', () => {
    const message = buildNotificationMessage('scanPaused', event({ data: { to: 'paused' } }), { publicUrl, scan: { name: 'n'.repeat(500), stats } })
    expect(message.title.length).toBe(200)
    expect(message.title.endsWith('…')).toBe(true)
  })

  it('builds the test message', () => {
    expect(testNotificationMessage(publicUrl)).toEqual({
      title: 'scantor test notification',
      message: `Notifications of ${publicUrl} reach this topic.`,
      priority: 3,
      tags: ['bell', 'scantor'],
      click: publicUrl,
    })
  })
})
