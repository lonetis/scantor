import { randomBytes } from 'node:crypto'
import { workerIndex } from './env'

/**
 * A unique lowercase slug (≤ 64 characters) for names created by a test: `<prefix>-<worker>-<time>-<random>`
 * (docs/testing.md §7.8). The prefix should say what the object is for, for example `unique('echo')`.
 */
export function unique(prefix: string): string {
  const head = prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const tail = `${workerIndex()}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  return `${head.slice(0, 63 - tail.length)}-${tail}`
}
