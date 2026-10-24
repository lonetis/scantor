// Unit tests of test-index.mjs (node:test, dependency-free; part of `just lint`).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { containerProblem, goTestPackages } from './test-index.mjs'

const files =
  (...paths) =>
  (path) =>
    paths.includes(path)

test('the index is generated inside a Linux container', () => {
  assert.equal(containerProblem({ platform: 'linux', exists: files('/.dockerenv') }), null)
  assert.equal(containerProblem({ platform: 'linux', exists: files('/run/.containerenv') }), null)
})

test('anywhere else it points at just test-index', () => {
  for (const [platform, exists] of [
    ['darwin', files()],
    ['darwin', files('/.dockerenv')],
    ['linux', files()],
    ['win32', files('/.dockerenv')],
  ]) {
    assert.match(containerProblem({ platform, exists }) ?? '', /runs only inside a Linux container.*`just test-index`/, platform)
  }
})

test('Go packages are the directories of the root module with tests, as go test ./... finds them', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-index-'))
  try {
    for (const path of [
      'go.mod',
      'embed_test.go',
      'internal/api/api.go',
      'internal/api/api_test.go',
      'internal/keys/keys.go',
      'tests/docker/fixtures/main_test.go',
      // a nested module, Go's ignored names, dependency trees and Playwright outputs hold no packages of the module
      'connectors/go/go.mod',
      'connectors/go/scantor_test.go',
      'tasks/reverse-dns/go.mod',
      'tasks/reverse-dns/main_test.go',
      'internal/conformance/testdata/go/echo/echo_test.go',
      '_tools/tool_test.go',
      '.cache/cache_test.go',
      'tests/node_modules/dep/dep_test.go',
      'tests/test-results/exec-1/stray_test.go',
      'tests/playwright-report/data/stray_test.go',
    ]) {
      mkdirSync(join(root, dirname(path)), { recursive: true })
      writeFileSync(join(root, path), '')
    }
    assert.deepEqual(goTestPackages(root), ['.', 'internal/api', 'tests/docker/fixtures'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
