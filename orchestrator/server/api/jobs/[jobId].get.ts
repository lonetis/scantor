defineRouteMeta({
  openAPI: {
    tags: ['jobs'],
    operationId: 'getJob',
    summary: 'Get a background job',
    description:
      'Returns one background job (for example the scanDelete or scanRetryFailed job returned with 202 by deleteScan and retryFailedAnalyses): state, progress {done, total}, attempts and the error of a failed job. With wait (seconds) the call returns once the job succeeded, failed or was cancelled (header Scantor-Wait: settled|timeout).',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      {
        name: 'wait',
        in: 'query',
        required: false,
        description: 'Seconds to wait for the job to finish (0–120).',
        schema: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
      },
    ],
    responses: {
      200: { description: 'The job', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such job', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many concurrent waits', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import type { Filter } from 'mongodb'
import { getJobQuery, jobIdParams } from '#shared/schemas/analyses'
import { TERMINAL_JOB_STATES } from '#shared/utils/enums'
import { toApiJob } from '../../services/jobs/mappers'
import type { JobDoc } from '../../types/documents'
import { requireUser } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { loadWithWait } from '../../utils/wait'
import { validateParams, validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { jobId } = validateParams(event, jobIdParams)
  const { wait } = validateQuery(event, getJobQuery)
  const { jobs } = useCollections()
  // Jobs of no user (userId null) are visible to admins only; another user's job is 404 (docs/api.md §1.3).
  const id = jobId.toLowerCase()
  const filter: Filter<JobDoc> = principal.isAdmin ? { _id: id } : { _id: id, userId: principal.user.id }
  const load = async (): Promise<JobDoc> => {
    const job = await jobs.findOne(filter)
    if (!job) throw apiError('notFound', 'job not found')
    return job
  }
  const job = await loadWithWait(event, {
    waitSeconds: wait,
    userId: principal.user.id,
    load,
    settled: (current) => (TERMINAL_JOB_STATES as readonly string[]).includes(current.state),
    watch: { collection: jobs as never, id },
  })
  return toApiJob(job)
})
