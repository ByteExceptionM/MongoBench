import { describe, expect, it } from 'vitest'
import { Binary, Code, DBRef, EJSON, ObjectId, UUID } from 'bson'
import {
  MAX_ARRAY_ELEMENTS,
  MAX_SCHEMA_FIELDS,
  addCounts,
  addressableFields,
  childFields,
  classifyCanonical,
  compareText,
  createSchemaBuilder,
  dominantType,
  resolveField,
  resolveSchemaField,
  schemaFieldPaths
} from './collectionSchema'
import type { CollectionSchema } from './types'

const canonical = (doc: Record<string, unknown>): unknown =>
  EJSON.serialize(doc, { relaxed: false })

const schemaOf = (...docs: unknown[]): CollectionSchema => {
  const builder = createSchemaBuilder()
  for (const doc of docs) builder.add(doc)
  return builder.build()
}

const field = (schema: CollectionSchema, path: string) => schema.fields.find((f) => f.path === path)

describe('classifyCanonical', () => {
  it.each([
    [{ $oid: '507f1f77bcf86cd799439011' }, 'objectId'],
    [{ $date: { $numberLong: '1704067200000' } }, 'date'],
    [{ $numberInt: '5' }, 'int'],
    [{ $numberLong: '5' }, 'long'],
    [{ $numberDouble: '5.5' }, 'double'],
    [{ $numberDecimal: '1.5' }, 'decimal'],
    [{ $binary: { base64: 'AAAA', subType: '00' } }, 'binData'],
    [{ $binary: { base64: 'AAAA', subType: '03' } }, 'uuidLegacy'],
    [{ $binary: { base64: 'AAAA', subType: '04' } }, 'uuid'],
    [{ $regularExpression: { pattern: 'a', options: 'i' } }, 'regex'],
    [{ $timestamp: { t: 1, i: 2 } }, 'timestamp'],
    [{ $minKey: 1 }, 'minKey'],
    [{ $maxKey: 1 }, 'maxKey'],
    [{ $symbol: 's' }, 'symbol'],
    [{ $code: 'f()' }, 'javascript'],
    [{ $code: 'f()', $scope: { a: { $numberInt: '1' } } }, 'javascript'],
    [{ $dbPointer: { $ref: 'c', $id: { $oid: '507f1f77bcf86cd799439011' } } }, 'dbPointer'],
    [{ $undefined: true }, 'undefined'],
    [{ $ref: 'users', $id: { $oid: '507f1f77bcf86cd799439011' } }, 'dbRef'],
    [{ $ref: 'users', $id: { $numberInt: '1' }, $db: 'app' }, 'dbRef'],
    ['text', 'string'],
    [true, 'bool'],
    [null, 'null'],
    [[1, 2], 'array'],
    [{ a: 1 }, 'object'],
    [{ $oid: 'x', other: 1 }, 'object'],
    [5, 'double']
  ])('classifies %j as %s', (value, type) => {
    expect(classifyCanonical(value)).toBe(type)
  })

  it('classifies values produced by the bson serializer', () => {
    const doc = canonical({
      date: new Date('2024-01-01T00:00:00Z'),
      uuid: new UUID('550e8400-e29b-41d4-a716-446655440000'),
      legacy: new Binary(Buffer.alloc(16), 3),
      code: new Code('f()', { a: 1 }),
      ref: new DBRef('users', new ObjectId())
    }) as Record<string, unknown>
    expect(classifyCanonical(doc['date'])).toBe('date')
    expect(classifyCanonical(doc['uuid'])).toBe('uuid')
    expect(classifyCanonical(doc['legacy'])).toBe('uuidLegacy')
    expect(classifyCanonical(doc['code'])).toBe('javascript')
    expect(classifyCanonical(doc['ref'])).toBe('dbRef')
  })
})

describe('createSchemaBuilder', () => {
  it('records nested paths sorted by path', () => {
    const schema = schemaOf({ b: { $numberInt: '1' }, a: { city: 'Berlin', zip: 'x' } })
    expect(schema.sampleSize).toBe(1)
    expect(schema.fields.map((f) => f.path)).toEqual(['a', 'a.city', 'a.zip', 'b'])
    expect(field(schema, 'a')?.types).toEqual({ object: 1 })
    expect(field(schema, 'b')?.types).toEqual({ int: 1 })
  })

  it('lets array elements share the array path and counts them in elementTypes', () => {
    const schema = schemaOf({
      items: [{ sku: 'a' }, { sku: 'b' }, { sku: 'c', qty: { $numberInt: '2' } }]
    })
    expect(field(schema, 'items')?.types).toEqual({ array: 1 })
    expect(field(schema, 'items')?.elementTypes).toEqual({ object: 3 })
    expect(field(schema, 'items.sku')?.types).toEqual({ string: 3 })
    expect(field(schema, 'items.qty')?.types).toEqual({ int: 1 })
  })

  it('counts a path once per document, not per occurrence', () => {
    const schema = schemaOf({ items: [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }] }, { other: 1 })
    expect(field(schema, 'items.sku')?.docCount).toBe(1)
  })

  it('recurses into nested arrays with the same path', () => {
    const schema = schemaOf({ grid: [[{ $numberInt: '1' }, { $numberInt: '2' }], ['x']] })
    expect(field(schema, 'grid')?.elementTypes).toEqual({ array: 2, int: 2, string: 1 })
  })

  it('orders tracked values by count, then by text', () => {
    const schema = schemaOf({ s: 'b' }, { s: 'a' }, { s: 'b' }, { s: 'c' })
    expect(field(schema, 's')?.values).toEqual([
      { ejson: '"b"', count: 2 },
      { ejson: '"a"', count: 1 },
      { ejson: '"c"', count: 1 }
    ])
    expect(field(schema, 's')?.valuesTruncated).toBeUndefined()
  })

  it('stops tracking at 20 distinct values and flags truncation at the 21st', () => {
    const docs = Array.from({ length: 21 }, (_, i) => ({ n: { $numberInt: String(i) } }))
    const schema = schemaOf(...docs)
    expect(field(schema, 'n')?.values).toHaveLength(20)
    expect(field(schema, 'n')?.valuesTruncated).toBe(true)
  })

  it('does not track long strings, nulls, objects or arrays', () => {
    const schema = schemaOf({ long: 'x'.repeat(101), n: null, o: { a: 'v' }, arr: [] })
    expect(field(schema, 'long')?.values).toBeUndefined()
    expect(field(schema, 'n')?.values).toBeUndefined()
    expect(field(schema, 'o')?.values).toBeUndefined()
    expect(field(schema, 'arr')?.values).toBeUndefined()
    expect(field(schema, 'o.a')?.values).toEqual([{ ejson: '"v"', count: 1 }])
  })

  it('tracks scalar array elements as values', () => {
    const schema = schemaOf({ tags: ['a', 'b', 'a'] })
    expect(field(schema, 'tags')?.values).toEqual([
      { ejson: '"a"', count: 2 },
      { ejson: '"b"', count: 1 }
    ])
  })

  it('collapses an object with more than 64 distinct keys into a map', () => {
    const scores = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`key${i}x`, { $numberInt: '1' }])
    )
    const schema = schemaOf({ scores })
    expect(field(schema, 'scores')?.mapLike).toBe(true)
    expect(schemaFieldPaths(schema)).toEqual(['scores'])
    expect(field(schema, 'scores.*')?.types).toEqual({ int: 70 })
  })

  it('collapses an object keyed by ids', () => {
    const byUser = Object.fromEntries(
      Array.from({ length: 10 }, () => [new UUID().toHexString(true), { seen: true }])
    )
    const schema = schemaOf({ byUser })
    expect(field(schema, 'byUser')?.mapLike).toBe(true)
    expect(field(schema, 'byUser.*.seen')?.types).toEqual({ bool: 10 })
  })

  it('keeps a small fixed key set as fields', () => {
    const schema = schemaOf({ address: { street: 'a', city: 'b', zip: 'c', country: 'd', n: 'e' } })
    expect(field(schema, 'address')?.mapLike).toBeUndefined()
    expect(childFields(schema, 'address')).toHaveLength(5)
  })

  it('re-keys and merges descendants that existed before the collapse', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({
      byId: { [String(1000 + i)]: { total: { $numberInt: String(i % 2) } } }
    }))
    const schema = schemaOf(...docs)
    expect(field(schema, 'byId')?.mapLike).toBe(true)
    expect(schema.fields.map((f) => f.path)).toEqual(['byId', 'byId.*', 'byId.*.total'])
    expect(field(schema, 'byId.*.total')?.types).toEqual({ int: 8 })
    expect(field(schema, 'byId.*.total')?.docCount).toBe(8)
    expect(field(schema, 'byId.*.total')?.values).toEqual([
      { ejson: '{"$numberInt":"0"}', count: 4 },
      { ejson: '{"$numberInt":"1"}', count: 4 }
    ])
  })

  it('counts each document once for a map that collapses mid-document', () => {
    const keys = Array.from({ length: 9 }, () => new UUID().toHexString(true))
    const statsOf = (from: number, to: number) =>
      Object.fromEntries(keys.slice(from, to).map((key) => [key, { kills: { $numberInt: '1' } }]))
    const schema = schemaOf(
      { stats: statsOf(0, 3) },
      { stats: statsOf(3, 7) },
      { stats: statsOf(7, 9) }
    )
    expect(field(schema, 'stats.*')?.docCount).toBe(3)
    expect(field(schema, 'stats.*.kills')?.docCount).toBe(3)
  })

  it('keeps the count when a merged key already appeared in the collapsing document', () => {
    const keys = Array.from({ length: 8 }, () => new UUID().toHexString(true))
    const statsOf = (picked: readonly string[]) =>
      Object.fromEntries(picked.map((key) => [key, { $numberInt: '1' }]))
    const schema = schemaOf(
      { stats: statsOf(keys.slice(0, 4)) },
      { stats: statsOf(keys.slice(4, 7)) },
      { stats: statsOf([keys[0]!, keys[7]!]) }
    )
    expect(field(schema, 'stats.*')?.docCount).toBe(3)
  })

  it('stops descending below depth 8', () => {
    let doc: Record<string, unknown> = { leaf: 'x' }
    for (let i = 10; i >= 1; i--) doc = { [`l${i}`]: doc }
    const schema = schemaOf(doc)
    const deepest = Math.max(...schema.fields.map((f) => f.path.split('.').length))
    expect(deepest).toBe(8)
    expect(schema.truncated).toBe(false)
  })

  it('flags truncation when the field cap is hit', () => {
    const doc = Object.fromEntries(
      Array.from({ length: MAX_SCHEMA_FIELDS + 5 }, (_, i) => [`f${i}`, 'v'])
    )
    const schema = schemaOf(doc)
    expect(schema.fields).toHaveLength(MAX_SCHEMA_FIELDS)
    expect(schema.truncated).toBe(true)
  })

  it('samples only the first array elements', () => {
    const schema = schemaOf({ n: Array.from({ length: 80 }, () => ({ $numberInt: '1' })) })
    expect(field(schema, 'n')?.elementTypes).toEqual({ int: MAX_ARRAY_ELEMENTS })
  })

  it('skips $-prefixed keys of plain objects', () => {
    const schema = schemaOf({ meta: { $comment: 'x', ok: true } })
    expect(schemaFieldPaths(schema)).toEqual(['meta', 'meta.ok'])
  })

  it('continues a seeded schema: counts add and values merge', () => {
    const seed = schemaOf({ s: 'a' }, { s: 'b' })
    const builder = createSchemaBuilder(seed)
    builder.add({ s: 'a', t: true })
    const schema = builder.build()
    expect(schema.sampleSize).toBe(3)
    expect(field(schema, 's')?.docCount).toBe(3)
    expect(field(schema, 's')?.types).toEqual({ string: 3 })
    expect(field(schema, 's')?.values).toEqual([
      { ejson: '"a"', count: 2 },
      { ejson: '"b"', count: 1 }
    ])
    expect(field(schema, 't')?.docCount).toBe(1)
  })

  it('routes new keys of a seeded map-like object to *', () => {
    const scores = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`k${i}z`, { $numberInt: '1' }])
    )
    const builder = createSchemaBuilder(schemaOf({ scores }))
    builder.add({ scores: { fresh: { $numberInt: '2' } } })
    const schema = builder.build()
    expect(field(schema, 'scores.fresh')).toBeUndefined()
    expect(field(schema, 'scores.*')?.types).toEqual({ int: 71 })
  })

  it('keeps value truncation of a seed', () => {
    const docs = Array.from({ length: 21 }, (_, i) => ({ n: { $numberInt: String(i) } }))
    const builder = createSchemaBuilder(schemaOf(...docs))
    builder.add({ n: { $numberInt: '0' } })
    expect(field(builder.build(), 'n')?.valuesTruncated).toBe(true)
  })

  it('ignores non-object documents', () => {
    const schema = schemaOf('x', null, [1])
    expect(schema).toEqual({ sampleSize: 0, fields: [], truncated: false })
  })
})

describe('schema lookups', () => {
  const scores = Object.fromEntries(
    Array.from({ length: 70 }, (_, i) => [`k${i}z`, { value: { $numberInt: '1' } }])
  )
  const schema = schemaOf({
    _id: { $oid: '507f1f77bcf86cd799439011' },
    address: { city: 'x', geo: { lat: { $numberDouble: '1.5' } } },
    items: [{ name: 'a' }],
    scores
  })

  it('resolves paths through map-like objects and array indexes', () => {
    expect(resolveSchemaField(schema, 'scores.anyKey.value')?.path).toBe('scores.*.value')
    expect(resolveSchemaField(schema, 'items.0.name')?.path).toBe('items.name')
    expect(resolveSchemaField(schema, 'address.geo.lat')?.types).toEqual({ double: 1 })
    expect(resolveSchemaField(schema, 'missing')).toBeUndefined()
  })

  it('resolves the same paths in a map of the fields', () => {
    const fields = new Map(schema.fields.map((f) => [f.path, f]))
    for (const path of ['scores.anyKey.value', 'items.0.name', 'address.geo.lat', 'missing']) {
      expect(resolveField(fields, path)).toBe(resolveSchemaField(schema, path))
    }
  })

  it('lists direct children without * entries', () => {
    expect(childFields(schema, '').map((f) => f.path)).toEqual([
      '_id',
      'address',
      'items',
      'scores'
    ])
    expect(childFields(schema, 'address').map((f) => f.path)).toEqual([
      'address.city',
      'address.geo'
    ])
    expect(childFields(schema, 'scores')).toEqual([])
    expect(childFields(schema, 'scores.k1z').map((f) => f.path)).toEqual(['scores.*.value'])
  })

  it('lists addressable fields only', () => {
    expect(addressableFields(schema).map((f) => f.path)).toEqual(schemaFieldPaths(schema))
    expect(addressableFields(schema).find((f) => f.path === 'address.city')?.types).toEqual({
      string: 1
    })
  })

  it('lists addressable paths only', () => {
    expect(schemaFieldPaths(schema)).toEqual([
      '_id',
      'address',
      'address.city',
      'address.geo',
      'address.geo.lat',
      'items',
      'items.name',
      'scores'
    ])
  })
})

describe('addCounts', () => {
  it('sums the counts per type into a new object', () => {
    const a = { string: 2, int: 1 }
    const b = { int: 3, null: 1 }
    expect(addCounts(a, b)).toEqual({ string: 2, int: 4, null: 1 })
    expect(a).toEqual({ string: 2, int: 1 })
    expect(b).toEqual({ int: 3, null: 1 })
  })
})

describe('compareText', () => {
  it('orders like the default sort', () => {
    const words = ['b', 'B', 'a', 'é', 'a.b', 'a_b', '']
    expect([...words].sort(compareText)).toEqual([...words].sort())
  })
})

describe('dominantType', () => {
  it('picks the most frequent type', () => {
    expect(dominantType({ string: 3, int: 5 })).toBe('int')
  })

  it('ignores null and undefined unless nothing else occurs', () => {
    expect(dominantType({ null: 10, string: 1 })).toBe('string')
    expect(dominantType({ null: 2 })).toBe('null')
    expect(dominantType({ undefined: 1 })).toBe('undefined')
  })

  it('returns null without counts', () => {
    expect(dominantType(undefined)).toBeNull()
    expect(dominantType({})).toBeNull()
  })
})
