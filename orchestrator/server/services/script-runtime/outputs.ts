import { randomUUID } from 'node:crypto'
import type { Filter, UpdateFilter } from 'mongodb'
import type { ScriptRunDoc, ScriptRunOutputDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError, validationError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'
import {
  abortMultipartUpload,
  type CompletedPart,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  headObject,
  presignInternalGet,
  presignUploadPart,
  s3ErrorCode,
  safeName,
} from '../../utils/s3'
import { isoDate } from '../../utils/serialize'
import { reserveStorage } from '../runtime/uploads'
import { FILE_URL_TTL_SECONDS, OUTPUT_PART_BYTES } from './limits'
import type { CompleteScriptOutputBody, CreateScriptOutputBody, CreateScriptOutputPartBody } from './schemas'

/*
 * Output files of script runs (docs/scripts.md, docs/data-model.md §9): S3 multipart uploads the script performs
 * itself through presigned UploadPart URLs of the internal endpoint.
 *
 *   create    a `pending` output with its multipart upload at `script-runs/<runId>/outputs/<outputId>/<safeName>`;
 *             idempotent on the name: the pending output of the same name and type is returned (200), a stored one
 *             or one of another type is 409 alreadyExists; at most SCANTOR_SCRIPT_RUN_MAX_OUTPUTS per run
 *   parts     one presigned PUT per part with its Content-Length signed; the size is reserved against
 *             SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES for all outputs of the run together (checked in the reserving write,
 *             so concurrent parts cannot pass it together; 413) and then against the owner's storage quota (403; the
 *             run's reservation is released again)
 *   complete  CompleteMultipartUpload, then HEAD for the stored size → `stored` with the SHA-256 the script reports
 *             (not verified by the server); idempotent
 *   finish    abortPendingOutputs drops the outputs a run left pending (the run's finish path calls it)
 *
 * Keys are generated here only; the bucket's abort-incomplete-multipart rule cleans uploads nobody aborted.
 */

const log = useLogger('script-runtime')

export const DEFAULT_OUTPUT_CONTENT_TYPE = 'application/octet-stream'

/** The S3 key of an output (docs/data-model.md §9). */
export function outputKey(scriptRunId: string, outputId: string, name: string): string {
  return `script-runs/${scriptRunId}/outputs/${outputId}/${safeName(name)}`
}

/** Object metadata of an output; header values must be ASCII. */
export function outputMetadata(outputId: string, name: string): Record<string, string> {
  return { 'output-id': outputId, name: encodeURIComponent(name) }
}

/** The outputs-related part of a run document. */
export type OutputsView = Pick<ScriptRunDoc, '_id' | 'userId' | 'outputs' | 'restartedFrom'>

/**
 * The run-document writes of the output state machine. Every write is one conditional update, so concurrent requests
 * of the same run cannot push two outputs of one name, exceed the count limit or store an output twice.
 */
export interface OutputStore {
  /** the run while it is `running`, else null */
  loadRunning(scriptRunId: string, userId: string): Promise<OutputsView | null>
  /** the run a resumed run continues (any state), else null */
  loadOriginal(scriptRunId: string, userId: string): Promise<Pick<ScriptRunDoc, 'outputs'> | null>
  /** appends `output` unless the run has one of that name or `maxOutputs` already, or is not running */
  push(scriptRunId: string, output: ScriptRunOutputDoc, maxOutputs: number, now: Date): Promise<boolean>
  /**
   * adds `bytes` to a pending output's reservation of a running run unless the run's outputs would then hold more than
   * `maxBytes` (runOutputBytes): the check and the reservation are one write, so concurrent parts never pass the cap
   */
  reserve(scriptRunId: string, outputId: string, bytes: number, maxBytes: number, now: Date): Promise<boolean>
  /** takes `bytes` off a pending output's reservation again (the owner's quota refused the part) */
  unreserve(scriptRunId: string, outputId: string, bytes: number, now: Date): Promise<void>
  /** a pending output of a running run becomes stored (renamed to `name` when given and no output has that name) */
  markStored(scriptRunId: string, outputId: string, stored: { size: number; sha256: string; name?: string }, now: Date): Promise<boolean>
  /** removes the given outputs while they are pending */
  removePending(scriptRunId: string, outputIds: readonly string[], now: Date): Promise<void>
}

export const mongoOutputStore: OutputStore = {
  async loadRunning(scriptRunId, userId) {
    return useCollections().scriptRuns.findOne(
      { _id: scriptRunId, userId, state: 'running' },
      { projection: { _id: 1, userId: 1, outputs: 1, restartedFrom: 1 } },
    )
  },
  async loadOriginal(scriptRunId, userId) {
    return useCollections().scriptRuns.findOne({ _id: scriptRunId, userId }, { projection: { outputs: 1 } })
  },
  async push(scriptRunId, output, maxOutputs, now) {
    const written = await useCollections().scriptRuns.updateOne(
      { _id: scriptRunId, state: 'running', 'outputs.name': { $ne: output.name }, [`outputs.${maxOutputs - 1}`]: { $exists: false } },
      { $push: { outputs: output }, $set: { updatedAt: now } },
    )
    return written.modifiedCount > 0
  },
  async reserve(scriptRunId, outputId, bytes, maxBytes, now) {
    // runOutputBytes as an expression; MongoDB re-evaluates the filter after a write conflict, so concurrent
    // reservations of one run serialise on it.
    const heldBytes = {
      $sum: {
        $map: {
          input: '$outputs',
          as: 'o',
          in: { $cond: [{ $eq: ['$$o.state', 'stored'] }, { $ifNull: ['$$o.size', 0] }, '$$o.reservedBytes'] },
        },
      },
    }
    const written = await useCollections().scriptRuns.updateOne(
      {
        _id: scriptRunId,
        state: 'running',
        outputs: { $elemMatch: { id: outputId, state: 'pending' } },
        $expr: { $lte: [{ $add: [bytes, heldBytes] }, maxBytes] },
      },
      { $inc: { 'outputs.$[output].reservedBytes': bytes }, $set: { updatedAt: now } },
      { arrayFilters: [{ 'output.id': outputId, 'output.state': 'pending' }] },
    )
    return written.modifiedCount > 0
  },
  async unreserve(scriptRunId, outputId, bytes, now) {
    await useCollections().scriptRuns.updateOne(
      { _id: scriptRunId, outputs: { $elemMatch: { id: outputId, state: 'pending' } } },
      { $inc: { 'outputs.$[output].reservedBytes': -bytes }, $set: { updatedAt: now } },
      { arrayFilters: [{ 'output.id': outputId, 'output.state': 'pending' }] },
    )
  },
  async markStored(scriptRunId, outputId, stored, now) {
    const written = await useCollections().scriptRuns.updateOne(
      {
        _id: scriptRunId,
        state: 'running',
        outputs: { $elemMatch: { id: outputId, state: 'pending' } },
        ...(stored.name === undefined ? {} : { 'outputs.name': { $ne: stored.name } }),
      },
      {
        $set: {
          ...(stored.name === undefined ? {} : { 'outputs.$.name': stored.name }),
          'outputs.$.state': 'stored',
          'outputs.$.size': stored.size,
          'outputs.$.sha256': stored.sha256,
          'outputs.$.uploadId': null,
          'outputs.$.reservedBytes': 0,
          'outputs.$.storedAt': now,
          updatedAt: now,
        },
      },
    )
    return written.modifiedCount > 0
  },
  async removePending(scriptRunId, outputIds, now) {
    if (outputIds.length === 0) return
    const pending: Filter<ScriptRunOutputDoc> = { id: { $in: [...outputIds] }, state: 'pending' }
    await useCollections().scriptRuns.updateOne({ _id: scriptRunId }, { $pull: { outputs: pending }, $set: { updatedAt: now } } as UpdateFilter<ScriptRunDoc>)
  },
}

export interface RuntimeOutput {
  id: string
  name: string
  size: number
  sha256: string
  contentType: string
  createdAt: string
}

export function toRuntimeOutput(output: ScriptRunOutputDoc): RuntimeOutput {
  return {
    id: output.id,
    name: output.name,
    size: output.size ?? 0,
    sha256: output.sha256 ?? '',
    contentType: output.contentType,
    createdAt: isoDate(output.createdAt),
  }
}

async function runningOutputs(principal: ScriptRunPrincipal, store: OutputStore): Promise<OutputsView> {
  const run = await store.loadRunning(principal.scriptRun.id, principal.scriptRun.userId)
  if (!run) throw apiError('unauthorized', 'the script run is no longer running')
  return run
}

function findOutput(run: Pick<ScriptRunDoc, 'outputs'>, outputId: string): ScriptRunOutputDoc {
  const output = (run.outputs ?? []).find((candidate) => candidate.id === outputId)
  if (!output) throw apiError('notFound', 'output not found')
  return output
}

function tooManyOutputs(maxOutputs: number) {
  return validationError([{ path: 'name', message: `a script run may store at most ${maxOutputs} outputs` }], 'too many outputs')
}

export interface CreatedOutput {
  created: boolean
  body: { output: { id: string; name: string; contentType: string }; partBytes: number }
}

function existingOutput(output: ScriptRunOutputDoc, contentType: string): CreatedOutput {
  if (output.state === 'stored') throw apiError('alreadyExists', `an output named "${output.name}" is already stored`)
  if (output.contentType !== contentType) {
    throw apiError('alreadyExists', `an output named "${output.name}" is being uploaded with the content type ${output.contentType}`)
  }
  return { created: false, body: { output: { id: output.id, name: output.name, contentType: output.contentType }, partBytes: OUTPUT_PART_BYTES } }
}

/** scriptRuntimeCreateOutput (see the header). */
export async function createOutput(
  principal: ScriptRunPrincipal,
  body: CreateScriptOutputBody,
  config: Pick<Config, 'scriptRunMaxOutputs'>,
  store: OutputStore = mongoOutputStore,
  now = new Date(),
): Promise<CreatedOutput> {
  const runId = principal.scriptRun.id
  const contentType = body.contentType ?? DEFAULT_OUTPUT_CONTENT_TYPE
  const run = await runningOutputs(principal, store)
  const existing = run.outputs.find((output) => output.name === body.name)
  if (existing) return existingOutput(existing, contentType)
  if (run.outputs.length >= config.scriptRunMaxOutputs) throw tooManyOutputs(config.scriptRunMaxOutputs)

  const id = randomUUID()
  const key = outputKey(runId, id, body.name)
  const uploadId = await createMultipartUpload(key, contentType, outputMetadata(id, body.name))
  const output: ScriptRunOutputDoc = {
    id,
    name: body.name,
    key,
    contentType,
    state: 'pending',
    uploadId,
    reservedBytes: 0,
    size: null,
    sha256: null,
    createdAt: now,
    storedAt: null,
  }
  if (await store.push(runId, output, config.scriptRunMaxOutputs, now)) {
    return { created: true, body: { output: { id, name: body.name, contentType }, partBytes: OUTPUT_PART_BYTES } }
  }
  // A concurrent request created the name first, the limit was reached meanwhile or the run ended.
  await abortMultipartUpload(key, uploadId).catch((error: unknown) => log.warn('aborting an unused output upload failed', { scriptRunId: runId, err: error }))
  const fresh = await runningOutputs(principal, store)
  const raced = fresh.outputs.find((candidate) => candidate.name === body.name)
  if (raced) return existingOutput(raced, contentType)
  throw tooManyOutputs(config.scriptRunMaxOutputs)
}

/** Bytes the outputs of a run hold against SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES: stored sizes plus pending reservations. */
export function runOutputBytes(outputs: readonly ScriptRunOutputDoc[]): number {
  return outputs.reduce((sum, output) => sum + (output.state === 'stored' ? (output.size ?? 0) : output.reservedBytes), 0)
}

function outputBytesExceeded(limit: number, used: number) {
  return apiError('payloadTooLarge', `the outputs of a script run may hold at most ${limit} bytes`, { limit, used })
}

export interface PresignedOutputPart {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: string
}

/** scriptRuntimeCreateOutputPart (see the header). */
export async function presignOutputPart(
  principal: ScriptRunPrincipal,
  outputId: string,
  body: CreateScriptOutputPartBody,
  config: Pick<Config, 'scriptRunMaxOutputBytes' | 'userStorageQuotaBytes' | 'uploadTimeoutMs'>,
  store: OutputStore = mongoOutputStore,
  now = new Date(),
): Promise<PresignedOutputPart> {
  const runId = principal.scriptRun.id
  const limit = config.scriptRunMaxOutputBytes
  const run = await runningOutputs(principal, store)
  const output = findOutput(run, outputId)
  if (output.state !== 'pending' || !output.uploadId)
    throw apiError('invalidState', 'the output is already stored', { state: output.state, allowed: ['pending'] })
  const used = runOutputBytes(run.outputs)
  if (used + body.size > limit) throw outputBytesExceeded(limit, used)
  // The run's cap first (one conditional write, also under concurrent parts), then the owner's quota.
  if (!(await store.reserve(runId, outputId, body.size, limit, now))) {
    const fresh = await runningOutputs(principal, store)
    const current = findOutput(fresh, outputId)
    if (current.state !== 'pending') throw apiError('invalidState', 'the output is already stored', { state: current.state, allowed: ['pending'] })
    throw outputBytesExceeded(limit, runOutputBytes(fresh.outputs))
  }
  try {
    await reserveStorage(run.userId, body.size, config.userStorageQuotaBytes)
  } catch (error) {
    await store
      .unreserve(runId, outputId, body.size, now)
      .catch((unreserveError: unknown) => log.warn('releasing an output part reservation failed', { scriptRunId: runId, err: unreserveError }))
    throw error
  }
  const signed = await presignUploadPart({
    key: output.key,
    uploadId: output.uploadId,
    partNumber: body.partNumber,
    contentLength: body.size,
    expiresInSeconds: Math.max(1, Math.round(config.uploadTimeoutMs / 1000)),
    profile: 'internal',
  })
  return { url: signed.url, method: 'PUT', headers: signed.headers, expiresAt: isoDate(signed.expiresAt) }
}

/** S3 answers for parts the client got wrong (not a server failure). */
const CLIENT_PART_ERRORS = new Set(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'MalformedXML', 'InvalidArgument'])

/** scriptRuntimeCompleteOutput (see the header). */
export async function completeOutput(
  principal: ScriptRunPrincipal,
  outputId: string,
  body: CompleteScriptOutputBody,
  store: OutputStore = mongoOutputStore,
  now = new Date(),
): Promise<{ output: RuntimeOutput }> {
  const runId = principal.scriptRun.id
  const run = await runningOutputs(principal, store)
  const output = findOutput(run, outputId)
  if (output.state === 'stored') return { output: toRuntimeOutput(output) }
  const rename = body.name !== undefined && body.name !== output.name ? body.name : undefined
  if (rename !== undefined && run.outputs.some((candidate) => candidate.name === rename)) {
    throw apiError('alreadyExists', `an output named "${rename}" already exists`)
  }
  try {
    await completeMultipartUpload(output.key, output.uploadId!, body.parts as CompletedPart[])
  } catch (error) {
    const code = s3ErrorCode(error)
    if (code === 'NoSuchUpload') {
      // A concurrent complete of the same output finished first.
      const fresh = findOutput(await runningOutputs(principal, store), outputId)
      if (fresh.state === 'stored') return { output: toRuntimeOutput(fresh) }
      throw apiError('invalidState', 'the upload of the output no longer exists', { state: 'aborted', allowed: ['pending'] })
    }
    if (code && CLIENT_PART_ERRORS.has(code))
      throw validationError([{ path: 'parts', message: `S3 rejected the parts (${code})` }], 'the parts cannot be combined')
    throw error
  }
  const head = await headObject(output.key)
  if (!head) throw new Error(`the completed output ${output.key} is missing`)
  if (head.size > output.reservedBytes) {
    // Unreachable while every part is presigned with its Content-Length: never store more than was reserved.
    await deleteObject(output.key)
    await store.removePending(runId, [outputId], now)
    throw validationError([{ path: 'parts', message: 'the parts hold more bytes than were presigned' }], 'the parts cannot be combined')
  }
  const stored = { size: head.size, sha256: body.sha256, ...(rename === undefined ? {} : { name: rename }) }
  if (!(await store.markStored(runId, outputId, stored, now))) {
    const fresh = await runningOutputs(principal, store)
    const current = findOutput(fresh, outputId)
    if (current.state === 'stored') return { output: toRuntimeOutput(current) }
    if (rename !== undefined && fresh.outputs.some((candidate) => candidate.name === rename)) {
      throw apiError('alreadyExists', `an output named "${rename}" already exists`)
    }
    throw apiError('invalidState', 'the output cannot be stored', { state: current.state, allowed: ['pending'] })
  }
  return { output: toRuntimeOutput({ ...output, ...stored, state: 'stored', storedAt: now }) }
}

export interface OutputUrl {
  url: string
  expiresAt: string
  name: string
  size: number
  sha256: string
  contentType: string
}

/**
 * scriptRuntimeOutputUrl: a presigned internal GET of a stored output of the run, or of the run it continues when it
 * was restarted with `resume` (404 otherwise).
 */
export async function outputUrl(principal: ScriptRunPrincipal, outputId: string, store: OutputStore = mongoOutputStore, now = new Date()): Promise<OutputUrl> {
  const run = await runningOutputs(principal, store)
  let output = run.outputs.find((candidate) => candidate.id === outputId)
  if (!output && run.restartedFrom?.resume) {
    output = (await store.loadOriginal(run.restartedFrom.id, run.userId))?.outputs?.find((candidate) => candidate.id === outputId)
  }
  if (output?.state !== 'stored') throw apiError('notFound', 'output not found')
  const { url, expiresAt } = presignInternalGet(output.key, FILE_URL_TTL_SECONDS, now)
  return { url, expiresAt: isoDate(expiresAt), name: output.name, size: output.size ?? 0, sha256: output.sha256 ?? '', contentType: output.contentType }
}

/**
 * Aborts the multipart uploads of the outputs a run left pending and drops them from the run (the run's finish path
 * calls it). An upload whose abort fails is still dropped: the bucket's abort-incomplete-multipart rule removes it.
 */
export async function abortPendingOutputs(run: Pick<ScriptRunDoc, '_id' | 'outputs'>, store: OutputStore = mongoOutputStore, now = new Date()): Promise<void> {
  const pending = (run.outputs ?? []).filter((output) => output.state === 'pending')
  if (pending.length === 0) return
  await Promise.all(
    pending.map(async (output) => {
      if (!output.uploadId) return
      try {
        await abortMultipartUpload(output.key, output.uploadId)
      } catch (error) {
        log.warn('aborting the upload of a pending output failed', { scriptRunId: run._id, outputId: output.id, err: error })
      }
    }),
  )
  await store.removePending(
    run._id,
    pending.map((output) => output.id),
    now,
  )
}
