import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mongoOutputStore, runOutputBytes } from '../../../server/services/script-runtime/outputs'
import type { ScriptRunDoc, ScriptRunOutputDoc } from '../../../server/types/documents'
import { useCollections } from '../../../server/utils/mongo'
import {
  connectIntegrationDatabase,
  disconnectIntegrationDatabase,
  discoverEnvironment,
  integrationEnabled,
  MONGO_IMAGE,
  requireImages,
  startMongo,
  TestContainers,
} from '../nodes/integration'

/*
 * The conditional writes of the script-run output store against a real MongoDB replica set (docs/scripts.md, outputs):
 * the reservation of a part checks SCANTOR_SCRIPT_RUN_MAX_OUTPUT_BYTES for all outputs of the run in the same write,
 * so concurrent parts of one run never hold more than the cap together.
 */

function output(id: string, overrides: Partial<ScriptRunOutputDoc> = {}): ScriptRunOutputDoc {
  return {
    id,
    name: `${id}.csv`,
    key: `script-runs/r/outputs/${id}/${id}.csv`,
    contentType: 'text/csv',
    state: 'pending',
    uploadId: `upload-${id}`,
    reservedBytes: 0,
    size: null,
    sha256: null,
    createdAt: new Date(),
    storedAt: null,
    ...overrides,
  }
}

describe.skipIf(!integrationEnabled)('script-run output store against MongoDB', () => {
  let containers: TestContainers

  beforeAll(async () => {
    const env = await discoverEnvironment()
    await requireImages(env.docker, [MONGO_IMAGE])
    containers = new TestContainers(env)
    await connectIntegrationDatabase(await startMongo(containers, 'script-outputs-mongo'))
  }, 180_000)

  afterAll(async () => {
    await disconnectIntegrationDatabase()
    await containers?.removeAll()
  })

  async function seedRun(outputs: ScriptRunOutputDoc[], state = 'running'): Promise<string> {
    const id = randomUUID()
    await useCollections().scriptRuns.insertOne({ _id: id, state, outputs } as unknown as ScriptRunDoc)
    return id
  }

  async function outputsOf(id: string): Promise<ScriptRunOutputDoc[]> {
    return (await useCollections().scriptRuns.findOne({ _id: id }))!.outputs
  }

  it('reserves concurrent parts of one run up to the per-run cap and not one byte beyond', async () => {
    const id = await seedRun([
      output('done', { state: 'stored', size: 100, sha256: 'c'.repeat(64), uploadId: null }),
      output('a'),
      output('b', { reservedBytes: 50 }),
    ])
    const results = await Promise.all(Array.from({ length: 20 }, () => mongoOutputStore.reserve(id, 'a', 100, 1000, new Date())))
    // 150 bytes were held: 8 parts of 100 fit under 1000.
    expect(results.filter(Boolean)).toHaveLength(8)
    const outputs = await outputsOf(id)
    expect(outputs.find((candidate) => candidate.id === 'a')?.reservedBytes).toBe(800)
    expect(runOutputBytes(outputs)).toBe(950)
  })

  it('refuses stored and unknown outputs and ended runs, and releases a reservation again', async () => {
    const id = await seedRun([output('done', { state: 'stored', size: 1, sha256: 'c'.repeat(64), uploadId: null }), output('a')])
    expect(await mongoOutputStore.reserve(id, 'done', 1, 10_000, new Date())).toBe(false)
    expect(await mongoOutputStore.reserve(id, 'missing', 1, 10_000, new Date())).toBe(false)
    expect(await mongoOutputStore.reserve(id, 'a', 300, 10_000, new Date())).toBe(true)
    await mongoOutputStore.unreserve(id, 'a', 100, new Date())
    expect((await outputsOf(id)).find((candidate) => candidate.id === 'a')?.reservedBytes).toBe(200)
    const ended = await seedRun([output('a')], 'completed')
    expect(await mongoOutputStore.reserve(ended, 'a', 1, 10_000, new Date())).toBe(false)
  })
})
