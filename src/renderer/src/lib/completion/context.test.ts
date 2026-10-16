import { describe, expect, it } from 'vitest'
import { analyzeContext, type EditorKind } from './context'

/** Analyzes `marked` at its `|` marker in an editor bound to `users`. */
const at = (marked: string, kind: EditorKind) => {
  const offset = marked.indexOf('|')
  return analyzeContext(marked.slice(0, offset) + marked.slice(offset + 1), offset, kind, 'users')
}

describe('analyzeContext: positions', () => {
  it.each<[string, EditorKind, Record<string, unknown>]>([
    ['{ "_id": |', 'filter', { at: 'queryValue', field: '_id', operator: null, inArray: false }],
    ['{ age: { $g|', 'filter', { at: 'operatorKey', field: 'age', present: [] }],
    ['{ $or: [ { na|', 'filter', { at: 'queryKey', base: '', topLevel: true }],
    ['{ items: { $elemMatch: { s|', 'filter', { at: 'elemMatchKey', field: 'items' }],
    ['{ items: { $elemMatch: { qty: |', 'filter', { at: 'queryValue', field: 'items.qty' }],
    [
      '{ a: { $in: [ObjectId("x"), |',
      'filter',
      { at: 'queryValue', field: 'a', operator: '$in', inArray: true, siblings: ['ObjectId("x")'] }
    ],
    ['{ a: { $in: |', 'filter', { at: 'queryValue', field: 'a', operator: '$in', inArray: false }],
    ['{ a: { $type: |', 'filter', { at: 'typeAlias', field: 'a' }],
    ['{ a: { $type: ["string", |', 'filter', { at: 'typeAlias', field: 'a' }],
    [
      '{ a: { $exists: |',
      'filter',
      { at: 'literal', values: ['true', 'false'], preferred: 'true' }
    ],
    ['{ a: { $not: { |', 'filter', { at: 'operatorKey', field: 'a' }],
    ['{ a: { $geoWithin: { |', 'filter', { at: 'geoKey' }],
    ['{ $text: { |', 'filter', { at: 'textKey' }],
    ['{ $jsonSchema: { properties: { |', 'filter', { at: 'queryKey', topLevel: false }],
    ['{ $jsonSchema: { |', 'filter', { at: 'jsonSchemaKey' }],
    ['{ $expr: { $eq: ["$|', 'filter', { at: 'expressionValue' }],
    ['{ $expr: { |', 'filter', { at: 'expressionKey' }],
    ['{ a: ObjectId("|', 'filter', { at: 'ctorArg', field: 'a', ctor: 'ObjectId' }],
    [
      '{ tags: ["a", |',
      'filter',
      { at: 'queryValue', field: 'tags', inArray: true, siblings: ['"a"'] }
    ],
    ['[ |', 'pipeline', { at: 'stageElement', stageIndex: 0 }],
    ['|', 'pipeline', { at: 'rootValue', expect: 'array' }],
    ['|', 'filter', { at: 'rootValue', expect: 'object' }],
    ['[{ $match: {} }, { |', 'pipeline', { at: 'stageKey', stageIndex: 1, present: [] }],
    ['[{ $group: { _id: "$|', 'pipeline', { at: 'expressionValue' }],
    ['[{ $group: { _id: null, total: { |', 'pipeline', { at: 'accumulatorKey', window: false }],
    ['[{ $group: { |', 'pipeline', { at: 'newFieldKey', group: true }],
    ['[{ $lookup: { from: "|', 'pipeline', { at: 'collectionName' }],
    ['[{ $lookup: { |', 'pipeline', { at: 'stageArgKey', stage: '$lookup' }],
    ['[{ $unwind: |', 'pipeline', { at: 'expressionValue', prefer: 'array' }],
    [
      '[{ $unwind: { preserveNullAndEmptyArrays: |',
      'pipeline',
      { at: 'literal', values: ['true', 'false'] }
    ],
    ['[{ $project: { a: 1, |', 'pipeline', { at: 'projectionKey', present: ['a'] }],
    ['[{ $sort: { a: |', 'pipeline', { at: 'sortValue', field: 'a' }],
    [
      '[{ $addFields: { x: { $dateToString: { |',
      'pipeline',
      { at: 'operatorArgKey', operator: '$dateToString' }
    ],
    ['[{ $addFields: { x: { $dateAdd: { unit: |', 'pipeline', { at: 'literal' }],
    ['[{ $setWindowFields: { output: { r: { |', 'pipeline', { at: 'accumulatorKey', window: true }],
    ['[{ $densify: { range: { |', 'pipeline', { at: 'stageArgKey', stage: '$densify.range' }],
    ['{ name: 1, |', 'projection', { at: 'projectionKey', present: ['name'] }],
    ['{ name: 1, a: |', 'projection', { at: 'projectionValue', field: 'a', mode: 'include' }],
    ['{ name: 0, a: |', 'projection', { at: 'projectionValue', mode: 'exclude' }],
    ['{ _id: 0, a: |', 'projection', { at: 'projectionValue', mode: null }],
    ['{ name: |', 'projection', { at: 'projectionValue', field: 'name' }],
    ['{ items: { |', 'projection', { at: 'projectionOperatorKey', field: 'items' }],
    ['{ createdAt: |', 'sort', { at: 'sortValue', field: 'createdAt' }],
    ['{ |', 'sort', { at: 'sortKey' }],
    ['db.|', 'shell', { at: 'shellCollection' }],
    ['db.users.|', 'shell', { at: 'shellMethod', coll: 'users' }],
    ['db.users.fi|', 'shell', { at: 'shellMethod', coll: 'users' }],
    ['db.a.b.|', 'shell', { at: 'shellMethod', coll: 'a.b' }],
    [
      'db.users.find({}).limit(5).|',
      'shell',
      { at: 'shellCursorMethod', head: 'find', used: ['limit'] }
    ],
    ['db.users.aggregate([]).|', 'shell', { at: 'shellCursorMethod', head: 'aggregate', used: [] }],
    ['d|', 'shell', { at: 'shellRoot' }],
    ['db.getCollection("|', 'shell', { at: 'collectionName' }],
    ['db["|', 'shell', { at: 'collectionName' }],
    ['db.users.find({}).sort({ |', 'shell', { at: 'sortKey' }],
    ['db.users.find({}, { |', 'shell', { at: 'projectionKey' }],
    ['db.users.distinct("|', 'shell', { at: 'fieldName' }],
    ['db.users.estimatedDocumentCount(|', 'shell', { at: 'none' }],
    ['db.users.aggregate([{ $match: { |', 'shell', { at: 'queryKey' }],
    ['{ address: { ci|', 'document', { at: 'documentKey', path: 'address' }],
    ['{ items: [ { s|', 'document', { at: 'documentKey', path: 'items' }],
    ['[{ a: 1 }, { |', 'document', { at: 'documentKey', path: '', present: [] }],
    ['{ a: 1 }, { b: 2, |', 'document', { at: 'documentKey', path: '', present: ['b'] }],
    ['{ tags: [ |', 'document', { at: 'documentValue', path: 'tags', element: true }],
    ['{ tags: |', 'document', { at: 'documentValue', path: 'tags', element: false }],
    ['{ _id: ObjectId("|', 'document', { at: 'ctorArg', field: '_id', ctor: 'ObjectId' }]
  ])('%s (%s)', (marked, kind, expected) => {
    expect(at(marked, kind).position).toMatchObject(expected)
  })
})

describe('analyzeContext: key and value slots', () => {
  it('offers keys after a comma, not values', () => {
    expect(at('{ a: 1, |', 'filter').position).toMatchObject({ at: 'queryKey', present: ['a'] })
  })

  it('treats a comma inside an array as an array element', () => {
    expect(at('{ a: [1, |', 'filter').position).toMatchObject({ at: 'queryValue', inArray: true })
  })

  it('stays inside a string value', () => {
    const ctx = at('{ a: "x, |', 'filter')
    expect(ctx.position).toMatchObject({ at: 'queryValue', field: 'a' })
    expect(ctx.token.quote).toBe('"')
  })

  it('offers values after a colon', () => {
    expect(at('{ a: |', 'filter').position).toMatchObject({ at: 'queryValue', field: 'a' })
  })

  it('is dead inside comments and right after values', () => {
    expect(at('{ a: 1 // x|', 'filter').position).toEqual({ at: 'none' })
    expect(at('{ a: 12|', 'filter').position).toEqual({ at: 'none' })
  })

  it('reports nothing after a complete key', () => {
    expect(at('{ name |', 'filter').position).toEqual({ at: 'none' })
  })
})

describe('analyzeContext: pipeline flow', () => {
  it('passes the stages before the cursor to the field source', () => {
    const position = at(
      '[{ $match: {} }, { $unwind: "$items" }, { $match: { |',
      'pipeline'
    ).position
    expect(position.at).toBe('queryKey')
    if (position.at !== 'queryKey') return
    expect(position.source.coll).toBe('users')
    expect(position.source.stages.map((s) => s.name)).toEqual(['$match', '$unwind'])
  })

  it('reads foreign fields from the $lookup target', () => {
    const ctx = at('[{ $lookup: { from: "orders", foreignField: "|', 'pipeline')
    expect(ctx.position).toMatchObject({ at: 'fieldName', source: { coll: 'orders', stages: [] } })
    expect(ctx.collections).toEqual(['users', 'orders'])
  })

  it('reads local fields from the pipeline input', () => {
    const ctx = at('[{ $unwind: "$a" }, { $lookup: { from: "orders", localField: "|', 'pipeline')
    expect(ctx.position).toMatchObject({ at: 'fieldName', source: { coll: 'users' } })
  })

  it('runs a $lookup pipeline over the target with the let variables', () => {
    const position = at(
      '[{ $lookup: { from: "orders", let: { uid: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$|',
      'pipeline'
    ).position
    expect(position).toMatchObject({
      at: 'expressionValue',
      source: { coll: 'orders' },
      vars: [{ name: 'uid', field: { source: { coll: 'users' }, path: '_id' } }]
    })
  })

  it('reads let and from written after the $lookup pipeline', () => {
    const ctx = at(
      '[{ $lookup: { pipeline: [{ $match: { $expr: { $eq: ["$a", "$$|"] } } }], from: "orders", let: { uid: "$_id" } } }]',
      'pipeline'
    )
    expect(ctx.position).toMatchObject({
      at: 'expressionValue',
      source: { coll: 'orders' },
      vars: [{ name: 'uid' }]
    })
    expect(ctx.collections).toEqual(['users', 'orders'])
  })

  it('includes the facet prefix and the branch stages', () => {
    const position = at(
      '[{ $unwind: "$x" }, { $facet: { a: [ { $limit: 1 }, { $match: { |',
      'pipeline'
    ).position
    expect(position.at).toBe('queryKey')
    if (position.at !== 'queryKey') return
    expect(position.source.stages.map((s) => s.name)).toEqual(['$unwind', '$limit'])
  })

  it('binds $map and $let variables', () => {
    expect(
      at('{ $expr: { $map: { input: "$a", as: "item", in: "$|', 'filter').position
    ).toMatchObject({
      at: 'expressionValue',
      vars: [{ name: 'item' }]
    })
    expect(at('{ $expr: { $let: { vars: { t: 1 }, in: "$|', 'filter').position).toMatchObject({
      at: 'expressionValue',
      vars: [{ name: 't' }]
    })
  })

  it('binds variables to the field they iterate or name', () => {
    const map = at('{ $expr: { $map: { input: "$items", as: "it", in: "$$it.|', 'filter')
    expect(map.position).toMatchObject({
      vars: [{ name: 'it', field: { source: { coll: 'users' }, path: 'items' } }]
    })
    const filter = at('{ $expr: { $filter: { input: "$items", cond: "$$|', 'filter')
    expect(filter.position).toMatchObject({ vars: [{ name: 'this', field: { path: 'items' } }] })
    const reduce = at('{ $expr: { $reduce: { input: "$items", in: "$$|', 'filter')
    expect(reduce.position).toMatchObject({
      vars: [{ name: 'value' }, { name: 'this', field: { path: 'items' } }]
    })
    const bound = at('{ $expr: { $let: { vars: { home: "$address", n: 1 }, in: "$$|', 'filter')
    expect(bound.position).toMatchObject({
      vars: [{ name: 'home', field: { path: 'address' } }, { name: 'n' }]
    })
    expect(bound.position.at === 'expressionValue' && bound.position.vars[1]?.field).toBe(undefined)
  })

  it('lists lookup targets of earlier stages, including nested pipelines', () => {
    const ctx = at(
      '[{ $lookup: { from: "orders", as: "o" } }, { $facet: { f: [{ $unionWith: "logs" }] } }, { $match: { |',
      'pipeline'
    )
    expect(ctx.collections).toEqual(['users', 'orders', 'logs'])
  })
})

describe('analyzeContext: keys after the cursor', () => {
  it('counts keys after the cursor as present in a document', () => {
    expect(at('{\n  "|"\n  "_id": 1, "name": "x"\n}', 'document').position).toMatchObject({
      at: 'documentKey',
      present: ['_id', 'name']
    })
  })

  it('counts keys after the cursor as present in a filter', () => {
    expect(at('{ |, name: "x" }', 'filter').position).toMatchObject({
      at: 'queryKey',
      present: ['name']
    })
  })
})

describe('analyzeContext: expected types', () => {
  it.each<[string, EditorKind, Record<string, unknown>]>([
    [
      '[{ $group: { _id: null, t: { $sum: "$|',
      'pipeline',
      { at: 'expressionValue', prefer: 'number' }
    ],
    ['[{ $project: { y: { $year: "$|', 'pipeline', { at: 'expressionValue', prefer: 'date' }],
    [
      '[{ $project: { d: { $dateToString: { date: "$|',
      'pipeline',
      { at: 'expressionValue', prefer: 'date' }
    ],
    ['{ $expr: { |', 'filter', { at: 'expressionKey', prefer: 'bool' }],
    ['{ $expr: { $and: [{ |', 'filter', { at: 'expressionKey', prefer: 'bool' }],
    ['{ $expr: { $cond: { if: "$|', 'filter', { at: 'expressionValue', prefer: 'bool' }],
    [
      '{ $expr: { $gt: ["$coins", "$|',
      'filter',
      { at: 'expressionValue', prefer: { source: { coll: 'users' }, path: 'coins' } }
    ],
    [
      '[{ $lookup: { from: "orders", localField: "uid", foreignField: "|',
      'pipeline',
      {
        at: 'fieldName',
        source: { coll: 'orders' },
        prefer: { source: { coll: 'users' }, path: 'uid' }
      }
    ]
  ])('%s (%s)', (marked, kind, expected) => {
    expect(at(marked, kind).position).toMatchObject(expected)
  })

  it('expects nothing in particular where any value fits', () => {
    const position = at('[{ $set: { x: "$|', 'pipeline').position
    expect(position.at).toBe('expressionValue')
    expect(position.at === 'expressionValue' && position.prefer).toBeUndefined()
  })
})

describe('analyzeContext: object literals and nested pipelines', () => {
  it('takes keys of a $set object literal from the field it extends', () => {
    expect(at('[{ $set: { address: { |', 'pipeline').position).toMatchObject({
      at: 'expressionKey',
      literalBase: 'address'
    })
    expect(at('[{ $set: { address: { geo: { |', 'pipeline').position).toMatchObject({
      literalBase: 'address.geo'
    })
  })

  it('takes compound $group keys from the root fields', () => {
    expect(at('[{ $group: { _id: { |', 'pipeline').position).toMatchObject({
      at: 'expressionKey',
      literalBase: ''
    })
    const operator = at('[{ $set: { x: { $add: [{ |', 'pipeline').position
    expect(operator.at).toBe('expressionKey')
    expect(operator.at === 'expressionKey' && operator.literalBase).toBeUndefined()
  })

  it('offers only direct children as $jsonSchema property names', () => {
    expect(at('{ $jsonSchema: { properties: { |', 'filter').position).toMatchObject({
      at: 'queryKey',
      childrenOnly: true
    })
  })

  it('marks $facet branches and $lookup / $unionWith pipelines', () => {
    expect(at('[{ $facet: { a: [{ |', 'pipeline').position).toMatchObject({
      at: 'stageKey',
      nested: 'facet'
    })
    expect(at('[{ $lookup: { from: "orders", pipeline: [|', 'pipeline').position).toMatchObject({
      at: 'stageElement',
      nested: 'sub'
    })
    expect(
      at('[{ $unionWith: { coll: "orders", pipeline: [{ |', 'pipeline').position
    ).toMatchObject({ at: 'stageKey', nested: 'sub' })
    const main = at('[{ |', 'pipeline').position
    expect(main.at).toBe('stageKey')
    expect(main.at === 'stageKey' && main.nested).toBeUndefined()
  })
})

describe('analyzeContext: shell source', () => {
  it('uses the command collection as the field source', () => {
    const ctx = at('db.orders.find({ |', 'shell')
    expect(ctx.position).toMatchObject({ at: 'queryKey', source: { coll: 'orders' } })
    expect(ctx.collections).toEqual(['orders'])
  })

  it('resolves getCollection and bracket accessors', () => {
    expect(at('db.getCollection("a-b").find({ |', 'shell').position).toMatchObject({
      source: { coll: 'a-b' }
    })
    expect(at('db["a b"].find({ |', 'shell').position).toMatchObject({ source: { coll: 'a b' } })
  })

  it('keeps the tab collection when no command names one', () => {
    expect(at('|', 'shell').collections).toEqual(['users'])
  })
})

describe('analyzeContext: shell writes', () => {
  it.each<[string, Record<string, unknown>]>([
    ['db.users.insertOne(|', { at: 'rootValue', expect: 'object' }],
    ['db.users.insertOne({ |', { at: 'documentKey', coll: 'users', path: '', present: [] }],
    ['db.users.insertOne({ address: { |', { at: 'documentKey', path: 'address' }],
    ['db.users.insertOne({ tags: [ |', { at: 'documentValue', path: 'tags', element: true }],
    ['db.users.insertOne({ _id: ObjectId("|', { at: 'ctorArg', field: '_id', ctor: 'ObjectId' }],
    ['db.users.insertOne({}, { |', { at: 'stageArgKey', stage: 'insertOne.options' }],
    ['db.users.insertMany(|', { at: 'rootValue', expect: 'array' }],
    ['db.users.insertMany([|', { at: 'rootValue', expect: 'object' }],
    ['db.users.insertMany([{ a: 1 }, { |', { at: 'documentKey', path: '', present: [] }],
    ['db.users.insertMany([], { ordered: |', { at: 'literal', values: ['true', 'false'] }],
    ['db.users.updateOne({ |', { at: 'queryKey', topLevel: true }],
    ['db.users.updateOne({}, |', { at: 'rootValue', expect: 'object' }],
    ['db.users.updateOne({}, { |', { at: 'updateKey', present: [] }],
    ['db.users.updateOne({}, { $set: { a: 1 }, | })', { at: 'updateKey', present: ['$set'] }],
    ['db.users.updateOne({}, { $set: { |', { at: 'updateFieldKey', op: '$set', present: [] }],
    [
      'db.users.updateOne({}, { $set: { name: |',
      { at: 'documentValue', path: 'name', element: false }
    ],
    ['db.users.updateOne({}, { $set: { address: { |', { at: 'documentKey', path: 'address' }],
    ['db.users.updateOne({}, { $setOnInsert: { at: |', { at: 'documentValue', path: 'at' }],
    ['db.users.updateOne({}, { $min: { age: |', { at: 'documentValue', path: 'age' }],
    ['db.users.updateOne({}, { $inc: { age: |', { at: 'updateValue', op: '$inc', field: 'age' }],
    ['db.users.updateOne({}, { $mul: { age: |', { at: 'updateValue', op: '$mul', field: 'age' }],
    ['db.users.updateOne({}, { $unset: { age: |', { at: 'updateValue', op: '$unset' }],
    ['db.users.updateOne({}, { $pop: { tags: |', { at: 'updateValue', op: '$pop', field: 'tags' }],
    ['db.users.updateOne({}, { $currentDate: { at: |', { at: 'updateValue', op: '$currentDate' }],
    [
      'db.users.updateOne({}, { $currentDate: { at: { |',
      { at: 'stageArgKey', stage: '$currentDate.field' }
    ],
    [
      'db.users.updateOne({}, { $currentDate: { at: { $type: |',
      { at: 'literal', values: ['"date"', '"timestamp"'] }
    ],
    ['db.users.updateOne({}, { $bit: { flags: |', { at: 'updateValue', op: '$bit' }],
    ['db.users.updateOne({}, { $bit: { flags: { |', { at: 'stageArgKey', stage: '$bit.field' }],
    ['db.users.updateOne({}, { $rename: { name: "|', { at: 'fieldName', renaming: 'name' }],
    [
      'db.users.updateOne({}, { $push: { tags: |',
      { at: 'documentValue', path: 'tags', element: true, modifiersOf: '$push' }
    ],
    [
      'db.users.updateOne({}, { $push: { tags: { |',
      { at: 'documentKey', path: 'tags', modifiersOf: '$push' }
    ],
    [
      'db.users.updateOne({}, { $addToSet: { tags: { |',
      { at: 'documentKey', path: 'tags', modifiersOf: '$addToSet' }
    ],
    [
      'db.users.updateOne({}, { $push: { tags: { $each: |',
      { at: 'documentValue', path: 'tags', element: false }
    ],
    [
      'db.users.updateOne({}, { $push: { tags: { $each: [|',
      { at: 'documentValue', path: 'tags', element: true }
    ],
    [
      'db.users.updateOne({}, { $push: { items: { $sort: |',
      { at: 'literal', values: ['1', '-1'], preferred: '1' }
    ],
    ['db.users.updateOne({}, { $push: { items: { $sort: { |', { at: 'documentKey', path: 'items' }],
    ['db.users.updateOne({}, { $push: { items: { $slice: |', { at: 'none' }],
    [
      'db.users.updateOne({}, { $push: { items: { sku: |',
      { at: 'documentValue', path: 'items.sku' }
    ],
    [
      'db.users.updateOne({}, { $pull: { tags: |',
      { at: 'queryValue', field: 'tags', operator: null }
    ],
    ['db.users.updateOne({}, { $pull: { items: { |', { at: 'elemMatchKey', field: 'items' }],
    [
      'db.users.updateOne({}, { $pull: { items: { qty: { $g|',
      { at: 'operatorKey', field: 'items.qty' }
    ],
    [
      'db.users.updateOne({}, { $pullAll: { tags: [|',
      { at: 'documentValue', path: 'tags', element: true }
    ],
    ['db.users.updateOne({}, { name: { |', { at: 'none' }],
    ['db.users.updateOne({}, { $where: { |', { at: 'none' }],
    ['db.users.updateOne({}, [|', { at: 'stageElement', stageIndex: 0, nested: 'update' }],
    [
      'db.users.updateOne({}, [{ $set: { a: 1 } }, { |',
      { at: 'stageKey', stageIndex: 1, nested: 'update' }
    ],
    ['db.users.updateMany({}, [{ $set: { a: "$|', { at: 'expressionValue' }],
    ['db.users.updateOne({}, {}, { |', { at: 'stageArgKey', stage: 'updateOne.options' }],
    ['db.users.updateOne({}, {}, { upsert: |', { at: 'literal', values: ['true', 'false'] }],
    ['db.users.replaceOne({}, { |', { at: 'documentKey', path: '' }],
    ['db.users.replaceOne({}, {}, { |', { at: 'stageArgKey', stage: 'replaceOne.options' }],
    ['db.users.deleteMany({ |', { at: 'queryKey' }],
    ['db.users.deleteOne({}, { |', { at: 'stageArgKey', stage: 'deleteOne.options' }],
    ['db.users.findOneAndDelete({}, { sort: { |', { at: 'sortKey' }],
    ['db.users.findOneAndReplace({}, {}, { projection: { |', { at: 'projectionKey' }],
    [
      'db.users.findOneAndUpdate({}, {}, { returnDocument: |',
      { at: 'literal', values: ['"after"', '"before"'] }
    ],
    ['db.users.bulkWrite(|', { at: 'rootValue', expect: 'array' }],
    ['db.users.bulkWrite([|', { at: 'bulkOperationElement' }],
    ['db.users.bulkWrite([{ |', { at: 'bulkOperationKey' }],
    ['db.users.bulkWrite([{ | deleteOne: {} }])', { at: 'none' }],
    ['db.users.bulkWrite([{ updateOne: { |', { at: 'stageArgKey', stage: 'bulkWrite.updateOne' }],
    ['db.users.bulkWrite([{ updateOne: { filter: { |', { at: 'queryKey' }],
    ['db.users.bulkWrite([{ updateMany: { update: { |', { at: 'updateKey' }],
    ['db.users.bulkWrite([{ insertOne: { document: { |', { at: 'documentKey', path: '' }],
    ['db.users.bulkWrite([{ replaceOne: { replacement: { a|', { at: 'documentKey', path: '' }],
    ['db.users.bulkWrite([{ foo: { |', { at: 'none' }],
    ['db.users.bulkWrite([], { |', { at: 'stageArgKey', stage: 'bulkWrite.options' }]
  ])('%s', (marked, expected) => {
    expect(at(marked, 'shell').position).toMatchObject(expected)
  })

  it('reads documents and updates against the command collection', () => {
    const ctx = at('db.orders.insertOne({ |', 'shell')
    expect(ctx.position).toMatchObject({ at: 'documentKey', coll: 'orders' })
    expect(ctx.collections).toEqual(['orders'])
    expect(at('db.orders.updateOne({}, { $inc: { |', 'shell').position).toMatchObject({
      at: 'updateFieldKey',
      source: { coll: 'orders', stages: [] }
    })
  })

  it('counts fields other update operators change as present', () => {
    const position = at(
      'db.users.updateOne({}, { $set: { a: 1 }, $inc: { b: 1, | }, $unset: { c: "" } })',
      'shell'
    ).position
    expect(position).toMatchObject({ at: 'updateFieldKey', op: '$inc' })
    expect(position.at === 'updateFieldKey' && [...position.present].sort()).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('resolves positional update paths to the array they address', () => {
    expect(
      at('db.users.updateOne({}, { $set: { "items.$[it].qty": |', 'shell').position
    ).toMatchObject({ at: 'documentValue', path: 'items.qty', element: false })
    expect(at('db.users.updateOne({}, { $set: { "tags.$": |', 'shell').position).toMatchObject({
      at: 'documentValue',
      path: 'tags',
      element: true
    })
    expect(
      at('db.users.updateOne({}, { $inc: { "items.$[].qty": |', 'shell').position
    ).toMatchObject({
      at: 'updateValue',
      field: 'items.qty'
    })
  })

  it('offers the $[identifier]s of the update as arrayFilters keys', () => {
    const update =
      '{ $set: { "items.$[it].qty": 1, "grades.$[g]": 0 }, $inc: { "items.$[it].n": 1 } }'
    expect(
      at(`db.users.updateMany({}, ${update}, { arrayFilters: [{ |`, 'shell').position
    ).toMatchObject({
      at: 'arrayFilterKey',
      identifiers: [
        { name: 'it', path: 'items' },
        { name: 'g', path: 'grades' }
      ],
      present: []
    })
    expect(
      at(`db.users.updateMany({}, ${update}, { arrayFilters: [{ it: 1 }, { |`, 'shell').position
    ).toMatchObject({ at: 'arrayFilterKey', identifiers: [{ name: 'g', path: 'grades' }] })
    expect(
      at(`db.users.updateMany({}, ${update}, { arrayFilters: [{ "it.qty": 1, | }] })`, 'shell')
        .position
    ).toMatchObject({ at: 'arrayFilterKey', identifiers: [{ name: 'it', path: 'items' }] })
  })

  it('reads arrayFilters conditions as queries on the identified array elements', () => {
    const update = '{ $set: { "items.$[it].qty": 1 } }'
    expect(
      at(`db.users.updateOne({}, ${update}, { arrayFilters: [{ "it.qty": |`, 'shell').position
    ).toMatchObject({ at: 'queryValue', field: 'items.qty' })
    expect(
      at(`db.users.updateOne({}, ${update}, { arrayFilters: [{ it: { $|`, 'shell').position
    ).toMatchObject({ at: 'operatorKey', field: 'items' })
    expect(
      at(`db.users.updateOne({}, ${update}, { arrayFilters: [{ other: |`, 'shell').position
    ).toEqual({ at: 'none' })
    expect(
      at(
        'db.users.bulkWrite([{ updateMany: { arrayFilters: [{ | }], filter: {}, update: { $unset: { "a.$[x].b": "" } } } }])',
        'shell'
      ).position
    ).toMatchObject({ at: 'arrayFilterKey', identifiers: [{ name: 'x', path: 'a' }] })
  })

  it('lets a shell aggregate end with a write stage', () => {
    expect(at('db.users.aggregate([{ $match: {} }, { |', 'shell').position).toMatchObject({
      at: 'stageKey',
      stageIndex: 1,
      finalWrite: true
    })
    expect(at('db.users.aggregate([|', 'shell').position).toMatchObject({
      at: 'stageElement',
      finalWrite: true
    })
    expect(at('db.users.aggregate([{ | }, { $match: {} }])', 'shell').position).toMatchObject({
      at: 'stageKey',
      finalWrite: false
    })
    const sub = at(
      'db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ |',
      'shell'
    ).position
    expect(sub).toMatchObject({ at: 'stageKey', nested: 'sub' })
    expect(sub.at === 'stageKey' && sub.finalWrite).toBeFalsy()
    const editor = at('[{ $match: {} }, { |', 'pipeline').position
    expect(editor.at === 'stageKey' && editor.finalWrite).toBeFalsy()
  })
})

describe('analyzeContext: key quoting', () => {
  it('uses double quotes when the text has only quoted keys', () => {
    expect(at('{ "a": 1, | }', 'filter').keyQuote).toBe('"')
  })

  it('uses shell style when any key is unquoted or there are none', () => {
    expect(at('{ "a": { $gt: 1 }, | }', 'filter').keyQuote).toBeNull()
    expect(at('{ | }', 'filter').keyQuote).toBeNull()
  })
})
