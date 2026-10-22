import type { ScantorError } from '#shared/types/common'
import type { TestRun, TestRunAnalysis } from '#shared/types/test-runs'
import { TERMINAL_TEST_RUN_STATES } from '#shared/utils/enums'
import type { ScantorErrorDoc, TestRunAnalysisDoc, TestRunDoc, TimingsDoc } from '../../types/documents'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// Test-run representations (docs/api.md §2): `TestRun` omits `secrets` and the internal keys and adds `analyses`
// when requested; `TestRunAnalysis` is an `Analysis` without round and worker fields. Configs and results are stored
// masked already (secrets "***").

export function isTestRunSettled(doc: Pick<TestRunDoc, 'state'>): boolean {
  return (TERMINAL_TEST_RUN_STATES as readonly string[]).includes(doc.state)
}

function toApiError(error: ScantorErrorDoc | null | undefined): ScantorError | null {
  if (!error) return null
  return { ...error, at: isoDate(error.at) }
}

function toApiTimings(timings: TimingsDoc | undefined) {
  if (!timings) return undefined
  return {
    scheduledAt: isoDateOrNull(timings.scheduledAt),
    startedAt: isoDateOrNull(timings.startedAt),
    finishedAt: isoDateOrNull(timings.finishedAt),
    durationMs: timings.durationMs,
  }
}

export function toApiTestRunAnalysis(doc: TestRunAnalysisDoc): TestRunAnalysis {
  return {
    id: doc._id,
    seq: doc.seq,
    status: doc.status,
    attempt: doc.attempt,
    ...(doc.config === undefined ? {} : { config: doc.config }),
    result: doc.result ?? null,
    error: toApiError(doc.error),
    attempts: doc.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      startedAt: isoDateOrNull(attempt.startedAt),
      finishedAt: isoDateOrNull(attempt.finishedAt),
      durationMs: attempt.durationMs,
      error: toApiError(attempt.error),
      logTail: attempt.logTail,
    })),
    files: doc.files.map(({ key: _key, ...file }) => file),
    logTail: doc.logTail ?? '',
    ...(doc.timings ? { timings: toApiTimings(doc.timings) } : {}),
  }
}

export function toApiTestRun(doc: TestRunDoc, analyses?: TestRunAnalysisDoc[]): TestRun {
  return {
    id: doc._id,
    userId: doc.userId,
    taskId: doc.taskId,
    taskName: doc.taskName,
    state: doc.state,
    input: doc.input,
    packSha256: doc.packSha256 ?? null,
    draftImage: doc.draftImage ?? null,
    description: doc.description ?? null,
    errors: doc.errors,
    summary: doc.summary,
    ...(analyses ? { analyses: analyses.map(toApiTestRunAnalysis) } : {}),
    createdAt: isoDate(doc.createdAt),
    startedAt: isoDateOrNull(doc.startedAt),
    finishedAt: isoDateOrNull(doc.finishedAt),
    expiresAt: isoDate(doc.expiresAt),
  }
}
