import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { env } from './env'
import { FIXTURES_URL } from './fixtures-server'

// A template data source under the test's control, for the e2e runtime specs (docs/templates.md §7): an HTTP server
// in the Playwright worker that answers the first requests to every path with the failures a test plans (503, 429
// with Retry-After) and proxies the rest to the fixtures server's Tranco and CrUX fakes. It records every request
// with its User-Agent. Containers on the runner's inner Docker reach it through any `*.<domain>` name, which
// resolves to the runner's docker0 address (docs/testing.md §7.3).

export interface RecordedRequest {
  path: string
  userAgent: string
  status: number
  at: number
}

export interface PlannedFailure {
  status: 503 | 429 | 500
  retryAfterSeconds?: number
}

export class FlakyDataSource {
  readonly requests: RecordedRequest[] = []
  private readonly seen = new Map<string, number>()
  private readonly server: Server
  private port = 0

  private constructor(
    /** failures answered to the 1st, 2nd, … request of each path; later requests are proxied */
    private readonly failures: PlannedFailure[],
    /** answer every request with this failure instead (an unavailable data source) */
    private readonly always: PlannedFailure | null,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request.url ?? '/', String(request.headers['user-agent'] ?? '')).then(
        ({ status, headers, body }) => {
          response.writeHead(status, headers)
          response.end(body)
        },
        (error: unknown) => {
          response.writeHead(502, { 'Content-Type': 'text/plain' })
          response.end(String(error))
        },
      )
    })
  }

  static async start(options: { failures?: PlannedFailure[]; always?: PlannedFailure }): Promise<FlakyDataSource> {
    const source = new FlakyDataSource(options.failures ?? [], options.always ?? null)
    await new Promise<void>((resolve) => source.server.listen(0, '0.0.0.0', resolve))
    source.port = (source.server.address() as AddressInfo).port
    return source
  }

  /** The base URL for SCANTOR_TRANCO_URL (`tranco`) or SCANTOR_CRUX_URL (`crux`), as containers reach it. */
  url(kind: 'tranco' | 'crux'): string {
    return `http://datasource.${env.domain}:${this.port}/${kind}`
  }

  private async handle(url: string, userAgent: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const path = url.split('?')[0]!
    const count = (this.seen.get(path) ?? 0) + 1
    this.seen.set(path, count)
    const failure = this.always ?? this.failures[count - 1]
    if (failure) {
      this.requests.push({ path, userAgent, status: failure.status, at: Date.now() })
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
      if (failure.retryAfterSeconds !== undefined) headers['Retry-After'] = String(failure.retryAfterSeconds)
      return { status: failure.status, headers, body: Buffer.from(`planned failure ${failure.status}\n`) }
    }
    const upstream = await fetch(`${FIXTURES_URL}${url}`)
    const body = Buffer.from(await upstream.arrayBuffer())
    this.requests.push({ path, userAgent, status: upstream.status, at: Date.now() })
    return { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' }, body }
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
