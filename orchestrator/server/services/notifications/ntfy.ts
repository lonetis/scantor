import { scantorVersion } from '../../utils/version'

/*
 * The ntfy client (docs/api.md §4.3, https://docs.ntfy.sh/publish/#publish-as-json): one JSON publish to the root of
 * the operator's ntfy server (SCANTOR_NTFY_URL), with the user's access token as a Bearer token when one is stored.
 * The server URL never comes from a request (security.md NTF-1), and redirects are not followed, so a publish only
 * ever reaches that server. The outcome says whether a failure is worth a retry: 408, 429, 5xx and unreachable
 * servers are; other answers (an unknown or forbidden topic, a wrong token) are not.
 */

export const NTFY_TIMEOUT_MS = 10_000
const MAX_ERROR_LENGTH = 300

/** ntfy priorities: 1 min, 2 low, 3 default, 4 high, 5 max. */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5

export interface NtfyMessage {
  title: string
  message: string
  priority: NtfyPriority
  /** emoji short codes and plain tags */
  tags: string[]
  /** opened when the notification is tapped */
  click?: string
}

export interface NtfyTarget {
  /** base URL of the ntfy server, without a trailing slash */
  server: string
  topic: string
  token: string | null
}

export interface DeliveryOutcome {
  ok: boolean
  /** HTTP status of the answer; null when the server could not be reached */
  status: number | null
  /** the failure, for the user; null after a success */
  message: string | null
  retryable: boolean
}

export interface PublishOptions {
  /** aborts the publish (the job's signal); an abort is thrown, never reported as an outcome */
  signal?: AbortSignal
  timeoutMs?: number
  fetch?: typeof fetch
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** ntfy errors are `{"code":40101,"http":401,"error":"unauthorized",…}`; anything else is shown as text. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch {
    // not JSON
  }
  return body.trim() || 'no details'
}

/** The first `max` bytes of the answer body (an error answer is small; nothing more is buffered). */
async function readBounded(response: Response, max = 4096): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < max) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    // a broken answer body adds no details
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8')
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export async function publishNtfy(target: NtfyTarget, message: NtfyMessage, options: PublishOptions = {}): Promise<DeliveryOutcome> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? NTFY_TIMEOUT_MS)]
  if (options.signal) signals.push(options.signal)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': `scantor/${scantorVersion}` }
  if (target.token) headers.authorization = `Bearer ${target.token}`
  const body = JSON.stringify({ topic: target.topic, ...message })
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${target.server}/`, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${options.timeoutMs ?? NTFY_TIMEOUT_MS} ms` : (error as Error).message
    return { ok: false, status: null, message: truncate(`the ntfy server could not be reached: ${reason}`, MAX_ERROR_LENGTH), retryable: true }
  }
  const text = await readBounded(response)
  if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, message: null, retryable: false }
  const detail = response.status >= 300 && response.status < 400 ? 'redirects are not followed' : errorText(text)
  return {
    ok: false,
    status: response.status,
    message: truncate(`the ntfy server answered ${response.status}: ${detail}`, MAX_ERROR_LENGTH),
    retryable: isRetryableStatus(response.status),
  }
}
