import type { Collection, Document } from 'mongodb'

// A small in-memory stand-in for a MongoDB collection, covering the query and update subset the foundation code
// uses (equality and comparison operators, $and/$or, $in/$nin, $exists, $type; $set/$setOnInsert/$inc/$unset and
// pipeline $set with $add/$ifNull; partial unique indexes). Unit tests use it instead of a database.

type Doc = Record<string, unknown>

export interface UniqueIndex {
  keys: string[]
  partialFilter?: Doc
}

export class DuplicateKeyError extends Error {
  readonly code = 11000
  constructor(index: string) {
    super(`E11000 duplicate key error index: ${index}`)
    this.name = 'MongoServerError'
  }
}

function getPath(doc: unknown, path: string): unknown {
  let node = doc
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Doc)[segment]
  }
  return node
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const segments = path.split('.')
  let node = doc
  for (const segment of segments.slice(0, -1)) {
    if (node[segment] === null || typeof node[segment] !== 'object') node[segment] = {}
    node = node[segment] as Doc
  }
  node[segments.at(-1)!] = value
}

function unsetPath(doc: Doc, path: string): void {
  const segments = path.split('.')
  const parent = segments.length === 1 ? doc : getPath(doc, segments.slice(0, -1).join('.'))
  if (parent && typeof parent === 'object') Reflect.deleteProperty(parent, segments.at(-1)!)
}

/** Replaces the contents of `target` in place (documents are shared by reference with the store). */
function replaceContents(target: Doc, next: Doc): void {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key)
  Object.assign(target, next)
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

function compare(a: unknown, b: unknown): number {
  const left = comparable(a) as number | string
  const right = comparable(b) as number | string
  if (left === right) return 0
  if (left === undefined || left === null) return -1
  if (right === undefined || right === null) return 1
  return left < right ? -1 : 1
}

function equals(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return comparable(a) === comparable(b)
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return a === b
}

function matchesValue(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date) && !Array.isArray(condition)) {
    const entries = Object.entries(condition as Doc)
    if (entries.length > 0 && entries.every(([key]) => key.startsWith('$'))) {
      return entries.every(([operator, operand]) => {
        switch (operator) {
          case '$eq':
            return matchesValue(value, operand)
          case '$ne':
            return !matchesValue(value, operand)
          case '$lt':
            return value !== undefined && value !== null && compare(value, operand) < 0
          case '$lte':
            return value !== undefined && value !== null && compare(value, operand) <= 0
          case '$gt':
            return value !== undefined && value !== null && compare(value, operand) > 0
          case '$gte':
            return value !== undefined && value !== null && compare(value, operand) >= 0
          case '$in':
            return (operand as unknown[]).some((candidate) => matchesValue(value, candidate))
          case '$nin':
            return !(operand as unknown[]).some((candidate) => matchesValue(value, candidate))
          case '$exists':
            return (value !== undefined) === operand
          case '$type':
            return operand === 'string' ? typeof value === 'string' : false
          default:
            throw new Error(`fake collection: unsupported operator ${operator}`)
        }
      })
    }
  }
  if (condition === null) return value === null || value === undefined
  if (Array.isArray(value) && !Array.isArray(condition)) return value.some((item) => equals(item, condition))
  return equals(value, condition)
}

export function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return (condition as Doc[]).every((clause) => matches(doc, clause))
    if (key === '$or') return (condition as Doc[]).some((clause) => matches(doc, clause))
    return matchesValue(getPath(doc, key), condition)
  })
}

function evaluate(doc: Doc, expression: unknown): unknown {
  if (typeof expression === 'string' && expression.startsWith('$')) return getPath(doc, expression.slice(1))
  if (expression !== null && typeof expression === 'object' && !(expression instanceof Date) && !Array.isArray(expression)) {
    const [operator, operand] = Object.entries(expression as Doc)[0] ?? []
    if (operator === '$add') return (operand as unknown[]).reduce<number>((sum, item) => sum + Number(evaluate(doc, item)), 0)
    if (operator === '$ifNull') {
      const [first, fallback] = operand as unknown[]
      const value = evaluate(doc, first)
      return value === null || value === undefined ? evaluate(doc, fallback) : value
    }
    if (operator?.startsWith('$')) throw new Error(`fake collection: unsupported expression ${operator}`)
  }
  return expression
}

function applyUpdate(doc: Doc, update: Doc | Doc[], inserting: boolean): Doc {
  const next = structuredClone(doc)
  if (Array.isArray(update)) {
    for (const stage of update) {
      for (const [path, expression] of Object.entries((stage.$set ?? {}) as Doc)) setPath(next, path, evaluate(doc, expression))
    }
    return next
  }
  for (const [operator, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      if (operator === '$set') setPath(next, path, structuredClone(value))
      else if (operator === '$setOnInsert') {
        if (inserting) setPath(next, path, structuredClone(value))
      } else if (operator === '$inc') setPath(next, path, Number(getPath(next, path) ?? 0) + Number(value))
      else if (operator === '$unset') unsetPath(next, path)
      else throw new Error(`fake collection: unsupported update operator ${operator}`)
    }
  }
  return next
}

function sortDocs(docs: Doc[], sort?: Record<string, 1 | -1>): Doc[] {
  if (!sort) return docs
  return [...docs].sort((a, b) => {
    for (const [key, direction] of Object.entries(sort)) {
      const order = compare(getPath(a, key), getPath(b, key))
      if (order !== 0) return order * direction
    }
    return 0
  })
}

function project(doc: Doc, projection?: Record<string, 0 | 1>): Doc {
  if (!projection) return structuredClone(doc)
  const included = Object.entries(projection).filter(([, flag]) => flag === 1)
  if (included.length === 0) return structuredClone(doc)
  const result: Doc = {}
  for (const [path] of included) {
    const value = getPath(doc, path)
    if (value !== undefined) setPath(result, path, structuredClone(value))
  }
  return result
}

interface FindOptions {
  sort?: Record<string, 1 | -1>
  projection?: Record<string, 0 | 1>
}

class FakeCursor<T> {
  private sortSpec?: Record<string, 1 | -1>
  private limitCount?: number
  private projection?: Record<string, 0 | 1>

  constructor(private readonly source: () => Doc[]) {}

  sort(spec: Record<string, 1 | -1>) {
    this.sortSpec = spec
    return this
  }

  limit(count: number) {
    this.limitCount = count
    return this
  }

  project<P = T>(projection: Record<string, 0 | 1>): FakeCursor<P> {
    this.projection = projection
    return this as unknown as FakeCursor<P>
  }

  async toArray(): Promise<T[]> {
    const sorted = sortDocs(this.source(), this.sortSpec)
    const limited = this.limitCount === undefined ? sorted : sorted.slice(0, this.limitCount)
    return limited.map((doc) => project(doc, this.projection)) as T[]
  }
}

export class FakeCollection<T extends Document = Document> {
  readonly docs: Doc[] = []
  /** every filter passed to a read, for assertions on query shapes */
  readonly filters: Doc[] = []

  constructor(
    readonly collectionName = 'fake',
    private readonly uniqueIndexes: UniqueIndex[] = [],
  ) {}

  private checkUnique(candidate: Doc, ignore?: Doc): void {
    for (const other of this.docs) {
      if (other === ignore) continue
      if (other._id === candidate._id) throw new DuplicateKeyError('_id_')
      for (const index of this.uniqueIndexes) {
        if (index.partialFilter && (!matches(candidate, index.partialFilter) || !matches(other, index.partialFilter))) continue
        if (index.keys.every((key) => equals(getPath(candidate, key), getPath(other, key)))) throw new DuplicateKeyError(index.keys.join('_'))
      }
    }
  }

  private select(filter: Doc): Doc[] {
    this.filters.push(filter)
    return this.docs.filter((doc) => matches(doc, filter))
  }

  async insertOne(doc: T) {
    const copy = structuredClone(doc) as Doc
    this.checkUnique(copy)
    this.docs.push(copy)
    return { acknowledged: true, insertedId: copy._id }
  }

  async findOne(filter: Doc = {}, options: FindOptions = {}): Promise<T | null> {
    const found = sortDocs(this.select(filter), options.sort)[0]
    return found ? (project(found, options.projection) as T) : null
  }

  find(filter: Doc = {}, options: FindOptions = {}): FakeCursor<T> {
    const cursor = new FakeCursor<T>(() => this.select(filter))
    if (options.sort) cursor.sort(options.sort)
    if (options.projection) cursor.project(options.projection)
    return cursor
  }

  async countDocuments(filter: Doc = {}): Promise<number> {
    return this.select(filter).length
  }

  private upsertDoc(filter: Doc, update: Doc | Doc[]): Doc {
    const seed: Doc = {}
    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith('$') && (value === null || typeof value !== 'object' || value instanceof Date)) setPath(seed, key, value)
    }
    const created = applyUpdate(seed, update, true)
    this.checkUnique(created)
    this.docs.push(created)
    return created
  }

  async findOneAndUpdate(
    filter: Doc,
    update: Doc | Doc[],
    options: { sort?: Record<string, 1 | -1>; returnDocument?: 'before' | 'after'; upsert?: boolean } = {},
  ): Promise<T | null> {
    const target = sortDocs(this.select(filter), options.sort)[0]
    if (!target) {
      if (!options.upsert) return null
      const created = this.upsertDoc(filter, update)
      return options.returnDocument === 'after' ? (structuredClone(created) as T) : null
    }
    const next = applyUpdate(target, update, false)
    this.checkUnique(next, target)
    const before = structuredClone(target)
    replaceContents(target, next)
    return (options.returnDocument === 'after' ? structuredClone(target) : before) as T
  }

  async updateOne(filter: Doc, update: Doc | Doc[], options: { upsert?: boolean } = {}) {
    const target = this.select(filter)[0]
    if (!target) {
      if (options.upsert) {
        this.upsertDoc(filter, update)
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
    }
    const next = applyUpdate(target, update, false)
    this.checkUnique(next, target)
    replaceContents(target, next)
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
  }

  async updateMany(filter: Doc, update: Doc) {
    const targets = this.select(filter)
    for (const target of targets) {
      replaceContents(target, applyUpdate(target, update, false))
    }
    return { matchedCount: targets.length, modifiedCount: targets.length }
  }

  async deleteOne(filter: Doc) {
    const index = this.docs.findIndex((doc) => matches(doc, filter))
    if (index >= 0) this.docs.splice(index, 1)
    return { deletedCount: index >= 0 ? 1 : 0 }
  }

  async deleteMany(filter: Doc) {
    const before = this.docs.length
    const keep = this.docs.filter((doc) => !matches(doc, filter))
    this.docs.splice(0, this.docs.length, ...keep)
    return { deletedCount: before - keep.length }
  }

  /** This fake typed as a driver collection. */
  asCollection(): Collection<T> {
    return this as unknown as Collection<T>
  }
}
