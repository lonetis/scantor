import { describe, expect, it } from 'vitest'
import { REDACTED, redactHeaders, redactText, redactValue } from '../../server/utils/redact'

// Log redaction (security.md MC-10).

describe('redactText', () => {
  it.each([
    [`key sk_scantor_${'a'.repeat(64)} used`, 'key sk_scantor_*** used'],
    [`sk_scantor_editor_${'B'.repeat(64)}`, 'sk_scantor_editor_***'],
    ['node snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9', 'node snt_***'],
    ['swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.ACEmTne4QDhTRflNR1PMDQLcKmqT5ax1LLY_r3I136M', 'swt_***'],
    ['setup sst_abcDEF123_-', 'setup sst_***'],
    ['spk_abc spk', 'spk_*** spk'],
    ['sic_abcdef', 'sic_***'],
    ['code sec_abcdef', 'code sec_***'],
    ['amqps://scan-1:p4ss@rabbitmq:5671', 'amqps://scan-1:***@rabbitmq:5671'],
    ['mongodb://scantor:secret@mongo:27017/?replicaSet=rs0', 'mongodb://scantor:***@mongo:27017/?replicaSet=rs0'],
    ['https://s3/x?X-Amz-Signature=abcdef&X-Amz-Date=1', 'https://s3/x?X-Amz-Signature=***&X-Amz-Date=1'],
    ['open https://x/setup?token=sst_abc to start', 'open https://x/setup?token=*** to start'],
    ['Authorization: Bearer abc.def', 'Authorization: Bearer ***'],
    ['http.extraheader=Authorization: Basic dXNlcjp0b2tlbg==', 'http.extraheader=Authorization: Basic ***'],
  ])('%s', (input, expected) => {
    expect(redactText(input)).toBe(expected)
  })

  it('leaves ordinary text alone', () => {
    expect(redactText('scan 5e1f0c2d started on node builtin')).toBe('scan 5e1f0c2d started on node builtin')
  })
})

describe('redactHeaders and redactValue', () => {
  it('replaces sensitive header values', () => {
    expect(redactHeaders({ Authorization: 'Bearer x', 'x-api-key': 'k', cookie: 'c', 'content-type': 'application/json' })).toEqual({
      Authorization: REDACTED,
      'x-api-key': REDACTED,
      cookie: REDACTED,
      'content-type': 'application/json',
    })
  })

  it('redacts nested values and sensitive keys', () => {
    const value = { headers: { 'X-Scantor-Setup-Token': 'sst_x' }, list: ['snt_abc', 1], when: new Date(0) }
    expect(redactValue(value)).toEqual({ headers: { 'X-Scantor-Setup-Token': REDACTED }, list: ['snt_***', 1], when: new Date(0) })
  })

  it('bounds depth', () => {
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let index = 0; index < 10; index++) deep = { next: deep }
    expect(JSON.stringify(redactValue(deep))).toContain('[depth limit]')
  })
})
