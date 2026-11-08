import type { FileContentQuery } from '#shared/schemas/analyses'
import type { Page } from '#shared/types/common'
import type { FileContent, FileDownload } from '#shared/types/exports'
import type { TestRun } from '#shared/types/test-runs'
import type { TaskDoc, TestRunAnalysisDoc, TestRunDoc } from '../../types/documents'
import { loadOwned } from '../../utils/authz'
import { invalidState } from '../../utils/errors'
import { cancelActiveJobs } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import type { UserPrincipal } from '../../utils/principal'
import { presignDownload } from '../../utils/s3'
import { isoDate } from '../../utils/serialize'
import { findStoredFile, readStoredFileContent, type StoredFile } from '../files/content'
import { requestCancellation } from './live'
import { toApiTestRun } from './mappers'

// Test runs (docs/api.md §4.11): listing per task, loading with ownership, the analyses of a run, cancellation, file
// downloads and inline file reads. Creation is in ./create, execution in ./job, the SSE stream in ./stream.

export const ACTIVE_TEST_RUN_STATES = ['queued', 'building', 'running'] as const

export async function loadOwnedTestRun(principal: UserPrincipal, testRunId: string): Promise<TestRunDoc> {
  return loadOwned(useCollections().testRuns, testRunId.toLowerCase(), principal, { what: 'test run' })
}

export async function reloadTestRun(doc: TestRunDoc): Promise<TestRunDoc> {
  return (await useCollections().testRuns.findOne({ _id: doc._id })) ?? doc
}

export async function testRunAnalyses(testRunId: string): Promise<TestRunAnalysisDoc[]> {
  return useCollections().testRunAnalyses.find({ testRunId }).sort({ seq: 1 }).toArray()
}

/** The `TestRun` representation, with its analyses when requested. */
export async function testRunRepresentation(doc: TestRunDoc, withAnalyses: boolean): Promise<TestRun> {
  return toApiTestRun(doc, withAnalyses ? await testRunAnalyses(doc._id) : undefined)
}

export async function listTestRuns(task: TaskDoc, query: { limit?: number; cursor?: string }): Promise<Page<TestRun>> {
  return findPage(useCollections().testRuns, { taskId: task._id }, query, (doc) => toApiTestRun(doc))
}

/**
 * cancelTestRun: `queued`, `building` and `running` become `cancelled`; a cancelled run is returned unchanged; a
 * finished one is 409 invalidState. The job stops at once when this process runs it, otherwise at its next lease
 * renewal.
 */
export async function cancelTestRun(doc: TestRunDoc): Promise<TestRunDoc> {
  const now = new Date()
  const cancelled = await useCollections().testRuns.findOneAndUpdate(
    { _id: doc._id, state: { $in: [...ACTIVE_TEST_RUN_STATES] } },
    { $set: { state: 'cancelled', finishedAt: now, updatedAt: now }, $unset: { 'secrets.request': '' } },
    { returnDocument: 'after' },
  )
  if (!cancelled) {
    const current = await reloadTestRun(doc)
    if (current.state === 'cancelled') return current
    throw invalidState('test run', current.state, ACTIVE_TEST_RUN_STATES, 'cancel')
  }
  requestCancellation(doc._id)
  await cancelActiveJobs('testRun', doc._id)
  return cancelled
}

/** The stored file `fileId` of one of the test run's analyses (uploaded after the run); 404 notFound otherwise. */
async function testRunFile(doc: TestRunDoc, fileId: string): Promise<StoredFile> {
  const analysis = await useCollections().testRunAnalyses.findOne({ testRunId: doc._id, 'files.id': fileId })
  return findStoredFile(analysis?.files, fileId)
}

/** getTestRunFileDownload: a presigned GET of one file of a test-run analysis. */
export async function testRunFileDownload(doc: TestRunDoc, fileId: string): Promise<FileDownload> {
  const file = await testRunFile(doc, fileId)
  const { url, expiresAt, inline } = await presignDownload({ key: file.key, name: file.name, contentType: file.contentType })
  return { url, expiresAt: isoDate(expiresAt), name: file.name, size: file.size, sha256: file.sha256, contentType: file.contentType, inline }
}

/** readTestRunFile: one page of a file of a test-run analysis, inline. */
export async function testRunFileContent(doc: TestRunDoc, fileId: string, range: FileContentQuery): Promise<FileContent> {
  return readStoredFileContent(await testRunFile(doc, fileId), range)
}
