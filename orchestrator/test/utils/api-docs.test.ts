import { describe, expect, it } from 'vitest'
import { renderApiDocsPage, SCALAR_BUNDLE_INTEGRITY, SCALAR_BUNDLE_URL, SCALAR_VERSION } from '../../server/utils/api-docs'

// The Scalar API reference page (docs/ui.md §13): one pinned bundle, checked by its integrity hash.

describe('renderApiDocsPage', () => {
  const html = renderApiDocsPage({ title: 'scantor API', description: 'REST API of "scantor" <b>', documentUrl: '/api/docs/openapi.json' })

  it('loads exactly the pinned bundle with its integrity hash', () => {
    expect(SCALAR_BUNDLE_URL).toBe(`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`)
    expect(SCALAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(SCALAR_BUNDLE_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/)
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0])
    expect(scripts).toEqual([
      '<script id="api-reference" data-configuration="{&quot;url&quot;:&quot;/api/docs/openapi.json&quot;}">',
      `<script src="${SCALAR_BUNDLE_URL}" integrity="${SCALAR_BUNDLE_INTEGRITY}" crossorigin="anonymous">`,
    ])
    // The configuration element is empty, so it never executes under the docs CSP.
    expect(html).toContain('data-configuration="{&quot;url&quot;:&quot;/api/docs/openapi.json&quot;}"></script>')
  })

  it('uses the dashboard favicons', () => {
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />')
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
  })

  it('escapes the title and description', () => {
    expect(html).toContain('<title>scantor API</title>')
    expect(html).toContain('<meta name="description" content="REST API of &quot;scantor&quot; &lt;b&gt;" />')
  })
})
