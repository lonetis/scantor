import { describe, expect, it } from 'vitest'
import { updateNotificationSettingsBody } from '#shared/schemas/notifications'
import { NOTIFICATION_TRIGGER_INFO, NOTIFICATION_TRIGGERS } from '#shared/utils/notifications'

// The request schema of updateNotificationSettings (docs/api.md §4.3) and the trigger catalog.

const parse = (body: unknown) => updateNotificationSettingsBody.safeParse(body)

function paths(body: unknown): string[] {
  const result = parse(body)
  return result.success ? [] : result.error.issues.map((issue) => [...issue.path, ...(issue.code === 'unrecognized_keys' ? issue.keys : [])].join('.'))
}

describe('updateNotificationSettingsBody', () => {
  it('accepts partial updates and null to clear the topic or the token', () => {
    expect(parse({}).success).toBe(true)
    expect(parse({ ntfy: {} }).success).toBe(true)
    expect(parse({ ntfy: { enabled: true, topic: ' scantor_alerts-1 ', token: 'tk_AbC123', triggers: ['scanFinished', 'revisionBuilt'] } }).data).toEqual({
      ntfy: { enabled: true, topic: 'scantor_alerts-1', token: 'tk_AbC123', triggers: ['scanFinished', 'revisionBuilt'] },
    })
    expect(parse({ ntfy: { topic: null, token: null } }).data).toEqual({ ntfy: { topic: null, token: null } })
  })

  it('rejects bad topics, tokens, triggers and unknown fields', () => {
    expect(paths({ ntfy: { topic: '' } })).toEqual(['ntfy.topic'])
    expect(paths({ ntfy: { topic: 'a/b' } })).toEqual(['ntfy.topic'])
    expect(paths({ ntfy: { topic: 'x'.repeat(65) } })).toEqual(['ntfy.topic'])
    expect(paths({ ntfy: { token: 'has space' } })).toEqual(['ntfy.token'])
    expect(paths({ ntfy: { token: 'x'.repeat(257) } })).toEqual(['ntfy.token'])
    expect(paths({ ntfy: { triggers: ['scanFinished', 'scanFinished'] } })).toEqual(['ntfy.triggers'])
    expect(paths({ ntfy: { triggers: ['everything'] } })).toEqual(['ntfy.triggers.0'])
    expect(paths({ ntfy: { server: 'http://169.254.169.254' } })).toEqual(['ntfy.server'])
    expect(paths({ webhook: {} })).toEqual(['webhook'])
  })
})

describe('notification triggers', () => {
  it('describes every trigger', () => {
    for (const trigger of NOTIFICATION_TRIGGERS) {
      expect(NOTIFICATION_TRIGGER_INFO[trigger].title.length, trigger).toBeGreaterThan(0)
      expect(NOTIFICATION_TRIGGER_INFO[trigger].description.length, trigger).toBeGreaterThan(0)
    }
  })
})
