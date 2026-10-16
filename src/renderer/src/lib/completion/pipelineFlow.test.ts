import { describe, expect, it } from 'vitest'
import { createSchemaBuilder, dominantType } from '@shared/collectionSchema'
import type { CollectionSchema } from '@shared/types'
import { applyStages } from './pipelineFlow'
import { scan, toStages, type StageAst } from './scanner'

/** Stage ASTs of a pipeline written without its brackets. */
const stages = (source: string): StageAst[] => {
  const text = `[${source}, `
  const pipeline = scan(text, text.length, 'value').frames[0]
  if (pipeline?.f !== 'array') throw new Error(`not a pipeline: ${source}`)
  return toStages(pipeline.node.items)
}

const schemaOf = (...docs: unknown[]): CollectionSchema => {
  const builder = createSchemaBuilder()
  for (const doc of docs) builder.add(doc)
  return builder.build()
}

const users = schemaOf(
  {
    _id: { $oid: '507f1f77bcf86cd799439011' },
    name: 'Ada',
    age: { $numberInt: '36' },
    price: { $numberDouble: '9.5' },
    userId: { $oid: '507f1f77bcf86cd799439012' },
    address: { city: 'Berlin', zip: '10115' },
    tags: ['a', 'b'],
    items: [{ sku: 'x', qty: { $numberInt: '1' } }]
  },
  { _id: { $oid: '507f1f77bcf86cd799439013' }, name: 'Bob', tags: [] }
)

const orders = schemaOf({
  _id: { $oid: '507f1f77bcf86cd799439014' },
  total: { $numberDouble: '3.5' }
})

const lookupSchema = (coll: string): CollectionSchema | null => (coll === 'orders' ? orders : null)

const run = (pipeline: string, input: CollectionSchema | null = users) =>
  applyStages(input, stages(pipeline), lookupSchema)

const paths = (schema: CollectionSchema | null) => schema?.fields.map((f) => f.path)

const typeOf = (schema: CollectionSchema | null, path: string) =>
  dominantType(schema?.fields.find((f) => f.path === path)?.types)

describe('applyStages: $project', () => {
  it('keeps _id and the included fields with their subtrees', () => {
    expect(paths(run('{ $project: { name: 1, address: 1 } }'))).toEqual([
      '_id',
      'address',
      'address.city',
      'address.zip',
      'name'
    ])
  })

  it('drops _id when it is excluded in an inclusion', () => {
    expect(paths(run('{ $project: { _id: 0, name: 1 } }'))).toEqual(['name'])
  })

  it('keeps the parent of an included subfield', () => {
    expect(paths(run('{ $project: { "address.city": 1 } }'))).toEqual([
      '_id',
      'address',
      'address.city'
    ])
  })

  it('removes excluded fields', () => {
    expect(paths(run('{ $project: { address: 0, items: 0, tags: 0, price: 0 } }'))).toEqual([
      '_id',
      'age',
      'name',
      'userId'
    ])
  })

  it('treats _id: 0 alone as an exclusion of _id only', () => {
    const result = run('{ $project: { _id: 0 } }')
    expect(paths(result)).not.toContain('_id')
    expect(paths(result)).toContain('name')
  })

  it('types computed fields', () => {
    const result = run('{ $project: { label: { $toUpper: "$name" }, n: "$age" } }')
    expect(typeOf(result, 'label')).toBe('string')
    expect(typeOf(result, 'n')).toBe('int')
  })
})

describe('applyStages: $addFields / $set', () => {
  it('copies a referenced field with its type and subtree', () => {
    const result = run('{ $addFields: { home: "$address" } }')
    expect(typeOf(result, 'home')).toBe('object')
    expect(typeOf(result, 'home.city')).toBe('string')
    expect(paths(result)).toContain('address')
  })

  it('infers operator result types', () => {
    const result = run(
      '{ $set: { s: { $toString: "$age" }, d: { $dateFromString: { dateString: "$name" } } } }'
    )
    expect(typeOf(result, 's')).toBe('string')
    expect(typeOf(result, 'd')).toBe('date')
  })

  it('types literals', () => {
    const result = run(
      '{ $set: { flag: true, n: 5, x: 1.5, at: ISODate("2024-01-01"), id: ObjectId("507f1f77bcf86cd799439011") } }'
    )
    expect([
      typeOf(result, 'flag'),
      typeOf(result, 'n'),
      typeOf(result, 'x'),
      typeOf(result, 'at'),
      typeOf(result, 'id')
    ]).toEqual(['bool', 'int', 'double', 'date', 'objectId'])
  })

  it('adds fields to an embedded document instead of replacing it', () => {
    const result = run('{ $addFields: { address: { country: "DE" } } }')
    expect(paths(result)).toEqual(expect.arrayContaining(['address.city', 'address.country']))
  })
})

describe('applyStages: $unset', () => {
  it('removes a single field with its subtree', () => {
    expect(paths(run('{ $unset: "address" }'))).not.toContain('address.city')
  })

  it('removes a list of fields', () => {
    const result = paths(run('{ $unset: ["name", "age"] }'))
    expect(result).not.toContain('name')
    expect(result).not.toContain('age')
    expect(result).toContain('_id')
  })
})

describe('applyStages: $group', () => {
  it('keeps the type and values of a referenced _id', () => {
    const result = run('{ $group: { _id: "$userId", total: { $sum: "$price" }, n: { $sum: 1 } } }')
    expect(paths(result)).toEqual(['_id', 'n', 'total'])
    expect(typeOf(result, '_id')).toBe('objectId')
    expect(result?.fields.find((f) => f.path === '_id')?.values).toHaveLength(1)
    expect(['int', 'long', 'double', 'decimal']).toContain(typeOf(result, 'total'))
    expect(typeOf(result, 'n')).toBe('int')
  })

  it('makes $push an array of the argument type', () => {
    const result = run(
      '{ $group: { _id: null, names: { $push: "$name" }, cities: { $addToSet: "$address" } } }'
    )
    expect(typeOf(result, '_id')).toBe('null')
    expect(result?.fields.find((f) => f.path === 'names')).toMatchObject({
      types: { array: 2 },
      elementTypes: { string: 2 }
    })
    expect(typeOf(result, 'cities.city')).toBe('string')
  })

  it('types other accumulators', () => {
    const result = run(
      '{ $group: { _id: "$name", avg: { $avg: "$age" }, first: { $first: "$address" }, c: { $count: {} } } }'
    )
    expect(typeOf(result, 'avg')).toBe('double')
    expect(typeOf(result, 'first.zip')).toBe('string')
    expect(typeOf(result, 'c')).toBe('int')
  })
})

describe('applyStages: $unwind', () => {
  it('replaces an array with its element types', () => {
    const result = run('{ $unwind: "$tags" }')
    const tags = result?.fields.find((f) => f.path === 'tags')
    expect(tags?.types).toEqual({ string: 2 })
    expect(tags?.elementTypes).toBeUndefined()
  })

  it('keeps element subfields and adds includeArrayIndex', () => {
    const result = run('{ $unwind: { path: "$items", includeArrayIndex: "idx" } }')
    expect(typeOf(result, 'items')).toBe('object')
    expect(typeOf(result, 'items.sku')).toBe('string')
    expect(typeOf(result, 'idx')).toBe('long')
  })
})

describe('applyStages: $lookup / $graphLookup', () => {
  it('adds `as` as an array of foreign documents', () => {
    const result = run(
      '{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } }'
    )
    expect(result?.fields.find((f) => f.path === 'orders')).toMatchObject({
      types: { array: 2 },
      elementTypes: { object: 2 }
    })
    expect(typeOf(result, 'orders.total')).toBe('double')
  })

  it('applies a lookup pipeline to the foreign schema', () => {
    const result = run(
      '{ $lookup: { from: "orders", pipeline: [{ $project: { _id: 0, total: 1 } }], as: "o" } }'
    )
    expect(paths(result)?.filter((p) => p.startsWith('o.'))).toEqual(['o.total'])
  })

  it('adds the depth field of a graph lookup', () => {
    const result = run('{ $graphLookup: { from: "orders", as: "chain", depthField: "depth" } }')
    expect(typeOf(result, 'chain.depth')).toBe('long')
    expect(typeOf(result, 'chain.total')).toBe('double')
  })
})

describe('applyStages: re-rooting and reshaping stages', () => {
  it('re-roots at an embedded document', () => {
    expect(paths(run('{ $replaceRoot: { newRoot: "$address" } }'))).toEqual(['city', 'zip'])
    expect(paths(run('{ $replaceWith: "$address" }'))).toEqual(['city', 'zip'])
  })

  it('re-roots at an object literal and at merged objects', () => {
    expect(paths(run('{ $replaceWith: { n: "$name" } }'))).toEqual(['n'])
    expect(paths(run('{ $replaceWith: { $mergeObjects: ["$address", { extra: 1 }] } }'))).toEqual([
      'city',
      'extra',
      'zip'
    ])
  })

  it('leaves only the count field after $count', () => {
    const result = run('{ $match: {} }, { $count: "total" }')
    expect(paths(result)).toEqual(['total'])
    expect(typeOf(result, 'total')).toBe('int')
  })

  it('groups and counts with $sortByCount', () => {
    const result = run('{ $sortByCount: "$name" }')
    expect(paths(result)).toEqual(['_id', 'count'])
    expect(typeOf(result, '_id')).toBe('string')
  })

  it('outputs count by default in $bucket', () => {
    const result = run('{ $bucket: { groupBy: "$age", boundaries: [0, 18, 65] } }')
    expect(paths(result)).toEqual(['_id', 'count'])
    expect(typeOf(result, '_id')).toBe('int')
  })

  it('uses the output accumulators of $bucketAuto', () => {
    const result = run(
      '{ $bucketAuto: { groupBy: "$price", buckets: 4, output: { names: { $push: "$name" } } } }'
    )
    expect(paths(result)).toEqual(['_id', '_id.max', '_id.min', 'names'])
    expect(typeOf(result, '_id.min')).toBe('double')
  })

  it('runs every $facet branch on the same input', () => {
    const result = run(
      '{ $facet: { byName: [{ $group: { _id: "$name" } }], total: [{ $count: "n" }] } }'
    )
    expect(paths(result)).toEqual(['byName', 'byName._id', 'total', 'total.n'])
    expect(typeOf(result, 'byName')).toBe('array')
  })

  it('adds window outputs', () => {
    const result = run(
      '{ $setWindowFields: { sortBy: { age: 1 }, output: { rank: { $rank: {} }, running: { $sum: "$price", window: { documents: ["unbounded", "current"] } } } } }'
    )
    expect(typeOf(result, 'rank')).toBe('int')
    expect(typeOf(result, 'running')).toBe('double')
    expect(paths(result)).toContain('name')
  })

  it('merges the fields of a $unionWith collection', () => {
    expect(paths(run('{ $unionWith: "orders" }'))).toContain('total')
  })
})

describe('applyStages: pass-through and unknown input', () => {
  it('passes the input through filtering and unknown stages', () => {
    expect(
      paths(
        run('{ $match: { a: 1 } }, { $sort: { a: 1 } }, { $limit: 5 }, { $someFutureStage: {} }')
      )
    ).toEqual(paths(users))
  })

  it('returns null for stages whose output is not collection documents', () => {
    expect(run('{ $collStats: {} }')).toBeNull()
  })

  it('stays unknown through pass-through stages and derives computed fields', () => {
    expect(run('{ $match: {} }', null)).toBeNull()
    expect(paths(run('{ $group: { _id: "$x", n: { $sum: 1 } } }', null))).toEqual(['_id', 'n'])
  })
})
