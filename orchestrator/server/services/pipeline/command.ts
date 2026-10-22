import { spawn } from 'node:child_process'
import { scantorBinary } from './binary'

// Short-lived `scantor` subprocesses with bounded output (template estimates).

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface CommandOptions {
  stdin?: string
  env: Record<string, string>
  timeoutMs: number
  /** output beyond this many bytes per stream is dropped */
  maxOutputBytes?: number
  binary?: string
}

export function runScantorCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const max = options.maxOutputBytes ?? 1024 ** 2
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary ?? scantorBinary(), args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString('utf8')
    })
    child.stdin.on('error', () => {
      // The command may exit before reading its input; its exit code reports the outcome.
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
    child.stdin.end(options.stdin ?? '')
  })
}
