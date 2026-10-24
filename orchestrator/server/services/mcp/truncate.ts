// Response cap of MCP tool results (docs/mcp.md §4.5): 256 KiB of UTF-8 text. Deterministic truncation: keep the
// longest prefix of a top-level `items`/`analyses`/`entries`/`lines` array (with `_truncated` and, for lists paginated
// by seq, a cursor after the last kept item), then shorten long strings (4 KiB, then 1 KiB), then cut the text on a
// UTF-8 boundary. Truncation works on the REST value and measures what is rendered (`present`: the untrusted_data
// wrapping of §4.6 and `_wait`), so the cursor reads the kept items themselves, not their wrappers.

export const MCP_RESPONSE_CAP_BYTES = 256 * 1024
const ARRAY_FIELDS = ['items', 'analyses', 'entries', 'lines'] as const

export interface CappedText {
  text: string
  /** present when something was dropped; becomes the second text block */
  note?: string
}

export interface CapOptions {
  /** the cap in UTF-8 bytes (default 256 KiB) */
  cap?: number
  /** turns a (truncated) value into what is rendered; the default renders the value itself */
  present?: (value: unknown) => unknown
  /** the list is paginated by seq (`afterSeq`): a cut list's `nextCursor` becomes the seq of its last kept item */
  seqCursor?: boolean
}

/**
 * Operations whose top-level list is paginated by seq for the given arguments (docs/mcp.md §4.5). With `sort`,
 * queryAnalyses returns items out of seq order and `nextCursor: null` (docs/api.md §5), so no cursor applies.
 */
const SEQ_PAGINATED: Record<string, (args: Record<string, unknown>) => boolean> = {
  queryAnalyses: (args) => args.sort === undefined,
}

export function isSeqPaginated(operationId: string, args: Record<string, unknown>): boolean {
  return SEQ_PAGINATED[operationId]?.(args) ?? false
}

/**
 * The `afterSeq` cursor after an analysis: its `seq`, else the seq suffix of its id `<scanId>-<seq>` (a projection
 * without `seq` keeps the id); null when the item carries neither.
 */
export function seqCursorOf(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null
  const { seq, id } = item as { seq?: unknown; id?: unknown }
  if (typeof seq === 'number' && Number.isSafeInteger(seq)) return String(seq)
  if (typeof id !== 'string') return null
  const suffix = id.slice(id.lastIndexOf('-') + 1)
  return /^\d+$/.test(suffix) && Number.isSafeInteger(Number(suffix)) ? String(Number(suffix)) : null
}

function render(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function shortenStrings(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    const size = bytes(value)
    if (size <= limit) return value
    const cut = Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8').replace(/�$/, '')
    return `${cut}…[truncated ${size - bytes(cut)} bytes]`
  }
  if (Array.isArray(value)) return value.map((item) => shortenStrings(item, limit))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenStrings(item, limit)]))
  }
  return value
}

/** Cuts `text` to at most `cap` bytes without splitting a UTF-8 sequence. */
export function cutUtf8(text: string, cap: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= cap) return text
  let end = cap
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

function note(what: string): string {
  return `[scantor] Response truncated to 256 KiB (${what}). Narrow it with limit, fields/projection, filter or afterSeq.`
}

/** Serialises a JSON value for a tool result, applying the cap. */
export function capJson(value: unknown, options: CapOptions = {}): CappedText {
  const cap = options.cap ?? MCP_RESPONSE_CAP_BYTES
  const present = options.present ?? ((candidate: unknown) => candidate)
  const show = (candidate: unknown) => render(present(candidate))
  let text = show(value)
  if (bytes(text) <= cap) return { text }
  const dropped: string[] = []
  let current = value

  if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    const record = current as Record<string, unknown>
    const field = ARRAY_FIELDS.find((key) => Array.isArray(record[key]))
    if (field) {
      const list = record[field] as unknown[]
      const build = (count: number) => {
        const next: Record<string, unknown> = { ...record, [field]: list.slice(0, count), _truncated: { field, returned: count, total: list.length } }
        if (options.seqCursor && 'nextCursor' in record) next.nextCursor = count > 0 ? seqCursorOf(list[count - 1]) : null
        return next
      }
      let low = 0
      let high = list.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (bytes(show(build(mid))) <= cap) low = mid
        else high = mid - 1
      }
      current = build(low)
      dropped.push(`${field}: returned ${low} of ${list.length}`)
      text = show(current)
      if (bytes(text) <= cap) return { text, note: note(dropped.join('; ')) }
    }
  }

  for (const limit of [4096, 1024]) {
    current = shortenStrings(current, limit)
    text = show(current)
    if (bytes(text) <= cap) {
      dropped.push(`strings longer than ${limit} bytes shortened`)
      return { text, note: note(dropped.join('; ')) }
    }
  }

  dropped.push('hard cut; the text is not valid JSON')
  return { text: cutUtf8(text, cap), note: note(dropped.join('; ')) }
}

/** Caps plain text (for example markdown guides). */
export function capText(text: string, cap = MCP_RESPONSE_CAP_BYTES): CappedText {
  if (bytes(text) <= cap) return { text }
  return { text: cutUtf8(text, cap), note: note('text cut at the cap') }
}
