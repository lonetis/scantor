import { describe, expect, it } from 'vitest'
import { LineCounter, uploadContentType, uploadKey } from '../../../server/services/uploads'
import { ApiError } from '../../../server/utils/errors'

// Uploaded list files (docs/api.md §4.9, docs/data-model.md §4.10).

describe('LineCounter', () => {
  it('counts non-empty lines across chunk boundaries', () => {
    const counter = new LineCounter()
    counter.update(Buffer.from('a.example\n\n  \nb.exa'))
    counter.update(Buffer.from('mple\r\n\t\nc'))
    expect(counter.finish()).toBe(3)
  })

  it('counts nothing for blank content', () => {
    const counter = new LineCounter()
    counter.update(Buffer.from('\n \n\r\n'))
    expect(counter.finish()).toBe(0)
  })
})

describe('uploads', () => {
  it('accepts text/plain and application/octet-stream only', () => {
    expect(uploadContentType('text/plain; charset=utf-8')).toBe('text/plain')
    expect(uploadContentType('application/octet-stream')).toBe('application/octet-stream')
    expect(() => uploadContentType('application/json')).toThrow(ApiError)
    expect(() => uploadContentType(undefined)).toThrow(ApiError)
  })

  it('keys uploads by owner and content hash', () => {
    expect(uploadKey('u1', 'ab12')).toBe('uploads/u1/ab12')
  })
})
