import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import type { JobContext } from '../../../server/utils/jobs'
import { useLogger } from '../../../server/utils/logger'
import { registerUserPurgeStep, resetUserPurgeSteps, userPurgeSteps } from '../../../server/utils/user-purge'

// The userPurge job (docs/data-model.md §5): registered steps run in order and a restarted job resumes at the step
// recorded in its cursor.

vi.mock('../../../server/utils/users', () => ({ deleteAuthUser: vi.fn() }))
vi.mock('../../../server/utils/s3', () => ({ deletePrefix: vi.fn() }))
vi.mock('../../../server/utils/mongo', () => ({ useCollections: vi.fn() }))

const { userPurgeJobKind } = await import('../../../server/services/jobs/user-purge')

function purgeJob(cursor: Record<string, unknown> = {}, subjectKind: JobDoc['subject']['kind'] = 'user'): JobDoc {
  return { _id: 'job-1', kind: 'userPurge', subject: { kind: subjectKind, id: 'user-1' }, cursor } as JobDoc
}

function context(job: JobDoc) {
  const cursors: Record<string, unknown>[] = []
  const ctx: JobContext = {
    job,
    log: useLogger('test'),
    config: {} as Config,
    signal: new AbortController().signal,
    saveCursor: async (cursor) => {
      cursors.push(cursor)
    },
    setProgress: async () => {},
  }
  return { ctx, cursors }
}

let ran: string[]

beforeEach(() => {
  resetUserPurgeSteps()
  ran = []
  for (const [name, order] of [
    ['jobs', 120],
    ['scans', 40],
    ['tasks', 70],
    ['user', 1000],
  ] as const) {
    registerUserPurgeStep({
      name,
      order,
      async run({ userId }) {
        ran.push(`${name}:${userId}`)
      },
    })
  }
})

describe('user purge steps', () => {
  it('orders registered steps and refuses duplicates', () => {
    expect(userPurgeSteps().map((step) => step.name)).toEqual(['scans', 'tasks', 'jobs', 'user'])
    expect(() => registerUserPurgeStep({ name: 'tasks', order: 1, run: async () => {} })).toThrow()
  })

  it('runs every step in order and records each in the cursor', async () => {
    const job = purgeJob()
    const { ctx, cursors } = context(job)
    await userPurgeJobKind.handler(job, ctx)
    expect(ran).toEqual(['scans:user-1', 'tasks:user-1', 'jobs:user-1', 'user:user-1'])
    expect(cursors).toEqual([{ step: 'scans' }, { step: 'tasks' }, { step: 'jobs' }, { step: 'user' }])
  })

  it('resumes at the recorded step', async () => {
    const job = purgeJob({ step: 'jobs' })
    await userPurgeJobKind.handler(job, context(job).ctx)
    expect(ran).toEqual(['jobs:user-1', 'user:user-1'])
  })

  it('rejects a job without a user subject', async () => {
    const job = purgeJob({}, 'scan')
    await expect(userPurgeJobKind.handler(job, context(job).ctx)).rejects.toMatchObject({ name: 'FatalJobError' })
  })

  it('runs in the reconciler component, one at a time', () => {
    expect(userPurgeJobKind.component).toBe('reconciler')
    expect(userPurgeJobKind.concurrency).toBe(1)
  })
})
