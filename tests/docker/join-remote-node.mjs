// Joins the simulated remote node of the test stack (docs/testing.md §7.4, phase 8b): signs in as the
// seeded admin, creates the node "remote-1" (pool "remote", label zone=remote), loads the node image into
// the remote node's own dockerd and runs the join command of createNode there, with the test CA as
// SCANTOR_CA_CERT. Waits until the node is online and writes its id and token to
// /run/scantor-test/remote-node.json for white-box tests. Runs inside the runner with Node's fetch
// (NODE_EXTRA_CA_CERTS trusts the test CA); exits non-zero with a message on any failure.
import { execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

const container = 'scantor-remote-node'
const node = { name: 'remote-1', pool: 'remote', labels: { zone: 'remote' } }
const outputFile = '/run/scantor-test/remote-node.json'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const publicUrl = required('SCANTOR_PUBLIC_URL')
const caPem = readFileSync(required('NODE_EXTRA_CA_CERTS'), 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      if (await check()) return
      last = undefined
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${last ? `: ${last.message}` : ''}`)
    await sleep(1000)
  }
}

let cookie = ''

async function api(method, path, body) {
  const response = await fetch(new URL(path, publicUrl), {
    method,
    headers: { Origin: publicUrl, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`)
  return { response, json: text ? JSON.parse(text) : null }
}

// Pipes `docker save <image>` into `docker load` inside the remote node.
function loadImage(image) {
  return new Promise((resolve, reject) => {
    const save = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'inherit'] })
    const load = spawn('docker', ['exec', '-i', container, 'docker', 'load', '-q'], { stdio: ['pipe', 'inherit', 'inherit'] })
    save.stdout.pipe(load.stdin)
    let pending = 2
    const done = (what) => (code) => {
      if (code !== 0) reject(new Error(`${what} exited with ${code}`))
      else if (--pending === 0) resolve()
    }
    save.on('error', reject).on('exit', done(`docker save ${image}`))
    load.on('error', reject).on('exit', done('docker load in the remote node'))
  })
}

async function main() {
  const signIn = await api('POST', '/api/auth/sign-in/email', { email: required('SCANTOR_ADMIN_EMAIL'), password: required('SCANTOR_ADMIN_PASSWORD') })
  cookie = signIn.response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ')
  if (!cookie) throw new Error('the sign-in set no session cookie')

  await until('the remote node dockerd', 120_000, async () => {
    await run('docker', ['exec', container, 'docker', 'info'])
    return true
  })

  const { json: created } = await api('POST', '/api/nodes', node)
  const { dockerRun } = created.join
  const match = /^docker run (.*) (\S+) node$/.exec(dockerRun)
  if (!match) throw new Error(`unexpected join command: ${dockerRun.replace(created.token, '<token>')}`)
  const image = match[2]

  console.log(`[join-remote-node] loading ${image} into ${container}`)
  await loadImage(image)

  // The join command exactly as the UI shows it, plus the test CA (passed through by name).
  console.log(`[join-remote-node] starting the node daemon of ${node.name} (${created.node.id})`)
  await run('docker', ['exec', '-e', `SCANTOR_CA_CERT=${caPem}`, container, 'sh', '-c', `docker run -e SCANTOR_CA_CERT ${match[1]} ${image} node`])

  await until(`${node.name} to be online`, 120_000, async () => {
    const { json } = await api('GET', `/api/nodes/${created.node.id}`)
    return json.state === 'online'
  })
  writeFileSync(outputFile, JSON.stringify({ id: created.node.id, name: node.name, pool: node.pool, labels: node.labels, token: created.token }, null, 2), {
    mode: 0o600,
  })
  console.log(`[join-remote-node] ${node.name} is online`)
}

main().catch((error) => {
  console.error(`[join-remote-node] ${error.message}`)
  process.exit(1)
})
