#!/usr/bin/env node
// A fake `scantor task build` for the pipeline driver tests: reads the pack from stdin, writes NDJSON events to
// stdout and behaves as FAKE_MODE says (ok, gate, hang, content, crash, big).
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MODE ?? 'ok'
let seq = 0
const emit = (phase, type, fields) => process.stdout.write(`${JSON.stringify({ v: 1, seq: seq++, at: new Date().toISOString(), phase, type, ...fields })}\n`)
const result = (fields) => emit('push', 'result', { result: { ok: true, pack: { packSha256: 'p', packBytes: 1, fileCount: 1, bytes: 1 }, manifest: { scantor: 1, name: 'echo', language: 'python', entry: 'main.py' }, settingsDefaults: null, language: 'python', privileged: false, baseImage: { ref: 'b', digest: 'sha256:b' }, image: { ref: 't', id: 'sha256:i', repository: 'tasks/x', tag: 'r', digest: 'sha256:d', bytes: 100, platform: { os: 'linux', arch: 'arm64' } }, description: null, errors: [], warnings: [], durationsMs: {}, ...fields } })

let input = 0
for await (const chunk of process.stdin) input += chunk.length
emit('pack', 'log', { stream: 'pipeline', text: `read ${input} bytes; args ${process.argv.slice(2).join(' ')}` })

if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else if (mode === 'content') {
  const error = { phase: 'static', file: 'Dockerfile', line: 3, message: 'D5: FROM localhost:5000/tasks/x is not allowed' }
  emit('static', 'error', { error })
  emit('static', 'result', { result: { ok: false, errors: [error], warnings: [], image: null, durationsMs: {} } })
  process.exit(2)
} else if (mode === 'crash') {
  process.stderr.write('panic: docker unreachable\n')
  process.exit(3)
} else if (mode === 'big') {
  result({ image: { ref: 't', id: 'sha256:i', digest: 'sha256:d', bytes: 10 ** 12, platform: { os: 'linux', arch: 'arm64' } } })
} else if (mode === 'gate') {
  emit('push', 'log', { stream: 'pipeline', text: 'waiting for push gate' })
  const lines = createInterface({ input: createReadStream(null, { fd: 3 }) })
  let answer = null
  for await (const line of lines) {
    answer = line
    break
  }
  if (answer === 'push') result({})
  else {
    const error = { phase: 'push', message: 'push gate closed' }
    emit('push', 'error', { error })
    emit('push', 'result', { result: { ok: false, errors: [error], warnings: [], image: null, durationsMs: {} } })
    process.exit(3)
  }
} else {
  result({})
}
