import { getRequestHeader, getRequestURL, type H3Event, readRawBody, setResponseHeader, setResponseStatus } from 'h3'
import type { Logger } from '../../utils/logger'
import { getTokenRequest, issueRegistryToken, logTokenOutcome, postTokenRequest, type RegistryTokenDeps } from './token'

// The HTTP side of the registry token realm (docs/api.md §6): both routes of /api/registry/token parse their flow
// here and answer in the registry format, never with the scantor error envelope. Shared by the Nitro routes and the
// registry integration test, which serves the same handler to a real Docker daemon.

/** A token form is a few hundred bytes; anything far larger is not a token request. */
export const MAX_TOKEN_FORM_BYTES = 64 * 1024

export type RegistryTokenFlow = 'get' | 'post'

export async function handleRegistryTokenEvent(event: H3Event, flow: RegistryTokenFlow, deps: RegistryTokenDeps, log: Logger): Promise<Record<string, unknown>> {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const authorization = getRequestHeader(event, 'authorization')
  let request
  if (flow === 'get') {
    request = getTokenRequest(authorization, getRequestURL(event).searchParams)
  } else {
    const raw = (await readRawBody(event, false)) ?? Buffer.alloc(0)
    if (raw.length > MAX_TOKEN_FORM_BYTES) {
      setResponseStatus(event, 400)
      return { errors: [{ code: 'SIZE_INVALID', message: 'token request body is too large' }] }
    }
    request = postTokenRequest(authorization, new URLSearchParams(raw.toString('utf8')))
  }
  const outcome = await issueRegistryToken(request, deps)
  logTokenOutcome(outcome, log)
  setResponseStatus(event, outcome.status)
  return outcome.body
}
