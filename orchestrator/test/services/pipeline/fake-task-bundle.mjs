#!/usr/bin/env node
// A fake `scantor task bundle` for the bundle driver and job tests: reads the bundle info from stdin, writes an
// archive to fd 3 and NDJSON events to stdout, and behaves as FAKE_MODE says:
//   ok        the archive, then a result with its size and SHA-256 (exit 0)
//   mismatch  the archive, then a result whose SHA-256 is not the archive's (exit 0)
//   content   a `build` error and a failed result (exit 2)
//   crash     half the archive, a panic on stderr (exit 3)
//   hang      the first part of the archive, then nothing until it is killed
import { createHash } from 'node:crypto'
import { Socket } from 'node:net'

const mode = process.env.FAKE_MODE ?? 'ok'
let seq = 0
const emit = (phase, type, fields) => process.stdout.write(`${JSON.stringify({ v: 1, seq: seq++, at: new Date().toISOString(), phase, type, ...fields })}\n`)

let input = ''
for await (const chunk of process.stdin) input += chunk
const info = JSON.parse(input)
emit('platform', 'log', {
  stream: 'pipeline',
  text: `bundling ${info.ref} as ${info.image}; args ${process.argv.slice(2).join(' ')}; push password ${process.env.SCANTOR_REGISTRY_PUSH_PASSWORD ? 'set' : 'unset'}`,
})

const archive = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from(`layer of ${info.image}\n`.repeat(4000))])
const sha256 = createHash('sha256').update(archive).digest('hex')
const out = new Socket({ fd: 3, readable: false, writable: true })
out.on('error', () => {})
const write = (data) => new Promise((resolve) => out.write(data, () => resolve()))
const close = () => new Promise((resolve) => out.end(resolve))
const bundle = { image: info.image, platform: info.platform, imageBytes: 123_456_789, bytes: archive.length, sha256, scantorVersion: 'dev' }
const result = (fields) => emit('platform', 'result', { result: { ok: true, bundle, errors: [], warnings: [], durationsMs: { build: 1, save: 2 }, ...fields } })

if (mode === 'content') {
  const error = { phase: 'build', message: 'the derived image exceeds SCANTOR_MAX_IMAGE_BYTES' }
  emit('build', 'error', { error })
  await close()
  emit('build', 'result', { result: { ok: false, bundle: null, errors: [error], warnings: [], durationsMs: {} } })
  process.exit(2)
} else if (mode === 'crash') {
  await write(archive.subarray(0, archive.length / 2))
  await close()
  process.stderr.write('panic: docker save failed\n')
  process.exit(3)
} else if (mode === 'hang') {
  await write(archive.subarray(0, 1024))
  setInterval(() => {}, 1000)
} else {
  await write(archive)
  await close()
  result(mode === 'mismatch' ? { bundle: { ...bundle, sha256: '0'.repeat(64) } } : {})
}
