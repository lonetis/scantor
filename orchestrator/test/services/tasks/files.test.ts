import { describe, expect, it } from 'vitest'
import { writeTaskFilesBody } from '#shared/schemas/tasks'
import { taskPathProblem, writeTaskFiles } from '../../../server/services/tasks/files'
import type { TaskDoc } from '../../../server/types/documents'
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

describe('writeTaskFiles', () => {
  it('answers an empty file path with 422 invalidPath, before any helper runs', async () => {
    // The body schema leaves the keys to the path rules, so the empty path is not a validation failure.
    const body = writeTaskFilesBody.parse({ files: { '': 'x', 'main.py': 'print(1)\n' } })
    const task = { _id: 't1', userId: 'u1', name: 'echo' } as TaskDoc
    await expect(writeTaskFiles(task, body.files)).rejects.toMatchObject({ code: 'invalidPath', statusCode: 422, details: { path: '' } })
  })
})
