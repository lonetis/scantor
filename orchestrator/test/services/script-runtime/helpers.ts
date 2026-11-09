import type { Collection, Document } from 'mongodb'
import type { AnalysisDoc, ScanDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Test doubles of the script runtime API: an analyses collection whose `find` cursors are async iterable and closable
// like the driver's (the export windows iterate them), with hooks that fail or delay a window.

export const OWNER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
export const OTHER_USER = '1c7a7a1f-4d1f-4b7f-8a1f-6e2a9c1b8d22'
export const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
export const RUN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
export const SCRIPT = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d'

export interface WindowHooks {
  /** runs before the n-th find (0-based) yields its first document; may throw or wait */
  beforeFind?: (index: number, filter: Document) => Promise<void> | void
}

export interface StreamableAnalyses {
  fake: FakeCollection<AnalysisDoc>
  collection: Collection<Document>
  finds: Document[]
  closed: number
}

/** An analyses collection for exportDocuments: findOne with sort and projection, find as an async iterable cursor. */
export function streamableAnalyses(hooks: WindowHooks = {}): StreamableAnalyses {
  const fake = new FakeCollection<AnalysisDoc>('analyses')
  const state: StreamableAnalyses = { fake, collection: undefined as unknown as Collection<Document>, finds: [], closed: 0 }
  const collection = {
    findOne: (filter: Document, options: { sort?: Record<string, 1 | -1>; projection?: Record<string, 0 | 1> } = {}) =>
      fake.findOne(filter, { sort: options.sort, projection: options.projection }),
    find: (filter: Document, options: { sort?: Record<string, 1 | -1>; projection?: Record<string, 0 | 1> } = {}) => {
      const index = state.finds.length
      state.finds.push(filter)
      const cursor = fake.find(filter, { sort: options.sort, projection: options.projection })
      return {
        async *[Symbol.asyncIterator]() {
          await hooks.beforeFind?.(index, filter)
          for (const doc of await cursor.toArray()) yield doc
        },
        close: async () => {
          state.closed += 1
        },
      }
    },
  }
  state.collection = collection as unknown as Collection<Document>
  return state
}

export function analysis(seq: number, overrides: Partial<AnalysisDoc> = {}): AnalysisDoc {
  const at = new Date('2026-01-01T00:00:00Z')
  return {
    _id: `${SCAN}-${seq}`,
    scanId: SCAN,
    userId: OWNER,
    seq,
    round: 1,
    status: 'succeeded',
    attempt: 1,
    config: { url: `https://example.com/${seq}`, token: 'secret' },
    result: { title: `t${seq}` },
    attempts: [],
    files: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as AnalysisDoc
}

export function scan(overrides: Partial<ScanDoc> = {}): ScanDoc {
  return {
    _id: SCAN,
    userId: OWNER,
    name: 'scan one',
    state: 'completed',
    task: { id: 't', name: 'files' },
    revision: { id: 'rev-1', number: 3, language: 'python' },
    secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: ['/token'], result: [] },
    stats: { pending: 0, retrying: 0, succeeded: 3, failed: 1, lost: 0, cancelled: 0, expectedTotal: null, ratePerMin: 0, recountedAt: null },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    ...overrides,
  } as ScanDoc
}
