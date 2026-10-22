import type { JobDoc } from '../../types/documents'
import { FatalJobError, type JobContext, type JobKindDefinition } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { deletePrefix } from '../../utils/s3'
import { registerUserPurgeStep, userPurgeSteps } from '../../utils/user-purge'
import { deleteAuthUser } from '../../utils/users'

// The `userPurge` job kind (reconciler component, concurrency 1; docs/data-model.md §4.12, §5). It runs the
// registered purge steps in order; the cursor records the next step, so a job restarted after a lease expiry
// resumes there. The foundation registers the steps for exports, uploads, credentials, events, jobs and the
// better-auth user; the domain areas register theirs (server/utils/user-purge.ts).

export const userPurgeJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: 1,
  maxAttempts: 10,
  async handler(job: JobDoc, ctx: JobContext) {
    const userId = job.subject.id
    if (job.subject.kind !== 'user') throw new FatalJobError('invalidSubject', `userPurge needs a user subject, got ${job.subject.kind}`)
    const plan = userPurgeSteps()
    const resumeAt = typeof job.cursor.step === 'string' ? plan.findIndex((step) => step.name === job.cursor.step) : 0
    const start = Math.max(0, resumeAt)
    for (let index = start; index < plan.length; index++) {
      const step = plan[index]!
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted')
      await ctx.saveCursor({ step: step.name }, { done: index, total: plan.length })
      ctx.log.info('user purge step', { step: step.name, userId })
      await step.run({ userId, job, log: ctx.log, config: ctx.config, signal: ctx.signal })
    }
    await ctx.setProgress(plan.length, plan.length)
  },
}

/** Registers the foundation's purge steps (server/plugins/10.components.ts). */
export function registerFoundationPurgeSteps(): void {
  registerUserPurgeStep({
    name: 'exports',
    order: 30,
    async run({ userId }) {
      await deletePrefix(`exports/${userId}/`)
      await useCollections().exports.deleteMany({ userId })
    },
  })
  registerUserPurgeStep({
    name: 'uploads',
    order: 90,
    async run({ userId }) {
      await deletePrefix(`uploads/${userId}/`)
      await useCollections().uploads.deleteMany({ userId })
    },
  })
  registerUserPurgeStep({
    name: 'credentials',
    order: 100,
    async run({ userId }) {
      await useCollections().credentials.deleteMany({ userId })
    },
  })
  registerUserPurgeStep({
    name: 'events',
    order: 110,
    async run({ userId }) {
      await useCollections().events.deleteMany({ userId })
    },
  })
  registerUserPurgeStep({
    name: 'jobs',
    order: 120,
    async run({ userId, job }) {
      await useCollections().jobs.deleteMany({ userId, _id: { $ne: job._id } })
    },
  })
  registerUserPurgeStep({
    name: 'user',
    order: 1000,
    async run({ userId }) {
      await deleteAuthUser(userId)
    },
  })
}
