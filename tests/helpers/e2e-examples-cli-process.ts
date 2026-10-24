import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { FIXTURE_DATA_SOURCES, type CliOptions } from './cli'
import { childEnv, env } from './env'

// A long-running scantor CLI process for the e2e CLI specs: streams its output while it runs, so a test can wait for
// an event (the debugger port of `dev debug`, the first `scheduled` event of `dev run`) and then attach, interrupt
// or kill it. It uses the same environment as helpers/cli.ts (the stack URL, the local image pair, the test CA and
// the fixture data sources). With `image: true` it runs the scantor:dev image through the shim pattern of scantor.sh
// (working directory mounted at the same path, the inner Docker socket), optionally with extra `docker run` flags.

export interface SpawnOptions extends Omit<CliOptions, 'timeoutMs'> {
  /** extra `docker run` flags before the image name (image mode only), for example `--add-host` */
  dockerArgs?: string[]
  /** name of the CLI container (image mode), so a test can address it */
  containerName?: string
}

export interface ProcessExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

/** The environment helpers/cli.ts gives the CLI. */
export function scantorEnv(options: Pick<CliOptions, 'token' | 'env'> = {}): Record<string, string> {
  return {
    SCANTOR_URL: env.publicUrl,
    SCANTOR_IMAGE_PREFIX: '',
    SCANTOR_IMAGE_TAG: 'dev',
    SCANTOR_CA_CERT: readFileSync(env.caCertFile, 'utf8'),
    ...FIXTURE_DATA_SOURCES,
    ...(options.token ? { SCANTOR_TOKEN: options.token } : {}),
    ...options.env,
  }
}

/** Parses the JSON lines of an output; other lines are skipped. */
export function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // a human line that happens to start with a brace
    }
  }
  return out
}

export class CliProcess {
  stdout = ''
  stderr = ''
  readonly exited: Promise<ProcessExit>
  private exit: ProcessExit | undefined
  private readonly waiters = new Set<() => void>()

  constructor(
    readonly child: ChildProcess,
    readonly description: string,
  ) {
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.stdout += chunk
      this.notify()
    })
    child.stderr?.on('data', (chunk: string) => {
      this.stderr += chunk
      this.notify()
    })
    this.exited = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => {
        this.exit = { exitCode, signal }
        this.notify()
        resolve(this.exit)
      })
    })
  }

  /** The JSON lines printed on stdout so far (`-o json` events). */
  events(): Record<string, unknown>[] {
    return jsonLines(this.stdout)
  }

  /**
   * Resolves with the predicate's value once it returns something other than undefined; rejects when the process
   * exits first or the timeout passes, with the output so far.
   */
  waitFor<T>(predicate: (p: CliProcess) => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = predicate(this)
        if (value !== undefined) {
          finish()
          resolve(value)
        } else if (this.exit) {
          finish()
          reject(new Error(`${this.description} exited (${JSON.stringify(this.exit)}) before ${what}\n${this.output()}`))
        }
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error(`${this.description}: no ${what} within ${timeoutMs / 1000} s\n${this.output()}`))
      }, timeoutMs)
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
      }
      this.waiters.add(check)
      check()
    })
  }

  /** Waits for the exit (≤ timeoutMs, then SIGKILL and an error). */
  async wait(timeoutMs: number): Promise<ProcessExit> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.child.kill('SIGKILL')
        reject(new Error(`${this.description} did not exit within ${timeoutMs / 1000} s\n${this.output()}`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([this.exited, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal)
  }

  /** Kills the process unless it has exited (cleanup in `finally`). */
  async stop(): Promise<void> {
    if (this.exit) return
    this.child.kill('SIGKILL')
    await this.exited
  }

  output(): string {
    return `--- stdout ---\n${this.stdout.slice(-20_000)}\n--- stderr ---\n${this.stderr.slice(-20_000)}`
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}

/** Starts the scantor CLI (the runner's binary, or the scantor:dev image with `image: true`). */
export function spawnScantor(args: string[], options: SpawnOptions = {}): CliProcess {
  const cwd = options.cwd ?? env.paths.tests
  const cliEnv = scantorEnv(options)
  let file = '/usr/local/bin/scantor'
  let argv = args
  if (options.image) {
    file = 'docker'
    const passEnv = Object.keys(cliEnv).flatMap((key) => ['-e', key])
    argv = [
      'run',
      '--rm',
      '-i',
      '--init',
      '--label',
      'scantor.test=true',
      ...(options.containerName ? ['--name', options.containerName] : []),
      '-v',
      `${cwd}:${cwd}`,
      '-w',
      cwd,
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      ...(options.dockerArgs ?? []),
      ...passEnv,
      'scantor:dev',
      ...args,
    ]
  }
  const child = spawn(file, argv, { cwd, env: childEnv(cliEnv, { inherit: false }), stdio: ['pipe', 'pipe', 'pipe'] })
  if (options.input !== undefined) child.stdin.end(options.input)
  else child.stdin.end()
  return new CliProcess(child, `scantor ${args.join(' ')}`)
}

/** Runs the runner's scantor binary and returns stdout as bytes (binary downloads such as `tasks files cat`). */
export function scantorBytes(
  args: string[],
  options: Pick<SpawnOptions, 'token' | 'cwd' | 'env'> = {},
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const cli = spawn('/usr/local/bin/scantor', args, {
    cwd: options.cwd ?? env.paths.tests,
    env: childEnv(scantorEnv(options), { inherit: false }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out: Buffer[] = []
  let stderr = ''
  cli.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  cli.stderr.setEncoding('utf8')
  cli.stderr.on('data', (chunk: string) => (stderr += chunk))
  return new Promise((resolve, reject) => {
    cli.on('error', reject)
    cli.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr }))
  })
}
