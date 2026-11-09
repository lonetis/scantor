import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, ScriptDoc, ScriptRunDoc } from '../../../server/types/documents'
import type { Config } from '../../../server/utils/config'
import type { JobContext } from '../../../server/utils/jobs'
import { useLogger } from '../../../server/utils/logger'
import type { UserPurgeContext } from '../../../server/utils/user-purge'
import { FakeCollection } from '../../helpers/fake-collection'

// Script deletion (docs/scripts.md, docs/data-model.md §4.12 `scriptDelete`): the request hides the script and creates
// the job; the job cancels active runs and defers until their jobs ended, then deletes the runs' data, the images, the
// folder and the document, resuming at the phase of its cursor; a run started after the stop phase sends it back. The
// user purge step 65 does the same for all scripts of a user. The script-run cleanup is a test double here.

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts', [{ keys: ['userId', 'name'] }]),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
  jobs: new FakeCollection<JobDoc>('jobs', [{ keys: ['kind', 'subject.id'], partialFilter: { active: true } }]),
}
const effects: string[] = []
const runs = { toCancel: 0, activeJobs: 0 }

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/services/script-runs/cleanup', () => ({
  cancelActiveScriptRuns: async (filter: Record<string, string>, reason: string) => {
    effects.push(`cancel:${JSON.stringify(filter)}:${reason}`)
    const cancelled = runs.toCancel
    runs.toCancel = 0
    return cancelled
  },
  countActiveScriptRunJobs: async () => runs.activeJobs,
  deleteScriptRunsData: async (filter: { scriptId?: string; userId?: string }) => {
    effects.push(`runs:${JSON.stringify(filter)}`)
    await store.scriptRuns.deleteMany(filter)
  },
  removeScriptImages: async (scriptId: string) => {
    effects.push(`images:${scriptId}`)
  },
}))
vi.mock('../../../server/services/script-runs/mappers', () => ({ toScriptRunSummary: () => ({}) }))
vi.mock('../../../server/services/helpers/ops', () => ({
  deleteFolder: async (userId: string, folder: { script: string }) => {
    effects.push(`workspace:${userId}/.scripts/${folder.script}`)
  },
  scaffold: async () => undefined,
}))

const { scriptDeleteJobKind, SCRIPT_DELETE_PHASES, SCRIPT_DELETED, STOP_RECHECK_MS, STOP_SETTLE_MS } = await import('../../../server/services/scripts/delete')
const { purgeUserScripts, scriptPurgeSteps } = await import('../../../server/services/scripts/purge')
const { requestScriptDeletion } = await import('../../../server/services/scripts')
const { newScriptDoc } = await import('../../../server/services/scripts/store')
const { JobDeferredError } = await import('../../../server/utils/jobs')

const USER_ID = 'u1'

function context(job: JobDoc) {
  const cursors: string[] = []
  const ctx: JobContext = {
    job,
    log: useLogger('test'),
    config: {} as Config,
    signal: new AbortController().signal,
    saveCursor: async (cursor) => {
      cursors.push(String(cursor.phase))
    },
    setProgress: async () => undefined,
  }
  return { ctx, cursors }
}

function deleteJob(script: ScriptDoc, cursor: Record<string, unknown> = {}): JobDoc {
  return { _id: 'j', kind: 'scriptDelete', subject: { kind: 'script', id: script._id }, cursor } as unknown as JobDoc
}

async function insertRun(script: ScriptDoc, id: string): Promise<void> {
  await store.scriptRuns.insertOne({
    _id: id,
    scriptId: script._id,
    userId: script.userId,
    state: 'completed',
    createdAt: new Date(),
  } as unknown as ScriptRunDoc)
}

let script: ScriptDoc

beforeEach(async () => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  effects.length = 0
  runs.toCancel = 0
  runs.activeJobs = 0
  script = { ...newScriptDoc({ userId: USER_ID, name: 'csp', language: 'python', source: { kind: 'scaffold' } }), deletingAt: new Date() }
  await store.scripts.insertOne(script)
  await insertRun(script, 'run-1')
})

describe('requestScriptDeletion', () => {
  it('hides the script at once and creates one scriptDelete job', async () => {
    const live = newScriptDoc({ userId: USER_ID, name: 'other', language: 'python', source: { kind: 'scaffold' } })
    await store.scripts.insertOne(live)
    const job = await requestScriptDeletion(live)
    expect(job).toMatchObject({ kind: 'scriptDelete', state: 'queued' })
    expect(store.scripts.docs.find((doc) => doc._id === live._id)?.deletingAt).toBeInstanceOf(Date)
    expect(store.jobs.docs[0]).toMatchObject({ kind: 'scriptDelete', userId: USER_ID, subject: { kind: 'script', id: live._id } })
  })

  it('answers 404 for a script that is already being deleted', async () => {
    await expect(requestScriptDeletion(script)).rejects.toMatchObject({ code: 'notFound' })
    expect(store.jobs.docs).toHaveLength(0)
  })
})

describe('scriptDelete job', () => {
  it('runs every phase in order and removes all data of the script', async () => {
    const job = deleteJob(script)
    const { ctx, cursors } = context(job)
    await scriptDeleteJobKind.handler(job, ctx)
    expect(cursors).toEqual([...SCRIPT_DELETE_PHASES])
    expect(effects).toEqual([
      `cancel:{"scriptId":"${script._id}"}:${SCRIPT_DELETED}`,
      `runs:{"scriptId":"${script._id}"}`,
      `images:${script._id}`,
      `workspace:${USER_ID}/.scripts/csp`,
    ])
    expect(store.scriptRuns.docs).toHaveLength(0)
    expect(store.scripts.docs).toHaveLength(0)
  })

  it('defers after cancelling runs so their jobs notice, then waits for active run jobs', async () => {
    runs.toCancel = 2
    const job = deleteJob(script)
    const first = context(job)
    const settle = await scriptDeleteJobKind.handler(job, first.ctx).catch((error: unknown) => error)
    expect(settle).toBeInstanceOf(JobDeferredError)
    expect((settle as InstanceType<typeof JobDeferredError>).until.getTime()).toBeGreaterThanOrEqual(Date.now() + STOP_SETTLE_MS - 1000)
    expect(first.cursors).toEqual(['stop'])

    runs.activeJobs = 1
    const resumed = deleteJob(script, { phase: 'stop' })
    const wait = await scriptDeleteJobKind.handler(resumed, context(resumed).ctx).catch((error: unknown) => error)
    expect(wait).toBeInstanceOf(JobDeferredError)
    expect((wait as InstanceType<typeof JobDeferredError>).until.getTime()).toBeLessThanOrEqual(Date.now() + STOP_RECHECK_MS)
    expect(store.scriptRuns.docs).toHaveLength(1)

    runs.activeJobs = 0
    const done = context(resumed)
    await scriptDeleteJobKind.handler(resumed, done.ctx)
    expect(done.cursors).toEqual([...SCRIPT_DELETE_PHASES])
    expect(store.scripts.docs).toHaveLength(0)
  })

  it('resumes at the phase of its cursor', async () => {
    store.scriptRuns.docs.length = 0
    const job = deleteJob(script, { phase: 'images' })
    const { ctx, cursors } = context(job)
    await scriptDeleteJobKind.handler(job, ctx)
    expect(cursors).toEqual(['images', 'workspace', 'script'])
    expect(effects).toEqual([`images:${script._id}`, `workspace:${USER_ID}/.scripts/csp`])
  })

  it('goes back to the stop phase when a run appeared after it', async () => {
    const job = deleteJob(script, { phase: 'workspace' })
    const { ctx, cursors } = context(job)
    await expect(scriptDeleteJobKind.handler(job, ctx)).rejects.toBeInstanceOf(JobDeferredError)
    expect(cursors).toEqual(['workspace', 'script', 'stop'])
    expect(store.scripts.docs).toHaveLength(1)
  })

  it('finishes quietly when the script is already gone and refuses a script that is not being deleted', async () => {
    store.scripts.docs.length = 0
    await expect(scriptDeleteJobKind.handler(deleteJob(script), context(deleteJob(script)).ctx)).resolves.toBeUndefined()
    const live = newScriptDoc({ userId: USER_ID, name: 'live', language: 'python', source: { kind: 'scaffold' } })
    await store.scripts.insertOne(live)
    await expect(scriptDeleteJobKind.handler(deleteJob(live), context(deleteJob(live)).ctx)).rejects.toMatchObject({ code: 'invalidState' })
    expect(effects).toEqual([])
  })
})

describe('user purge step 65', () => {
  function purgeContext(): UserPurgeContext {
    return { userId: USER_ID, job: {} as JobDoc, log: useLogger('test'), config: {} as Config, signal: new AbortController().signal }
  }

  it('is registered at order 65', () => {
    expect(scriptPurgeSteps.map((step) => [step.name, step.order])).toEqual([['scripts', 65]])
  })

  it('deletes the runs, the images and the scripts of the user', async () => {
    const other = newScriptDoc({ userId: USER_ID, name: 'other', language: 'python', source: { kind: 'upload' } })
    await store.scripts.insertOne(other)
    await store.scripts.insertOne(newScriptDoc({ userId: 'u2', name: 'csp', language: 'python', source: { kind: 'upload' } }))
    await purgeUserScripts(purgeContext())
    expect(effects).toEqual([
      `cancel:{"userId":"${USER_ID}"}:the user was deleted`,
      `runs:{"userId":"${USER_ID}"}`,
      `images:${script._id}`,
      `images:${other._id}`,
    ])
    expect(store.scripts.docs.map((doc) => doc.userId)).toEqual(['u2'])
  })

  it('defers the purge while run jobs of the user are active', async () => {
    runs.activeJobs = 1
    await expect(purgeUserScripts(purgeContext())).rejects.toBeInstanceOf(JobDeferredError)
    expect(store.scripts.docs).toHaveLength(1)
  })
})
