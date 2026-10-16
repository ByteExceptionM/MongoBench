import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RESULT_CAP, type DocumentEnvelope, type WriteOp } from '@shared/types'
import type { AppliedSimple } from '@/store/tabs'
import {
  boundedFindLimit,
  compileFind,
  runAggregation,
  runFind,
  runShellCommand,
  runShellWrite,
  writtenCollection,
  type ShellReadCommand,
  type ShellWriteCommand
} from './queryRun'

const { find, aggregate, count, distinct, write } = vi.hoisted(() => ({
  find: vi.fn(),
  aggregate: vi.fn(),
  count: vi.fn(),
  distinct: vi.fn(),
  write: vi.fn()
}))
vi.mock('./api', () => ({ api: { query: { find, aggregate, count, distinct, write } } }))

const CONN = '00000000-0000-4000-8000-000000000001'
const REQUEST = '00000000-0000-4000-8000-0000000000aa'
const DB = { connectionId: CONN, db: 'app' }
const USERS = { ...DB, coll: 'users' }

const envelope = (n: number): DocumentEnvelope => ({
  id: `{"$numberInt":"${n}"}`,
  data: { _id: n },
  canonical: `{"_id":{"$numberInt":"${n}"}}`,
  hash: 'h'
})
const rows = (n: number): DocumentEnvelope[] => Array.from({ length: n }, (_, i) => envelope(i))

const applied = (patch: Partial<AppliedSimple> = {}): AppliedSimple => ({
  filter: '{}',
  projection: '{}',
  sort: '{}',
  skip: 0,
  limit: 100,
  epoch: 1,
  ...patch
})

beforeEach(() => {
  find.mockReset().mockResolvedValue({ documents: rows(2), tookMs: 7 })
  aggregate.mockReset().mockResolvedValue({ documents: rows(2), tookMs: 8, truncated: false })
  count.mockReset().mockResolvedValue({ count: 42, estimated: false, tookMs: 3 })
  distinct.mockReset().mockResolvedValue({ documents: rows(2), tookMs: 4, truncated: false })
  write.mockReset().mockResolvedValue({ tookMs: 11, counts: {}, ids: [], idsTruncated: false })
})

describe('boundedFindLimit', () => {
  it.each([
    [null, RESULT_CAP + 1],
    [1, 1],
    [50, 50],
    [RESULT_CAP, RESULT_CAP],
    [RESULT_CAP + 1, RESULT_CAP + 1],
    [5000, RESULT_CAP + 1]
  ])('maps %s to %s', (limit, expected) => {
    expect(boundedFindLimit(limit)).toBe(expected)
  })
})

describe('compileFind', () => {
  it('compiles the editor texts to EJSON and keeps paging', () => {
    const result = compileFind(
      applied({ filter: '{ age: { $gt: 5 } }', sort: '{ a: -1 }', skip: 20, limit: 10 })
    )
    expect(result).toEqual({
      ok: true,
      find: { filter: '{"age":{"$gt":5}}', projection: '{}', sort: '{"a":-1}', skip: 20, limit: 10 }
    })
  })

  it('names the editor that fails to parse', () => {
    expect(compileFind(applied({ projection: '{ a: }' }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Projection: /)
    })
    expect(compileFind(applied({ filter: '{', sort: '{ a: }' }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Filter: /)
    })
  })
})

describe('runFind', () => {
  const compiled = (patch: Record<string, unknown> = {}) => ({
    filter: '{}',
    projection: '{}',
    sort: '{}',
    skip: 0,
    limit: 100,
    ...patch
  })

  it('sends the query with its request id and wraps whole documents as full rows', async () => {
    const result = await runFind(USERS, compiled({ skip: 200 }), REQUEST)
    expect(find).toHaveBeenCalledWith({
      ...USERS,
      filter: '{}',
      projection: '{}',
      sort: '{}',
      skip: 200,
      limit: 100,
      requestId: REQUEST
    })
    expect(result).toEqual({
      kind: 'documents',
      origin: 'find',
      documents: rows(2),
      tookMs: 7,
      truncated: false,
      rowAccess: 'full',
      coll: 'users'
    })
  })

  it('omits a zero limit and empty editors', async () => {
    await runFind(USERS, compiled({ filter: '', projection: '', sort: '', limit: 0 }), REQUEST)
    expect(find).toHaveBeenCalledWith({ ...USERS, skip: 0, requestId: REQUEST })
  })

  it('gives projected rows byId access', async () => {
    const result = await runFind(USERS, compiled({ projection: '{"name":1}' }), REQUEST)
    expect(result).toMatchObject({ rowAccess: 'byId' })
  })

  it('treats an empty projection as whole documents', async () => {
    expect(await runFind(USERS, compiled({ projection: '' }), REQUEST)).toMatchObject({
      rowAccess: 'full'
    })
  })
})

describe('runAggregation', () => {
  it('sends the compiled pipeline with its request id', async () => {
    await runAggregation(USERS, { ejson: '[{"$match":{}}]', documentPreserving: true }, REQUEST)
    expect(aggregate).toHaveBeenCalledWith({
      ...USERS,
      pipeline: '[{"$match":{}}]',
      requestId: REQUEST
    })
  })

  it('gives full access only to document-preserving pipelines', async () => {
    const preserving = await runAggregation(
      USERS,
      { ejson: '[]', documentPreserving: true },
      REQUEST
    )
    const derived = await runAggregation(
      USERS,
      { ejson: '[{"$group":{"_id":"$a"}}]', documentPreserving: false },
      REQUEST
    )
    expect(preserving).toMatchObject({ kind: 'documents', origin: 'aggregate', rowAccess: 'full' })
    expect(derived).toMatchObject({ rowAccess: 'none' })
  })

  it('reports truncation from the response', async () => {
    aggregate.mockResolvedValue({ documents: rows(RESULT_CAP), tookMs: 9, truncated: true })
    const result = await runAggregation(USERS, { ejson: '[]', documentPreserving: true }, REQUEST)
    expect(result).toMatchObject({ truncated: true, tookMs: 9, coll: 'users' })
  })
})

describe('runShellCommand', () => {
  const shell = (coll: string, op: ShellReadCommand['op']): ShellReadCommand => ({ coll, op })
  const findOp = (patch: Record<string, unknown> = {}): ShellReadCommand['op'] => ({
    kind: 'find',
    filter: '{"a":1}',
    projection: null,
    sort: null,
    skip: 0,
    limit: null,
    ...patch
  })

  it('caps a find without a limit at RESULT_CAP + 1 and targets the command collection', async () => {
    await runShellCommand(DB, shell('orders', findOp({ skip: 30 })), REQUEST)
    expect(find).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      filter: '{"a":1}',
      skip: 30,
      limit: RESULT_CAP + 1,
      requestId: REQUEST
    })
  })

  it('passes projection, sort and a small limit through', async () => {
    await runShellCommand(
      DB,
      shell('orders', findOp({ projection: '{"b":1}', sort: '{"c":-1}', limit: 5 })),
      REQUEST
    )
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ projection: '{"b":1}', sort: '{"c":-1}', limit: 5 })
    )
  })

  it('cuts RESULT_CAP + 1 rows to RESULT_CAP and marks the result truncated', async () => {
    find.mockResolvedValue({ documents: rows(RESULT_CAP + 1), tookMs: 5 })
    const result = await runShellCommand(DB, shell('orders', findOp()), REQUEST)
    expect(result).toMatchObject({ kind: 'documents', origin: 'find', truncated: true })
    expect(result.kind === 'documents' && result.documents).toHaveLength(RESULT_CAP)
  })

  it('does not mark exactly RESULT_CAP rows as truncated', async () => {
    find.mockResolvedValue({ documents: rows(RESULT_CAP), tookMs: 5 })
    const result = await runShellCommand(DB, shell('orders', findOp()), REQUEST)
    expect(result).toMatchObject({ truncated: false, coll: 'orders' })
  })

  it('derives row access from the projection', async () => {
    const whole = await runShellCommand(DB, shell('orders', findOp()), REQUEST)
    const partial = await runShellCommand(
      DB,
      shell('orders', findOp({ projection: '{"b":1}' })),
      REQUEST
    )
    expect(whole).toMatchObject({ rowAccess: 'full' })
    expect(partial).toMatchObject({ rowAccess: 'byId' })
  })

  it('runs findOne as a find with limit 1', async () => {
    const result = await runShellCommand(
      DB,
      shell('orders', { kind: 'findOne', filter: '{}', projection: '{"x":1}' }),
      REQUEST
    )
    expect(find).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      filter: '{}',
      projection: '{"x":1}',
      skip: 0,
      limit: 1,
      requestId: REQUEST
    })
    expect(result).toMatchObject({ origin: 'find', rowAccess: 'byId', truncated: false })
  })

  it('maps aggregate with its preserving flag and response truncation', async () => {
    aggregate.mockResolvedValue({ documents: rows(1), tookMs: 2, truncated: true })
    const result = await runShellCommand(
      DB,
      shell('orders', { kind: 'aggregate', pipeline: '[]', documentPreserving: false }),
      REQUEST
    )
    expect(aggregate).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      pipeline: '[]',
      requestId: REQUEST
    })
    expect(result).toMatchObject({ origin: 'aggregate', rowAccess: 'none', truncated: true })
  })

  it('counts exactly for countDocuments', async () => {
    const result = await runShellCommand(
      DB,
      shell('orders', { kind: 'count', method: 'countDocuments', filter: '{}' }),
      REQUEST
    )
    expect(count).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      filter: '{}',
      exact: true,
      requestId: REQUEST
    })
    expect(result).toEqual({
      kind: 'count',
      method: 'countDocuments',
      count: 42,
      estimated: false,
      tookMs: 3,
      coll: 'orders'
    })
  })

  it('lets legacy count estimate an empty filter', async () => {
    count.mockResolvedValue({ count: 10, estimated: true, tookMs: 1 })
    const result = await runShellCommand(
      DB,
      shell('orders', { kind: 'count', method: 'count', filter: '{}' }),
      REQUEST
    )
    expect(count).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      filter: '{}',
      exact: false,
      requestId: REQUEST
    })
    expect(result).toMatchObject({ method: 'count', estimated: true })
  })

  it('sends no filter for estimatedDocumentCount', async () => {
    count.mockResolvedValue({ count: 10, estimated: true, tookMs: 1 })
    await runShellCommand(
      DB,
      shell('orders', { kind: 'count', method: 'estimatedDocumentCount', filter: null }),
      REQUEST
    )
    expect(count).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      exact: false,
      requestId: REQUEST
    })
  })

  it('runs distinct without a request id and never grants row access', async () => {
    distinct.mockResolvedValue({ documents: rows(3), tookMs: 6, truncated: true })
    const result = await runShellCommand(
      DB,
      shell('orders', { kind: 'distinct', field: 'status', filter: '{"a":1}' }),
      REQUEST
    )
    expect(distinct).toHaveBeenCalledWith({
      ...DB,
      coll: 'orders',
      field: 'status',
      filter: '{"a":1}'
    })
    expect(result).toMatchObject({
      kind: 'documents',
      origin: 'distinct',
      rowAccess: 'none',
      truncated: true,
      tookMs: 6
    })
  })

  it('omits an absent distinct filter', async () => {
    await runShellCommand(
      DB,
      shell('orders', { kind: 'distinct', field: 'status', filter: null }),
      REQUEST
    )
    expect(distinct).toHaveBeenCalledWith({ ...DB, coll: 'orders', field: 'status' })
  })
})

describe('runShellWrite', () => {
  const writeCommand = (
    coll: string,
    op: WriteOp,
    writes: ShellWriteCommand['op']['writes'] = { db: null, coll }
  ): ShellWriteCommand => ({ coll, op: { kind: 'write', write: op, writes } })

  it('sends the write op for the command collection and maps the response', async () => {
    write.mockResolvedValue({
      tookMs: 9,
      counts: { inserted: 2 },
      ids: ['{"$oid":"65f0a0a0a0a0a0a0a0a0a0a1"}', '{"$numberInt":"7"}'],
      idsTruncated: false
    })
    const op: WriteOp = { method: 'insertMany', documents: ['{}', '{"_id":{"$numberInt":"7"}}'] }
    const result = await runShellWrite(DB, writeCommand('orders', op))
    expect(write).toHaveBeenCalledWith({ ...DB, coll: 'orders', op })
    expect(result).toEqual({
      method: 'insertMany',
      counts: { inserted: 2 },
      ids: ['{"$oid":"65f0a0a0a0a0a0a0a0a0a0a1"}', '{"$numberInt":"7"}'],
      idsTruncated: false,
      returned: null,
      writes: { ...DB, coll: 'orders' },
      tookMs: 9
    })
  })

  it.each<WriteOp>([
    { method: 'insertOne', document: '{}' },
    { method: 'updateOne', filter: '{}', update: '{"$set":{"a":{"$numberInt":"1"}}}' },
    { method: 'updateMany', filter: '{}', update: '[{"$set":{"a":"$b"}}]' },
    { method: 'replaceOne', filter: '{}', replacement: '{"a":{"$numberInt":"1"}}' },
    { method: 'deleteOne', filter: '{"a":{"$numberInt":"1"}}' },
    { method: 'deleteMany', filter: '{}' },
    {
      method: 'bulkWrite',
      operations: '[{"deleteOne":{"filter":{}}}]',
      options: '{"ordered":false}'
    }
  ])('returns no document for $method', async (op) => {
    write.mockResolvedValue({ tookMs: 1, counts: { deleted: 1 }, ids: [], idsTruncated: false })
    const result = await runShellWrite(DB, writeCommand('orders', op))
    expect(write).toHaveBeenCalledWith({ ...DB, coll: 'orders', op })
    expect(result).toMatchObject({ method: op.method, counts: { deleted: 1 }, returned: null })
  })

  it('keeps the truncation of the ids', async () => {
    write.mockResolvedValue({
      tookMs: 1,
      counts: { inserted: RESULT_CAP + 5 },
      ids: Array.from({ length: RESULT_CAP }, (_, i) => `{"$numberInt":"${i}"}`),
      idsTruncated: true
    })
    const op: WriteOp = { method: 'insertMany', documents: ['{}'] }
    const result = await runShellWrite(DB, writeCommand('orders', op))
    expect(result.idsTruncated).toBe(true)
    expect(result.ids).toHaveLength(RESULT_CAP)
  })

  it('reports the $out / $merge target of an aggregation as the written collection', async () => {
    const op: WriteOp = {
      method: 'aggregate',
      pipeline: '[{"$out":{"db":"archive","coll":"old"}}]'
    }
    const result = await runShellWrite(
      DB,
      writeCommand('orders', op, { db: 'archive', coll: 'old' })
    )
    expect(write).toHaveBeenCalledWith({ ...DB, coll: 'orders', op })
    expect(result).toMatchObject({
      method: 'aggregate',
      returned: null,
      writes: { connectionId: CONN, db: 'archive', coll: 'old' }
    })
  })

  describe('returned document', () => {
    const doc = envelope(1)

    // Main decodes the returned document with value promotion, so it is never edited as is.
    it.each<{ name: string; op: WriteOp; rowAccess: 'byId' | 'none' }>([
      {
        name: 'findOneAndDelete',
        op: { method: 'findOneAndDelete', filter: '{}' },
        rowAccess: 'none'
      },
      {
        name: 'findOneAndDelete returning a projection',
        op: { method: 'findOneAndDelete', filter: '{}', options: '{"projection":{"a":1}}' },
        rowAccess: 'none'
      },
      {
        name: 'findOneAndUpdate returning the document before the update',
        op: { method: 'findOneAndUpdate', filter: '{}', update: '{"$set":{"a":1}}' },
        rowAccess: 'byId'
      },
      {
        name: 'findOneAndUpdate with returnDocument "after"',
        op: {
          method: 'findOneAndUpdate',
          filter: '{}',
          update: '{"$set":{"a":1}}',
          options: '{"returnDocument":"after"}'
        },
        rowAccess: 'byId'
      },
      {
        name: 'findOneAndUpdate with returnNewDocument true',
        op: {
          method: 'findOneAndUpdate',
          filter: '{}',
          update: '{"$set":{"a":1}}',
          options: '{"returnNewDocument":true,"upsert":true}'
        },
        rowAccess: 'byId'
      },
      {
        name: 'findOneAndUpdate with an empty projection of the new document',
        op: {
          method: 'findOneAndUpdate',
          filter: '{}',
          update: '{"$set":{"a":1}}',
          options: '{"returnDocument":"after","projection":{}}'
        },
        rowAccess: 'byId'
      },
      {
        name: 'findOneAndReplace returning the replaced document',
        op: { method: 'findOneAndReplace', filter: '{}', replacement: '{}' },
        rowAccess: 'byId'
      },
      {
        name: 'findOneAndReplace with returnDocument "after"',
        op: {
          method: 'findOneAndReplace',
          filter: '{}',
          replacement: '{}',
          options: '{"returnDocument":"after"}'
        },
        rowAccess: 'byId'
      }
    ])('$name gives $rowAccess access', async ({ op, rowAccess }) => {
      write.mockResolvedValue({
        tookMs: 1,
        counts: {},
        ids: [],
        idsTruncated: false,
        document: doc
      })
      const result = await runShellWrite(DB, writeCommand('orders', op))
      expect(result.returned).toEqual({ document: doc, rowAccess })
    })

    it('reports a findOneAnd* that matched nothing as a null document', async () => {
      write.mockResolvedValue({
        tookMs: 1,
        counts: {},
        ids: [],
        idsTruncated: false,
        document: null
      })
      const op: WriteOp = { method: 'findOneAndDelete', filter: '{"a":1}' }
      const result = await runShellWrite(DB, writeCommand('orders', op))
      expect(result.returned).toEqual({ document: null, rowAccess: 'none' })
    })
  })
})

describe('writtenCollection', () => {
  const command = (writes: ShellWriteCommand['op']['writes']): ShellWriteCommand => ({
    coll: 'orders',
    op: { kind: 'write', write: { method: 'aggregate', pipeline: '[]' }, writes }
  })

  it('resolves a target without a database to the tab database', () => {
    expect(writtenCollection(DB, command({ db: null, coll: 'summary' }))).toEqual({
      ...DB,
      coll: 'summary'
    })
  })

  it('keeps a target in another database', () => {
    expect(writtenCollection(DB, command({ db: 'archive', coll: 'summary' }))).toEqual({
      connectionId: CONN,
      db: 'archive',
      coll: 'summary'
    })
  })
})
