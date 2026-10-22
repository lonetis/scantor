import { describe, expect, it } from 'vitest'
import { checkHelperResult, HelperError, mapHelperError, parseHelperStderr, parseHelperStdout, scrubMessage } from '../../../server/services/helpers/protocol'

// The helper I/O protocol and its error mapping (docs/editor.md §9.3).

describe('parseHelperStderr', () => {
  it('collects logs, the snapshot summary and the final error; ignores other lines', () => {
    const stderr = [
      '{"type":"log","level":"info","msg":"extracting"}',
      'not json',
      '{"type":"summary","packSha256":"ab","packBytes":10,"fileCount":2,"bytes":30}',
      '{"type":"error","error":{"code":"invalidPath","message":"bad","path":"../x"}}',
    ].join('\n')
    expect(parseHelperStderr(stderr)).toEqual({
      logs: [{ level: 'info', msg: 'extracting' }],
      summary: { packSha256: 'ab', packBytes: 10, fileCount: 2, bytes: 30 },
      error: { code: 'invalidPath', message: 'bad', path: '../x', details: undefined },
    })
  })
})

describe('mapHelperError', () => {
  it.each([
    ['invalidPath', 'invalidPath'],
    ['invalidArgument', 'badRequest'],
    ['tooManyFiles', 'payloadTooLarge'],
    ['tooLarge', 'payloadTooLarge'],
    ['workspaceFull', 'payloadTooLarge'],
    ['notFound', 'notFound'],
    ['exists', 'alreadyExists'],
    ['manifestInvalid', 'manifestInvalid'],
    ['workspaceDirty', 'workspaceDirty'],
    ['gitFailed', 'gitFailed'],
    ['gitDiverged', 'gitDiverged'],
    ['internal', 'internal'],
    ['somethingNew', 'internal'],
  ])('%s → %s', (helperCode, apiCode) => {
    expect(mapHelperError('extract', { code: helperCode, message: 'm' }).code).toBe(apiCode)
  })

  it('keeps path, limits and manifest errors as details', () => {
    expect(mapHelperError('read', { code: 'invalidPath', message: 'm', path: 'a/../b' }).details).toEqual({ path: 'a/../b' })
    expect(mapHelperError('extract', { code: 'tooLarge', message: 'm', details: { limit: 5, actual: 9 } }).details).toEqual({ limit: 5, actual: 9 })
    const errors = [{ phase: 'static', file: 'scantor.yaml', line: 2, message: 'bad' }]
    expect(mapHelperError('extract', { code: 'manifestInvalid', message: 'm', details: { errors } }).details).toEqual({ errors })
  })

  it('never leaks internal messages', () => {
    expect(mapHelperError('commit', { code: 'internal', message: 'open /workspace/x: permission denied' }).message).toBe('workspace commit failed')
  })

  it('redacts git credentials from messages', () => {
    const mapped = mapHelperError('git-clone', { code: 'gitFailed', message: 'fatal: auth failed for token ghp_supersecret' }, ['ghp_supersecret'])
    expect(mapped.message).not.toContain('ghp_supersecret')
    expect(mapped.details).toEqual({ message: mapped.message })
    expect(scrubMessage('x abcd y', ['abcd'])).toBe('x *** y')
  })
})

describe('checkHelperResult', () => {
  it('passes exit 0, maps exit 1 with an error line and treats everything else as internal', () => {
    expect(checkHelperResult('list', { exitCode: 0, stdout: Buffer.from('{}'), stderr: '' }).error).toBeNull()
    const userError = () => checkHelperResult('list', { exitCode: 1, stdout: Buffer.alloc(0), stderr: '{"type":"error","error":{"code":"notFound","message":"no such task"}}' })
    expect(userError).toThrow(HelperError)
    try {
      userError()
    } catch (error) {
      expect((error as HelperError).code).toBe('notFound')
      expect((error as HelperError).helperCode).toBe('notFound')
      expect((error as HelperError).statusCode).toBe(404)
    }
    for (const exitCode of [1, 2, 137]) {
      try {
        checkHelperResult('snapshot', { exitCode, stdout: Buffer.alloc(0), stderr: 'panic' })
        expect.unreachable()
      } catch (error) {
        expect((error as HelperError).code).toBe('internal')
      }
    }
  })

  it('parses the stdout document', () => {
    expect(parseHelperStdout('list', { exitCode: 0, stdout: Buffer.from('{"entries":[],"truncated":false}\n'), stderr: '' })).toEqual({ entries: [], truncated: false })
    expect(() => parseHelperStdout('list', { exitCode: 0, stdout: Buffer.from(''), stderr: '' })).toThrow(HelperError)
  })
})
