import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevisionDoc, ScanDoc, ScriptDoc, ScriptRunDoc, TaskDoc } from '../../server/types/documents'
import { FakeCollection } from '../helpers/fake-collection'

// Ownership helpers (docs/auth.md §9): 401 → 404 → 403, foreign resources are 404, one query per load, name lookups
// never cross users, and create references are always the caller's own documents.

const store = {
  tasks: new FakeCollection<TaskDoc>('tasks'),
  revisions: new FakeCollection<RevisionDoc>('revisions'),
  scans: new FakeCollection<ScanDoc>('scans'),
  analyses: new FakeCollection('analyses'),
  scripts: new FakeCollection<ScriptDoc>('scripts'),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
}

vi.mock('../../server/utils/mongo', () => ({
  useCollections: () => ({
    tasks: store.tasks.asCollection(),
    revisions: store.revisions.asCollection(),
    scans: store.scans.asCollection(),
    analyses: store.analyses.asCollection(),
    scripts: store.scripts.asCollection(),
    scriptRuns: store.scriptRuns.asCollection(),
  }),
}))

const {
  loadOwned,
  loadOwnedAnalysis,
  loadOwnedScan,
  ownedRef,
  ownerFilter,
  callerFilter,
  requireAdmin,
  requireSession,
  requireUser,
  requireWorker,
  assertCurrentEpoch,
  resolveRevisionRef,
  resolveTask,
  requireScriptRun,
  resolveScript,
  loadOwnedScriptRun,
  loadScansForScriptRun,
  loadRunScan,
  loadRunAnalysis,
} = await import('../../server/utils/authz')
const { ApiError } = await import('../../server/utils/errors')
type UserPrincipal = import('../../server/utils/principal').UserPrincipal
type Principal = import('../../server/utils/principal').Principal

const ALICE = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const BOB = '1c7a7a1f-4d1f-4b7f-8a1f-6e2a9c1b8d22'
const ADMIN = '2d8b8b2a-5e2a-4c8a-9b2a-7f3b0d2c9e33'
const ALICE_TASK = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const BOB_TASK = '8a4c3d2b-0e5f-4a7b-9c3d-2e4f6a8b0c1d'
const ALICE_SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const ALICE_SCAN_2 = '6f2a1d3e-9b8c-4d4e-8f2a-3b4c5d6e7f80'
const ALICE_DELETING_SCAN = '7a3b2e4f-0c9d-4e5f-9a3b-4c5d6e7f8091'
const BOB_SCAN = '8b4c3f5a-1d0e-4f6a-8b4c-5d6e7f8091a2'
const ALICE_SCRIPT = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d'
const BOB_SCRIPT = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'
const ALICE_RUN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'

function user(id: string, overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  return { kind: 'user', via: 'session', user: { id, email: `${id}@x`, name: id, role: 'user' }, isAdmin: false, ...overrides }
}
const alice = user(ALICE)
const bob = user(BOB)
const admin = user(ADMIN, { isAdmin: true, user: { id: ADMIN, email: 'a@x', name: 'a', role: 'admin' } })

function eventWith(principal: Principal | null): H3Event {
  return { context: { principal } } as unknown as H3Event
}

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect((error as InstanceType<typeof ApiError>).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

function task(id: string, userId: string, name: string, extra: Partial<TaskDoc> = {}): TaskDoc {
  return { _id: id, userId, name, deletingAt: null, ...extra } as TaskDoc
}

function revision(id: string, taskId: string, userId: string, number: number, state: RevisionDoc['state']): RevisionDoc {
  return { _id: id, taskId, userId, number, state } as RevisionDoc
}

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.splice(0)
  for (const collection of Object.values(store)) collection.filters.splice(0)
  store.tasks.docs.push(task(ALICE_TASK, ALICE, 'alpha'), task(BOB_TASK, BOB, 'alpha'))
  store.tasks.docs.push(task('9b5d4e3c-1f6a-4b8c-8d4e-3f5a7b9c1d2e', ALICE, 'gone', { deletingAt: new Date() }))
  store.revisions.docs.push(
    revision('c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f', ALICE_TASK, ALICE, 1, 'ready'),
    revision('d2e3f4a5-6b7c-4d8e-9f0a-1b2c3d4e5f6a', ALICE_TASK, ALICE, 2, 'ready'),
    revision('e3f4a5b6-7c8d-4e9f-8a1b-2c3d4e5f6a7b', ALICE_TASK, ALICE, 3, 'failed'),
  )
  store.scans.docs.push({ _id: ALICE_SCAN, userId: ALICE, state: 'completed' } as ScanDoc)
  store.scans.docs.push(
    { _id: ALICE_SCAN_2, userId: ALICE, state: 'running' } as ScanDoc,
    { _id: ALICE_DELETING_SCAN, userId: ALICE, state: 'deleting' } as ScanDoc,
    { _id: BOB_SCAN, userId: BOB, state: 'completed' } as ScanDoc,
  )
  store.analyses.docs.push({ _id: `${ALICE_SCAN}-7`, scanId: ALICE_SCAN, seq: 7 })
  store.scripts.docs.push(
    { _id: ALICE_SCRIPT, userId: ALICE, name: 'csp', deletingAt: null } as ScriptDoc,
    { _id: BOB_SCRIPT, userId: BOB, name: 'csp', deletingAt: null } as ScriptDoc,
    { _id: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', userId: ALICE, name: 'gone', deletingAt: new Date() } as ScriptDoc,
  )
  store.scriptRuns.docs.push({ _id: ALICE_RUN, userId: ALICE, scriptId: ALICE_SCRIPT, scanIds: [ALICE_SCAN] } as ScriptRunDoc)
})

describe('principal helpers', () => {
  it('requireUser: 401 without a user principal; 403 for editor keys where forbidden', async () => {
    await expectCode(() => requireUser(eventWith(null)), 'unauthorized')
    await expectCode(() => requireUser(eventWith({ kind: 'setup' })), 'unauthorized')
    expect(requireUser(eventWith(alice))).toBe(alice)
    const editor = user(ALICE, { via: 'apiKey', apiKey: { id: 'k', configId: 'editor' } })
    expect(requireUser(eventWith(editor))).toBe(editor)
    await expectCode(() => requireUser(eventWith(editor), { editorKey: false }), 'forbidden')
  })

  it('requireAdmin and requireSession', async () => {
    await expectCode(() => requireAdmin(eventWith(alice)), 'adminRequired')
    expect(requireAdmin(eventWith(admin))).toBe(admin)
    await expectCode(() => requireSession(eventWith(user(ALICE, { via: 'apiKey' }))), 'sessionRequired')
    expect(requireSession(eventWith(alice))).toBe(alice)
  })

  it('requireWorker binds the role and the epoch', async () => {
    const runner: Principal = { kind: 'worker', worker: { id: 'w', scanId: 's', userId: ALICE, role: 'runner', nodeId: 'n', epoch: 0 } }
    expect(requireWorker(eventWith(runner)).worker.id).toBe('w')
    await expectCode(() => requireWorker(eventWith(runner), { role: 'scheduler' }), 'forbidden')
    await expectCode(() => requireWorker(eventWith(alice)), 'unauthorized')
    await expectCode(() => assertCurrentEpoch(1, 2), 'staleEpoch')
    expect(() => assertCurrentEpoch(2, 2)).not.toThrow()
  })

  it('requireScriptRun accepts only a script-run principal', async () => {
    const run: Principal = { kind: 'scriptRun', scriptRun: { id: ALICE_RUN, userId: ALICE, scriptId: ALICE_SCRIPT, scanIds: [ALICE_SCAN], limit: null } }
    expect(requireScriptRun(eventWith(run)).scriptRun.id).toBe(ALICE_RUN)
    await expectCode(() => requireScriptRun(eventWith(alice)), 'unauthorized')
    await expectCode(() => requireScriptRun(eventWith(null)), 'unauthorized')
    await expectCode(() => requireUser(eventWith(run)), 'unauthorized')
  })
})

describe('ownerFilter', () => {
  it('scopes users to themselves and lets admins filter', async () => {
    expect(ownerFilter(alice)).toEqual({ userId: ALICE })
    expect(ownerFilter(alice, ALICE)).toEqual({ userId: ALICE })
    await expectCode(() => ownerFilter(alice, BOB), 'adminRequired')
    expect(ownerFilter(admin)).toEqual({})
    expect(ownerFilter(admin, BOB)).toEqual({ userId: BOB })
  })
})

describe('callerFilter', () => {
  it('scopes the caller-only lists to the caller, admins included', () => {
    expect(callerFilter(alice)).toEqual({ userId: ALICE })
    expect(callerFilter(admin)).toEqual({ userId: admin.user.id })
  })
})

describe('loadOwned', () => {
  it('loads with one query scoped to the owner, and admins by id only', async () => {
    expect((await loadOwned(store.tasks.asCollection(), ALICE_TASK, alice))._id).toBe(ALICE_TASK)
    expect(store.tasks.filters.at(-1)).toEqual({ _id: ALICE_TASK, userId: ALICE })
    expect((await loadOwned(store.tasks.asCollection(), BOB_TASK, admin))._id).toBe(BOB_TASK)
    expect(store.tasks.filters.at(-1)).toEqual({ _id: BOB_TASK })
  })

  it('answers 404 for foreign, missing, malformed and invisible documents', async () => {
    await expectCode(loadOwned(store.tasks.asCollection(), BOB_TASK, alice), 'notFound')
    await expectCode(loadOwned(store.tasks.asCollection(), '00000000-0000-4000-8000-000000000000', alice), 'notFound')
    const before = store.tasks.filters.length
    await expectCode(loadOwned(store.tasks.asCollection(), '{"$ne":null}', alice), 'notFound')
    expect(store.tasks.filters.length).toBe(before)
    await expectCode(
      loadOwned(store.tasks.asCollection(), '9b5d4e3c-1f6a-4b8c-8d4e-3f5a7b9c1d2e', alice, { visible: (doc) => !doc.deletingAt }),
      'notFound',
    )
  })

  it('ownedRef only ever returns the caller’s own documents, even for admins', async () => {
    expect((await ownedRef(store.tasks.asCollection(), ALICE_TASK, alice))._id).toBe(ALICE_TASK)
    await expectCode(ownedRef(store.tasks.asCollection(), ALICE_TASK, admin), 'notFound')
    await expectCode(ownedRef(store.tasks.asCollection(), 'nope', alice), 'notFound')
  })
})

describe('resolveTask', () => {
  it('resolves names among the caller’s tasks only', async () => {
    expect((await resolveTask(alice, 'alpha'))._id).toBe(ALICE_TASK)
    expect((await resolveTask(bob, 'alpha'))._id).toBe(BOB_TASK)
    await expectCode(resolveTask(admin, 'alpha'), 'notFound')
  })

  it('resolves ids with ownership; deleted tasks are invisible', async () => {
    expect((await resolveTask(admin, BOB_TASK))._id).toBe(BOB_TASK)
    await expectCode(resolveTask(alice, BOB_TASK), 'notFound')
    await expectCode(resolveTask(alice, 'gone'), 'notFound')
    await expectCode(resolveTask(alice, '9b5d4e3c-1f6a-4b8c-8d4e-3f5a7b9c1d2e'), 'notFound')
    await expectCode(resolveTask(alice, 'Not A Slug'), 'notFound')
  })
})

describe('resolveRevisionRef', () => {
  it.each([
    ['alpha@1', 1],
    ['alpha@latest', 2],
    ['alpha', 2],
    [`${ALICE_TASK}@3`, 3],
    ['d2e3f4a5-6b7c-4d8e-9f0a-1b2c3d4e5f6a', 2],
    [ALICE_TASK, 2],
  ])('%s → revision %d', async (ref, number) => {
    expect((await resolveRevisionRef(alice, ref)).number).toBe(number)
  })

  it.each(['alpha@9', 'alpha@x', 'beta@1', `${BOB_TASK}@latest`, 'd2e3f4a5-6b7c-4d8e-9f0a-1b2c3d4e5f6b'])('%s is 404 for alice', async (ref) => {
    await expectCode(resolveRevisionRef(alice, ref), 'notFound')
  })

  it('never resolves another user’s revision id for a non-admin', async () => {
    await expectCode(resolveRevisionRef(bob, 'd2e3f4a5-6b7c-4d8e-9f0a-1b2c3d4e5f6a'), 'notFound')
    expect((await resolveRevisionRef(admin, 'd2e3f4a5-6b7c-4d8e-9f0a-1b2c3d4e5f6a')).number).toBe(2)
  })
})

describe('loadOwnedScan and loadOwnedAnalysis', () => {
  it('loads analyses through the owned scan', async () => {
    expect((await loadOwnedScan(alice, ALICE_SCAN))._id).toBe(ALICE_SCAN)
    expect((await loadOwnedAnalysis(alice, `${ALICE_SCAN}-7`)).analysis._id).toBe(`${ALICE_SCAN}-7`)
    expect(store.analyses.filters.at(-1)).toEqual({ _id: `${ALICE_SCAN}-7`, scanId: ALICE_SCAN })
  })

  it.each([`${ALICE_SCAN}-8`, `${ALICE_SCAN}--1`, `${ALICE_SCAN}-1.5`, 'x-1', `${ALICE_SCAN}-99999999999999999`])('%s is 404', async (id) => {
    await expectCode(loadOwnedAnalysis(alice, id), 'notFound')
  })

  it('hides another user’s analyses', async () => {
    await expectCode(loadOwnedAnalysis(bob, `${ALICE_SCAN}-7`), 'notFound')
  })
})

describe('scripts and script runs', () => {
  type ScriptRunPrincipal = import('../../server/utils/principal').ScriptRunPrincipal
  const runOf = (scanIds: string[], userId = ALICE): ScriptRunPrincipal => ({
    kind: 'scriptRun',
    scriptRun: { id: ALICE_RUN, userId, scriptId: ALICE_SCRIPT, scanIds, limit: null },
  })

  it('resolves script names among the caller’s scripts only, and ids for admins', async () => {
    expect((await resolveScript(alice, 'csp'))._id).toBe(ALICE_SCRIPT)
    expect((await resolveScript(bob, 'csp'))._id).toBe(BOB_SCRIPT)
    // An admin's name lookup stays among the admin's own scripts; another user's script is addressed by id.
    await expectCode(resolveScript(admin, 'csp'), 'notFound')
    expect((await resolveScript(admin, BOB_SCRIPT))._id).toBe(BOB_SCRIPT)
    expect((await resolveScript(alice, ALICE_SCRIPT.toUpperCase()))._id).toBe(ALICE_SCRIPT)
    await expectCode(resolveScript(alice, BOB_SCRIPT), 'notFound')
  })

  it.each(['gone', '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', 'upload', 'Not_A_Name', 'missing'])('script %s is 404', async (ref) => {
    await expectCode(resolveScript(alice, ref), 'notFound')
  })

  it('loads script runs of their owner (the script owner) and lets admins see them', async () => {
    expect((await loadOwnedScriptRun(alice, ALICE_RUN)).scriptId).toBe(ALICE_SCRIPT)
    expect((await loadOwnedScriptRun(admin, ALICE_RUN))._id).toBe(ALICE_RUN)
    await expectCode(loadOwnedScriptRun(bob, ALICE_RUN), 'notFound')
    await expectCode(loadOwnedScriptRun(alice, 'not-a-uuid'), 'notFound')
  })

  it('binds the script owner’s live scans, deduplicated in request order', async () => {
    const script = { userId: ALICE }
    const scans = await loadScansForScriptRun(script, [ALICE_SCAN_2, ALICE_SCAN, ALICE_SCAN_2.toUpperCase()])
    expect(scans.map((scan) => scan._id)).toEqual([ALICE_SCAN_2, ALICE_SCAN])
    expect(store.scans.filters.at(-1)).toEqual({ _id: { $in: [ALICE_SCAN_2, ALICE_SCAN] }, userId: ALICE, state: { $nin: ['deleting', 'deleted'] } })
  })

  it.each([
    ['another user’s scan', [ALICE_SCAN, BOB_SCAN]],
    ['a scan being deleted', [ALICE_DELETING_SCAN]],
    ['an unknown scan', ['9c5d4a6b-2e1f-4a7b-9c5d-6e7f8091a2b3']],
    ['a malformed id', ['nope']],
    ['no scan', []],
    ['more than 20 scans', Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)],
  ])('refuses to bind %s with 404', async (_what, ids) => {
    await expectCode(loadScansForScriptRun({ userId: ALICE }, ids), 'notFound')
  })

  it('never binds another tenant’s scan for an admin’s script, whatever the caller’s power', async () => {
    // The owner is the script's: an admin's own script cannot read Bob's scan.
    await expectCode(loadScansForScriptRun({ userId: ADMIN }, [BOB_SCAN]), 'notFound')
  })

  it('lets a script-run container read only its own live scans of its owner', async () => {
    expect((await loadRunScan(runOf([ALICE_SCAN]), ALICE_SCAN))._id).toBe(ALICE_SCAN)
    expect((await loadRunScan(runOf([ALICE_SCAN]), ALICE_SCAN.toUpperCase()))._id).toBe(ALICE_SCAN)
    await expectCode(loadRunScan(runOf([ALICE_SCAN]), ALICE_SCAN_2), 'notFound')
    await expectCode(loadRunScan(runOf([ALICE_DELETING_SCAN]), ALICE_DELETING_SCAN), 'notFound')
    // Even a scan id in the run's list is refused when the scan is not the owner's.
    await expectCode(loadRunScan(runOf([BOB_SCAN]), BOB_SCAN), 'notFound')
    await expectCode(loadRunScan(runOf([ALICE_SCAN]), 'nope'), 'notFound')
  })

  it('loads analyses for a script-run container through loadRunScan', async () => {
    const { analysis } = await loadRunAnalysis(runOf([ALICE_SCAN]), `${ALICE_SCAN}-7`)
    expect(analysis._id).toBe(`${ALICE_SCAN}-7`)
    expect(store.analyses.filters.at(-1)).toEqual({ _id: `${ALICE_SCAN}-7`, scanId: ALICE_SCAN })
    await expectCode(loadRunAnalysis(runOf([ALICE_SCAN_2]), `${ALICE_SCAN}-7`), 'notFound')
    await expectCode(loadRunAnalysis(runOf([ALICE_SCAN]), `${ALICE_SCAN}-8`), 'notFound')
    await expectCode(loadRunAnalysis(runOf([ALICE_SCAN]), 'x-1'), 'notFound')
  })
})
