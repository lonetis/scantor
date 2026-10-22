import { getRequestURL } from 'h3'
import { defineNitroPlugin } from 'nitropack/runtime'
import { type OpenApiDocument, publishedOpenApiDocument } from '../utils/operations'

// Nitro generates /api/docs/openapi.json from every handler it has (docs/api.md §1.1). The response is narrowed to
// the API operations before it is sent, for every reader alike: clients, the Scalar UI at /api/docs, the operation
// registry and the MCP tool catalogue (both load it through localFetch).

const DOCUMENT_PATH = '/api/docs/openapi.json'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event, response) => {
    if (getRequestURL(event).pathname !== DOCUMENT_PATH) return
    const body = response.body
    if (!body || typeof body !== 'object' || !('paths' in body)) return
    response.body = publishedOpenApiDocument(body as OpenApiDocument)
  })
})
