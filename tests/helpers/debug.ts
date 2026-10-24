import { connect, type Socket } from 'node:net'

// Minimal debugger clients for e2e/debug.spec.ts (docs/testing.md §7.8): each one attaches to a debuggee that
// `scantor dev debug` started under the base image's debug command (SCANTOR_DEBUG_CMD) and lets it run, so the
// analysis completes. They speak just enough of each protocol to resume the program:
//   - debugpy: the Debug Adapter Protocol (`initialize`, `attach`, `configurationDone`);
//   - the Node inspector: the Chrome DevTools protocol over WebSocket (`Runtime.runIfWaitingForDebugger`, and
//     `Debugger.resume` whenever `--inspect-brk` pauses the program);
//   - Delve: its JSON-RPC API v2 (`RPCServer.Command {name: "continue"}`, then `RPCServer.Detach` once the program
//     exited, which ends the headless server).
// The port is published on 127.0.0.1 before the debugger listens, so every client retries the connection (docker's
// port proxy accepts and closes it while nothing listens in the container) until its first answer or the timeout.

export type DebuggerKind = 'debugpy' | 'node-inspector' | 'delve'

export interface DebugSession {
  kind: DebuggerKind
  /** what the client saw, for assertions and diagnostics */
  transcript: string[]
  /** resolves when the debuggee is gone (debugpy `terminated`, CDP socket closed, Delve `exited`) */
  finished: Promise<void>
  close(): Promise<void>
}

/** The debugger a SCANTOR_DEBUG_CMD starts (docs/tasks.md §4.2). */
export function debuggerKind(debugCommand: string): DebuggerKind {
  if (/\bdebugpy\b/.test(debugCommand)) return 'debugpy'
  if (/--inspect(-brk)?=/.test(debugCommand)) return 'node-inspector'
  if (/\bdlv\b/.test(debugCommand)) return 'delve'
  throw new Error(`unknown debugger in SCANTOR_DEBUG_CMD ${JSON.stringify(debugCommand)}`)
}

export interface AttachOptions {
  host?: string
  /** how long to keep retrying the connection and handshake */
  timeoutMs?: number
}

/** Attaches the client of `kind` to host:port and resumes the program. */
export function attachDebugger(kind: DebuggerKind, port: number, options: AttachOptions = {}): Promise<DebugSession> {
  switch (kind) {
    case 'debugpy':
      return attachDap(port, options)
    case 'node-inspector':
      return attachCdp(port, options)
    case 'delve':
      return attachDelve(port, options)
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Retries `attempt` until it resolves or the deadline passes; rethrows the last error with context. */
async function retry<T>(what: string, timeoutMs: number, attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      last = error
    }
    if (Date.now() >= deadline) throw new Error(`${what}: no debugger answered within ${timeoutMs / 1000} s: ${String(last)}`)
    await delay(500)
  }
}

function openSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/** Resolves with the predicate's value once a received message satisfies it; rejects on close or timeout. */
function waitForMessage<M, T>(
  subscribe: (listener: (message: M) => void) => () => void,
  closed: Promise<void>,
  match: (message: M) => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`no ${what} within ${timeoutMs / 1000} s`))
    }, timeoutMs)
    const unsubscribe = subscribe((message) => {
      const value = match(message)
      if (value !== undefined) {
        clearTimeout(timer)
        unsubscribe()
        resolve(value)
      }
    })
    void closed.then(() => {
      clearTimeout(timer)
      unsubscribe()
      reject(new Error(`the connection closed before ${what}`))
    })
  })
}

// ── DAP (debugpy) ────────────────────────────────────────────────────────────────────────────────

interface DapMessage {
  seq: number
  type: 'request' | 'response' | 'event'
  command?: string
  event?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: Record<string, unknown>
}

/** One DAP connection: Content-Length framed JSON messages. */
class DapConnection {
  private buffer = Buffer.alloc(0)
  private seq = 0
  private readonly listeners = new Set<(message: DapMessage) => void>()
  readonly closed: Promise<void>

  constructor(
    readonly socket: Socket,
    private readonly transcript: string[],
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()))
    socket.on('error', () => undefined)
  }

  subscribe = (listener: (message: DapMessage) => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  send(command: string, args: Record<string, unknown> = {}): number {
    const seq = ++this.seq
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }))
    this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
    this.transcript.push(`→ ${command}`)
    return seq
  }

  response(seq: number, timeoutMs: number): Promise<DapMessage> {
    return waitForMessage(
      this.subscribe,
      this.closed,
      (m) => (m.type === 'response' && m.request_seq === seq ? m : undefined),
      timeoutMs,
      `the response to request ${seq}`,
    )
  }

  event(name: string, timeoutMs: number): Promise<DapMessage> {
    return waitForMessage(this.subscribe, this.closed, (m) => (m.type === 'event' && m.event === name ? m : undefined), timeoutMs, `the ${name} event`)
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = /Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))
      if (!length) throw new Error(`malformed DAP header: ${this.buffer.subarray(0, headerEnd).toString('utf8')}`)
      const start = headerEnd + 4
      const end = start + Number(length[1])
      if (this.buffer.length < end) return
      const message = JSON.parse(this.buffer.subarray(start, end).toString('utf8')) as DapMessage
      this.buffer = this.buffer.subarray(end)
      this.transcript.push(`← ${message.type} ${message.command ?? message.event ?? ''}${message.success === false ? ` failed: ${message.message}` : ''}`)
      for (const listener of [...this.listeners]) listener(message)
    }
  }
}

async function attachDap(port: number, options: AttachOptions): Promise<DebugSession> {
  const host = options.host ?? '127.0.0.1'
  const transcript: string[] = []
  const connection = await retry('debugpy', options.timeoutMs ?? 120_000, async () => {
    const socket = await openSocket(host, port)
    const dap = new DapConnection(socket, transcript)
    try {
      const initialize = dap.send('initialize', {
        clientID: 'scantor-tests',
        clientName: 'scantor tests',
        adapterID: 'debugpy',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsRunInTerminalRequest: false,
      })
      const response = await dap.response(initialize, 10_000)
      if (!response.success) throw new Error(`initialize failed: ${response.message}`)
      return dap
    } catch (error) {
      socket.destroy()
      throw error
    }
  })
  // attach → the adapter sends `initialized` → configurationDone releases --wait-for-client; the attach response
  // follows.
  const initialized = connection.event('initialized', 60_000)
  const attach = connection.send('attach', { name: 'scantor tests', type: 'python', request: 'attach', justMyCode: false, subProcess: false })
  const attached = connection.response(attach, 60_000)
  await initialized
  const done = await connection.response(connection.send('configurationDone'), 60_000)
  if (!done.success) throw new Error(`configurationDone failed: ${done.message}`)
  const attachResponse = await attached
  if (!attachResponse.success) throw new Error(`attach failed: ${attachResponse.message}`)
  const finished = Promise.race([
    connection.closed,
    waitForMessage(
      connection.subscribe,
      connection.closed,
      (m) => (m.type === 'event' && (m.event === 'terminated' || m.event === 'exited') ? true : undefined),
      24 * 3600_000,
      'the end',
    ).then(
      () => undefined,
      () => undefined,
    ),
  ])
  return {
    kind: 'debugpy',
    transcript,
    finished,
    close: async () => {
      connection.socket.destroy()
      await connection.closed
    },
  }
}

// ── CDP (Node inspector) ─────────────────────────────────────────────────────────────────────────

interface CdpMessage {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: { message: string }
  params?: Record<string, unknown>
}

async function attachCdp(port: number, options: AttachOptions): Promise<DebugSession> {
  const host = options.host ?? '127.0.0.1'
  const transcript: string[] = []
  const socket = await retry('node inspector', options.timeoutMs ?? 120_000, async () => {
    const response = await fetch(`http://${host}:${port}/json/list`)
    if (!response.ok) throw new Error(`GET /json/list: ${response.status}`)
    const targets = (await response.json()) as { webSocketDebuggerUrl?: string }[]
    const target = targets.find((t) => t.webSocketDebuggerUrl)
    if (!target) throw new Error(`no debuggable target in ${JSON.stringify(targets)}`)
    // The inspector names its listen address (0.0.0.0 inside the container); connect through the published port.
    const url = new URL(target.webSocketDebuggerUrl!)
    url.host = `${host}:${port}`
    transcript.push(`target ${url.pathname}`)
    const ws = new WebSocket(url.toString())
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error(`WebSocket ${url} failed`)), { once: true })
    })
    return ws
  })

  let nextId = 0
  const listeners = new Set<(message: CdpMessage) => void>()
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }))
  const subscribe = (listener: (message: CdpMessage) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  const call = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId
    socket.send(JSON.stringify({ id, method, params }))
    transcript.push(`→ ${method}`)
    return waitForMessage(subscribe, closed, (m: CdpMessage) => (m.id === id ? m : undefined), 30_000, `the answer to ${method}`).then((m) => {
      if (m.error) throw new Error(`${method} failed: ${m.error.message}`)
      return m.result ?? {}
    })
  }
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (message.method) transcript.push(`← ${message.method}`)
    // --inspect-brk stops before the first statement; any later pause (a `debugger` statement) is resumed too.
    if (message.method === 'Debugger.paused') void call('Debugger.resume').catch(() => undefined)
    for (const listener of [...listeners]) listener(message)
  })

  await call('Runtime.enable')
  await call('Debugger.enable')
  await call('Runtime.runIfWaitingForDebugger')
  return {
    kind: 'node-inspector',
    transcript,
    finished: closed,
    close: async () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
      await closed
    },
  }
}

// ── Delve JSON-RPC ───────────────────────────────────────────────────────────────────────────────

interface DelveResponse {
  id: number
  result: Record<string, unknown> | null
  error: string | null
}

async function attachDelve(port: number, options: AttachOptions): Promise<DebugSession> {
  const host = options.host ?? '127.0.0.1'
  const transcript: string[] = []
  let buffer = ''
  let nextId = 0
  const listeners = new Set<(message: DelveResponse) => void>()
  const subscribe = (listener: (message: DelveResponse) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }

  const socket = await retry('delve', options.timeoutMs ?? 120_000, async () => {
    const candidate = await openSocket(host, port)
    // A cheap call proves that Delve itself answers (not only docker's port proxy, which accepts and then resets the
    // connection while nothing listens in the container: that ECONNRESET is one more failed attempt).
    let timer: NodeJS.Timeout | undefined
    const answered = new Promise<void>((resolve, reject) => {
      candidate.on('error', reject)
      let data = ''
      const onData = (chunk: Buffer) => {
        data += chunk.toString('utf8')
        if (data.includes('\n')) {
          candidate.off('data', onData)
          const response = JSON.parse(data.slice(0, data.indexOf('\n'))) as DelveResponse
          buffer = data.slice(data.indexOf('\n') + 1)
          if (response.error) reject(new Error(`GetVersion failed: ${response.error}`))
          else {
            transcript.push(`← GetVersion ${JSON.stringify(response.result)}`)
            resolve()
          }
        }
      }
      candidate.on('data', onData)
      candidate.once('close', () => reject(new Error('the connection closed')))
      timer = setTimeout(() => reject(new Error('no answer to GetVersion')), 5000)
    })
    candidate.write(`${JSON.stringify({ method: 'RPCServer.GetVersion', params: [{}], id: ++nextId })}\n`)
    try {
      await answered
      return candidate
    } catch (error) {
      candidate.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
  })
  socket.removeAllListeners('close')
  socket.removeAllListeners('error')
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.on('error', () => undefined)
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, newline)) as DelveResponse
      buffer = buffer.slice(newline + 1)
      for (const listener of [...listeners]) listener(message)
    }
  })
  const call = (method: string, params: Record<string, unknown>, timeoutMs: number) => {
    const id = ++nextId
    socket.write(`${JSON.stringify({ method, params: [params], id })}\n`)
    transcript.push(`→ ${method} ${JSON.stringify(params)}`)
    return waitForMessage(subscribe, closed, (m: DelveResponse) => (m.id === id ? m : undefined), timeoutMs, `the answer to ${method}`)
  }

  // `continue` answers only when the program stops: here, when it exited after the runtime's shutdown request.
  const finished = call('RPCServer.Command', { name: 'continue' }, 24 * 3600_000).then(
    async (response) => {
      const state = (response.result?.State ?? {}) as { exited?: boolean; exitStatus?: number }
      transcript.push(`← continue ${response.error ?? JSON.stringify({ exited: state.exited, exitStatus: state.exitStatus })}`)
      // The headless server (--accept-multiclient) outlives its program; detaching ends it.
      if (!socket.destroyed) await call('RPCServer.Detach', { Kill: true }, 10_000).catch(() => undefined)
    },
    () => undefined,
  )
  return {
    kind: 'delve',
    transcript,
    finished,
    close: async () => {
      socket.destroy()
      await closed
    },
  }
}
