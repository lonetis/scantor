import { defineEventHandler, toWebRequest } from 'h3'
import { useAuth } from '../../utils/auth'

// better-auth (docs/api.md §3): every `/api/auth/*` endpoint. Not part of the OpenAPI operation registry; the auth
// middleware rejects API keys here and applies credential-less CORS to JWKS, token and registration.

export default defineEventHandler((event) => useAuth().handler(toWebRequest(event)))
