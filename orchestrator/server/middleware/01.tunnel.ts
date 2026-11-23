import { defineEventHandler } from 'h3'
import { apiError } from '../utils/errors'
import { rawPathOf } from '../utils/request-path'
import { isTunnelRefusedPath, isTunnelRequest } from '../utils/tunnel'

// Tunnel requests (docs/auth.md §1, utils/tunnel.ts): the node, worker and script runtime APIs, the admin tools, the
// registry token realm and the editor do not exist through the tunnel URL, so every path below them is 404 notFound,
// as for an unknown operation. Sorted after 01.path.ts (the path is canonical) and before 02.body-limit.ts and
// 10.auth.ts, so no body is read and no credential is looked at. Pages pass; the UI hides what the tunnel lacks.

export default defineEventHandler((event) => {
  if (!isTunnelRequest(event)) return
  const path = rawPathOf(event.path)
  if (isTunnelRefusedPath(path)) throw apiError('notFound', `no operation at ${path}`)
})
