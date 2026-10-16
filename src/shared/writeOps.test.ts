import { describe, expect, it } from 'vitest'
import { WRITE_METHODS } from './types'
import {
  BULK_OPERATION_FIELDS,
  BULK_OPERATION_OPTIONS,
  BULK_WRITE_OPERATIONS,
  EXCLUSIVE_OPTIONS,
  UPDATE_PIPELINE_STAGES,
  WRITE_ARGUMENTS,
  WRITE_OPTIONS,
  bulkWriteError,
  filterError,
  insertDocumentError,
  isDocument,
  replacementError,
  updateError,
  writeOptionsError
} from './writeOps'

const STAGE_LIST = '$addFields, $set, $project, $unset, $replaceRoot, $replaceWith'

describe('UPDATE_PIPELINE_STAGES', () => {
  it('holds exactly the stages MongoDB allows in an update pipeline', () => {
    expect([...UPDATE_PIPELINE_STAGES]).toEqual([
      '$addFields',
      '$set',
      '$project',
      '$unset',
      '$replaceRoot',
      '$replaceWith'
    ])
  })
})

describe('BULK_WRITE_OPERATIONS', () => {
  it('lists the six operations bulkWrite accepts', () => {
    expect(BULK_WRITE_OPERATIONS).toEqual([
      'insertOne',
      'updateOne',
      'updateMany',
      'replaceOne',
      'deleteOne',
      'deleteMany'
    ])
  })
})

describe('WRITE_OPTIONS', () => {
  it('has an entry for every write method', () => {
    expect(Object.keys(WRITE_OPTIONS).sort()).toEqual([...WRITE_METHODS].sort())
  })

  it.each([
    ['insertOne', ['bypassDocumentValidation']],
    ['insertMany', ['ordered', 'bypassDocumentValidation']],
    [
      'updateOne',
      ['collation', 'hint', 'let', 'upsert', 'arrayFilters', 'bypassDocumentValidation']
    ],
    [
      'updateMany',
      ['collation', 'hint', 'let', 'upsert', 'arrayFilters', 'bypassDocumentValidation']
    ],
    ['replaceOne', ['collation', 'hint', 'let', 'upsert', 'bypassDocumentValidation']],
    ['deleteOne', ['collation', 'hint', 'let']],
    ['deleteMany', ['collation', 'hint', 'let']],
    [
      'findOneAndUpdate',
      [
        'collation',
        'hint',
        'let',
        'upsert',
        'arrayFilters',
        'bypassDocumentValidation',
        'projection',
        'sort',
        'returnDocument',
        'returnNewDocument'
      ]
    ],
    [
      'findOneAndReplace',
      [
        'collation',
        'hint',
        'let',
        'upsert',
        'bypassDocumentValidation',
        'projection',
        'sort',
        'returnDocument',
        'returnNewDocument'
      ]
    ],
    ['findOneAndDelete', ['collation', 'hint', 'let', 'projection', 'sort']],
    ['bulkWrite', ['ordered', 'bypassDocumentValidation']]
  ] as const)('%s accepts exactly %j', (method, keys) => {
    expect(Object.keys(WRITE_OPTIONS[method])).toEqual(keys)
  })
})

describe('isDocument', () => {
  it('accepts objects and rejects null, arrays and primitives', () => {
    expect([{}, { a: 1 }, null, [], 'x', 1].map(isDocument)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false
    ])
  })
})

describe('EXCLUSIVE_OPTIONS', () => {
  it('pairs returnDocument with returnNewDocument, which choose the same document', () => {
    expect(EXCLUSIVE_OPTIONS).toEqual([['returnDocument', 'returnNewDocument']])
  })
})

describe('WRITE_ARGUMENTS', () => {
  it('has an entry for every write method', () => {
    expect(Object.keys(WRITE_ARGUMENTS).sort()).toEqual([...WRITE_METHODS].sort())
  })

  it.each([
    ['insertOne', ['document']],
    ['insertMany', ['documents']],
    ['updateOne', ['filter', 'update']],
    ['updateMany', ['filter', 'update']],
    ['replaceOne', ['filter', 'replacement']],
    ['deleteOne', ['filter']],
    ['deleteMany', ['filter']],
    ['findOneAndUpdate', ['filter', 'update']],
    ['findOneAndReplace', ['filter', 'replacement']],
    ['findOneAndDelete', ['filter']],
    ['bulkWrite', ['operations']]
  ] as const)('%s takes %j before its options', (method, args) => {
    expect(WRITE_ARGUMENTS[method]).toEqual(args)
  })
})

describe('BULK_OPERATION_FIELDS', () => {
  it('lists the fields each operation requires besides its options', () => {
    expect(BULK_OPERATION_FIELDS).toEqual({
      insertOne: ['document'],
      updateOne: ['filter', 'update'],
      updateMany: ['filter', 'update'],
      replaceOne: ['filter', 'replacement'],
      deleteOne: ['filter'],
      deleteMany: ['filter']
    })
  })
})

describe('BULK_OPERATION_OPTIONS', () => {
  it('allows no options on a bulk insertOne', () => {
    expect(BULK_OPERATION_OPTIONS.insertOne).toEqual({})
  })

  it('allows upsert and arrayFilters only where the operation updates', () => {
    expect(Object.keys(BULK_OPERATION_OPTIONS.updateMany)).toEqual([
      'upsert',
      'arrayFilters',
      'collation',
      'hint'
    ])
    expect(Object.keys(BULK_OPERATION_OPTIONS.replaceOne)).toEqual(['upsert', 'collation', 'hint'])
    expect(Object.keys(BULK_OPERATION_OPTIONS.deleteMany)).toEqual(['collation', 'hint'])
  })
})

describe('filterError', () => {
  it('accepts a filter document, empty or not', () => {
    expect(filterError('deleteMany', {})).toBeNull()
    expect(filterError('updateOne', { a: 1 })).toBeNull()
  })

  it.each([[[]], ['a'], [null], [1]])('rejects %j, naming the method', (filter) => {
    expect(filterError('findOneAndDelete', filter)).toBe(
      'findOneAndDelete() filter must be an object'
    )
  })
})

describe('updateError', () => {
  it('accepts an update-operator document', () => {
    expect(updateError({ $set: { a: 1 }, $inc: { n: 1 } })).toBeNull()
  })

  it('accepts an update pipeline of allowed stages', () => {
    expect(updateError([{ $set: { a: 1 } }, { $unset: 'b' }, { $replaceWith: '$doc' }])).toBeNull()
  })

  it('rejects an empty update pipeline', () => {
    expect(updateError([])).toBe('An update pipeline needs at least one stage')
  })

  it('rejects a pipeline stage MongoDB does not allow in updates, naming its position', () => {
    expect(updateError([{ $set: { a: 1 } }, { $match: {} }])).toBe(
      `Update pipeline stage 2 must be one of ${STAGE_LIST}`
    )
  })

  it('rejects a pipeline stage with more than one operator', () => {
    expect(updateError([{ $set: { a: 1 }, $unset: 'b' }])).toBe(
      `Update pipeline stage 1 must be one of ${STAGE_LIST}`
    )
  })

  it('rejects a pipeline entry that is not a stage object', () => {
    expect(updateError(['$set'])).toBe(`Update pipeline stage 1 must be one of ${STAGE_LIST}`)
    expect(updateError([{}])).toBe(`Update pipeline stage 1 must be one of ${STAGE_LIST}`)
  })

  it.each([null, 'x', 5, true])('rejects %j as neither operators nor a pipeline', (update) => {
    expect(updateError(update)).toBe(
      'The update must be an object of update operators or a pipeline array'
    )
  })

  it('rejects an empty update document', () => {
    expect(updateError({})).toBe('The update needs at least one operator such as $set')
  })

  it('points a plain document at replaceOne', () => {
    expect(updateError({ name: 'x' })).toBe(
      'The update needs operators such as $set; replaceOne replaces whole documents'
    )
  })

  it('rejects operators mixed with plain fields', () => {
    expect(updateError({ $set: { a: 1 }, name: 'x' })).toBe(
      "The update can't mix operators with plain fields"
    )
  })
})

describe('replacementError', () => {
  it('accepts a plain document, empty or not', () => {
    expect(replacementError({ name: 'x', nested: { $literal: 1 } })).toBeNull()
    expect(replacementError({})).toBeNull()
  })

  it.each([null, [], [{ a: 1 }], 'x', 1])('rejects %j as not a document', (replacement) => {
    expect(replacementError(replacement)).toBe('The replacement must be a document')
  })

  it('points a top-level operator at updateOne', () => {
    expect(replacementError({ name: 'x', $set: { a: 1 } })).toBe(
      "A replacement can't contain update operators; updateOne applies operators"
    )
  })
})

describe('insertDocumentError', () => {
  it('accepts a document', () => {
    expect(insertDocumentError({ a: 1 })).toBeNull()
  })

  it.each([null, [], 'x', 1, undefined])('rejects %j', (document) => {
    expect(insertDocumentError(document)).toBe('Each inserted document must be an object')
  })
})

describe('writeOptionsError', () => {
  it('accepts an empty options object', () => {
    expect(writeOptionsError('updateOne', {})).toBeNull()
  })

  it('accepts every value kind in its valid form', () => {
    expect(
      writeOptionsError('findOneAndUpdate', {
        upsert: true,
        collation: { locale: 'en' },
        arrayFilters: [{ 'e.k': 1 }],
        hint: 'name_1',
        returnDocument: 'after',
        projection: { a: 1 },
        sort: { a: -1 },
        let: { v: 1 }
      })
    ).toBeNull()
    expect(writeOptionsError('deleteOne', { hint: { name: 1 } })).toBeNull()
    expect(writeOptionsError('findOneAndReplace', { returnNewDocument: false })).toBeNull()
  })

  it.each([null, [], 'x'])('rejects %j as an options value', (options) => {
    expect(writeOptionsError('insertOne', options)).toBe('insertOne() options must be an object')
  })

  it('names the unknown key and the supported ones', () => {
    expect(writeOptionsError('deleteMany', { upsert: true })).toBe(
      'deleteMany() options: unknown option "upsert"; supported: collation, hint, let'
    )
  })

  it('rejects a non-boolean flag', () => {
    expect(writeOptionsError('insertMany', { ordered: 'false' })).toBe(
      'insertMany() options: "ordered" must be true or false'
    )
  })

  it('rejects a non-object document option', () => {
    expect(writeOptionsError('replaceOne', { collation: 'en' })).toBe(
      'replaceOne() options: "collation" must be an object'
    )
  })

  it.each([{ 'e.k': 1 }, [{ a: 1 }, 'x']])('rejects arrayFilters %j', (arrayFilters) => {
    expect(writeOptionsError('updateMany', { arrayFilters })).toBe(
      'updateMany() options: "arrayFilters" must be an array of objects'
    )
  })

  it.each([1, null, ['a']])('rejects hint %j', (hint) => {
    expect(writeOptionsError('updateOne', { hint })).toBe(
      'updateOne() options: "hint" must be an index name or key pattern'
    )
  })

  it('rejects a returnDocument other than before or after', () => {
    expect(writeOptionsError('findOneAndUpdate', { returnDocument: 'new' })).toBe(
      'findOneAndUpdate() options: "returnDocument" must be "before" or "after"'
    )
  })

  it('rejects returnDocument together with returnNewDocument', () => {
    expect(
      writeOptionsError('findOneAndReplace', { returnDocument: 'after', returnNewDocument: true })
    ).toBe('findOneAndReplace() options: use returnDocument or returnNewDocument, not both')
  })

  it('keeps returnNewDocument away from findOneAndDelete', () => {
    expect(writeOptionsError('findOneAndDelete', { returnNewDocument: true })).toBe(
      'findOneAndDelete() options: unknown option "returnNewDocument"; supported: collation, hint, let, projection, sort'
    )
  })
})

describe('bulkWriteError', () => {
  it('accepts every operation in its valid form', () => {
    expect(
      bulkWriteError([
        { insertOne: { document: { a: 1 } } },
        { updateOne: { filter: { a: 1 }, update: { $set: { b: 1 } }, upsert: true } },
        { updateMany: { filter: {}, update: [{ $set: { c: 1 } }], arrayFilters: [{ x: 1 }] } },
        { replaceOne: { filter: { a: 1 }, replacement: { a: 2 }, hint: 'a_1' } },
        { deleteOne: { filter: { a: 2 }, collation: { locale: 'en' } } },
        { deleteMany: { filter: {} } }
      ])
    ).toBeNull()
  })

  it.each([[], null, { insertOne: { document: {} } }])('rejects %j as the operations', (ops) => {
    expect(bulkWriteError(ops)).toBe('bulkWrite() expects a non-empty array of operations')
  })

  it.each([
    ['an unknown operation', { insertMany: { documents: [] } }],
    ['two operations in one entry', { deleteOne: { filter: {} }, deleteMany: { filter: {} } }],
    ['a non-object entry', 'insertOne'],
    ['an empty entry', {}]
  ])('rejects %s, naming its position', (_case, entry) => {
    expect(bulkWriteError([{ deleteOne: { filter: {} } }, entry])).toBe(
      'bulkWrite() operation 2 must be one of { insertOne | updateOne | updateMany | replaceOne | deleteOne | deleteMany: { … } }'
    )
  })

  it('rejects an operation whose body is not an object', () => {
    expect(bulkWriteError([{ deleteMany: [] }])).toBe(
      'bulkWrite() operation 1: deleteMany needs an object'
    )
  })

  it.each([
    [{ insertOne: {} }, 'insertOne needs "document"'],
    [{ updateOne: { filter: {} } }, 'updateOne needs "update"'],
    [{ updateMany: { update: { $set: { a: 1 } } } }, 'updateMany needs "filter"'],
    [{ replaceOne: { filter: {} } }, 'replaceOne needs "replacement"'],
    [{ deleteOne: {} }, 'deleteOne needs "filter"']
  ])('rejects %j: %s', (entry, reason) => {
    expect(bulkWriteError([entry])).toBe(`bulkWrite() operation 1: ${reason}`)
  })

  it('rejects an inserted document that is not an object', () => {
    expect(bulkWriteError([{ insertOne: { document: [1] } }])).toBe(
      'bulkWrite() operation 1: Each inserted document must be an object'
    )
  })

  it('rejects a filter that is not an object', () => {
    expect(bulkWriteError([{ deleteOne: { filter: 'a' } }])).toBe(
      'bulkWrite() operation 1: the filter must be an object'
    )
  })

  it('applies the update rules to an update operation', () => {
    expect(bulkWriteError([{ updateMany: { filter: {}, update: { a: 1 } } }])).toBe(
      'bulkWrite() operation 1: The update needs operators such as $set; replaceOne replaces whole documents'
    )
  })

  it('applies the replacement rules to a replace operation', () => {
    expect(bulkWriteError([{ replaceOne: { filter: {}, replacement: { $set: { a: 1 } } } }])).toBe(
      "bulkWrite() operation 1: A replacement can't contain update operators; updateOne applies operators"
    )
  })

  it('rejects an option the operation does not take', () => {
    expect(bulkWriteError([{ deleteOne: { filter: {}, upsert: true } }])).toBe(
      'bulkWrite() operation 1 (deleteOne): unknown option "upsert"; supported: collation, hint'
    )
  })

  it('says a bulk insertOne takes no options', () => {
    expect(bulkWriteError([{ insertOne: { document: {}, ordered: true } }])).toBe(
      'bulkWrite() operation 1 (insertOne): no options are supported'
    )
  })

  it('checks the value kind of an operation option', () => {
    expect(bulkWriteError([{ updateOne: { filter: {}, update: [{ $set: {} }], upsert: 1 } }])).toBe(
      'bulkWrite() operation 1 (updateOne): "upsert" must be true or false'
    )
  })

  it('reports the first invalid operation only', () => {
    expect(bulkWriteError([{ deleteOne: {} }, { insertOne: {} }])).toBe(
      'bulkWrite() operation 1: deleteOne needs "filter"'
    )
  })
})
