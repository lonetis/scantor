import type { TemplateEstimate } from '#shared/types/catalog'
import type { ValidationIssue } from '#shared/types/common'
import { useConfig } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { expandPointer, parsePointer } from '../../utils/secrets'
import { validateConfig } from '../configs/validate'
import { pipelineEnv } from '../pipeline/binary'
import { runScantorCommand } from '../pipeline/command'
import { findTemplate } from './templates'

// Template estimates (docs/api.md §4.12, §5.1 step 9; docs/templates.md §2, §5): the scan config is validated with
// defaults against the template's canonical schema, then `scantor templates estimate <name> --config -
// [--upload <id>=<lines>]…` runs as a subprocess without network. Exit 0 prints {expectedTotal, exact}; exit 2 prints
// {issues} for semantic rules JSON Schema cannot express, which become 422 configInvalid (JSON pointers into the
// request body, under /scanConfig).

const ESTIMATE_TIMEOUT_MS = 30_000

export interface EstimateOptions {
  /**
   * Restricts referenced uploads to this owner (the estimate route). Callers that already checked upload ownership
   * (scan start, docs/api.md §5.1 step 8) omit it.
   */
  userId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Instance paths of `"x-scantor": "upload"` fields of a (template) scan config schema (top-level properties). */
export function uploadPointers(schema: Record<string, unknown>): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  return Object.entries(properties)
    .filter(([, property]) => isRecord(property) && property['x-scantor'] === 'upload')
    .map(([name]) => `/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`)
}

/** Upload ids referenced by a config at the given pointers. */
export function referencedUploadIds(config: Record<string, unknown>, pointers: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const pattern of pointers) {
    for (const pointer of expandPointer(config, pattern)) {
      let node: unknown = config
      for (const segment of parsePointer(pointer)) {
        if (Array.isArray(node)) node = /^\d+$/.test(segment) ? node[Number(segment)] : undefined
        else node = isRecord(node) ? node[segment] : undefined
      }
      if (typeof node === 'string' && node.length > 0) ids.add(node)
    }
  }
  return [...ids]
}

function prefixIssues(issues: unknown): ValidationIssue[] {
  if (!Array.isArray(issues)) return [{ path: '/scanConfig', message: 'rejected by the template' }]
  return issues.slice(0, 100).map((issue: unknown) => {
    const record = isRecord(issue) ? issue : {}
    const path = typeof record.path === 'string' ? record.path : ''
    return { path: `/scanConfig${path}`, message: typeof record.message === 'string' ? record.message : 'invalid' }
  })
}

/**
 * Estimates the number of analyses of a template scan config. Throws 404 notFound for an unknown template or upload
 * and 422 configInvalid for a config the template rejects.
 */
export async function estimateTemplate(template: string, scanConfig: unknown, options: EstimateOptions = {}): Promise<TemplateEstimate> {
  const definition = await findTemplate(template)
  if (!definition) throw apiError('notFound', `template ${template} not found`)
  const validated = validateConfig('scanConfig', definition.scanConfigSchema, scanConfig ?? {})
  if (validated.issues.length > 0) {
    throw apiError('configInvalid', `scan config rejected by template ${template}: ${validated.issues[0]!.path} ${validated.issues[0]!.message}`, {
      issues: validated.issues,
    })
  }
  const effective = validated.value as Record<string, unknown>

  const uploadIds = referencedUploadIds(effective, uploadPointers(definition.scanConfigSchema))
  const uploadArgs: string[] = []
  if (uploadIds.length > 0) {
    const filter = options.userId ? { _id: { $in: uploadIds }, userId: options.userId } : { _id: { $in: uploadIds } }
    const uploads = await useCollections().uploads.find(filter, { projection: { _id: 1, lines: 1 } }).toArray()
    for (const id of uploadIds) {
      const upload = uploads.find((candidate) => candidate._id === id)
      if (!upload) throw apiError('notFound', `upload ${id} not found`)
      uploadArgs.push('--upload', `${id}=${upload.lines}`)
    }
  }

  const config = useConfig()
  const result = await runScantorCommand(['templates', 'estimate', template, '--config', '-', ...uploadArgs], {
    stdin: JSON.stringify(effective),
    env: pipelineEnv(config),
    timeoutMs: ESTIMATE_TIMEOUT_MS,
  }).catch((error: unknown) => {
    useLogger('catalog').error('running the template estimate failed', { template, err: error })
    throw apiError('internal', 'the template estimate could not run')
  })
  if (result.exitCode === 2) {
    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      body = null
    }
    const issues = prefixIssues(isRecord(body) ? body.issues : undefined)
    throw apiError('configInvalid', `scan config rejected by template ${template}: ${issues[0]?.path ?? ''} ${issues[0]?.message ?? ''}`.trim(), { issues })
  }
  if (result.exitCode !== 0) {
    useLogger('catalog').error('template estimate failed', { template, exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr.slice(-2000) })
    throw apiError('internal', 'the template estimate failed')
  }
  let output: unknown
  try {
    output = JSON.parse(result.stdout)
  } catch {
    output = null
  }
  if (!isRecord(output) || !('expectedTotal' in output)) throw apiError('internal', 'the template estimate returned no result')
  const expectedTotal = typeof output.expectedTotal === 'number' && Number.isFinite(output.expectedTotal) ? output.expectedTotal : null
  return {
    expectedTotal,
    exact: output.exact === true,
    confirmationRequired: expectedTotal !== null && expectedTotal > config.scanConfirmThreshold,
    tooLarge: expectedTotal !== null && expectedTotal > config.maxAnalysesPerScan,
  }
}
