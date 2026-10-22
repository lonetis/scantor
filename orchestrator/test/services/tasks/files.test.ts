import { describe, expect, it } from 'vitest'
import { taskPathProblem } from '../../../server/services/tasks/files'
import { readRepoFile } from '../../helpers/repo'

// The path pre-check of the file routes against the shared corpus (docs/editor.md §9.5, security.md WS-3). The
// helper is authoritative; the orchestrator must never accept a path the corpus marks invalid.

interface PathCase {
  path?: string
  pathBase64?: string
  valid: boolean
}

const corpus = JSON.parse(readRepoFile('tests/corpora/paths/cases.json')) as { paths: PathCase[] }
const cases = corpus.paths.filter((entry): entry is PathCase & { path: string } => typeof entry.path === 'string')

describe('taskPathProblem', () => {
  it.each(cases.map((entry) => [JSON.stringify(entry.path).slice(0, 60), entry] as const))('%s', (_label, entry) => {
    expect(taskPathProblem(entry.path) === null).toBe(entry.valid)
  })

  it('allows the task root only where an operation addresses it', () => {
    expect(taskPathProblem('', true)).toBeNull()
    expect(taskPathProblem('')).not.toBeNull()
  })
})
