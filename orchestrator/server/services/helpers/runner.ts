import { request as httpRequest } from 'node:http'
import { PassThrough, type Readable, Writable } from 'node:stream'
import type Docker from 'dockerode'
import type { ContainerCreateOptions } from 'dockerode'
import type { Logger } from '../../utils/logger'
import { STDERR_CAP_BYTES, STDOUT_CAP_BYTES } from './protocol'
import type { HelperResult } from './types'

// Runs one helper container through the Engine API (docs/editor.md §9.2): create with an attachable stdin, attach
// before start (so no output is lost), start, write stdin and half-close it, read the demultiplexed stdout and
// stderr, wait, and always remove the container explicitly (AutoRemove races with wait). On the wall-clock timeout
// or when the caller's signal aborts, the container is killed and removed.

export class HelperTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`workspace helper exceeded ${timeoutMs} ms`)
    this.name = 'HelperTimeoutError'
  }
}

export class HelperOutputTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`workspace helper output exceeds ${limit} bytes`)
    this.name = 'HelperOutputTooLargeError'
  }
}

/** Collects at most `cap` bytes; `keep: 'head'` fails beyond the cap, `keep: 'tail'` keeps the last bytes. */
class CappedCollector extends Writable {
  private chunks: Buffer[] = []
  private size = 0
  overflowed = false

  constructor(
    private readonly cap: number,
    private readonly keep: 'head' | 'tail',
  ) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size > this.cap) {
      this.overflowed = true
      if (this.keep === 'tail') {
        const joined = Buffer.concat(this.chunks)
        this.chunks = [joined.subarray(joined.length - this.cap)]
        this.size = this.cap
      } else {
        this.chunks = []
        this.size = 0
      }
    }
    callback()
  }

  value(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

export interface RunContainerOptions {
  docker: Docker
  spec: ContainerCreateOptions
  stdin?: Readable | Buffer
  /** when set, stdout is streamed here instead of being collected (no cap) */
  stdoutSink?: NodeJS.WritableStream
  timeoutMs: number
  /** kills the helper and rejects with the signal's reason when it aborts */
  signal?: AbortSignal
  log: Logger
  /** test seam: how the stdio stream is opened */
  attach?: AttachFn
}

/** Opens the container's stdio stream (multiplexed stdout/stderr, raw stdin). */
export type AttachFn = (docker: Docker, container: Docker.Container) => Promise<NodeJS.ReadWriteStream>

interface ModemConnection {
  getSocketPath?: () => Promise<string> | undefined
  host?: string
  port?: number | string
  protocol?: string
  version?: string
}

/**
 * Attaches to a created container with a hijacked HTTP connection that carries no request body
 * (`Content-Length: 0`), as the docker CLI does. dockerode's own attach writes its options as a JSON body before the
 * upgrade, and the daemon may hand those bytes to the container's stdin ahead of the real input.
 */
export const hijackedAttach: AttachFn = async (docker, container) => {
  const modem = docker.modem as unknown as ModemConnection
  const socketPath = await modem.getSocketPath?.()
  if (!socketPath && modem.protocol === 'https') throw new Error('workspace helpers need the Docker daemon on a unix socket or plain TCP')
  const prefix = modem.version ? `/${modem.version}` : ''
  const path = `${prefix}/containers/${container.id}/attach?stream=1&stdin=1&stdout=1&stderr=1`
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      ...(socketPath ? { socketPath } : { host: modem.host, port: modem.port }),
      method: 'POST',
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'tcp', 'Content-Length': '0' },
    })
    request.once('upgrade', (_response, socket, head) => {
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    request.once('response', (response) => {
      response.resume()
      reject(new Error(`attaching to the workspace helper failed: HTTP ${response.statusCode}`))
    })
    request.once('error', reject)
    request.end()
  })
}

async function removeQuietly(container: Docker.Container, log: Logger): Promise<void> {
  try {
    await container.remove({ force: true, v: true })
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) log.warn('removing a workspace helper failed', { container: container.id, err: error })
  }
}

function writeStdin(stream: NodeJS.ReadWriteStream, stdin: Readable | Buffer | undefined, log: Logger): void {
  // The attach stream is a hijacked socket: ending it half-closes the connection, which closes the container's
  // stdin (StdinOnce). Write errors after the helper exited early (EPIPE) are expected and not fatal.
  const onError = (error: Error) => log.debug('writing helper stdin failed', { err: error })
  if (stdin === undefined) {
    stream.end()
    return
  }
  if (Buffer.isBuffer(stdin)) {
    stream.end(stdin)
    return
  }
  stdin.on('error', (error) => {
    onError(error)
    stream.end()
  })
  stdin.pipe(stream as unknown as NodeJS.WritableStream)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('aborted')
}

/** Creates, runs and removes one helper container and returns its exit code and output. */
export async function runHelperContainer(options: RunContainerOptions): Promise<HelperResult> {
  const { docker, log, signal } = options
  if (signal?.aborted) throw abortReason(signal)
  const container = await docker.createContainer(options.spec)
  let timer: NodeJS.Timeout | null = null
  let onAbort: (() => void) | null = null
  let streamed: PassThrough | null = null
  try {
    const stream = await (options.attach ?? hijackedAttach)(docker, container)
    const stdout = new CappedCollector(STDOUT_CAP_BYTES, 'head')
    const stderr = new CappedCollector(STDERR_CAP_BYTES, 'tail')
    if (options.stdoutSink) {
      streamed = new PassThrough()
      streamed.pipe(options.stdoutSink as NodeJS.WritableStream)
    }
    const stdoutTarget = streamed ?? stdout
    const ended = new Promise<void>((resolve) => {
      stream.once('end', resolve)
      stream.once('close', resolve)
      stream.once('error', (error) => {
        log.debug('helper attach stream failed', { err: error })
        resolve()
      })
    })
    docker.modem.demuxStream(stream, stdoutTarget, stderr)
    await container.start()
    writeStdin(stream, options.stdin, log)

    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HelperTimeoutError(options.timeoutMs)), options.timeoutMs)
      if (signal) {
        onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    })
    let exitCode: number
    try {
      const waited = (await Promise.race([container.wait(), stopped])) as { StatusCode: number }
      exitCode = waited.StatusCode
    } catch (error) {
      if (error instanceof HelperTimeoutError || signal?.aborted) {
        await container.kill().catch((killError: unknown) => log.debug('killing a stopped helper failed', { err: killError }))
      }
      throw error
    }
    // The attach stream ends after the container exits; give it a moment to deliver the last frames.
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))])
    if (streamed) {
      streamed.end()
      streamed = null
    }
    if (stdout.overflowed) throw new HelperOutputTooLargeError(STDOUT_CAP_BYTES)
    return { exitCode, stdout: stdout.value(), stderr: stderr.value().toString('utf8') }
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    // A helper that did not exit normally sends nothing more to the sink; the caller decides what the sink sees.
    streamed?.unpipe()
    await removeQuietly(container, log)
  }
}
