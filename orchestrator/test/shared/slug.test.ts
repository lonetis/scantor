import { describe, expect, it } from 'vitest'
import { isUuid, isValidTaskName, taskNameProblem } from '#shared/utils/slug'

// Task names (docs/data-model.md §4.1, docs/api.md §1.4).

describe('task names', () => {
  it.each(['echo', 'a', 'http-title', 'a1-b2', 'x'.repeat(64)])('%s is valid', (name) => {
    expect(isValidTaskName(name)).toBe(true)
    expect(taskNameProblem(name)).toBeNull()
  })

  it.each(['', 'Echo', '-echo', 'echo-', 'echo_1', 'x'.repeat(65), 'upload', 'import-git', 'new', 'latest', '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'])(
    '%j is invalid',
    (name) => {
      expect(isValidTaskName(name)).toBe(false)
      expect(taskNameProblem(name)).not.toBeNull()
    },
  )

  it('recognises uuids', () => {
    expect(isUuid('7F3B2C1A-9D4E-4F6A-8B2C-1D3E5F7A9B0C')).toBe(true)
    expect(isUuid('7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0')).toBe(false)
  })
})
