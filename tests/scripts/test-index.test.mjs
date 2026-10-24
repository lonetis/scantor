// Unit tests of test-index.mjs (node:test, dependency-free; part of `just lint`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containerProblem } from './test-index.mjs'

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
