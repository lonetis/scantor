import { defineEventHandler } from 'h3'
import { apiError } from '../utils/errors'
import { isCanonicalPath, rawPathOf } from '../utils/request-path'

// Canonical request paths (docs/auth.md §1, security.md AUTH-5): a raw path that a URL parser would rewrite (dot
// segments, also percent-encoded, backslashes, repeated leading slashes, characters it percent-encodes) is 400
// badRequest before any other check. Afterwards the router, every middleware and better-auth see the same path,
// so no check keyed on the path can be skipped with another spelling of it.

export default defineEventHandler((event) => {
  if (!isCanonicalPath(rawPathOf(event.node.req.url))) throw apiError('badRequest', 'the request path is not in canonical form')
})
