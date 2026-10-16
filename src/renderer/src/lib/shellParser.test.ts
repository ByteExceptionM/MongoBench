import { describe, expect, it } from 'vitest'
import { MAX_INSERT_DOCUMENTS, WRITE_METHODS } from '@shared/types'
import {
  formatShellCommand,
  parseShellCommand,
  shellCollectionAccessor,
  SHELL_AGGREGATE_CURSOR_METHODS,
  SHELL_COLLECTION_METHODS,
  SHELL_CURSOR_METHODS,
  SHELL_READ_METHODS,
  writeConfirmation,
  writeTargetName,
  type ShellCommand
} from './shellParser'

const parseOk = (input: string): ShellCommand => {
  const r = parseShellCommand(input)
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.error}`)
  return r.command
}

const parseError = (input: string): { error: string; offset: number } => {
  const r = parseShellCommand(input)
  if (r.ok) throw new Error(`expected an error for ${input}`)
  return { error: r.error, offset: r.offset }
}

describe('parseShellCommand', () => {
  it('parses a bare find()', () => {
    expect(parseOk('db.users.find()')).toEqual({
      coll: 'users',
      op: { kind: 'find', filter: '{}', projection: null, sort: null, skip: 0, limit: null }
    })
  })

  it('parses find with filter and projection', () => {
    const { op } = parseOk('db.orders.find({ status: "active" }, { _id: 0, total: 1 })')
    expect(op.kind).toBe('find')
    if (op.kind !== 'find') return
    expect(JSON.parse(op.filter)).toEqual({ status: 'active' })
    expect(op.projection && JSON.parse(op.projection)).toEqual({ _id: 0, total: 1 })
  })

  it('treats an empty projection as none', () => {
    const { op } = parseOk('db.orders.find({}, {})')
    expect(op.kind === 'find' && op.projection).toBeNull()
  })

  it('parses find with chained .sort.skip.limit', () => {
    const { op } = parseOk('db.users.find({}).sort({ createdAt: -1 }).skip(20).limit(10)')
    if (op.kind !== 'find') throw new Error('expected find')
    expect(JSON.parse(op.sort!)).toEqual({ createdAt: -1 })
    expect(op.skip).toBe(20)
    expect(op.limit).toBe(10)
  })

  it('reads .limit(0) as no limit', () => {
    const { op } = parseOk('db.users.find().limit(0)')
    expect(op.kind === 'find' && op.limit).toBeNull()
  })

  it('accepts .projection() and the no-op .toArray() / .pretty()', () => {
    const { op } = parseOk('db.users.find({ a: 1 }).projection({ name: 1 }).pretty().toArray()')
    if (op.kind !== 'find') throw new Error('expected find')
    expect(op.projection && JSON.parse(op.projection)).toEqual({ name: 1 })
  })

  it('parses aggregate with a pipeline and flags reshaping output', () => {
    const { op } = parseOk(
      'db.events.aggregate([{ $match: { type: "click" } }, { $count: "n" }]).toArray()'
    )
    if (op.kind !== 'aggregate') throw new Error('expected aggregate')
    expect(JSON.parse(op.pipeline)).toEqual([{ $match: { type: 'click' } }, { $count: 'n' }])
    expect(op.documentPreserving).toBe(false)
  })

  it('flags $match-only aggregations as document-preserving', () => {
    const { op } = parseOk('db.events.aggregate([{ $match: { a: 1 } }, { $limit: 5 }])')
    expect(op.kind === 'aggregate' && op.documentPreserving).toBe(true)
  })

  it('parses findOne with filter and projection', () => {
    expect(parseOk('db.x.findOne({ id: 1 }, { name: 1 })')).toEqual({
      coll: 'x',
      op: { kind: 'findOne', filter: '{"id":1}', projection: '{"name":1}' }
    })
    expect(parseOk('db.x.findOne()').op).toEqual({
      kind: 'findOne',
      filter: '{}',
      projection: null
    })
  })

  it('parses the count methods with their filters', () => {
    expect(parseOk('db.x.countDocuments({ active: true })').op).toEqual({
      kind: 'count',
      method: 'countDocuments',
      filter: '{"active":true}'
    })
    expect(parseOk('db.x.count()').op).toEqual({ kind: 'count', method: 'count', filter: '{}' })
    expect(parseOk('db.x.estimatedDocumentCount()').op).toEqual({
      kind: 'count',
      method: 'estimatedDocumentCount',
      filter: null
    })
  })

  it('parses distinct with and without a filter', () => {
    expect(parseOk("db.x.distinct('a')").op).toEqual({ kind: 'distinct', field: 'a', filter: null })
    expect(parseOk('db.x.distinct("a.b", { n: { $gt: 1 } })').op).toEqual({
      kind: 'distinct',
      field: 'a.b',
      filter: '{"n":{"$gt":1}}'
    })
  })

  it('handles ObjectId() inside args', () => {
    const { op } = parseOk('db.users.find({ _id: ObjectId("507f1f77bcf86cd799439011") })')
    expect(op.kind === 'find' && JSON.parse(op.filter)).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' }
    })
  })

  it('respects parens and quotes inside strings and regexes', () => {
    const a = parseOk('db.x.find({ msg: "a) ) (" })').op
    expect(a.kind === 'find' && JSON.parse(a.filter)).toEqual({ msg: 'a) ) (' })
    const b = parseOk('db.x.find({ name: /a)/ })').op
    expect(b.kind === 'find' && JSON.parse(b.filter)).toEqual({
      name: { $regularExpression: { pattern: 'a)', options: '' } }
    })
    const c = parseOk("db.x.find({ name: /it's/i })").op
    expect(c.kind === 'find' && JSON.parse(c.filter)).toEqual({
      name: { $regularExpression: { pattern: "it's", options: 'i' } }
    })
  })

  it('ignores leading, inline and trailing comments', () => {
    const command = parseOk(`// don't panic
      db.x.find({ /* inline */ a: 1 }) // trailing
      /* block */`)
    expect(command).toEqual({
      coll: 'x',
      op: { kind: 'find', filter: '{"a":1}', projection: null, sort: null, skip: 0, limit: null }
    })
  })

  it('accepts a trailing semicolon but only one command', () => {
    expect(parseOk('db.x.find();').coll).toBe('x')
    const input = 'db.x.find(); db.y.find()'
    expect(parseError(input)).toEqual({
      error: 'Only one command per run',
      offset: input.indexOf('db.y')
    })
  })

  it('accepts whitespace and newlines anywhere', () => {
    const command = parseOk(`
      db
        .users
        .find({
          status: "active"
        })
        .limit(5)
    `)
    expect(command.coll).toBe('users')
    expect(command.op.kind === 'find' && command.op.limit).toBe(5)
  })

  it('addresses collections through getCollection, brackets and dotted names', () => {
    expect(parseOk("db.getCollection('my-coll').find()").coll).toBe('my-coll')
    expect(parseOk('db["my-coll"].countDocuments()').coll).toBe('my-coll')
    expect(parseOk('db["a b"].aggregate([])').coll).toBe('a b')
    expect(parseOk('db.a.b.find()').coll).toBe('a.b')
    expect(parseOk('db.getCollection("player-data").find({ a: 1 }).limit(5)')).toEqual({
      coll: 'player-data',
      op: { kind: 'find', filter: '{"a":1}', projection: null, sort: null, skip: 0, limit: 5 }
    })
  })

  it('rejects empty collection names', () => {
    expect(parseError("db.getCollection('').find()").error).toBe(
      'Collection name must not be empty'
    )
    expect(parseError('db[""].find()').error).toBe('Collection name must not be empty')
  })

  it('points names that are not identifiers at getCollection', () => {
    for (const input of ['db.player-data.find()', 'db.2024_logs.find()', 'db.logs.2024.find()']) {
      expect(parseError(input).error, input).toMatch(/db\.getCollection\("name"\)/)
    }
    expect(parseError('db.player-data.find()').offset).toBe('db.player'.length)
  })

  it('rejects database-level calls', () => {
    expect(parseError('db.getSiblingDB("admin").users.find()').error).toBe(
      "`db.getSiblingDB()` isn't supported; use db.<collection>.<method>(…)"
    )
    expect(parseError('db.runCommand({ ping: 1 })').error).toMatch(
      /`db\.runCommand\(\)` isn't supported/
    )
  })

  it('points legacy write methods at their replacements', () => {
    for (const [method, replacement] of [
      ['insert', 'insertOne or insertMany'],
      ['update', 'updateOne, updateMany or replaceOne'],
      ['remove', 'deleteOne or deleteMany'],
      ['save', 'insertOne, or replaceOne with upsert: true'],
      ['findAndModify', 'findOneAndUpdate, findOneAndReplace or findOneAndDelete']
    ] as const) {
      expect(parseError(`db.x.${method}({})`), method).toEqual({
        error: `\`${method}()\` is a legacy method; use ${replacement}`,
        offset: 'db.x.'.length
      })
    }
  })

  it('points collection administration at the explorer', () => {
    for (const [method, item] of [
      ['drop', 'Drop…'],
      ['createIndex', 'Indexes…'],
      ['createIndexes', 'Indexes…'],
      ['dropIndex', 'Indexes…'],
      ['dropIndexes', 'Indexes…'],
      ['renameCollection', 'Rename…']
    ] as const) {
      expect(parseError(`db.x.${method}()`), method).toEqual({
        error: `\`${method}()\` isn't supported here; use ${item} in the explorer's collection menu`,
        offset: 'db.x.'.length
      })
    }
  })

  it('rejects unknown methods and lists the supported ones', () => {
    expect(parseError('db.x.mapReduce()').error).toBe(
      `Unsupported method \`mapReduce\`. Supported: ${SHELL_COLLECTION_METHODS.join(', ')}.`
    )
    expect(parseError('db.x.toString()').error).toMatch(/^Unsupported method `toString`/)
  })

  it('runs the read methods and then every write method', () => {
    expect(SHELL_COLLECTION_METHODS.slice(-WRITE_METHODS.length)).toEqual([...WRITE_METHODS])
    expect(SHELL_COLLECTION_METHODS.slice(0, 2)).toEqual(['find', 'findOne'])
  })

  it('lists as read methods exactly the methods that are not write methods', () => {
    expect(SHELL_READ_METHODS).toEqual([
      'find',
      'findOne',
      'aggregate',
      'countDocuments',
      'count',
      'estimatedDocumentCount',
      'distinct'
    ])
    expect(
      SHELL_READ_METHODS.filter((m) => (WRITE_METHODS as readonly string[]).includes(m))
    ).toEqual([])
  })

  it('rejects unsupported cursor methods at their position', () => {
    const input = 'db.x.find().hint({ a: 1 })'
    expect(parseError(input)).toEqual({
      error: `Unsupported cursor method .hint(). Supported: ${SHELL_CURSOR_METHODS.join(', ')}`,
      offset: input.indexOf('hint')
    })
  })

  it('points a cursor .count() at countDocuments', () => {
    expect(parseError('db.users.find({ a: 1 }).count()').error).toBe(
      "Cursor .count() isn't supported; use db.users.countDocuments(filter)"
    )
  })

  it('rejects chained calls after non-cursor methods', () => {
    expect(parseError('db.x.aggregate([]).limit(5)').error).toBe(
      "`.limit()` can't follow aggregate(…)"
    )
    expect(parseError('db.x.findOne({}).sort({ a: 1 })').error).toBe(
      "`.sort()` can't follow findOne(…)"
    )
    expect(parseError('db.x.countDocuments().skip(3)').error).toBe(
      "`.skip()` can't follow countDocuments(…)"
    )
    expect(parseError('db.x.distinct("a").toArray()').error).toBe(
      "`.toArray()` can't follow distinct(…)"
    )
  })

  it('rejects invalid skip and limit values', () => {
    for (const input of [
      'db.x.find().limit(1.5)',
      'db.x.find().limit(-1)',
      'db.x.find().limit(NumberInt(5))',
      'db.x.find().limit("5")',
      'db.x.find().limit()',
      'db.x.find().skip(-1)'
    ]) {
      expect(parseError(input).error, input).toMatch(
        /expects (a non-negative integer|one argument)/
      )
    }
  })

  it('rejects duplicate chained calls', () => {
    expect(parseError('db.x.find().limit(1).limit(2)').error).toBe('.limit() specified twice')
  })

  it('rejects a projection given twice', () => {
    const input = 'db.x.find({}, { a: 1 }).projection({ b: 1 })'
    expect(parseError(input)).toEqual({
      error: 'Projection given twice: pass it to find(…) or .projection(…), not both',
      offset: input.indexOf('projection(')
    })
  })

  it('checks argument counts and types', () => {
    const tooMany = 'db.x.find({}, {}, {})'
    expect(parseError(tooMany)).toEqual({
      error: "Too many arguments; options aren't supported. Use find(filter, projection)",
      offset: tooMany.lastIndexOf('{}')
    })
    expect(parseError('db.x.estimatedDocumentCount(1)').error).toBe(
      "Too many arguments; options aren't supported. Use estimatedDocumentCount()"
    )
    expect(parseError('db.x.aggregate([], { allowDiskUse: true })').error).toBe(
      "Too many arguments; options aren't supported. Use aggregate(pipeline)"
    )
    expect(parseError('db.x.find([])').error).toBe('find() filter must be an object')
    expect(parseError('db.x.countDocuments(5)').error).toBe(
      'countDocuments() filter must be an object'
    )
    expect(parseError('db.x.distinct(1)').error).toBe('distinct() expects a field name string')
    expect(parseError('db.x.distinct()').error).toBe('distinct() expects a field name string')
    expect(parseError('db.x.find().toArray(1)').error).toBe('.toArray() takes no arguments')
  })

  it('validates aggregate pipelines', () => {
    const input = 'db.x.aggregate([{ $out: "copy" }, { $match: {} }])'
    expect(parseError(input)).toEqual({
      error: 'Stage 1: $out must be the last stage',
      offset: input.indexOf('[')
    })
    expect(parseError('db.x.aggregate({ $match: {} })').error).toBe(
      'Pipeline must be an array of stages, e.g. [{ $match: { … } }]'
    )
    expect(parseError('db.x.aggregate()').error).toBe(
      'aggregate() expects the pipeline array, e.g. aggregate([{ $match: { … } }])'
    )
  })

  it('rejects a change stream pipeline', () => {
    const input = 'db.x.aggregate([{ $changeStream: {} }])'
    expect(parseError(input)).toEqual({
      error: 'Stage 1: $changeStream never ends, so it cannot run here',
      offset: input.indexOf('[')
    })
  })

  it('accepts every aggregate cursor method after aggregate(…)', () => {
    for (const method of SHELL_AGGREGATE_CURSOR_METHODS) {
      expect(parseOk(`db.x.aggregate([]).${method}()`).op.kind, method).toBe('aggregate')
    }
  })

  it('rejects malformed input', () => {
    expect(parseError('foo bar').error).toBe('Expected `db.<collection>.<method>(…)`')
    expect(parseError('').error).toBe('Expected `db.<collection>.<method>(…)`')
    expect(parseError('db.users').error).toBe('Expected `db.<collection>.<method>(…)`')
    expect(parseShellCommand('db.x.find(').ok).toBe(false)
    expect(parseShellCommand('db.x.find()garbage').ok).toBe(false)
    expect(parseShellCommand('db.x.find({}, {}').ok).toBe(false)
  })

  it('reports tokenizer errors at the offending character', () => {
    expect(parseError('db.x.find({ a: # })').offset).toBe('db.x.find({ a: '.length)
  })
})

describe('parseShellCommand write commands', () => {
  const writes = { db: null, coll: 'users' }

  it('parses insertOne with and without options', () => {
    expect(parseOk('db.users.insertOne({ name: "ada", n: 5.0 })')).toEqual({
      coll: 'users',
      op: {
        kind: 'write',
        write: { method: 'insertOne', document: '{"name":"ada","n":{"$numberDouble":"5.0"}}' },
        writes
      }
    })
    expect(parseOk('db.users.insertOne({}, { bypassDocumentValidation: true })').op).toEqual({
      kind: 'write',
      write: {
        method: 'insertOne',
        document: '{}',
        options: '{"bypassDocumentValidation":true}'
      },
      writes
    })
  })

  it('keeps shell helper values as EJSON', () => {
    const { op } = parseOk(
      'db.users.insertOne({ _id: ObjectId("507f1f77bcf86cd799439011"), at: ISODate("2024-01-01T00:00:00.000Z"), n: NumberLong("5") })'
    )
    expect(op.kind === 'write' && op.write).toEqual({
      method: 'insertOne',
      document:
        '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"at":{"$date":"2024-01-01T00:00:00.000Z"},"n":{"$numberLong":"5"}}'
    })
  })

  it('parses insertMany', () => {
    expect(parseOk('db.users.insertMany([{ a: 1 }, { a: 2 }], { ordered: false })').op).toEqual({
      kind: 'write',
      write: {
        method: 'insertMany',
        documents: ['{"a":1}', '{"a":2}'],
        options: '{"ordered":false}'
      },
      writes
    })
  })

  it('parses updateOne, updateMany and findOneAndUpdate', () => {
    expect(
      parseOk('db.users.updateOne({ _id: 1 }, { $set: { a: 1 } }, { upsert: true })').op
    ).toEqual({
      kind: 'write',
      write: {
        method: 'updateOne',
        filter: '{"_id":1}',
        update: '{"$set":{"a":1}}',
        options: '{"upsert":true}'
      },
      writes
    })
    expect(
      parseOk('db.users.updateMany({}, [{ $set: { total: { $add: ["$a", "$b"] } } }])').op
    ).toEqual({
      kind: 'write',
      write: {
        method: 'updateMany',
        filter: '{}',
        update: '[{"$set":{"total":{"$add":["$a","$b"]}}}]'
      },
      writes
    })
    expect(
      parseOk(
        'db.users.findOneAndUpdate({ _id: 1 }, { $inc: { n: 1 } }, { returnNewDocument: true, projection: { n: 1 } })'
      ).op
    ).toEqual({
      kind: 'write',
      write: {
        method: 'findOneAndUpdate',
        filter: '{"_id":1}',
        update: '{"$inc":{"n":1}}',
        options: '{"returnNewDocument":true,"projection":{"n":1}}'
      },
      writes
    })
  })

  it('parses arrayFilters options', () => {
    const { op } = parseOk(
      'db.users.updateMany({}, { $set: { "items.$[e].ok": true } }, { arrayFilters: [{ "e.n": { $gt: 1 } }] })'
    )
    expect(op.kind === 'write' && op.write).toEqual({
      method: 'updateMany',
      filter: '{}',
      update: '{"$set":{"items.$[e].ok":true}}',
      options: '{"arrayFilters":[{"e.n":{"$gt":1}}]}'
    })
  })

  it('parses replaceOne and findOneAndReplace', () => {
    expect(parseOk('db.users.replaceOne({ _id: 1 }, { name: "x" }, { upsert: true })').op).toEqual({
      kind: 'write',
      write: {
        method: 'replaceOne',
        filter: '{"_id":1}',
        replacement: '{"name":"x"}',
        options: '{"upsert":true}'
      },
      writes
    })
    expect(
      parseOk(
        'db.users.findOneAndReplace({ _id: 1 }, { a: 1 }, { returnDocument: "after", sort: { a: 1 } })'
      ).op
    ).toEqual({
      kind: 'write',
      write: {
        method: 'findOneAndReplace',
        filter: '{"_id":1}',
        replacement: '{"a":1}',
        options: '{"returnDocument":"after","sort":{"a":1}}'
      },
      writes
    })
  })

  it('parses deleteOne, deleteMany and findOneAndDelete', () => {
    expect(parseOk('db.users.deleteOne({ a: 1 })').op).toEqual({
      kind: 'write',
      write: { method: 'deleteOne', filter: '{"a":1}' },
      writes
    })
    expect(parseOk('db.users.deleteMany({ status: "old" }, { hint: "status_1" })').op).toEqual({
      kind: 'write',
      write: { method: 'deleteMany', filter: '{"status":"old"}', options: '{"hint":"status_1"}' },
      writes
    })
    expect(parseOk('db.users.findOneAndDelete({ a: 1 }, { sort: { at: 1 } })').op).toEqual({
      kind: 'write',
      write: { method: 'findOneAndDelete', filter: '{"a":1}', options: '{"sort":{"at":1}}' },
      writes
    })
  })

  it('parses bulkWrite', () => {
    const { op } = parseOk(`db.users.bulkWrite([
      { insertOne: { document: { a: 1 } } },
      { updateMany: { filter: {}, update: { $set: { b: 1 } }, upsert: true } },
      { deleteOne: { filter: { a: 1 } } }
    ], { ordered: false })`)
    expect(op).toEqual({
      kind: 'write',
      write: {
        method: 'bulkWrite',
        operations:
          '[{"insertOne":{"document":{"a":1}}},{"updateMany":{"filter":{},"update":{"$set":{"b":1}},"upsert":true}},{"deleteOne":{"filter":{"a":1}}}]',
        options: '{"ordered":false}'
      },
      writes
    })
  })

  it('writes to the collection the command addresses', () => {
    expect(parseOk('db.getCollection("player-data").deleteOne({ a: 1 })')).toEqual({
      coll: 'player-data',
      op: {
        kind: 'write',
        write: { method: 'deleteOne', filter: '{"a":1}' },
        writes: { db: null, coll: 'player-data' }
      }
    })
  })

  it('reports a missing argument at the method', () => {
    for (const [input, error] of [
      ['db.x.insertOne()', 'Missing document. Use insertOne(document, options)'],
      ['db.x.insertMany()', 'Missing documents. Use insertMany(documents, options)'],
      ['db.x.updateOne({ a: 1 })', 'Missing update. Use updateOne(filter, update, options)'],
      ['db.x.replaceOne({})', 'Missing replacement. Use replaceOne(filter, replacement, options)'],
      ['db.x.deleteMany()', 'Missing filter. Use deleteMany(filter, options)'],
      ['db.x.findOneAndDelete()', 'Missing filter. Use findOneAndDelete(filter, options)'],
      ['db.x.bulkWrite()', 'Missing operations. Use bulkWrite(operations, options)']
    ] as const) {
      expect(parseError(input), input).toEqual({ error, offset: 'db.x.'.length })
    }
  })

  it('reports surplus arguments at the first one', () => {
    const input = 'db.x.deleteOne({}, {}, {})'
    expect(parseError(input)).toEqual({
      error: 'Too many arguments. Use deleteOne(filter, options)',
      offset: input.lastIndexOf('{}')
    })
  })

  it('reports invalid documents at their argument', () => {
    for (const [input, arg, error] of [
      ['db.x.insertOne([{ a: 1 }])', '[', 'Each inserted document must be an object'],
      ['db.x.insertMany({ a: 1 })', '{', 'insertMany() expects a non-empty array of documents'],
      ['db.x.insertMany([])', '[', 'insertMany() expects a non-empty array of documents'],
      ['db.x.insertMany([{}, 5])', '[', 'Each inserted document must be an object'],
      ['db.x.deleteOne("a")', '"', 'deleteOne() filter must be an object'],
      ['db.x.updateOne([], { $set: { a: 1 } })', '[', 'updateOne() filter must be an object']
    ] as const) {
      expect(parseError(input), input).toEqual({ error, offset: input.indexOf(arg) })
    }
  })

  it('limits insertMany to one request worth of documents', () => {
    const docs = (n: number): string => `db.x.insertMany([${Array(n).fill('{}').join(',')}])`
    expect(parseShellCommand(docs(MAX_INSERT_DOCUMENTS)).ok).toBe(true)
    expect(parseError(docs(MAX_INSERT_DOCUMENTS + 1))).toEqual({
      error: 'insertMany() takes at most 10,000 documents per run',
      offset: docs(1).indexOf('[')
    })
  })

  it('checks updates and replacements with the shared rules', () => {
    for (const [input, error] of [
      [
        'db.x.updateOne({ a: 1 }, { a: 2 })',
        'The update needs operators such as $set; replaceOne replaces whole documents'
      ],
      ['db.x.updateMany({}, {})', 'The update needs at least one operator such as $set'],
      [
        'db.x.findOneAndUpdate({}, [{ $match: {} }])',
        'Update pipeline stage 1 must be one of $addFields, $set, $project, $unset, $replaceRoot, $replaceWith'
      ],
      [
        'db.x.replaceOne({}, { $set: { a: 1 } })',
        "A replacement can't contain update operators; updateOne applies operators"
      ],
      ['db.x.findOneAndReplace({}, [])', 'The replacement must be a document']
    ] as const) {
      expect(parseError(input), input).toEqual({ error, offset: input.indexOf(', ') + 2 })
    }
  })

  it('checks bulkWrite operations with the shared rules', () => {
    const input = 'db.x.bulkWrite([{ updateOne: { filter: {} } }])'
    expect(parseError(input)).toEqual({
      error: 'bulkWrite() operation 1: updateOne needs "update"',
      offset: input.indexOf('[')
    })
    expect(parseError('db.x.bulkWrite([])').error).toBe(
      'bulkWrite() expects a non-empty array of operations'
    )
  })

  it('checks options at their argument', () => {
    for (const [input, options, error] of [
      [
        'db.x.insertOne({}, { ordered: true })',
        '{ ordered',
        'insertOne() options: unknown option "ordered"; supported: bypassDocumentValidation'
      ],
      [
        'db.x.updateOne({}, { $set: { a: 1 } }, { upsert: "yes" })',
        '{ upsert',
        'updateOne() options: "upsert" must be true or false'
      ],
      ['db.x.deleteMany({}, true)', 'true', 'deleteMany() options must be an object'],
      [
        'db.x.findOneAndUpdate({}, { $set: { a: 1 } }, { returnDocument: "new" })',
        '{ returnDocument',
        'findOneAndUpdate() options: "returnDocument" must be "before" or "after"'
      ],
      [
        'db.x.findOneAndReplace({}, {}, { returnDocument: "after", returnNewDocument: true })',
        '{ returnDocument',
        'findOneAndReplace() options: use returnDocument or returnNewDocument, not both'
      ],
      [
        'db.x.findOneAndDelete({}, { returnDocument: "after" })',
        '{ returnDocument',
        'findOneAndDelete() options: unknown option "returnDocument"; supported: collation, hint, let, projection, sort'
      ]
    ] as const) {
      expect(parseError(input), input).toEqual({ error, offset: input.indexOf(options) })
    }
  })

  it('checks arguments in source order', () => {
    const input = 'db.x.updateOne({}, { a: 1 }, { upsert: "yes" })'
    expect(parseError(input).offset).toBe(input.indexOf('{ a'))
  })

  it('rejects chained calls after a write', () => {
    const input = 'db.x.insertOne({}).toArray()'
    expect(parseError(input)).toEqual({
      error: "`.toArray()` can't follow insertOne(…)",
      offset: input.indexOf('toArray')
    })
  })

  it('parses an aggregation ending in $out as a write to that collection', () => {
    expect(parseOk('db.users.aggregate([{ $match: { a: 1 } }, { $out: "archive" }])')).toEqual({
      coll: 'users',
      op: {
        kind: 'write',
        write: { method: 'aggregate', pipeline: '[{"$match":{"a":1}},{"$out":"archive"}]' },
        writes: { db: null, coll: 'archive' }
      }
    })
  })

  it('reads the output collection of every $out and $merge form', () => {
    for (const [stage, target] of [
      ['{ $out: { db: "reports", coll: "daily" } }', { db: 'reports', coll: 'daily' }],
      ['{ $merge: "totals" }', { db: null, coll: 'totals' }],
      ['{ $merge: { into: "totals", on: "_id" } }', { db: null, coll: 'totals' }],
      [
        '{ $merge: { into: { db: "reports", coll: "totals" } } }',
        { db: 'reports', coll: 'totals' }
      ],
      ['{ $merge: { into: { coll: "totals" } } }', { db: null, coll: 'totals' }]
    ] as const) {
      const { op } = parseOk(`db.users.aggregate([${stage}])`)
      expect(op.kind === 'write' && op.writes, stage).toEqual(target)
    }
  })

  it('allows the aggregate cursor methods after an aggregation that writes', () => {
    expect(parseOk('db.users.aggregate([{ $out: "copy" }]).toArray()').op.kind).toBe('write')
  })

  it('rejects a $out or $merge without an output collection', () => {
    for (const [stage, error] of [
      ['{ $out: 5 }', 'Stage 2: $out must name the output collection, e.g. { $out: "name" }'],
      ['{ $out: "" }', 'Stage 2: $out must name the output collection, e.g. { $out: "name" }'],
      [
        '{ $out: { db: "reports" } }',
        'Stage 2: $out must name the output collection, e.g. { $out: "name" }'
      ],
      [
        '{ $merge: { on: "_id" } }',
        'Stage 2: $merge must name the output collection, e.g. { $merge: { into: "name" } }'
      ],
      [
        '{ $merge: { into: { db: 5, coll: "t" } } }',
        'Stage 2: $merge must name the output collection, e.g. { $merge: { into: "name" } }'
      ]
    ] as const) {
      const input = `db.users.aggregate([{ $match: {} }, ${stage}])`
      expect(parseError(input), stage).toEqual({ error, offset: input.indexOf('[') })
    }
  })
})

describe('writeConfirmation', () => {
  const confirmation = (input: string): string | null => writeConfirmation(parseOk(input), 'app')

  it('asks before updateMany or deleteMany with an empty filter', () => {
    expect(confirmation('db.users.updateMany({}, { $set: { a: 1 } })')).toBe(
      'updateMany with an empty filter updates every document in users.'
    )
    expect(confirmation('db.getCollection("player-data").deleteMany({})')).toBe(
      'deleteMany with an empty filter deletes every document in player-data.'
    )
  })

  it('runs filtered and single-document writes right away', () => {
    for (const input of [
      'db.users.updateMany({ a: 1 }, { $set: { a: 2 } })',
      'db.users.deleteMany({ a: 1 })',
      'db.users.updateOne({}, { $set: { a: 1 } })',
      'db.users.deleteOne({})',
      'db.users.findOneAndDelete({})',
      'db.users.replaceOne({}, { a: 1 })',
      'db.users.insertMany([{ a: 1 }])',
      'db.users.aggregate([{ $merge: "totals" }])'
    ]) {
      expect(confirmation(input), input).toBeNull()
    }
  })

  it('asks before a bulkWrite with an unfiltered updateMany or deleteMany', () => {
    expect(
      confirmation(
        'db.users.bulkWrite([{ deleteMany: { filter: { a: 1 } } }, { deleteMany: { filter: {} } }])'
      )
    ).toBe(
      'bulkWrite operation 2: deleteMany with an empty filter deletes every document in users.'
    )
    expect(
      confirmation(
        'db.users.bulkWrite([{ updateMany: { filter: {}, update: { $set: { a: 1 } } } }])'
      )
    ).toBe(
      'bulkWrite operation 1: updateMany with an empty filter updates every document in users.'
    )
    expect(
      confirmation(
        'db.users.bulkWrite([{ deleteOne: { filter: {} } }, { updateMany: { filter: { a: 1 }, update: { $set: { a: 2 } } } }])'
      )
    ).toBeNull()
  })

  it('asks before $out replaces a collection', () => {
    expect(confirmation('db.users.aggregate([{ $match: {} }, { $out: "archive" }])')).toBe(
      '$out replaces the collection archive with the pipeline output.'
    )
    expect(confirmation('db.users.aggregate([{ $out: { db: "reports", coll: "daily" } }])')).toBe(
      '$out replaces the collection reports.daily with the pipeline output.'
    )
    expect(confirmation('db.users.aggregate([{ $out: { db: "app", coll: "daily" } }])')).toBe(
      '$out replaces the collection daily with the pipeline output.'
    )
  })

  it('never asks for reads', () => {
    expect(confirmation('db.users.find({})')).toBeNull()
    expect(confirmation('db.users.aggregate([{ $match: {} }])')).toBeNull()
  })
})

describe('writeTargetName', () => {
  it('names the database only when it is not the tab database', () => {
    expect(writeTargetName({ db: null, coll: 'daily' }, 'app')).toBe('daily')
    expect(writeTargetName({ db: 'app', coll: 'daily' }, 'app')).toBe('daily')
    expect(writeTargetName({ db: 'reports', coll: 'daily' }, 'app')).toBe('reports.daily')
  })
})

describe('shellCollectionAccessor', () => {
  it('uses dot access for identifier paths and getCollection otherwise', () => {
    expect(shellCollectionAccessor('users')).toBe('db.users')
    expect(shellCollectionAccessor('system.profile')).toBe('db.system.profile')
    expect(shellCollectionAccessor('$cmd')).toBe('db.$cmd')
    expect(shellCollectionAccessor('player-data')).toBe('db.getCollection("player-data")')
    expect(shellCollectionAccessor('2024_logs')).toBe('db.getCollection("2024_logs")')
    expect(shellCollectionAccessor('a..b')).toBe('db.getCollection("a..b")')
  })

  it('produces accessors the parser reads back', () => {
    for (const coll of ['users', 'system.profile', 'player-data', 'a b', 'getCollection', 'x"y']) {
      expect(parseOk(`${shellCollectionAccessor(coll)}.find()`).coll, coll).toBe(coll)
    }
  })
})

describe('formatShellCommand', () => {
  const options = { timezone: 'UTC', uuidEncoding: 'default' as const, indent: 2, printWidth: 80 }

  it('puts each chained call on its own line', () => {
    expect(
      formatShellCommand('db.users.find({a:1}).sort({createdAt:-1}).limit(10);', options)
    ).toBe('db.users.find({ a: 1 })\n  .sort({ createdAt: -1 })\n  .limit(10)')
  })

  it('hugs a pipeline that does not fit on the first line', () => {
    expect(
      formatShellCommand(
        'db.orders.aggregate([{$match:{status:"A"}},{$group:{_id:"$cust",n:{$sum:1}}}])',
        options
      )
    ).toBe(
      [
        'db.orders.aggregate([',
        '  { $match: { status: "A" } },',
        '  { $group: { _id: "$cust", n: { $sum: 1 } } }',
        '])'
      ].join('\n')
    )
  })

  it('indents a broken argument of a chained call', () => {
    const long = 'x'.repeat(70)
    expect(formatShellCommand(`db.c.find().sort({ ${long}: 1, b: -1 })`, options)).toBe(
      ['db.c.find()', '  .sort({', `    ${long}: 1,`, '    b: -1', '  })'].join('\n')
    )
  })

  it('keeps the accessor style', () => {
    expect(formatShellCommand("db['my-coll'].find( )", options)).toBe('db["my-coll"].find()')
    expect(formatShellCommand("db.getCollection('x').countDocuments()", options)).toBe(
      'db.getCollection("x").countDocuments()'
    )
    expect(formatShellCommand('db . a . b . find ( )', options)).toBe('db.a.b.find()')
  })

  it('preserves shell helpers and drops comments', () => {
    const input = `db.c.find({ // who
      _id: ObjectId("507f1f77bcf86cd799439011"), at: ISODate("2024-01-01T00:00:00.000Z"),
      n: NumberLong("5"), d: 5.0, re: /^a/i, u: JUUID("550e8400-e29b-41d4-a716-446655440000")
    })`
    expect(formatShellCommand(input, { ...options, uuidEncoding: 'java' })).toBe(
      [
        'db.c.find({',
        '  _id: ObjectId("507f1f77bcf86cd799439011"),',
        '  at: ISODate("2024-01-01T00:00:00.000Z"),',
        '  n: NumberLong("5"),',
        '  d: 5.0,',
        '  re: /^a/i,',
        '  u: JUUID("550e8400-e29b-41d4-a716-446655440000")',
        '})'
      ].join('\n')
    )
  })

  it('round-trips to the same command', () => {
    for (const input of [
      'db.users.find({ a: { $in: [1, 2.5, 3.0] }, b: /x\\/y/ }, { a: 1 }).sort({ b: -1 }).skip(5).limit(0)',
      'db["a b"].aggregate([{ $match: { at: { $gte: ISODate("2024-01-01T00:00:00.000Z") } } }, { $group: { _id: "$k", n: { $sum: 1 } } }]).toArray()',
      'db.getCollection("x").distinct("tags", { n: NumberDecimal("1.5") })',
      'db.c.findOne({ u: UUID("550e8400-e29b-41d4-a716-446655440000"), t: Timestamp(1700000000, 7) })'
    ]) {
      const formatted = formatShellCommand(input, options)
      expect(formatted, input).not.toBeNull()
      expect(parseShellCommand(formatted!), input).toEqual(parseShellCommand(input))
    }
  })

  it('formats write commands with their options', () => {
    expect(formatShellCommand('db.x.deleteMany({a:1},{hint:"a_1"})', options)).toBe(
      'db.x.deleteMany({ a: 1 }, { hint: "a_1" })'
    )
    expect(
      formatShellCommand(
        'db.users.updateMany({status:"old"},{$set:{archived:true,at:ISODate("2024-01-01T00:00:00.000Z")}},{upsert:true})',
        options
      )
    ).toBe(
      [
        'db.users.updateMany({ status: "old" }, {',
        '  $set: { archived: true, at: ISODate("2024-01-01T00:00:00.000Z") }',
        '}, { upsert: true })'
      ].join('\n')
    )
  })

  it('round-trips write commands', () => {
    for (const input of [
      'db.x.insertOne({ _id: ObjectId("507f1f77bcf86cd799439011"), n: NumberLong("5"), d: 1.0 }, { bypassDocumentValidation: true })',
      'db.x.insertMany([{ a: 1 }, { a: 2.5 }], { ordered: false })',
      'db.x.updateMany({}, [{ $set: { total: { $add: ["$a", "$b"] } } }])',
      'db["a b"].findOneAndUpdate({ _id: 1 }, { $inc: { n: 1 } }, { returnDocument: "after", projection: { n: 1 } })',
      'db.x.replaceOne({ _id: 1 }, { a: /x/i }, { upsert: true })',
      'db.x.bulkWrite([{ insertOne: { document: { a: 1 } } }, { deleteMany: { filter: { a: { $lt: 0 } } } }], { ordered: false })',
      'db.x.aggregate([{ $match: { a: 1 } }, { $merge: { into: { db: "r", coll: "t" }, on: "_id" } }])'
    ]) {
      const formatted = formatShellCommand(input, options)
      expect(formatted, input).not.toBeNull()
      expect(parseShellCommand(formatted!), input).toEqual(parseShellCommand(input))
    }
  })

  it('formats syntactically valid commands the shell would not run', () => {
    expect(formatShellCommand('db.x.remove({a:1})', options)).toBe('db.x.remove({ a: 1 })')
  })

  it('returns null for blank or invalid input', () => {
    expect(formatShellCommand('', options)).toBeNull()
    expect(formatShellCommand('   ', options)).toBeNull()
    expect(formatShellCommand('db.x.find(', options)).toBeNull()
    expect(formatShellCommand('{ a: 1 }', options)).toBeNull()
  })
})
