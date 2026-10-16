import { describe, expect, it } from 'vitest'
import { createSchemaBuilder } from '@shared/collectionSchema'
import { WRITE_METHODS, type CollectionSchema } from '@shared/types'
import { BULK_WRITE_OPERATIONS, UPDATE_PIPELINE_STAGES, WRITE_OPTIONS } from '@shared/writeOps'
import {
  SHELL_AGGREGATE_CURSOR_METHODS,
  SHELL_COLLECTION_METHODS,
  SHELL_CURSOR_METHODS,
  shellCollectionAccessor
} from '../shellParser'
import { analyzeContext, type EditorKind } from './context'
import {
  suggest,
  type SuggestEnv,
  type SuggestResult,
  type SuggestTrigger,
  type Suggestion
} from './suggest'

const NOW = new Date('2024-01-15T12:00:00.000Z')

const schemaOf = (...docs: unknown[]): CollectionSchema => {
  const builder = createSchemaBuilder()
  for (const doc of docs) builder.add(doc)
  return builder.build()
}

const oid = (n: number) => ({ $oid: `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}` })
const scores = Object.fromEntries(
  Array.from({ length: 70 }, (_, i) => [`k${i}z`, { $numberInt: '1' }])
)

const users = schemaOf(
  ...Array.from({ length: 6 }, (_, i) => ({
    _id: oid(i),
    name: `user${i}`,
    status: i < 4 ? 'active' : 'inactive',
    age: { $numberInt: String(20 + i) },
    createdAt: { $date: { $numberLong: String(1704067200000 + i) } },
    uid: { $binary: { base64: 'VQ6EAOKbQdSnFkRmVUQAAA==', subType: '04' } },
    legacy: { $binary: { base64: 'VQ6EAOKbQdSnFkRmVUQAAA==', subType: '03' } },
    big: { $numberLong: '9007199254740993' },
    ids: [oid(10), oid(11)],
    tags: ['a', 'b'],
    address: { city: 'Berlin', zip: '10115' },
    note: 'price $5',
    flag: i % 3 !== 0,
    scores
  }))
)
const orders = schemaOf({ _id: oid(20), userId: oid(1), total: { $numberDouble: '9.5' } })
const places = schemaOf({
  _id: oid(30),
  items: [{ sku: 'a', qty: { $numberInt: '1' } }],
  loc: { type: 'Point', coordinates: [{ $numberDouble: '13.4' }, { $numberDouble: '52.5' }] }
})

const makeEnv = (overrides: Partial<SuggestEnv> = {}): SuggestEnv => ({
  coll: 'users',
  collections: ['users', 'orders', 'my logs'],
  schemaOf: (coll) => ({ users, orders, places })[coll] ?? null,
  uuidEncoding: 'default',
  timezone: 'UTC',
  now: NOW,
  shellMethods: SHELL_COLLECTION_METHODS,
  cursorMethods: SHELL_CURSOR_METHODS,
  aggregateCursorMethods: SHELL_AGGREGATE_CURSOR_METHODS,
  collectionAccessor: shellCollectionAccessor,
  ...overrides
})

const INVOKE: SuggestTrigger = { kind: 'invoke' }

/** Suggestions at the `|` marker of `marked`. */
const run = (
  marked: string,
  kind: EditorKind = 'filter',
  options: { env?: Partial<SuggestEnv>; trigger?: SuggestTrigger } = {}
): SuggestResult => {
  const offset = marked.indexOf('|')
  const env = makeEnv(options.env)
  const ctx = analyzeContext(
    marked.slice(0, offset) + marked.slice(offset + 1),
    offset,
    kind,
    env.coll
  )
  return suggest(ctx, env, options.trigger ?? INVOKE)
}

const ordered = (result: SuggestResult): Suggestion[] =>
  [...result.items].sort((a, b) => (a.sortText < b.sortText ? -1 : 1))
const labels = (result: SuggestResult): string[] => ordered(result).map((item) => item.label)
const item = (result: SuggestResult, label: string): Suggestion | undefined =>
  result.items.find((i) => i.label === label)
const preselected = (result: SuggestResult): Suggestion[] => result.items.filter((i) => i.preselect)
const char = (c: string): SuggestTrigger => ({ kind: 'character', char: c })

describe('suggest: value model', () => {
  it('preselects ObjectId for an objectId field and spaces after a bare colon', () => {
    const result = run('{ "_id":|')
    const [first] = ordered(result)
    expect(first).toMatchObject({ insertText: ' ObjectId("$0")', snippet: true, preselect: true })
    expect(first?.description).toBe('objectId · 100%')
    expect(preselected(result)).toHaveLength(1)
    expect(ordered(run('{ "_id": |'))[0]?.insertText).toBe('ObjectId("$0")')
  })

  it('defaults ISODate to now in the connection timezone', () => {
    const [first] = ordered(run('{ createdAt: |', 'filter', { env: { timezone: 'Europe/Berlin' } }))
    expect(first?.insertText).toBe('ISODate("${0:2024-01-15T13:00:00.000+01:00}")')
  })

  it('picks UUID, JUUID / BinData(3) and NumberLong by type', () => {
    expect(ordered(run('{ uid: |'))[0]?.insertText).toBe('UUID("$0")')
    expect(
      ordered(run('{ legacy: |', 'filter', { env: { uuidEncoding: 'java' } }))[0]?.insertText
    ).toBe('JUUID("$0")')
    expect(ordered(run('{ legacy: |'))[0]?.insertText).toBe('BinData(3, "$0")')
    expect(ordered(run('{ big: |'))[0]?.insertText).toBe('NumberLong("${0:0}")')
  })

  it('offers no constructor for ints in a filter but NumberInt in a document', () => {
    const filter = run('{ age: |')
    expect(filter.items.some((i) => i.kind === 'constructor')).toBe(false)
    expect(item(filter, '20')).toMatchObject({ insertText: '20', snippet: false })
    const document = run('{ age: |', 'document')
    expect(ordered(document)[0]).toMatchObject({ insertText: 'NumberInt(${0:0})', preselect: true })
    expect(item(document, 'NumberInt(20)')).toBeDefined()
  })

  it('orders enum strings by count and preselects the most frequent', () => {
    const result = run('{ status: |')
    const values = ordered(result).filter((i) => i.kind === 'value')
    expect(values.map((i) => i.label)).toEqual(['"active"', '"inactive"'])
    expect(values[0]).toMatchObject({ preselect: true, sortText: 'b0000', filterText: 'active' })
    expect(preselected(result)).toHaveLength(1)
  })

  it('shows three examples of a high-cardinality field at tier d', () => {
    const examples = run('{ name: |').items.filter((i) => i.description === 'example')
    expect(examples).toHaveLength(3)
    expect(examples.every((i) => i.sortText.startsWith('d'))).toBe(true)
  })

  it('uses the element type of an array field', () => {
    expect(ordered(run('{ ids: |'))[0]?.insertText).toBe('ObjectId("$0")')
  })

  it('excludes values already in the $in array', () => {
    const result = run('{ status: { $in: ["active", |')
    expect(item(result, '"active"')).toBeUndefined()
    expect(item(result, '"inactive"')).toBeDefined()
  })

  it('wraps the constructor in an array for $in before the array is typed', () => {
    expect(ordered(run('{ _id: { $in: |'))[0]).toMatchObject({
      insertText: '[ObjectId("$0")]',
      retrigger: true
    })
  })

  it('offers only string contents inside quotes', () => {
    const result = run('{ status: "ac|" }')
    expect(result.items.map((i) => i.insertText)).toEqual(['active', 'inactive'])
    expect(run('{ age: "|" }').items).toEqual([])
  })

  it('keeps the more frequent boolean preselected', () => {
    const result = run('{ flag: |')
    expect(preselected(result).map((i) => i.label)).toEqual(['true'])
  })

  it('offers null in filters', () => {
    expect(item(run('{ status: |'), 'null')?.sortText.startsWith('d')).toBe(true)
  })

  it('falls back to every constructor at tier e for an unknown field', () => {
    const result = run('{ missing: |')
    expect(result.items.length).toBeGreaterThan(5)
    expect(result.items.every((i) => i.sortText.startsWith('e') && !i.preselect)).toBe(true)
  })

  it('suggests constructor arguments from samples', () => {
    const result = run('{ _id: ObjectId("|") }')
    expect(result.items[0]).toMatchObject({
      label: '507f1f77bcf86cd799439000',
      insertText: '507f1f77bcf86cd799439000'
    })
  })

  it('replaces a whole string value up to its closing quote', () => {
    const name = run('{ name: "us|er-1" }')
    expect('{ name: "user-1" }'.slice(name.range.start, name.range.end)).toBe('user-1')
    const date = run('{ createdAt: ISODate("2024-05|-07") }')
    const dateText = '{ createdAt: ISODate("2024-05-07") }'
    expect(dateText.slice(date.range.start, date.range.end)).toBe('2024-05-07')
  })

  it('closes an unterminated string around an inserted value', () => {
    expect(item(run('{ status: "ac|, age: 5 }'), '"active"')?.insertText).toBe('active"')
    expect(item(run('{ status: "ac|" }'), '"active"')?.insertText).toBe('active')
  })

  it('adds one space before an array template after a bare colon', () => {
    expect(ordered(run('{ _id: { $in:|'))[0]?.insertText).toBe(' [ObjectId("$0")]')
  })

  it('lists observed type aliases first', () => {
    expect(labels(run('{ age: { $type: |'))[0]).toBe('int')
    expect(item(run('{ age: { $type: |'), 'int')?.insertText).toBe('"int"')
  })
})

describe('suggest: escaping', () => {
  const unescapedDollar = /(^|[^\\])\$(?![0-9{])/
  const positions: [string, EditorKind][] = [
    ['{ |', 'filter'],
    ['{ "|', 'filter'],
    ['{ "a": 1, |', 'filter'],
    ['{ age: { |', 'filter'],
    ['{ name: { |', 'filter'],
    ['{ tags: { $elemMatch: { |', 'filter'],
    ['{ _id: |', 'filter'],
    ['{ missing: |', 'filter'],
    ['{ $text: { |', 'filter'],
    ['{ a: { $near: { |', 'filter'],
    ['[ |', 'pipeline'],
    ['[{ |', 'pipeline'],
    ['[{ "|', 'pipeline'],
    ['[{ $group: { _id: null, n: { |', 'pipeline'],
    ['[{ $setWindowFields: { output: { r: { |', 'pipeline'],
    ['[{ $project: { x: { |', 'pipeline'],
    ['[{ $lookup: { |', 'pipeline'],
    ['[{ $unwind: { |', 'pipeline'],
    ['{ tags: |', 'projection'],
    ['{ name: |', 'sort'],
    ['|', 'shell'],
    ['db.users.|', 'shell'],
    ['db.users.find({}).|', 'shell'],
    ['db.users.insertOne({ |', 'shell'],
    ['db.users.updateOne({}, { |', 'shell'],
    ['db.users.updateOne({}, { $currentDate: { createdAt: |', 'shell'],
    ['db.users.updateOne({}, { $bit: { flags: |', 'shell'],
    ['db.users.updateOne({}, { $push: { tags: |', 'shell'],
    ['db.users.updateOne({}, { $push: { tags: { |', 'shell'],
    ['db.users.updateOne({}, [|', 'shell'],
    ['db.users.updateMany({}, {}, { |', 'shell'],
    ['db.users.aggregate([{ $match: {} }, { |', 'shell'],
    ['db.users.bulkWrite([|', 'shell'],
    ['db.users.bulkWrite([{ updateOne: { |', 'shell'],
    ['{ a: |', 'document']
  ]

  it.each(positions)('escapes literal $ in snippets at %s (%s)', (marked, kind) => {
    for (const suggestion of run(marked, kind).items) {
      if (suggestion.snippet) expect(suggestion.insertText).not.toMatch(unescapedDollar)
    }
  })

  it('escapes $ in quoted operator keys', () => {
    expect(item(run('{ "a": 1, | }'), '$and')?.insertText).toBe('"\\$and": [{ $0 }]')
  })

  it('inserts sample values containing $ as plain text', () => {
    expect(item(run('{ note: |'), '"price $5"')).toMatchObject({
      insertText: '"price $5"',
      snippet: false
    })
  })
})

describe('suggest: keys', () => {
  it('lists _id first, then fields by presence and depth', () => {
    const result = labels(run('{ |'))
    expect(result[0]).toBe('_id')
    expect(result.indexOf('name')).toBeLessThan(result.indexOf('address.city'))
    expect(result).toContain('scores')
    expect(result).not.toContain('scores.*')
  })

  it('inserts key, colon and space and re-opens suggestions', () => {
    expect(item(run('{ |'), 'name')).toMatchObject({
      insertText: 'name: ',
      snippet: false,
      retrigger: true
    })
  })

  it('inserts only the key when a colon follows', () => {
    const name = item(run('{ na|me: 1 }'), 'name')
    expect(name).toMatchObject({ insertText: 'name' })
    expect(name?.retrigger).toBeUndefined()
  })

  it('quotes dotted paths and keys in quoted documents', () => {
    expect(item(run('{ ad|'), 'address.city')?.insertText).toBe('"address.city": ')
    expect(item(run('{ "age": 1, |'), 'name')?.insertText).toBe('"name": ')
  })

  it('completes inside quotes and replaces through the closing quote', () => {
    const result = run('{ "na|" }')
    expect(item(result, 'name')?.insertText).toBe('name": ')
    expect(result.range).toEqual({ start: 3, end: 6 })
  })

  it('excludes present keys', () => {
    expect(item(run('{ name: 1, |'), 'name')).toBeUndefined()
  })

  it('narrows to children after a dotted prefix', () => {
    const result = run('{ address.|')
    expect(labels(result)).toEqual(['address.city', 'address.zip'])
    expect(result.range.start).toBe(2)
  })

  it('does not expand a map-like object', () => {
    expect(run('{ scores.|').items).toEqual([])
  })

  it('offers top-level operators at tier c, or tier a after $', () => {
    expect(item(run('{ |'), '$or')?.sortText.startsWith('c')).toBe(true)
    expect(item(run('{ $|'), '$or')?.sortText.startsWith('a')).toBe(true)
  })

  it('ranks operators by the field type', () => {
    const name = run('{ name: { |')
    expect(item(name, '$regex')?.sortText.startsWith('c')).toBe(true)
    expect(item(name, '$size')?.sortText.startsWith('e')).toBe(true)
    const tags = run('{ tags: { |')
    for (const op of ['$size', '$all', '$elemMatch'])
      expect(item(tags, op)?.sortText.startsWith('c')).toBe(true)
  })

  it('offers $options only next to $regex', () => {
    expect(item(run('{ name: { |'), '$options')).toBeUndefined()
    expect(item(run('{ name: { $regex: /a/, |'), '$options')).toBeDefined()
  })

  it('inserts operator templates', () => {
    const result = run('{ _id: { |')
    expect(item(result, '$in')).toMatchObject({
      insertText: '\\$in: [$0]',
      snippet: true,
      retrigger: true
    })
    expect(item(result, '$gt')).toMatchObject({
      insertText: '$gt: ',
      snippet: false,
      retrigger: true
    })
    expect(item(result, '$oid')?.sortText.startsWith('e')).toBe(true)
  })

  it('excludes keys that follow the cursor', () => {
    expect(item(run('{ |, name: "x" }'), 'name')).toBeUndefined()
    expect(item(run('{\n  "|"\n  "name": "x"\n}', 'document'), 'name')).toBeUndefined()
  })

  it('replaces a whole dotted key from its first segment', () => {
    const result = run('{ addr|ess.city: 1 }')
    expect('{ address.city: 1 }'.slice(result.range.start, result.range.end)).toBe('address.city')
    expect(item(result, 'address')?.insertText).toBe('address')
  })

  it('offers only direct children as $jsonSchema property names', () => {
    const root = labels(run('{ $jsonSchema: { properties: { | } } }'))
    expect(root).toContain('address')
    expect(root).not.toContain('address.city')
    expect(
      labels(run('{ $jsonSchema: { properties: { address: { properties: { | } } } } }'))
    ).toEqual(['city', 'zip'])
  })

  it('treats only GeoJSON objects as geo fields', () => {
    expect(item(run('{ address: { | } }'), '$geoWithin')?.sortText.startsWith('e')).toBe(true)
    const loc = run('{ loc: { | } }', 'filter', { env: { coll: 'places' } })
    expect(item(loc, '$near')?.sortText.startsWith('c')).toBe(true)
  })

  it('leaves non-fitting operators out once a letter is typed', () => {
    expect(item(run('{ address: { | } }'), '$bitsAllClear')).toBeDefined()
    expect(item(run('{ address: { c| } }'), '$bitsAllClear')).toBeUndefined()
  })

  it('suggests document keys of the nested path and nothing below a map', () => {
    expect(labels(run('{ address: { |', 'document'))).toEqual(['city', 'zip'])
    expect(run('{ scores: { |', 'document').items).toEqual([])
  })

  it('documents sample values in the editor kind and display settings of each request', () => {
    const doc = (label: string, kind: EditorKind, env: Partial<SuggestEnv> = {}) =>
      item(run('{ |', kind, { env }), label)?.documentation
    expect(doc('createdAt', 'filter')).toContain('`ISODate("2024-01-01T00:00:00.000Z")` ×1')
    expect(doc('createdAt', 'filter', { timezone: 'Europe/Berlin' })).toContain(
      '`ISODate("2024-01-01T01:00:00.000+01:00")` ×1'
    )
    expect(doc('age', 'filter')).toContain('`20` ×1')
    expect(doc('age', 'document')).toContain('`NumberInt(20)` ×1')
    expect(doc('legacy', 'filter', { uuidEncoding: 'java' })).toContain('`JUUID("')
    expect(doc('legacy', 'filter')).toContain('`BinData(3, "')
  })
})

describe('suggest: projection and sort', () => {
  it('puts 1 first in include mode and 0 first in exclude mode', () => {
    expect(preselected(run('{ name: 1, age: |', 'projection')).map((i) => i.label)).toEqual(['1'])
    expect(preselected(run('{ name: 0, age: |', 'projection')).map((i) => i.label)).toEqual(['0'])
    expect(preselected(run('{ _id: |', 'projection')).map((i) => i.label)).toEqual(['0'])
  })

  it('offers $slice and $elemMatch for arrays', () => {
    expect(item(run('{ tags: |', 'projection'), '{ $slice: … }')).toBeDefined()
    expect(item(run('{ name: |', 'projection'), '{ $slice: … }')).toBeUndefined()
  })

  it('preselects -1 for date fields and 1 otherwise', () => {
    expect(preselected(run('{ createdAt: |', 'sort')).map((i) => i.label)).toEqual(['-1'])
    expect(preselected(run('{ name: |', 'sort')).map((i) => i.label)).toEqual(['1'])
  })
})

describe('suggest: pipelines', () => {
  it('offers first-stage-only stages only at index 0', () => {
    expect(item(run('[ |', 'pipeline'), '$geoNear')).toBeDefined()
    const second = run('[{ $match: {} }, { |', 'pipeline')
    expect(item(second, '$geoNear')).toBeUndefined()
    expect(item(second, '$match')).toBeDefined()
  })

  it('never offers stages that cannot run here', () => {
    const main = labels(run('[ |', 'pipeline'))
    for (const stage of ['$out', '$merge', '$changeStream', '$documents', '$currentOp'])
      expect(main).not.toContain(stage)
    expect(main).toContain('$geoNear')
  })

  it('offers only the stages a $facet branch allows', () => {
    const facet = labels(run('[{ $facet: { a: [{ | }] } }]', 'pipeline'))
    for (const stage of ['$facet', '$geoNear', '$collStats', '$indexStats', '$search'])
      expect(facet).not.toContain(stage)
    expect(facet).toContain('$match')
  })

  it('offers $documents first in a $lookup pipeline', () => {
    const sub = labels(run('[{ $lookup: { as: "o", pipeline: [ | ] } }]', 'pipeline'))
    expect(sub).toContain('$documents')
    expect(sub).not.toContain('$merge')
  })

  it('does not call $group outputs overwrites', () => {
    const group = run('[{ $group: { _id: "$status", | } }]', 'pipeline')
    expect(group.items.some((i) => i.description === 'overwrite')).toBe(false)
    expect(item(run('[{ $set: { | } }]', 'pipeline'), 'name')?.description).toBe('overwrite')
  })

  it('pins _id only where the stage input can have it', () => {
    expect(
      labels(run('[{ $replaceRoot: { newRoot: "$address" } }, { $project: { | } }]', 'pipeline'))
    ).toEqual(['city', 'zip'])
    expect(labels(run('{ | }', 'projection'))[0]).toBe('_id')
    expect(labels(run('{ | }', 'projection', { env: { schemaOf: () => null } }))).toEqual(['_id'])
  })

  it('ranks expressions over array projection operators for a computed field', () => {
    const computed = run('[{ $project: { x: { | } } }]', 'pipeline')
    expect(item(computed, '$abs')?.sortText.startsWith('c')).toBe(true)
    expect(item(computed, '$meta')?.sortText.startsWith('c')).toBe(true)
    expect(item(computed, '$elemMatch')?.sortText.startsWith('e')).toBe(true)
    expect(item(computed, '$slice')).toMatchObject({ insertText: '\\$slice: [$0]' })
    const array = run('[{ $project: { tags: { | } } }]', 'pipeline')
    expect(item(array, '$slice')?.sortText.startsWith('c')).toBe(true)
    expect(item(array, '$abs')?.sortText.startsWith('e')).toBe(true)
  })

  it('offers subfields as keys of a $set object literal', () => {
    const result = run('[{ $set: { address: { | } } }]', 'pipeline')
    expect(labels(result).slice(0, 2)).toEqual(['city', 'zip'])
    expect(item(result, 'city')?.insertText).toBe('city: ')
    expect(item(result, '$concat')?.sortText.startsWith('c')).toBe(true)
  })

  it('offers root fields as keys of a compound $group key', () => {
    const result = run('[{ $group: { _id: { | } } }]', 'pipeline')
    expect(item(result, 'status')?.sortText.startsWith('b')).toBe(true)
    expect(item(result, 'address.city')).toBeUndefined()
  })

  it('wraps stage templates in an element', () => {
    expect(item(run('[ |', 'pipeline'), '$match')?.insertText).toBe('{ \\$match: { $0 } }')
    expect(item(run('[{ |', 'pipeline'), '$group')?.insertText).toBe('\\$group: { _id: $0 }')
  })

  it('suggests field references inside expression strings', () => {
    const result = run('[{ $group: { _id: "$|" } }]', 'pipeline')
    expect(item(result, '$name')).toMatchObject({ insertText: '$name', snippet: false })
    expect(item(result, '$$ROOT')).toBeDefined()
  })

  it('suggests fields of the stage input', () => {
    const result = run('[{ $project: { label: "$name" } }, { $match: { |', 'pipeline')
    expect(labels(result)).toContain('label')
    expect(labels(result)).not.toContain('age')
  })

  it('suggests foreign fields from the $lookup target', () => {
    expect(labels(run('[{ $lookup: { from: "orders", foreignField: "|', 'pipeline'))).toEqual([
      '_id',
      'total',
      'userId'
    ])
  })

  it('lists other collections first and the current one last', () => {
    expect(labels(run('[{ $lookup: { from: "|', 'pipeline'))).toEqual([
      'orders',
      'my logs',
      'users'
    ])
  })

  it('lists required stage arguments first', () => {
    const result = labels(run('[{ $lookup: { |', 'pipeline'))
    expect(result.slice(0, 2)).toEqual(['from', 'as'])
  })

  it('offers accumulators and window functions', () => {
    expect(item(run('[{ $group: { _id: null, n: { |', 'pipeline'), '$sum')?.insertText).toBe(
      '\\$sum: ${0:1}'
    )
    expect(item(run('[{ $group: { _id: null, n: { |', 'pipeline'), '$rank')).toBeUndefined()
    expect(item(run('[{ $setWindowFields: { output: { r: { |', 'pipeline'), '$rank')).toBeDefined()
  })
})

describe('suggest: expected types', () => {
  it('ranks numeric fields first for a numeric accumulator', () => {
    expect(labels(run('[{ $group: { _id: null, t: { $sum: "$|" } } }]', 'pipeline'))[0]).toBe(
      '$age'
    )
  })

  it('ranks date fields first for a date argument', () => {
    const marked = '[{ $project: { d: { $dateToString: { date: "$|" } } } }]'
    expect(labels(run(marked, 'pipeline'))[0]).toBe('$createdAt')
  })

  it('ranks fields like the other side of a comparison first', () => {
    expect(labels(run('{ $expr: { $gt: ["$big", "$|"] } }')).slice(0, 2)).toEqual(['$age', '$big'])
  })

  it('ranks bool-returning operators first under $expr', () => {
    const result = run('{ $expr: { | } }')
    expect(item(result, '$gt')?.sortText.startsWith('b')).toBe(true)
    expect(item(result, '$abs')?.sortText.startsWith('c')).toBe(true)
  })

  it('ranks foreign fields of the local field type first', () => {
    const marked = '[{ $lookup: { from: "orders", localField: "age", foreignField: "|" } }]'
    expect(labels(run(marked, 'pipeline'))[0]).toBe('total')
  })
})

describe('suggest: variables', () => {
  it('completes subfields of a variable bound to a field', () => {
    const marked = '{ $expr: { $let: { vars: { home: "$address" }, in: "$$home.|" } } }'
    const result = run(marked, 'filter', { trigger: char('.') })
    expect(labels(result)).toEqual(['$$home.city', '$$home.zip'])
    expect(item(result, '$$home.city')).toMatchObject({
      insertText: '$$home.city',
      filterText: '$$home.city'
    })
  })

  it('completes element subfields of $map and $filter variables', () => {
    const env = { coll: 'places' }
    const map = '[{ $project: { s: { $map: { input: "$items", as: "it", in: "$$it.|" } } } }]'
    expect(labels(run(map, 'pipeline', { env }))).toEqual(['$$it.qty', '$$it.sku'])
    const filter = '[{ $project: { s: { $filter: { input: "$items", cond: "$$this.|" } } } }]'
    expect(labels(run(filter, 'pipeline', { env }))).toEqual(['$$this.qty', '$$this.sku'])
  })

  it('offers nothing below a variable that holds no field', () => {
    const marked = '{ $expr: { $reduce: { input: "$tags", initialValue: 0, in: "$$value.|" } } }'
    expect(run(marked).items).toEqual([])
  })
})

describe('suggest: shell', () => {
  it('starts with a find on the tab collection', () => {
    expect(ordered(run('|', 'shell'))[0]).toMatchObject({
      insertText: 'db.users.find({ $0 })',
      preselect: true
    })
    expect(ordered(run('|', 'shell', { env: { coll: 'my logs' } }))[0]?.insertText).toBe(
      'db.getCollection("my logs").find({ $0 })'
    )
  })

  it('lists dot-addressable collections first, current first', () => {
    expect(labels(run('db.|', 'shell'))).toEqual(['users', 'orders', 'my logs'])
    expect(item(run('db.|', 'shell'), 'orders')).toMatchObject({
      insertText: 'orders.',
      retrigger: true
    })
  })

  it('reaches other collection names through getCollection', () => {
    expect(item(run('db.|', 'shell'), 'my logs')).toMatchObject({
      insertText: 'getCollection("my logs").',
      filterText: 'my logs',
      retrigger: true
    })
    expect(item(run('db.|', 'shell'), 'my logs')?.sortText.startsWith('c')).toBe(true)
  })

  it('continues a dotted collection name before the methods', () => {
    const result = run('db.game.|', 'shell', { env: { collections: ['users', 'game.events'] } })
    expect(item(result, 'events')).toMatchObject({ insertText: 'events.', retrigger: true })
    expect(item(result, 'events')?.sortText.startsWith('b')).toBe(true)
    expect(item(result, 'find')).toBeDefined()
  })

  it('addresses the tab collection through the injected accessor', () => {
    const env = {
      collectionAccessor: (coll: string) => `db.getCollection(${JSON.stringify(coll)})`
    }
    expect(ordered(run('|', 'shell', { env }))[0]?.insertText).toBe(
      'db.getCollection("users").find({ $0 })'
    )
  })

  it('takes the calls allowed after aggregate from the environment', () => {
    const env = { aggregateCursorMethods: ['toArray'] }
    expect(labels(run('db.users.aggregate([]).|', 'shell', { env }))).toEqual(['toArray'])
  })

  it('keeps the chain when replacing a collection segment', () => {
    expect(item(run('db.us|ers.find({})', 'shell'), 'orders')).toMatchObject({
      insertText: 'orders'
    })
  })

  it('lists exactly the supported collection methods', () => {
    expect(labels(run('db.users.|', 'shell'))).toEqual([...SHELL_COLLECTION_METHODS])
  })

  it('lists the cursor methods not used yet', () => {
    expect(labels(run('db.users.find({}).limit(5).|', 'shell'))).toEqual(
      SHELL_CURSOR_METHODS.filter((m) => m !== 'limit')
    )
    expect(labels(run('db.users.aggregate([]).|', 'shell'))).toEqual(['toArray', 'pretty'])
    expect(run('db.users.findOne({}).|', 'shell').items).toEqual([])
  })

  it('keeps an existing argument list when renaming a method', () => {
    expect(item(run('db.users.fi|({})', 'shell'), 'find')).toMatchObject({
      insertText: 'find',
      snippet: false
    })
  })
})

describe('suggest: shell writes', () => {
  const shell = (
    marked: string,
    options: { env?: Partial<SuggestEnv>; trigger?: SuggestTrigger } = {}
  ) => run(marked, 'shell', options)

  it('inserts call templates for the write methods', () => {
    const result = shell('db.users.|', { env: { shellMethods: WRITE_METHODS } })
    expect(labels(result)).toEqual([...WRITE_METHODS])
    expect(item(result, 'updateOne')).toMatchObject({
      insertText: 'updateOne({ $0 })',
      snippet: true,
      retrigger: true
    })
    expect(item(result, 'insertMany')?.insertText).toBe('insertMany([{ $0 }])')
    expect(item(result, 'bulkWrite')?.insertText).toBe('bulkWrite([$0])')
    for (const method of WRITE_METHODS) expect(item(result, method)?.documentation).toBeTruthy()
  })

  it('completes inserted documents with document fidelity', () => {
    expect(ordered(shell('db.users.insertOne({ age: |'))[0]).toMatchObject({
      insertText: 'NumberInt(${0:0})',
      preselect: true
    })
    expect(ordered(shell('db.users.insertOne({ big: |'))[0]?.insertText).toBe(
      'NumberLong("${0:0}")'
    )
    expect(labels(shell('db.users.insertOne({ address: { |'))).toEqual(['city', 'zip'])
    expect(labels(shell('db.users.insertMany([{ name: "x" }, { |'))).toContain('name')
    expect(ordered(shell('db.users.find({ age: |'))[0]?.kind).not.toBe('constructor')
  })

  it('lists the update operators at the root of an update', () => {
    const result = shell('db.users.updateOne({}, { |')
    expect(labels(result)).toEqual([
      '$set',
      '$unset',
      '$inc',
      '$mul',
      '$rename',
      '$min',
      '$max',
      '$currentDate',
      '$setOnInsert',
      '$push',
      '$addToSet',
      '$pop',
      '$pull',
      '$pullAll',
      '$bit'
    ])
    expect(item(result, '$set')).toMatchObject({
      insertText: '\\$set: { $0 }',
      snippet: true,
      retrigger: true
    })
    expect(item(shell('db.users.updateOne({}, { $set: {}, | })'), '$set')).toBeUndefined()
  })

  it('offers updatable fields under an update operator', () => {
    const set = shell('db.users.updateOne({}, { $set: { |')
    expect(labels(set)).not.toContain('_id')
    expect(item(set, 'address.city')?.insertText).toBe('"address.city": ')
    expect(labels(shell('db.users.updateOne({}, { $setOnInsert: { |'))).toContain('_id')
    expect(labels(shell('db.users.updateOne({}, { $set: { address.|'))).toEqual([
      'address.city',
      'address.zip'
    ])
  })

  it('addresses fields inside array elements through $[]', () => {
    const set = labels(shell('db.places.updateOne({}, { $set: { | } })'))
    expect(set).toEqual(expect.arrayContaining(['items', 'items.$[].qty', 'items.$[].sku']))
    expect(set).not.toContain('items.qty')
    expect(
      item(shell('db.places.updateOne({}, { $inc: { | } })'), 'items.$[].qty')?.insertText
    ).toBe('"items.$[].qty": ')
    expect(labels(shell('db.places.updateOne({}, { $set: { items.| } })'))).toEqual([
      'items.$[].qty',
      'items.$[].sku'
    ])
    expect(labels(shell('db.places.updateOne({}, { $set: { "items.$[it].|" } })'))).toEqual([
      'items.$[it].qty',
      'items.$[it].sku'
    ])
  })

  it('renames only fields outside array elements, never onto _id or its own path', () => {
    const keys = labels(shell('db.places.updateOne({}, { $rename: { | } })'))
    expect(keys).toEqual(expect.arrayContaining(['items', 'loc', 'loc.type']))
    expect(keys.some((key) => key.includes('$'))).toBe(false)
    expect(labels(shell('db.places.updateOne({}, { $rename: { loc: |'))).toEqual(['items'])
    expect(labels(shell('db.places.updateOne({}, { $rename: { "loc.type": |'))).toEqual([
      'items',
      'loc.coordinates'
    ])
  })

  it('ranks the fields an operator applies to first', () => {
    expect(labels(shell('db.users.updateOne({}, { $inc: { |')).slice(0, 2)).toEqual(['age', 'big'])
    expect(labels(shell('db.users.updateOne({}, { $push: { |')).slice(0, 2)).toEqual([
      'ids',
      'tags'
    ])
    expect(labels(shell('db.users.updateOne({}, { $currentDate: { |'))[0]).toBe('createdAt')
  })

  it('excludes fields other operators of the update already change', () => {
    const result = shell('db.users.updateOne({}, { $set: { name: "x" }, $unset: { | } })')
    expect(item(result, 'name')).toBeUndefined()
    expect(item(result, 'status')).toBeDefined()
  })

  it('suggests the values each update operator takes', () => {
    const inc = shell('db.users.updateOne({}, { $inc: { age: |')
    expect(labels(inc)).toEqual(['1', '-1'])
    expect(preselected(inc).map((i) => i.label)).toEqual(['1'])
    expect(labels(shell('db.users.updateOne({}, { $mul: { age: |'))).toEqual(['2', '-1'])
    expect(ordered(shell('db.users.updateOne({}, { $unset: { age: |'))[0]).toMatchObject({
      insertText: '""',
      preselect: true
    })
    expect(labels(shell('db.users.updateOne({}, { $pop: { tags: |'))).toEqual(['1', '-1'])
    expect(ordered(shell('db.users.updateOne({}, { $set: { age: |'))[0]?.insertText).toBe(
      'NumberInt(${0:0})'
    )
    expect(ordered(shell('db.users.updateOne({}, { $max: { createdAt: |'))[0]?.label).toBe(
      'ISODate("…")'
    )
    expect(
      item(shell('db.users.updateOne({}, { $rename: { name: |'), 'address.city')
    ).toMatchObject({ insertText: '"address.city"' })
    expect(ordered(shell('db.users.updateOne({}, { $pullAll: { tags: |'))[0]).toMatchObject({
      insertText: '[$0]',
      preselect: true
    })
  })

  it('sets the current date as true or a typed $type', () => {
    const result = shell('db.users.updateOne({}, { $currentDate: { createdAt: |')
    expect(labels(result)).toEqual(['true', '{ $type: "date" }', '{ $type: "timestamp" }'])
    expect(preselected(result).map((i) => i.label)).toEqual(['true'])
    expect(item(result, '{ $type: "date" }')).toMatchObject({
      insertText: '{ \\$type: "date" }',
      snippet: true
    })
    const env = { schemaOf: () => schemaOf({ ts: { $timestamp: { t: 1, i: 1 } } }) }
    const timestamp = shell('db.users.updateOne({}, { $currentDate: { ts: |', { env })
    expect(preselected(timestamp).map((i) => i.label)).toEqual(['{ $type: "timestamp" }'])
    expect(
      item(shell('db.users.updateOne({}, { $currentDate: { createdAt: { |'), '$type')
    ).toMatchObject({ insertText: '$type: ', retrigger: true })
    expect(labels(shell('db.users.updateOne({}, { $currentDate: { createdAt: { $type: |'))).toEqual(
      ['"date"', '"timestamp"']
    )
  })

  it('offers the bitwise operations of $bit', () => {
    expect(labels(shell('db.users.updateOne({}, { $bit: { age: |'))).toEqual([
      '{ and: … }',
      '{ or: … }',
      '{ xor: … }'
    ])
    expect(labels(shell('db.users.updateOne({}, { $bit: { age: { |'))).toEqual(['and', 'or', 'xor'])
  })

  it('suggests element values and modifiers for $push and $addToSet', () => {
    const value = shell('db.users.updateOne({}, { $push: { tags: |')
    expect(preselected(value).map((i) => i.label)).toEqual(['"a"'])
    expect(item(value, '{ $each: [ … ] }')).toMatchObject({
      insertText: '{ \\$each: [$0] }',
      retrigger: true
    })
    expect(labels(shell('db.users.updateOne({}, { $push: { tags: { |'))).toEqual([
      '$each',
      '$position',
      '$slice',
      '$sort'
    ])
    expect(labels(shell('db.users.updateOne({}, { $addToSet: { tags: { |'))).toEqual(['$each'])
    const each = shell('db.users.updateOne({}, { $addToSet: { ids: { $each: [|')
    expect(ordered(each)[0]?.insertText).toBe('ObjectId("$0")')
  })

  it('offers element fields beside the modifiers until one kind is used', () => {
    expect(labels(shell('db.places.updateOne({}, { $push: { items: { |'))).toEqual([
      'qty',
      'sku',
      '$each',
      '$position',
      '$slice',
      '$sort'
    ])
    expect(
      labels(shell('db.places.updateOne({}, { $push: { items: { $each: [], | } } })'))
    ).toEqual(['$position', '$slice', '$sort'])
    expect(labels(shell('db.places.updateOne({}, { $push: { items: { sku: "a", | } } })'))).toEqual(
      ['qty']
    )
    expect(labels(shell('db.places.updateOne({}, { $push: { items: { $sort: { |'))).toEqual([
      'qty',
      'sku'
    ])
  })

  it('reads $pull values as conditions on the array elements', () => {
    expect(item(shell('db.users.updateOne({}, { $pull: { tags: |'), '"a"')).toBeDefined()
    const keys = labels(shell('db.places.updateOne({}, { $pull: { items: { |'))
    expect(keys.slice(0, 2)).toEqual(['qty', 'sku'])
    expect(keys).toContain('$or')
  })

  it('lists the options of each write method', () => {
    const update = labels(shell('db.users.updateOne({}, { $set: {} }, { |'))
    expect(update[0]).toBe('upsert')
    expect([...update].sort()).toEqual(Object.keys(WRITE_OPTIONS.updateOne).sort())
    expect(labels(shell('db.users.insertMany([], { |'))).toEqual([
      'ordered',
      'bypassDocumentValidation'
    ])
    expect(item(shell('db.users.updateOne({}, {}, { |'), 'upsert')).toMatchObject({
      insertText: 'upsert: ',
      retrigger: true
    })
    expect(item(shell('db.users.updateMany({}, {}, { |'), 'arrayFilters')?.insertText).toBe(
      'arrayFilters: [{ $0 }]'
    )
  })

  it('offers no arrayFilters next to an update pipeline', () => {
    expect(item(shell('db.users.updateOne({}, [{ $set: { a: 1 } }], { |'), 'arrayFilters')).toBe(
      undefined
    )
    expect(
      item(shell('db.users.updateOne({}, { $set: { a: 1 } }, { |'), 'arrayFilters')
    ).toBeDefined()
    const bulk = 'db.users.bulkWrite([{ updateMany: { filter: {}, | update: [{ $unset: "a" }] } }])'
    expect(item(shell(bulk), 'arrayFilters')).toBeUndefined()
    expect(item(shell(bulk), 'upsert')).toBeDefined()
  })

  it('offers only one of returnDocument and returnNewDocument', () => {
    const options = (rest: string) =>
      labels(shell(`db.users.findOneAndUpdate({}, {}, { ${rest}| })`))
    expect(options('')).toEqual(expect.arrayContaining(['returnDocument', 'returnNewDocument']))
    expect(options('returnDocument: "after", ')).not.toContain('returnNewDocument')
    expect(options('returnNewDocument: true, ')).not.toContain('returnDocument')
  })

  it('completes option values by kind', () => {
    expect(labels(shell('db.users.updateOne({}, {}, { upsert: |'))).toEqual(['true', 'false'])
    expect(labels(shell('db.users.findOneAndUpdate({}, {}, { returnDocument: |'))).toEqual([
      '"after"',
      '"before"'
    ])
    expect(labels(shell('db.users.findOneAndDelete({}, { sort: { createdAt: |'))[0]).toBe('-1')
    expect(labels(shell('db.users.findOneAndReplace({}, {}, { projection: { |'))[0]).toBe('_id')
  })

  it('completes arrayFilters keys from the identifiers of the update', () => {
    const update = '{ $set: { "items.$[it].qty": 1 } }'
    const result = shell(`db.places.updateMany({}, ${update}, { arrayFilters: [{ |`)
    expect(labels(result)).toEqual(['it', 'it.qty', 'it.sku'])
    expect(item(result, 'it.qty')).toMatchObject({ insertText: '"it.qty": ', retrigger: true })
    expect(item(result, 'it')?.insertText).toBe('it: ')
    expect(
      labels(shell(`db.places.updateMany({}, ${update}, { arrayFilters: [{ it.| }] })`))
    ).toEqual(['it.qty', 'it.sku'])
  })

  it('wraps bulkWrite operations as array elements', () => {
    const result = shell('db.users.bulkWrite([|')
    expect(labels(result)).toEqual([...BULK_WRITE_OPERATIONS])
    expect(item(result, 'updateOne')).toMatchObject({
      insertText: '{ updateOne: { $0 } }',
      snippet: true,
      retrigger: true
    })
    expect(item(shell('db.users.bulkWrite([{ |'), 'deleteMany')).toMatchObject({
      insertText: 'deleteMany: { $0 }',
      retrigger: true
    })
    expect(labels(shell('db.users.bulkWrite([{ updateOne: { |')).slice(0, 2)).toEqual([
      'filter',
      'update'
    ])
    expect(labels(shell('db.users.bulkWrite([{ insertOne: { |'))).toEqual(['document'])
  })

  it('offers $out and $merge only at the end of a shell aggregate', () => {
    const last = shell('db.users.aggregate([{ $match: {} }, { |')
    expect(item(last, '$out')?.sortText.startsWith('e')).toBe(true)
    expect(item(last, '$merge')?.sortText.startsWith('e')).toBe(true)
    expect(item(shell('db.users.aggregate([|'), '$out')).toBeDefined()
    expect(item(shell('db.users.aggregate([{ | }, { $limit: 1 }])'), '$out')).toBeUndefined()
    expect(
      item(shell('db.users.aggregate([{ $lookup: { from: "orders", pipeline: [{ |'), '$merge')
    ).toBeUndefined()
  })

  it('offers only the update pipeline stages in an update pipeline', () => {
    const stages = [...UPDATE_PIPELINE_STAGES].sort()
    expect(labels(shell('db.users.updateOne({}, [|')).sort()).toEqual(stages)
    expect(labels(shell('db.users.updateOne({}, [{ $set: {} }, { |')).sort()).toEqual(stages)
  })

  it('opens on the trigger characters of update and bulkWrite slots', () => {
    const opens = (marked: string, c: string) =>
      shell(marked, { trigger: char(c) }).items.length > 0
    expect(opens('db.users.updateOne({}, {|', '{')).toBe(true)
    expect(opens('db.users.bulkWrite([|', '[')).toBe(true)
    expect(opens('db.users.updateOne({}, { $inc: { age: | } })', ' ')).toBe(true)
    expect(opens('db.users.updateOne({}, { $inc: { age: |1 } })', ' ')).toBe(false)
    expect(opens('db.users.insertOne({ status: | })', ' ')).toBe(true)
    expect(opens('db.users.insertOne({ missing: | })', ' ')).toBe(false)
  })
})

describe('suggest: trigger gating', () => {
  it('ignores a space that does not follow a colon', () => {
    expect(run('{ a: 1, |', 'filter', { trigger: char(' ') }).items).toEqual([])
  })

  it('responds to a space or colon after a colon at a value position', () => {
    expect(run('{ _id: |', 'filter', { trigger: char(' ') }).items.length).toBeGreaterThan(0)
    expect(run('{ _id:|', 'filter', { trigger: char(':') }).items.length).toBeGreaterThan(0)
  })

  it('stays quiet on a typed colon or space when a value already follows', () => {
    expect(run('{ status: |"active" }', 'filter', { trigger: char(' ') }).items).toEqual([])
    expect(run('{ age: { $gt: |5 } }', 'filter', { trigger: char(' ') }).items).toEqual([])
    expect(run('{ age:|-1 }', 'sort', { trigger: char(':') }).items).toEqual([])
    expect(run('{ "age": |5 }', 'document', { trigger: char(' ') }).items).toEqual([])
    expect(run('{ "flag": |true }', 'document', { trigger: char(' ') }).items).toEqual([])
  })

  it('opens on a typed colon or space in an empty value slot', () => {
    const fits = (marked: string, kind: EditorKind, c: string) =>
      run(marked, kind, { trigger: char(c) }).items.length > 0
    expect(fits('{ status: | }', 'filter', ' ')).toBe(true)
    expect(fits('{ status:|}', 'filter', ':')).toBe(true)
    expect(fits('{\n  status: |\n}', 'filter', ' ')).toBe(true)
    expect(fits('db.users.find({ status: | })', 'shell', ' ')).toBe(true)
    expect(fits('{ age: { $exists: | } }', 'filter', ' ')).toBe(true)
    expect(fits('{ age: | }', 'sort', ' ')).toBe(true)
  })

  it('does not pop up constructors of an unknown field on a typed colon or space', () => {
    expect(run('{ missing: | }', 'filter', { trigger: char(' ') }).items).toEqual([])
    expect(run('db.users.find({ missing: | })', 'shell', { trigger: char(' ') }).items).toEqual([])
    expect(run('{ missing: | }').items.length).toBeGreaterThan(0)
  })

  it('never triggers on commas or letters', () => {
    expect(run('{ a: 1,|', 'filter', { trigger: char(',') }).items).toEqual([])
    expect(run('{ n|', 'filter', { trigger: char('n') }).items).toEqual([])
  })

  it('triggers $ at keys and expression values', () => {
    expect(run('{ $|', 'filter', { trigger: char('$') }).items.length).toBeGreaterThan(0)
    expect(run('{ a: $|', 'filter', { trigger: char('$') }).items).toEqual([])
    expect(
      run('[{ $group: { _id: "$|" } }]', 'pipeline', { trigger: char('$') }).items.length
    ).toBeGreaterThan(0)
  })

  it('triggers quotes at keys and string-valued positions only', () => {
    expect(run('{ "|" }', 'filter', { trigger: char('"') }).items.length).toBeGreaterThan(0)
    expect(run('{ status: "|" }', 'filter', { trigger: char('"') }).items.length).toBeGreaterThan(0)
    expect(run('{ age: "|" }', 'filter', { trigger: char('"') }).items).toEqual([])
  })

  it('triggers dots after dotted keys and in shell chains', () => {
    expect(run('{ address.|', 'filter', { trigger: char('.') }).items.length).toBeGreaterThan(0)
    expect(run('db.users.|', 'shell', { trigger: char('.') }).items.length).toBeGreaterThan(0)
  })

  it('triggers [ only for stage elements and array values', () => {
    expect(run('[|]', 'pipeline', { trigger: char('[') }).items.length).toBeGreaterThan(0)
    expect(
      run('{ _id: { $in: [|] } }', 'filter', { trigger: char('[') }).items.length
    ).toBeGreaterThan(0)
    expect(run('{ a: [|] }', 'filter', { trigger: char('{') }).items).toEqual([])
  })

  it('limits the document editor to quotes at keys and colons at known empty values', () => {
    expect(run('{ $|', 'document', { trigger: char('$') }).items).toEqual([])
    expect(run('{ "|" }', 'document', { trigger: char('"') }).items.length).toBeGreaterThan(0)
    expect(run('{ status:|', 'document', { trigger: char(':') }).items.length).toBeGreaterThan(0)
    expect(run('{ missing:|', 'document', { trigger: char(':') }).items).toEqual([])
    expect(run('{ status: | 5 }', 'document', { trigger: char(' ') }).items).toEqual([])
  })

  it('always responds to an explicit invoke', () => {
    expect(run('{ missing: |', 'document').items.length).toBeGreaterThan(0)
  })
})
