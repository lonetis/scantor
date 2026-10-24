import type { MaybeRefOrGetter } from 'vue'
import type { Analysis, AnalysisAggregateResult, AnalysisQueryResult } from '#shared/types/analyses'
import type { FileRef, Page } from '#shared/types/common'
import type { FileDownload } from '#shared/types/exports'
import { ANALYSIS_STATUSES, type AnalysisStatus } from '#shared/utils/enums'

// Analyses of one scan (docs/ui.md §5.13.2–§5.13.4; docs/api.md §4.14, §4.15): listAnalyses with a field projection
// for the results table, getAnalysis for the slideover, queryAnalyses/aggregateAnalyses for the query console and
// getFileDownload for files. Everything returned here is untrusted data and is rendered as text only.

export const RESULTS_PAGE_SIZE = 50
/** Rows kept in memory by the results table (docs/ui.md §5.13.2). */
export const RESULTS_MAX_ROWS = 5000
/** Rows re-read by the results table's auto-refresh. */
export const RESULTS_REFRESH_ROWS = 1000
export const MAX_RESULT_COLUMNS = 4

/** The projection of a results table row besides the chosen result columns. */
export const RESULT_ROW_FIELDS = ['id', 'seq', 'status', 'attempt', 'round', 'error.type', 'error.message', 'timings', 'files'] as const

/** A row of the results table: the projected fields of one analysis. */
export interface AnalysisRow {
  id: string
  seq: number
  status: AnalysisStatus
  attempt?: number
  round?: number
  error?: { type?: string, message?: string }
  timings?: { scheduledAt?: string | null, startedAt?: string | null, finishedAt?: string | null, durationMs?: number | null }
  files?: FileRef[]
  result?: Record<string, unknown>
  [field: string]: unknown
}

/** Filters of the results tab (ResultsFilterBar ↔ ScanResultsTable). */
export interface ResultsFilters {
  statuses: AnalysisStatus[]
  /** Advanced JSON filter text; null shows the status filter instead (queryAnalyses vs listAnalyses). */
  advanced: string | null
  /** Result properties shown as columns (at most MAX_RESULT_COLUMNS). */
  columns: string[]
  autoRefresh: boolean
}

/**
 * Analysis statuses from a route query value (`?status=failed,lost`, repeated keys) or a status list, in canonical
 * order without duplicates; unknown values are ignored.
 */
export function analysisStatusesOf(value: unknown): AnalysisStatus[] {
  const raw = (Array.isArray(value) ? value : [value]).flatMap((entry: unknown) => (typeof entry === 'string' ? entry.split(',') : []))
  return ANALYSIS_STATUSES.filter((status) => raw.includes(status))
}

/**
 * The name of a file chip's download button: "Download <file> of analysis <seq>". The analysis distinguishes the
 * chips of different result rows, which often carry files of the same name (docs/ui.md §11 rule 1).
 */
export function fileDownloadLabel(fileName: string, analysisId: string): string {
  const seq = /-(\d+)$/.exec(analysisId)?.[1]
  return seq === undefined ? `Download ${fileName}` : `Download ${fileName} of analysis ${seq}`
}

export function analysisIdOf(scanId: string, seq: number): string {
  return `${scanId}-${seq}`
}

/** The listAnalyses `fields` of a results table row. */
export function resultRowFields(columns: readonly string[]): string[] {
  return [...RESULT_ROW_FIELDS, ...columns.map((column) => `result.${column}`)]
}

/** Top-level property names of a Result JSON Schema, in declaration order. */
export function resultProperties(schema: Record<string, unknown> | null | undefined): string[] {
  const properties = schema?.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? Object.keys(properties) : []
}

/** True for a value shaped like a FileRef `{id, name, size, sha256, contentType}`. */
export function isFileRef(value: unknown): value is FileRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.size === 'number'
    && typeof candidate.sha256 === 'string'
    && typeof candidate.contentType === 'string'
}

/**
 * The FileRefs of a result at the describe output's `fileRefPaths` (JSON pointers relative to the result; `*` matches
 * any array index or property name), with the pointer each was found at.
 */
export function fileRefsAt(result: unknown, pointers: readonly string[]): { pointer: string, file: FileRef }[] {
  const found: { pointer: string, file: FileRef }[] = []
  const walk = (node: unknown, rest: readonly string[], path: readonly string[]) => {
    if (rest.length === 0) {
      if (isFileRef(node)) found.push({ pointer: formatPointer(path), file: node })
      return
    }
    if (node === null || typeof node !== 'object') return
    const [head, ...tail] = rest as [string, ...string[]]
    const keys = head === '*' ? Object.keys(node) : Object.hasOwn(node, head) ? [head] : []
    for (const key of keys) walk((node as Record<string, unknown>)[key], tail, [...path, key])
  }
  for (const pointer of pointers) walk(result, parsePointer(pointer), [])
  return found
}

export function useAnalyses(scanId: MaybeRefOrGetter<string>) {
  const api = useApi()
  const scanPath = () => `/api/scans/${encodeURIComponent(toValue(scanId))}`

  function list(
    params: { status?: readonly AnalysisStatus[], afterSeq?: number | null, limit?: number, fields?: readonly string[] },
    options: { background?: boolean } = {},
  ): Promise<Page<AnalysisRow>> {
    return api<Page<AnalysisRow>>(`${scanPath()}/analyses`, {
      query: apiQuery({ status: params.status, afterSeq: params.afterSeq ?? null, limit: params.limit, fields: params.fields }),
      background: options.background,
    })
  }

  function get(seq: number): Promise<Analysis> {
    return api<Analysis>(`/api/analyses/${encodeURIComponent(analysisIdOf(toValue(scanId), seq))}`, { toast: false })
  }

  /** queryAnalyses; errors are shown inline by the callers (no toast). */
  function query(
    body: { filter: Record<string, unknown>, projection?: Record<string, unknown>, sort?: Record<string, unknown>, limit?: number, afterSeq?: number },
    options: { background?: boolean } = {},
  ): Promise<AnalysisQueryResult> {
    return api<AnalysisQueryResult>(`${scanPath()}/analyses/query`, { method: 'POST', body, toast: false, background: options.background })
  }

  /** aggregateAnalyses; errors are shown inline by the callers (no toast). */
  function aggregate(body: { pipeline: Record<string, unknown>[], limit?: number }): Promise<AnalysisAggregateResult> {
    return api<AnalysisAggregateResult>(`${scanPath()}/analyses/aggregate`, { method: 'POST', body, toast: false })
  }

  function fileDownload(analysisId: string, fileId: string): Promise<FileDownload> {
    return api<FileDownload>(`/api/analyses/${encodeURIComponent(analysisId)}/files/${encodeURIComponent(fileId)}`)
  }

  return { list, get, query, aggregate, fileDownload }
}
