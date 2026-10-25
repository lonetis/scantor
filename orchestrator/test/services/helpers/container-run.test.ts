import { Duplex, PassThrough, Readable } from 'node:stream'
import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'
import { HelperOutputTooLargeError, HelperTimeoutError, runHelperContainer } from '../../../server/services/helpers/runner'
import { STDOUT_CAP_BYTES } from '../../../server/services/helpers/protocol'
import { useLogger } from '../../../server/utils/logger'

// runHelperContainer against a fake Engine API: attach before start, stdin written and half-closed, demultiplexed
// output collected, the container always removed, killed on timeout.

interface Behaviour {
  stdout?: Buffer | string
  stderr?: string
  exitCode?: number
  /** never exits (until killed) */
  hang?: boolean
}

function fakeDocker(behaviour: Behaviour) {
  const calls: string[] = []
  let stdinData = Buffer.alloc(0)
  let targets: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } | null = null
  let exit: ((code: number) => void) | null = null
  const attachStream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      stdinData = Buffer.concat([stdinData, chunk])
      callback()
    },
    final(callback) {
      calls.push('stdin-closed')
      callback()
    },
  })
  const container = {
    id: 'c1',
    async attach() {
      calls.push('attach')
      return attachStream
    },
    async start() {
      calls.push('start')
      setImmediate(() => {
        if (behaviour.stdout) targets!.stdout.write(behaviour.stdout)
        if (behaviour.stderr) targets!.stderr.write(behaviour.stderr)
        if (!behaviour.hang) {
          attachStream.push(null)
          exit?.(behaviour.exitCode ?? 0)
        }
      })
    },
    wait() {
      return new Promise<{ StatusCode: number }>((resolve) => {
        exit = (code) => resolve({ StatusCode: code })
      })
    },
    async kill() {
      calls.push('kill')
      attachStream.push(null)
      exit?.(137)
    },
    async remove() {
      calls.push('remove')
    },
  }
  const docker = {
    async createContainer() {
      calls.push('create')
      return container
    },
    modem: {
      demuxStream(stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream) {
        targets = { stdout, stderr }
        // Like docker-modem, consume the multiplexed stream so it can end.
        stream.resume()
      },
    },
  } as unknown as Docker
  return { docker, calls, stdin: () => stdinData.toString('utf8') }
}

const log = useLogger('test')
const attach = (_docker: Docker, container: Docker.Container) => container.attach({}) as Promise<NodeJS.ReadWriteStream>

describe('runHelperContainer', () => {
  it('writes stdin, collects output and removes the container', async () => {
    const fake = fakeDocker({ stdout: '{"ok":true}', stderr: '{"type":"log","level":"info","msg":"x"}\n', exitCode: 0 })
    const result = await runHelperContainer({ docker: fake.docker, spec: {}, stdin: Buffer.from('{"files":{}}'), timeoutMs: 5000, log, attach })
    expect(result).toEqual({ exitCode: 0, stdout: Buffer.from('{"ok":true}'), stderr: '{"type":"log","level":"info","msg":"x"}\n' })
    expect(fake.stdin()).toBe('{"files":{}}')
    expect(fake.calls).toEqual(['create', 'attach', 'start', 'stdin-closed', 'remove'])
  })

  it('pipes a stream to stdin and streams stdout to a sink', async () => {
    const fake = fakeDocker({ stdout: 'tar.gz bytes', exitCode: 0 })
    const sink = new PassThrough()
    const chunks: Buffer[] = []
    sink.on('data', (chunk: Buffer) => chunks.push(chunk))
    const result = await runHelperContainer({ docker: fake.docker, spec: {}, stdin: Readable.from([Buffer.from('a'), Buffer.from('b')]), stdoutSink: sink, timeoutMs: 5000, log, attach })
    expect(result.stdout.length).toBe(0)
    expect(Buffer.concat(chunks).toString()).toBe('tar.gz bytes')
    expect(fake.stdin()).toBe('ab')
  })

  it('kills and removes a helper that exceeds its timeout', async () => {
    const fake = fakeDocker({ hang: true })
    await expect(runHelperContainer({ docker: fake.docker, spec: {}, timeoutMs: 20, log, attach })).rejects.toBeInstanceOf(HelperTimeoutError)
    expect(fake.calls).toContain('kill')
    expect(fake.calls.at(-1)).toBe('remove')
  })

  it('kills and removes a helper when the signal aborts, and stops forwarding to the sink', async () => {
    const fake = fakeDocker({ hang: true })
    const abort = new AbortController()
    const sink = new PassThrough()
    const running = runHelperContainer({ docker: fake.docker, spec: {}, stdoutSink: sink, timeoutMs: 5000, signal: abort.signal, log, attach })
    setTimeout(() => abort.abort(new Error('cancelled')), 10)
    await expect(running).rejects.toThrow('cancelled')
    expect(fake.calls).toContain('kill')
    expect(fake.calls.at(-1)).toBe('remove')
    expect(sink.writableEnded).toBe(false)
  })

  it('does not create a container for an aborted signal', async () => {
    const fake = fakeDocker({ exitCode: 0 })
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(runHelperContainer({ docker: fake.docker, spec: {}, timeoutMs: 5000, signal: abort.signal, log, attach })).rejects.toThrow('cancelled')
    expect(fake.calls).toEqual([])
  })

  it('fails when stdout exceeds its cap', async () => {
    const fake = fakeDocker({ stdout: Buffer.alloc(STDOUT_CAP_BYTES + 1, 0x61), exitCode: 0 })
    await expect(runHelperContainer({ docker: fake.docker, spec: {}, timeoutMs: 5000, log, attach })).rejects.toBeInstanceOf(HelperOutputTooLargeError)
    expect(fake.calls.at(-1)).toBe('remove')
  })
})
