import { describe, expect, it, vi } from 'vitest'
import { BSON, BSONRegExp, Double, EJSON, Int32, Long, ObjectId, type Document } from 'bson'
import { MongoServerError } from 'mongodb'
import { rejectedStageMessage } from '@shared/pipeline'
import { RESULT_CAP, type WriteOp } from '@shared/types'
import {
  bulkWriteError,
  insertDocumentError,
  replacementError,
  updateError,
  writeOptionsError
} from '@shared/writeOps'
import { mapError } from '../lib/errorMap'
import type { ConnectionService } from './ConnectionService'
import { QueryService } from './QueryService'

const REF = { connectionId: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', db: 'app', coll: 'players' }
const REQUEST_ID = '0b6e4a52-3c1d-4f7e-9a8b-2d5c6e7f8a9b'
const OID = '507f1f77bcf86cd799439011'
const BEYOND_2_53 = '9007199254740993'

type ReadOptions = {
  raw?: boolean
  promoteValues?: boolean
  promoteLongs?: boolean
  bsonRegExp?: boolean
  signal?: AbortSignal
}

type ServerReply = { code: number; errmsg: string }

/**
 * Holds documents as BSON bytes and answers reads like the driver: raw bytes with `raw`, else
 * decoded with the call's BSON options. A `failure` reply is decoded with those same options into
 * a MongoServerError, as the driver's connection does. With `hang`, reads settle only when their
 * signal aborts, rejecting with `abortError` or else the signal's reason.
 */
function fakeCollection(
  docs: Document[],
  {
    hang = false,
    failure,
    abortError
  }: { hang?: boolean; failure?: ServerReply; abortError?: Error } = {}
) {
  const bytes = docs.map((d) => BSON.serialize(d))
  const bsonOptions = (options: ReadOptions | undefined) => ({
    promoteValues: options?.promoteValues,
    promoteLongs: options?.promoteLongs,
    bsonRegExp: options?.bsonRegExp,
    raw: options?.raw
  })
  const decoded = (options: ReadOptions | undefined): Document[] =>
    bytes.map((b) => BSON.deserialize(b, bsonOptions(options)))
  const results = (options: ReadOptions | undefined): unknown[] =>
    options?.raw ? bytes : decoded(options)
  const read = <T>(options: ReadOptions | undefined, value: () => T): Promise<T> => {
    if (failure) {
      const reply = BSON.deserialize(BSON.serialize({ ok: 0, ...failure }), bsonOptions(options))
      return Promise.reject(new MongoServerError(reply))
    }
    if (!hang) return Promise.resolve(value())
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(abortError ?? options.signal?.reason))
    })
  }

  const cursor = (options: ReadOptions | undefined) => {
    const c = {
      project: vi.fn(() => c),
      sort: vi.fn(() => c),
      skip: vi.fn(() => c),
      limit: vi.fn(() => c),
      toArray: () => read(options, () => results(options))
    }
    return c
  }

  return {
    find: vi.fn((_filter: Document, options?: ReadOptions) => cursor(options)),
    aggregate: vi.fn((_pipeline: Document[], options?: ReadOptions) => ({
      toArray: () => read(options, () => results(options))
    })),
    findOne: vi.fn((_filter: Document, options?: ReadOptions) =>
      read(options, () => results(options)[0] ?? null)
    ),
    countDocuments: vi.fn((_filter: Document, options?: ReadOptions) =>
      read(options, () => docs.length)
    ),
    estimatedDocumentCount: vi.fn(async () => docs.length),
    distinct: vi.fn((field: string, _filter: Document, options?: ReadOptions) =>
      read(options, () => decoded(options).map((d) => d[field]))
    ),
    replaceOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 }))
  }
}

function serviceFor(coll: object): QueryService {
  const client = { db: () => ({ collection: () => coll }) }
  return new QueryService({ getClient: () => client } as unknown as ConnectionService)
}

function manyDocs(n: number): Document[] {
  return Array.from({ length: n }, (_, i) => ({ i }))
}

/** A filter value as the driver encodes it, with Longs left unpromoted. */
function encodedAs(filter: unknown, field: string): string {
  const encoded = BSON.deserialize(BSON.serialize(filter as Document), { promoteLongs: false })
  return `${(encoded[field] as { _bsontype?: string })._bsontype}(${String(encoded[field])})`
}

describe('QueryService.find', () => {
  it('reads without promoting values, so stored numeric types survive', async () => {
    const coll = fakeCollection([
      { _id: new ObjectId(OID), coins: Long.fromNumber(1500), ratio: new Double(2) }
    ])
    const { documents } = await serviceFor(coll).find({ ...REF, skip: 0 })

    expect(JSON.parse(documents[0]?.canonical ?? '')).toEqual({
      _id: { $oid: OID },
      coins: { $numberLong: '1500' },
      ratio: { $numberDouble: '2.0' }
    })
  })

  it('keeps stored regexes that a JS RegExp cannot represent', async () => {
    const coll = fakeCollection([
      { _id: 1, dotAll: new BSONRegExp('dot.all', 's'), pcre: new BSONRegExp('(?i)abc', '') }
    ])
    const { documents } = await serviceFor(coll).find({ ...REF, skip: 0 })

    expect(JSON.parse(documents[0]?.canonical ?? '')).toMatchObject({
      dotAll: { $regularExpression: { pattern: 'dot.all', options: 's' } },
      pcre: { $regularExpression: { pattern: '(?i)abc', options: '' } }
    })
  })

  it('identifies a document by its canonical _id', async () => {
    const coll = fakeCollection([{ _id: new ObjectId(OID), name: 'a' }])
    const { documents } = await serviceFor(coll).find({ ...REF, skip: 0 })
    expect(documents[0]?.id).toBe(`{"$oid":"${OID}"}`)
  })

  it('gives rows without _id a null id', async () => {
    const coll = fakeCollection([{ name: 'a' }, { name: 'b' }])
    const { documents } = await serviceFor(coll).find({
      ...REF,
      projection: '{"_id":0,"name":1}',
      skip: 0
    })
    expect(documents.map((d) => d.id)).toEqual([null, null])
  })

  it('applies projection, sort, skip and limit to the cursor', async () => {
    const coll = fakeCollection([{ _id: 1 }])
    await serviceFor(coll).find({
      ...REF,
      filter: '{"a":1}',
      projection: '{"a":1}',
      sort: '{"b":-1}',
      skip: 20,
      limit: 10
    })
    const cursor = coll.find.mock.results[0]?.value as ReturnType<typeof coll.find>
    expect(coll.find.mock.calls[0]?.[0]).toEqual({ a: 1 })
    expect(cursor.project).toHaveBeenCalledWith({ a: 1 })
    expect(cursor.sort).toHaveBeenCalledWith({ b: -1 })
    expect(cursor.skip).toHaveBeenCalledWith(20)
    expect(cursor.limit).toHaveBeenCalledWith(10)
  })

  it('reloads a document by an Int64 _id beyond 2^53 without rounding it', async () => {
    const coll = fakeCollection([])
    await serviceFor(coll).find({
      ...REF,
      filter: `{"_id":{"$numberLong":"${BEYOND_2_53}"}}`,
      skip: 0,
      limit: 1
    })
    expect(encodedAs(coll.find.mock.calls[0]?.[0], '_id')).toBe(`Long(${BEYOND_2_53})`)
  })
})

describe('QueryService.aggregate', () => {
  it('caps the pipeline server-side with one extra row to detect truncation', async () => {
    const coll = fakeCollection([])
    await serviceFor(coll).aggregate({ ...REF, pipeline: '[{"$match":{"a":"x"}}]' })
    expect(coll.aggregate.mock.calls[0]?.[0]).toEqual([
      { $match: { a: 'x' } },
      { $limit: RESULT_CAP + 1 }
    ])
  })

  it('keeps the stored numeric and regex types', async () => {
    const coll = fakeCollection([{ _id: 1, d: new Double(5), re: new BSONRegExp('a b', 'x') }])
    const res = await serviceFor(coll).aggregate({ ...REF, pipeline: '[]' })
    expect(JSON.parse(res.documents[0]?.canonical ?? '')).toEqual({
      _id: { $numberInt: '1' },
      d: { $numberDouble: '5.0' },
      re: { $regularExpression: { pattern: 'a b', options: 'x' } }
    })
  })

  it('returns RESULT_CAP rows and flags truncation when more came back', async () => {
    const coll = fakeCollection(manyDocs(RESULT_CAP + 1))
    const res = await serviceFor(coll).aggregate({ ...REF, pipeline: '[]' })
    expect(res.documents).toHaveLength(RESULT_CAP)
    expect(res.truncated).toBe(true)
  })

  it('does not flag a result of exactly RESULT_CAP rows', async () => {
    const coll = fakeCollection(manyDocs(RESULT_CAP))
    const res = await serviceFor(coll).aggregate({ ...REF, pipeline: '[]' })
    expect(res.documents).toHaveLength(RESULT_CAP)
    expect(res.truncated).toBe(false)
  })

  it('gives derived rows without _id a null id', async () => {
    const coll = fakeCollection([{ total: 3 }])
    const res = await serviceFor(coll).aggregate({ ...REF, pipeline: '[{"$count":"total"}]' })
    expect(res.documents[0]?.id).toBeNull()
  })

  it.each([
    ['$out', 'target'],
    ['$merge', 'target'],
    ['$changeStream', {}]
  ])('rejects a pipeline with %s before it reaches the server', async (stage, spec) => {
    const coll = fakeCollection([])
    const run = serviceFor(coll).aggregate({
      ...REF,
      pipeline: JSON.stringify([{ $match: {} }, { [stage]: spec }])
    })
    await expect(run).rejects.toMatchObject({
      name: 'ValidationError',
      message: rejectedStageMessage(stage)
    })
    expect(coll.aggregate).not.toHaveBeenCalled()
  })

  it('rejects a pipeline that is not an array of stage objects', async () => {
    const coll = fakeCollection([])
    const service = serviceFor(coll)
    await expect(service.aggregate({ ...REF, pipeline: '{"$match":{}}' })).rejects.toMatchObject({
      name: 'ValidationError'
    })
    await expect(service.aggregate({ ...REF, pipeline: '["$match"]' })).rejects.toMatchObject({
      name: 'ValidationError'
    })
  })
})

describe('QueryService.count', () => {
  it('estimates an empty filter from collection metadata by default', async () => {
    const coll = fakeCollection(manyDocs(3))
    const res = await serviceFor(coll).count({ ...REF })
    expect(res).toMatchObject({ count: 3, estimated: true })
    expect(res.tookMs).toBeGreaterThanOrEqual(0)
    expect(coll.countDocuments).not.toHaveBeenCalled()
  })

  it('counts exactly when asked, even with an empty filter', async () => {
    const coll = fakeCollection(manyDocs(3))
    const res = await serviceFor(coll).count({ ...REF, filter: '{}', exact: true })
    expect(res).toMatchObject({ count: 3, estimated: false })
    expect(res.tookMs).toBeGreaterThanOrEqual(0)
    expect(coll.estimatedDocumentCount).not.toHaveBeenCalled()
  })

  it('counts a non-empty filter exactly', async () => {
    const coll = fakeCollection(manyDocs(2))
    const res = await serviceFor(coll).count({ ...REF, filter: '{"i":{"$gte":0}}' })
    expect(res).toMatchObject({ count: 2, estimated: false })
    expect(coll.countDocuments.mock.calls[0]?.[0]).toEqual({ i: { $gte: 0 } })
  })

  it('counts on an Int64 beyond 2^53 without rounding it', async () => {
    const coll = fakeCollection([])
    await serviceFor(coll).count({ ...REF, filter: `{"uid":{"$numberLong":"${BEYOND_2_53}"}}` })
    expect(encodedAs(coll.countDocuments.mock.calls[0]?.[0], 'uid')).toBe(`Long(${BEYOND_2_53})`)
  })
})

describe('QueryService.distinct', () => {
  it('wraps each value as a { value } row without an id', async () => {
    const coll = fakeCollection([
      { tag: 'a' },
      { tag: Long.fromString(BEYOND_2_53) },
      { tag: new BSONRegExp('dot.all', 's') }
    ])
    const res = await serviceFor(coll).distinct({ ...REF, field: 'tag', filter: '{"x":1}' })

    expect(coll.distinct.mock.calls[0]?.slice(0, 2)).toEqual(['tag', { x: 1 }])
    expect(res.documents.map((d) => d.id)).toEqual([null, null, null])
    expect(res.documents.map((d) => JSON.parse(d.canonical))).toEqual([
      { value: 'a' },
      { value: { $numberLong: BEYOND_2_53 } },
      { value: { $regularExpression: { pattern: 'dot.all', options: 's' } } }
    ])
    expect(res.truncated).toBe(false)
  })

  it('keeps an Int64 within 2^53 an Int64', async () => {
    const coll = fakeCollection([{ n: Long.fromNumber(5) }])
    const res = await serviceFor(coll).distinct({ ...REF, field: 'n' })

    expect(res.documents.map((d) => JSON.parse(d.canonical))).toEqual([
      { value: { $numberLong: '5' } }
    ])
  })

  it('caps the values at RESULT_CAP and flags truncation', async () => {
    const coll = fakeCollection(manyDocs(RESULT_CAP + 5))
    const res = await serviceFor(coll).distinct({ ...REF, field: 'i' })
    expect(res.documents).toHaveLength(RESULT_CAP)
    expect(res.truncated).toBe(true)
  })

  it('filters on an Int64 beyond 2^53 without rounding it', async () => {
    const coll = fakeCollection([])
    await serviceFor(coll).distinct({
      ...REF,
      field: 'name',
      filter: `{"uid":{"$numberLong":"${BEYOND_2_53}"}}`
    })
    expect(encodedAs(coll.distinct.mock.calls[0]?.[1], 'uid')).toBe(`Long(${BEYOND_2_53})`)
  })
})

describe('QueryService server errors', () => {
  const id = `{"$oid":"${OID}"}`

  it.each([
    ['find', (s: QueryService) => s.find({ ...REF, skip: 0 })],
    ['aggregate', (s: QueryService) => s.aggregate({ ...REF, pipeline: '[]' })],
    ['distinct', (s: QueryService) => s.distinct({ ...REF, field: 'a' })],
    [
      'the replace precondition',
      (s: QueryService) =>
        s.replaceOne({ ...REF, id, expectedHash: 'x', replacement: `{"_id":${id}}` })
    ],
    ['the delete precondition', (s: QueryService) => s.deleteOne({ ...REF, id, expectedHash: 'x' })]
  ])('%s keeps the server error code a number, as driver retries require', async (_op, run) => {
    const coll = fakeCollection([], { failure: { code: 189, errmsg: 'Primary stepped down' } })

    const error = await run(serviceFor(coll)).then(
      () => null,
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(MongoServerError)
    expect(mapError(error)).toEqual({
      code: 'driver_error',
      message: 'Primary stepped down',
      details: { mongoCode: 189 }
    })
  })
})

describe('QueryService writes', () => {
  it('checks the replace precondition against a document decoded like the envelope', async () => {
    const coll = fakeCollection([
      { _id: new ObjectId(OID), coins: Long.fromNumber(5), re: new BSONRegExp('a/b', 's') }
    ])
    const service = serviceFor(coll)
    const [env] = (await service.find({ ...REF, skip: 0 })).documents
    if (env?.id == null) throw new Error('expected an envelope with an id')

    const res = await service.replaceOne({
      ...REF,
      id: env.id,
      expectedHash: env.hash,
      replacement: env.canonical
    })

    expect(res).toEqual({ matched: 1, modified: 1 })
  })

  it('checks the delete precondition against a document decoded like the envelope', async () => {
    const coll = fakeCollection([
      { _id: new ObjectId(OID), ratio: new Double(1), re: new BSONRegExp('', 'u') }
    ])
    const service = serviceFor(coll)
    const [env] = (await service.find({ ...REF, skip: 0 })).documents
    if (env?.id == null) throw new Error('expected an envelope with an id')

    const res = await service.deleteOne({ ...REF, id: env.id, expectedHash: env.hash })

    expect(res).toEqual({ deletedCount: 1 })
  })

  it('refuses a replace when the stored document changed', async () => {
    const coll = fakeCollection([{ _id: new ObjectId(OID), coins: Long.fromNumber(5) }])
    const id = `{"$oid":"${OID}"}`

    const run = serviceFor(coll).replaceOne({
      ...REF,
      id,
      expectedHash: 'stale',
      replacement: `{"_id":${id}}`
    })

    await expect(run).rejects.toMatchObject({ name: 'DocumentConflictError' })
    expect(coll.replaceOne).not.toHaveBeenCalled()
  })
})

describe('QueryService.cancel', () => {
  it('aborts a running find with a CancelledError', async () => {
    const service = serviceFor(fakeCollection([{ _id: 1 }], { hang: true }))
    const run = service.find({ ...REF, skip: 0, requestId: REQUEST_ID })
    service.cancel(REQUEST_ID)
    await expect(run).rejects.toMatchObject({ name: 'CancelledError' })
  })

  it('aborts a running aggregation', async () => {
    const service = serviceFor(fakeCollection([], { hang: true }))
    const run = service.aggregate({ ...REF, pipeline: '[]', requestId: REQUEST_ID })
    service.cancel(REQUEST_ID)
    await expect(run).rejects.toMatchObject({ name: 'CancelledError' })
  })

  it('aborts a running exact count', async () => {
    const service = serviceFor(fakeCollection([], { hang: true }))
    const run = service.count({ ...REF, exact: true, requestId: REQUEST_ID })
    service.cancel(REQUEST_ID)
    await expect(run).rejects.toMatchObject({ name: 'CancelledError' })
  })

  // An abort during getMore kills the cursor, so the in-flight getMore fails with the server's interrupt.
  it.each([
    ['find', 237, (s: QueryService) => s.find({ ...REF, skip: 0, requestId: REQUEST_ID })],
    [
      'aggregation',
      11601,
      (s: QueryService) => s.aggregate({ ...REF, pipeline: '[]', requestId: REQUEST_ID })
    ]
  ])('reports a %s cancelled during getMore as cancelled', async (_op, code, start) => {
    const interrupted = new MongoServerError({
      errmsg: 'Executor error during getMore :: caused by :: operation was interrupted',
      code
    })
    const service = serviceFor(fakeCollection([], { hang: true, abortError: interrupted }))
    const run = start(service)
    service.cancel(REQUEST_ID)
    await expect(run).rejects.toMatchObject({ name: 'CancelledError' })
  })

  it('passes on a server error of a run that was not cancelled', async () => {
    const coll = fakeCollection([], { failure: { code: 2, errmsg: 'bad query' } })
    const run = serviceFor(coll).find({ ...REF, skip: 0, requestId: REQUEST_ID })
    await expect(run).rejects.toBeInstanceOf(MongoServerError)
  })

  it('aborts only the run with that id', async () => {
    const otherId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const coll = fakeCollection([], { hang: true })
    const service = serviceFor(coll)
    void service.find({ ...REF, skip: 0, requestId: REQUEST_ID }).catch(() => undefined)
    void service.find({ ...REF, skip: 0, requestId: otherId }).catch(() => undefined)

    service.cancel(REQUEST_ID)

    const signals = coll.find.mock.calls.map((call) => call[1]?.signal)
    expect(signals.map((s) => s?.aborted)).toEqual([true, false])
    service.cancel(otherId)
  })

  it('forgets a run once it settled', async () => {
    const coll = fakeCollection([{ _id: 1 }])
    const service = serviceFor(coll)
    await service.find({ ...REF, skip: 0, requestId: REQUEST_ID })

    service.cancel(REQUEST_ID)

    expect(coll.find.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
  })

  it('ignores unknown ids', () => {
    const service = serviceFor(fakeCollection([]))
    expect(() => service.cancel(REQUEST_ID)).not.toThrow()
  })
})

type WriteCallOptions = ReadOptions &
  Document & { includeResultMetadata?: boolean; promoteLongs?: boolean }

type ModifyReply = { value: Document | null; lastErrorObject: Document }

type BulkIds = { insertedIds: Record<number, unknown>; upsertedIds: Record<number, unknown> }

/**
 * Takes writes like the driver and answers with fixed server results. A findOneAnd* reply is built
 * as BSON and decoded with the call's BSON options; a `failure` reply is decoded the same way into
 * a MongoServerError, as the driver's connection does.
 */
function fakeWriteCollection({
  modify = { value: null, lastErrorObject: { n: 0 } },
  upsertedId = null,
  bulkIds = { insertedIds: { 0: new ObjectId(OID), 3: 7 }, upsertedIds: { 1: Long.fromNumber(9) } },
  failure
}: {
  modify?: ModifyReply
  upsertedId?: unknown
  bulkIds?: BulkIds
  failure?: ServerReply & Document
} = {}) {
  const decode = (reply: Document, options: WriteCallOptions | undefined): Document =>
    BSON.deserialize(BSON.serialize(reply), {
      promoteValues: options?.promoteValues,
      promoteLongs: options?.promoteLongs,
      bsonRegExp: options?.bsonRegExp,
      raw: options?.raw
    })
  const findAndModify = (options: WriteCallOptions | undefined): Promise<unknown> => {
    if (failure) return Promise.reject(new MongoServerError(decode({ ok: 0, ...failure }, options)))
    const reply = decode({ ...modify, ok: 1 }, options)
    return Promise.resolve(options?.includeResultMetadata ? reply : (reply['value'] ?? null))
  }
  // The server reports upserted ids; the driver takes inserted ids from the documents it was given.
  const updated = async (options: WriteCallOptions | undefined) => {
    const reply = decode(
      upsertedId === null
        ? { n: 2, nModified: 1 }
        : { n: 1, nModified: 0, upserted: [{ index: 0, _id: upsertedId }] },
      options
    )
    const upserts = (reply['upserted'] as Document[] | undefined) ?? []
    return {
      acknowledged: true,
      matchedCount: upserts.length > 0 ? 0 : reply['n'],
      modifiedCount: reply['nModified'],
      upsertedCount: upserts.length,
      upsertedId: upserts[0]?.['_id'] ?? null
    }
  }
  const toArray = vi.fn(async () => [])

  return {
    insertOne: vi.fn(async (document: Document, _options?: WriteCallOptions) => ({
      acknowledged: true,
      insertedId: document['_id']
    })),
    insertMany: vi.fn(async (documents: Document[], _options?: WriteCallOptions) => ({
      acknowledged: true,
      insertedCount: documents.length,
      insertedIds: Object.fromEntries(documents.map((d, i) => [i, d['_id']]))
    })),
    updateOne: vi.fn((_filter: Document, _update: unknown, options?: WriteCallOptions) =>
      updated(options)
    ),
    updateMany: vi.fn((_filter: Document, _update: unknown, options?: WriteCallOptions) =>
      updated(options)
    ),
    replaceOne: vi.fn((_filter: Document, _replacement: Document, options?: WriteCallOptions) =>
      updated(options)
    ),
    deleteOne: vi.fn(async (_filter: Document, _options?: WriteCallOptions) => ({
      acknowledged: true,
      deletedCount: 1
    })),
    deleteMany: vi.fn(async (_filter: Document, _options?: WriteCallOptions) => ({
      acknowledged: true,
      deletedCount: 3
    })),
    findOneAndUpdate: vi.fn((_filter: Document, _update: unknown, options?: WriteCallOptions) =>
      findAndModify(options)
    ),
    findOneAndReplace: vi.fn(
      (_filter: Document, _replacement: Document, options?: WriteCallOptions) =>
        findAndModify(options)
    ),
    findOneAndDelete: vi.fn((_filter: Document, options?: WriteCallOptions) =>
      findAndModify(options)
    ),
    bulkWrite: vi.fn(async (_operations: Document[], options?: WriteCallOptions) => ({
      insertedCount: 2,
      matchedCount: 3,
      modifiedCount: 2,
      deletedCount: 4,
      upsertedCount: 1,
      insertedIds: bulkIds.insertedIds,
      upsertedIds: decode({ ids: bulkIds.upsertedIds }, options)['ids'] as Record<number, unknown>
    })),
    aggregate: vi.fn((_pipeline: Document[], _options?: WriteCallOptions) => ({ toArray })),
    toArray
  }
}

const canonical = (value: unknown): string => EJSON.stringify(value, { relaxed: false })

/** A value as the server receives it, in canonical EJSON object form. */
function sentAs(value: unknown): unknown {
  const { v } = BSON.deserialize(BSON.serialize({ v: value }), {
    promoteValues: false,
    bsonRegExp: true
  })
  return JSON.parse(canonical(v))
}

const writeOf = (op: WriteOp) => ({ ...REF, op })

const TYPED = {
  d: new Double(5),
  l: Long.fromString(BEYOND_2_53),
  i: new Int32(7),
  re: new BSONRegExp('a/b', 's')
}
const TYPED_SENT = {
  d: { $numberDouble: '5.0' },
  l: { $numberLong: BEYOND_2_53 },
  i: { $numberInt: '7' },
  re: { $regularExpression: { pattern: 'a/b', options: 's' } }
}

describe('QueryService.write — inserts', () => {
  it('sends the document with its exact BSON types and reports its id', async () => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({ method: 'insertOne', document: canonical({ _id: new ObjectId(OID), ...TYPED }) })
    )

    expect(sentAs(coll.insertOne.mock.calls[0]?.[0])).toEqual({
      _id: { $oid: OID },
      ...TYPED_SENT
    })
    expect(res).toMatchObject({
      counts: { inserted: 1 },
      ids: [`{"$oid":"${OID}"}`],
      idsTruncated: false
    })
    expect(res.tookMs).toBeGreaterThanOrEqual(0)
    expect(res).not.toHaveProperty('document')
  })

  it('passes the insert options to the driver', async () => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({
        method: 'insertOne',
        document: '{"_id":1}',
        options: '{"bypassDocumentValidation":true}'
      })
    )
    expect(coll.insertOne.mock.calls[0]?.[1]).toEqual({ bypassDocumentValidation: true })
  })

  it('reports insertMany ids in document order with their exact types', async () => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({
        method: 'insertMany',
        documents: [canonical({ _id: new Double(1) }), canonical({ _id: Long.fromNumber(2) })],
        options: '{"ordered":false}'
      })
    )

    expect(coll.insertMany.mock.calls[0]?.[1]).toEqual({ ordered: false })
    expect(res).toMatchObject({
      counts: { inserted: 2 },
      ids: ['{"$numberDouble":"1.0"}', '{"$numberLong":"2"}'],
      idsTruncated: false
    })
  })

  it('caps the reported insertMany ids at RESULT_CAP', async () => {
    const coll = fakeWriteCollection()
    const documents = Array.from({ length: RESULT_CAP + 1 }, (_, i) => `{"_id":${i}}`)
    const res = await serviceFor(coll).write(writeOf({ method: 'insertMany', documents }))

    expect(res.counts).toEqual({ inserted: RESULT_CAP + 1 })
    expect(res.ids).toHaveLength(RESULT_CAP)
    expect(res.ids[0]).toBe('{"$numberInt":"0"}')
    expect(res.idsTruncated).toBe(true)
  })

  it('does not flag exactly RESULT_CAP ids as truncated', async () => {
    const coll = fakeWriteCollection()
    const documents = Array.from({ length: RESULT_CAP }, (_, i) => `{"_id":${i}}`)
    const res = await serviceFor(coll).write(writeOf({ method: 'insertMany', documents }))
    expect(res.ids).toHaveLength(RESULT_CAP)
    expect(res.idsTruncated).toBe(false)
  })
})

describe('QueryService.write — updates and deletes', () => {
  it('sends the filter, the update and the options of updateOne with exact types', async () => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({
        method: 'updateOne',
        filter: `{"uid":{"$numberLong":"${BEYOND_2_53}"}}`,
        update: canonical({ $set: TYPED }),
        options: canonical({ upsert: true, arrayFilters: [{ 'e.k': new Int32(1) }], hint: 'uid_1' })
      })
    )

    const [filter, update, options] = coll.updateOne.mock.calls[0] ?? []
    expect(encodedAs(filter, 'uid')).toBe(`Long(${BEYOND_2_53})`)
    expect(sentAs(update)).toEqual({ $set: TYPED_SENT })
    expect(sentAs(options)).toMatchObject({
      upsert: true,
      arrayFilters: [{ 'e.k': { $numberInt: '1' } }],
      hint: 'uid_1'
    })
  })

  it.each(['updateOne', 'updateMany', 'replaceOne'] as const)(
    '%s reports an upserted Long id exactly, decoding the reply without promoting Longs',
    async (method) => {
      const coll = fakeWriteCollection({ upsertedId: Long.fromNumber(77) })
      const filter = '{"_id":{"$numberLong":"77"}}'
      const op: WriteOp =
        method === 'replaceOne'
          ? { method, filter, replacement: '{"a":true}', options: '{"upsert":true}' }
          : { method, filter, update: '{"$set":{"a":true}}', options: '{"upsert":true}' }
      const res = await serviceFor(coll).write(writeOf(op))

      expect(coll[method].mock.calls[0]?.[2]).toMatchObject({
        upsert: true,
        promoteLongs: false,
        bsonRegExp: true
      })
      expect(coll[method].mock.calls[0]?.[2]).not.toHaveProperty('promoteValues')
      expect(res).toMatchObject({ counts: { upserted: 1 }, ids: ['{"$numberLong":"77"}'] })
    }
  )

  // An upsert copies the filter's equality fields into the new document.
  it('sends the filter with its exact types', async () => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({
        method: 'updateOne',
        filter: canonical({ k: new Double(5), i: new Int32(1) }),
        update: '{"$set":{"a":true}}',
        options: '{"upsert":true}'
      })
    )
    expect(sentAs(coll.updateOne.mock.calls[0]?.[0])).toEqual({
      k: { $numberDouble: '5.0' },
      i: { $numberInt: '1' }
    })
  })

  it('reports matched, modified and upserted, without ids when nothing was upserted', async () => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({ method: 'updateMany', filter: '{}', update: '{"$inc":{"n":{"$numberInt":"1"}}}' })
    )
    expect(res).toMatchObject({
      counts: { matched: 2, modified: 1, upserted: 0 },
      ids: [],
      idsTruncated: false
    })
  })

  it('reports the upserted id', async () => {
    const coll = fakeWriteCollection({ upsertedId: new ObjectId(OID) })
    const res = await serviceFor(coll).write(
      writeOf({
        method: 'updateOne',
        filter: '{"a":"x"}',
        update: '{"$set":{"b":true}}',
        options: '{"upsert":true}'
      })
    )
    expect(res).toMatchObject({
      counts: { matched: 0, modified: 0, upserted: 1 },
      ids: [`{"$oid":"${OID}"}`]
    })
  })

  it('passes an update pipeline through as an array', async () => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({
        method: 'updateMany',
        filter: '{}',
        update: canonical([{ $set: { d: new Double(2) } }, { $unset: 'tmp' }])
      })
    )
    expect(sentAs(coll.updateMany.mock.calls[0]?.[1])).toEqual([
      { $set: { d: { $numberDouble: '2.0' } } },
      { $unset: 'tmp' }
    ])
  })

  it('sends a replacement with exact types and reports the update counters', async () => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({ method: 'replaceOne', filter: '{"_id":1}', replacement: canonical(TYPED) })
    )
    expect(sentAs(coll.replaceOne.mock.calls[0]?.[1])).toEqual(TYPED_SENT)
    expect(res.counts).toEqual({ matched: 2, modified: 1, upserted: 0 })
  })

  it.each([
    ['deleteOne', 1],
    ['deleteMany', 3]
  ] as const)('%s reports the deleted count', async (method, deleted) => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({ method, filter: '{"a":1}', options: '{"hint":"a_1"}' })
    )

    expect(sentAs(coll[method].mock.calls[0]?.slice(0, 2))).toEqual([
      { a: { $numberInt: '1' } },
      { hint: 'a_1' }
    ])
    expect(res).toMatchObject({ counts: { deleted }, ids: [], idsTruncated: false })
    expect(res).not.toHaveProperty('document')
  })
})

describe('QueryService.write — findOneAnd*', () => {
  const stored = {
    _id: new ObjectId(OID),
    l: Long.fromNumber(5),
    big: Long.fromString(BEYOND_2_53),
    re: new BSONRegExp('dot.all', 's'),
    half: new Double(2.5),
    d: new Double(5)
  }

  it('reads the document with normal decoding, so error replies stay plain objects', async () => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({ method: 'findOneAndUpdate', filter: '{}', update: '{"$set":{"seen":true}}' })
    )

    const options = coll.findOneAndUpdate.mock.calls[0]?.[2]
    expect(options).toMatchObject({ promoteLongs: false, bsonRegExp: true })
    expect(options).not.toHaveProperty('raw')
    expect(options).not.toHaveProperty('promoteValues')
  })

  it('keeps Longs and regexes exact; an integral Double reads back as an integer', async () => {
    const coll = fakeWriteCollection({
      modify: { value: stored, lastErrorObject: { n: 1, updatedExisting: true } }
    })
    const res = await serviceFor(coll).write(
      writeOf({ method: 'findOneAndUpdate', filter: '{}', update: '{"$set":{"seen":true}}' })
    )

    expect(res.document?.id).toBe(`{"$oid":"${OID}"}`)
    expect(JSON.parse(res.document?.canonical ?? '')).toEqual({
      _id: { $oid: OID },
      l: { $numberLong: '5' },
      big: { $numberLong: BEYOND_2_53 },
      re: { $regularExpression: { pattern: 'dot.all', options: 's' } },
      half: { $numberDouble: '2.5' },
      d: { $numberInt: '5' }
    })
    expect(res).toMatchObject({ counts: { matched: 1, upserted: 0 }, ids: [] })
  })

  it('returns null when nothing matched', async () => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({ method: 'findOneAndDelete', filter: '{"a":1}' })
    )
    expect(res).toMatchObject({ document: null, counts: { deleted: 0 }, ids: [] })
  })

  it('reports a findOneAndDelete that removed a document', async () => {
    const coll = fakeWriteCollection({ modify: { value: stored, lastErrorObject: { n: 1 } } })
    const res = await serviceFor(coll).write(
      writeOf({ method: 'findOneAndDelete', filter: '{}', options: '{"sort":{"d":-1}}' })
    )
    expect(res.counts).toEqual({ deleted: 1 })
    expect(JSON.parse(res.document?.canonical ?? '')).toMatchObject({
      big: { $numberLong: BEYOND_2_53 }
    })
  })

  it('reports an upsert that returned no document, with the exact upserted id', async () => {
    const coll = fakeWriteCollection({
      modify: {
        value: null,
        lastErrorObject: { n: 1, updatedExisting: false, upserted: Long.fromNumber(42) }
      }
    })
    const res = await serviceFor(coll).write(
      writeOf({
        method: 'findOneAndReplace',
        filter: '{"_id":{"$numberLong":"42"}}',
        replacement: canonical(TYPED),
        options: '{"upsert":true}'
      })
    )

    expect(sentAs(coll.findOneAndReplace.mock.calls[0]?.[1])).toEqual(TYPED_SENT)
    expect(res).toMatchObject({
      document: null,
      counts: { matched: 0, upserted: 1 },
      ids: ['{"$numberLong":"42"}']
    })
  })

  it.each([
    [true, 'after'],
    [false, 'before']
  ])('maps returnNewDocument %s to returnDocument %s', async (returnNewDocument, expected) => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({
        method: 'findOneAndUpdate',
        filter: '{}',
        update: '{"$set":{"a":true}}',
        options: JSON.stringify({ returnNewDocument, upsert: true })
      })
    )

    const options = coll.findOneAndUpdate.mock.calls[0]?.[2]
    expect(options).toMatchObject({ returnDocument: expected, upsert: true })
    expect(options).not.toHaveProperty('returnNewDocument')
  })

  it('passes returnDocument and projection through', async () => {
    const coll = fakeWriteCollection()
    await serviceFor(coll).write(
      writeOf({
        method: 'findOneAndReplace',
        filter: '{}',
        replacement: '{"a":true}',
        options: '{"returnDocument":"after","projection":{"a":{"$numberInt":"1"}}}'
      })
    )
    const options = coll.findOneAndReplace.mock.calls[0]?.[2]
    expect(options).toMatchObject({ returnDocument: 'after' })
    expect(sentAs(options?.['projection'])).toEqual({ a: { $numberInt: '1' } })
  })

  it('keeps the server error code a number, as driver retries require', async () => {
    const coll = fakeWriteCollection({ failure: { code: 189, errmsg: 'Primary stepped down' } })
    const error = await serviceFor(coll)
      .write(writeOf({ method: 'findOneAndDelete', filter: '{}' }))
      .then(
        () => null,
        (e: unknown) => e
      )

    expect(error).toBeInstanceOf(MongoServerError)
    expect(mapError(error)).toEqual({
      code: 'driver_error',
      message: 'Primary stepped down',
      details: { mongoCode: 189 }
    })
  })

  it("keeps a state-change error's topologyVersion an object, as SDAM's stale check requires", async () => {
    const coll = fakeWriteCollection({
      failure: {
        code: 10107,
        errmsg: 'not primary',
        topologyVersion: { processId: new ObjectId(OID), counter: Long.fromNumber(6) }
      }
    })
    const error = (await serviceFor(coll)
      .write(writeOf({ method: 'findOneAndUpdate', filter: '{}', update: '{"$set":{"a":true}}' }))
      .then(
        () => null,
        (e: unknown) => e
      )) as MongoServerError

    expect(error.code).toBe(10107)
    expect(error['topologyVersion']).toEqual({
      processId: new ObjectId(OID),
      counter: Long.fromNumber(6)
    })
  })
})

describe('QueryService.write — bulkWrite', () => {
  it('sends the operations with exact types and the options', async () => {
    const coll = fakeWriteCollection()
    const operations = [
      { insertOne: { document: TYPED } },
      {
        updateOne: {
          filter: { l: Long.fromString(BEYOND_2_53) },
          update: { $set: { d: new Double(1) } },
          upsert: true
        }
      },
      { deleteMany: { filter: { i: new Int32(7) } } }
    ]
    await serviceFor(coll).write(
      writeOf({
        method: 'bulkWrite',
        operations: canonical(operations),
        options: '{"ordered":false}'
      })
    )

    expect(sentAs(coll.bulkWrite.mock.calls[0]?.[0])).toEqual([
      { insertOne: { document: TYPED_SENT } },
      {
        updateOne: {
          filter: { l: { $numberLong: BEYOND_2_53 } },
          update: { $set: { d: { $numberDouble: '1.0' } } },
          upsert: true
        }
      },
      { deleteMany: { filter: { i: { $numberInt: '7' } } } }
    ])
    expect(coll.bulkWrite.mock.calls[0]?.[1]).toEqual({
      ordered: false,
      promoteLongs: false,
      bsonRegExp: true
    })
  })

  it('reports every counter, then the inserted ids followed by the upserted ids', async () => {
    const coll = fakeWriteCollection()
    const res = await serviceFor(coll).write(
      writeOf({ method: 'bulkWrite', operations: '[{"deleteMany":{"filter":{}}}]' })
    )
    expect(res).toMatchObject({
      counts: { inserted: 2, matched: 3, modified: 2, deleted: 4, upserted: 1 },
      ids: [`{"$oid":"${OID}"}`, '{"$numberInt":"7"}', '{"$numberLong":"9"}'],
      idsTruncated: false
    })
  })

  // An unordered bulkWrite indexes each map by position among operations of its own kind.
  it('keeps inserted and upserted ids whose map keys coincide', async () => {
    const coll = fakeWriteCollection({
      bulkIds: { insertedIds: { 0: 'y1', 1: 'y2' }, upsertedIds: { 0: 'x1', 1: 'x2' } }
    })
    const res = await serviceFor(coll).write(
      writeOf({
        method: 'bulkWrite',
        operations: '[{"deleteMany":{"filter":{}}}]',
        options: '{"ordered":false}'
      })
    )
    expect(res.ids).toEqual(['"y1"', '"y2"', '"x1"', '"x2"'])
  })

  it('caps the reported bulkWrite ids at RESULT_CAP', async () => {
    const inserted = Object.fromEntries(Array.from({ length: RESULT_CAP }, (_, i) => [i, i]))
    const coll = fakeWriteCollection({
      bulkIds: { insertedIds: inserted, upsertedIds: { 0: 'u' } }
    })
    const res = await serviceFor(coll).write(
      writeOf({ method: 'bulkWrite', operations: '[{"deleteMany":{"filter":{}}}]' })
    )
    expect(res.ids).toHaveLength(RESULT_CAP)
    expect(res.ids).not.toContain('"u"')
    expect(res.idsTruncated).toBe(true)
  })
})

describe('QueryService.write — aggregation', () => {
  it('runs the pipeline as given, without the read cap, and drains its cursor', async () => {
    const coll = fakeWriteCollection()
    const pipeline = [{ $set: { d: new Double(3) } }, { $merge: { into: 'copy' } }]
    const res = await serviceFor(coll).write(
      writeOf({ method: 'aggregate', pipeline: canonical(pipeline) })
    )

    expect(sentAs(coll.aggregate.mock.calls[0]?.[0])).toEqual([
      { $set: { d: { $numberDouble: '3.0' } } },
      { $merge: { into: 'copy' } }
    ])
    expect(coll.toArray).toHaveBeenCalledOnce()
    expect(res).toMatchObject({ counts: {}, ids: [], idsTruncated: false })
    expect(res).not.toHaveProperty('document')
  })
})

describe('QueryService.write — validation', () => {
  const methods = [
    'insertOne',
    'insertMany',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'findOneAndDelete',
    'bulkWrite',
    'aggregate'
  ] as const

  async function rejection(op: WriteOp): Promise<unknown> {
    const coll = fakeWriteCollection()
    const error = await serviceFor(coll)
      .write(writeOf(op))
      .then(
        () => null,
        (e: unknown) => e
      )
    for (const method of methods) expect(coll[method]).not.toHaveBeenCalled()
    return error
  }

  it.each<[string, WriteOp, string | null]>([
    [
      'a document that is not an object',
      { method: 'insertOne', document: '[{"a":1}]' },
      insertDocumentError([])
    ],
    [
      'one insertMany document that is not an object',
      { method: 'insertMany', documents: ['{"a":1}', '"x"'] },
      insertDocumentError('x')
    ],
    [
      'an update without operators',
      { method: 'updateOne', filter: '{}', update: '{"a":1}' },
      updateError({ a: 1 })
    ],
    [
      'an update pipeline with a read stage',
      { method: 'findOneAndUpdate', filter: '{}', update: '[{"$match":{}}]' },
      updateError([{ $match: {} }])
    ],
    [
      'a replacement with operators',
      { method: 'findOneAndReplace', filter: '{}', replacement: '{"$set":{"a":1}}' },
      replacementError({ $set: { a: 1 } })
    ],
    [
      'a filter that is not an object',
      { method: 'deleteOne', filter: '[{"a":1}]' },
      'deleteOne() filter must be an object'
    ],
    [
      'an unknown option',
      { method: 'deleteMany', filter: '{}', options: '{"upsert":true}' },
      writeOptionsError('deleteMany', { upsert: true })
    ],
    [
      'options that are not an object',
      { method: 'updateMany', filter: '{}', update: '{"$set":{}}', options: '[]' },
      writeOptionsError('updateMany', [])
    ],
    [
      'returnDocument together with returnNewDocument',
      {
        method: 'findOneAndUpdate',
        filter: '{}',
        update: '{"$set":{}}',
        options: '{"returnDocument":"after","returnNewDocument":true}'
      },
      writeOptionsError('findOneAndUpdate', { returnDocument: 'after', returnNewDocument: true })
    ],
    [
      'an invalid bulk operation',
      { method: 'bulkWrite', operations: '[{"insertOne":{}}]' },
      bulkWriteError([{ insertOne: {} }])
    ],
    [
      'a pipeline that does not end in a write stage',
      { method: 'aggregate', pipeline: '[{"$match":{}}]' },
      'A write pipeline must end with $out or $merge'
    ],
    [
      'a write stage before the last stage',
      { method: 'aggregate', pipeline: '[{"$out":"a"},{"$merge":{"into":"b"}}]' },
      'Stage 1: $out must be the last stage'
    ],
    [
      'a change stream before the write stage',
      { method: 'aggregate', pipeline: '[{"$changeStream":{}},{"$out":"a"}]' },
      `Stage 1: ${rejectedStageMessage('$changeStream')}`
    ],
    [
      'a pipeline that is not an array',
      { method: 'aggregate', pipeline: '{"$out":"a"}' },
      'Pipeline must be an array of stage objects'
    ]
  ])('rejects %s before it reaches the server', async (_case, op, message) => {
    expect(message).not.toBeNull()
    expect(await rejection(op)).toMatchObject({ name: 'ValidationError', message })
  })
})
