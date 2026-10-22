import type { JobDoc } from '../types/documents'
import type { Config } from './config'
import type { Logger } from './logger'

/*
 * User purge steps (docs/data-model.md §5): the `userPurge` job (server/services/jobs/user-purge.ts) deletes a
 * user's data step by step, persisting the current step in its cursor, so a restarted job resumes. Steps must be
 * idempotent and must check `signal`. Domain areas register their steps from their Nitro plugin:
 *
 *   registerUserPurgeStep({ name: 'scans', order: 40, run: async ({ userId, signal }) => … })
 *
 * Order of docs/data-model.md §5 (foundation steps marked *):
 *    10 cancel the user's scans          (scans)
 *    20 editor and editor API key        (editor)
 *    30 exports                        * (documents and S3 `exports/<userId>/`)
 *    40 scans (scan-delete logic, analyses, files)  (scans)
 *    50 test runs                        (test runs)
 *    60 revisions and task images        (revisions)
 *    70 tasks                            (tasks)
 *    80 workspace and editor-home directories (helper `purge`)  (workspace)
 *    90 uploads                        * (documents and S3 `uploads/<userId>/`)
 *   100 credentials                    *
 *   110 events                         *
 *   120 jobs (other than the purge job) *
 *  1000 the better-auth user           *
 */

export interface UserPurgeContext {
  userId: string
  job: JobDoc
  log: Logger
  config: Config
  signal: AbortSignal
}

export interface UserPurgeStep {
  name: string
  order: number
  run(ctx: UserPurgeContext): Promise<void>
}

const globalKey = '__scantorUserPurgeSteps'
type GlobalWithSteps = typeof globalThis & { [globalKey]?: UserPurgeStep[] }

function steps(): UserPurgeStep[] {
  const global = globalThis as GlobalWithSteps
  global[globalKey] ??= []
  return global[globalKey]
}

export function registerUserPurgeStep(step: UserPurgeStep): void {
  if (steps().some((existing) => existing.name === step.name)) throw new Error(`user purge step ${step.name} is registered twice`)
  steps().push(step)
}

/** Registered steps in execution order. */
export function userPurgeSteps(): UserPurgeStep[] {
  return [...steps()].sort((a, b) => a.order - b.order)
}

export function resetUserPurgeSteps(): void {
  steps().length = 0
}
