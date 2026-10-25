import { defineEventHandler, setResponseHeader } from 'h3'
import { useRuntimeConfig } from 'nitropack/runtime'
import { renderApiDocsPage } from '../../utils/api-docs'

// The Scalar API reference (docs/ui.md §13): public like the OpenAPI document it renders, with the docs CSP of
// utils/security-headers.ts. It replaces Nitro's built-in Scalar page, which loaded an unpinned bundle
// (utils/api-docs.ts).

interface OpenApiRuntimeConfig {
  route?: string
  meta?: { title?: string; description?: string }
}

export default defineEventHandler((event) => {
  const openAPI = (useRuntimeConfig(event).nitro as { openAPI?: OpenApiRuntimeConfig } | undefined)?.openAPI
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  return renderApiDocsPage({
    title: openAPI?.meta?.title ?? 'API Reference',
    description: openAPI?.meta?.description ?? '',
    documentUrl: openAPI?.route ?? '/api/docs/openapi.json',
  })
})
