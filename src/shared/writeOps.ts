import type { WriteMethod } from './types'

/**
 * Argument rules of the write methods. The shell parser and main check writes with them, so both
 * reject the same input with the same message; completion offers what they accept. Values are
 * plain parsed JSON/EJSON trees.
 */

/** Stages an update pipeline may contain; MongoDB rejects every other stage there. */
export const UPDATE_PIPELINE_STAGES: ReadonlySet<string> = new Set([
  '$addFields',
  '$set',
  '$project',
  '$unset',
  '$replaceRoot',
  '$replaceWith'
])

/** Operations `bulkWrite` accepts, named like the keys of its argument's elements. */
export const BULK_WRITE_OPERATIONS = [
  'insertOne',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany'
] as const

export type BulkWriteOperation = (typeof BULK_WRITE_OPERATIONS)[number]

/** A field a `bulkWrite` operation requires; the write methods name their arguments alike. */
export type WriteField = 'document' | 'filter' | 'update' | 'replacement'

/** A required argument of a write method. */
export type WriteArgument = WriteField | 'documents' | 'operations'

/** Fields each `bulkWrite` operation requires besides its options. */
export const BULK_OPERATION_FIELDS: Readonly<Record<BulkWriteOperation, readonly WriteField[]>> = {
  insertOne: ['document'],
  updateOne: ['filter', 'update'],
  updateMany: ['filter', 'update'],
  replaceOne: ['filter', 'replacement'],
  deleteOne: ['filter'],
  deleteMany: ['filter']
}

/** Arguments each write method requires, in call order; each also takes a trailing options object. */
export const WRITE_ARGUMENTS: Readonly<Record<WriteMethod, readonly WriteArgument[]>> = {
  ...BULK_OPERATION_FIELDS,
  insertMany: ['documents'],
  findOneAndUpdate: ['filter', 'update'],
  findOneAndReplace: ['filter', 'replacement'],
  findOneAndDelete: ['filter'],
  bulkWrite: ['operations']
}

/** The value an option takes: `documents` is an array of objects, `hint` an index name or key. */
export type WriteOptionKind = 'boolean' | 'document' | 'documents' | 'hint' | 'returnDocument'

type OptionSpec = Readonly<Record<string, WriteOptionKind>>

const FILTERED: OptionSpec = { collation: 'document', hint: 'hint', let: 'document' }
const UPDATE: OptionSpec = {
  ...FILTERED,
  upsert: 'boolean',
  arrayFilters: 'documents',
  bypassDocumentValidation: 'boolean'
}
const REPLACE: OptionSpec = { ...FILTERED, upsert: 'boolean', bypassDocumentValidation: 'boolean' }
const RETURNING: OptionSpec = {
  projection: 'document',
  sort: 'document',
  returnDocument: 'returnDocument',
  returnNewDocument: 'boolean'
}

/** Options each write method accepts, and the kind of value each takes. */
export const WRITE_OPTIONS: Readonly<Record<WriteMethod, OptionSpec>> = {
  insertOne: { bypassDocumentValidation: 'boolean' },
  insertMany: { ordered: 'boolean', bypassDocumentValidation: 'boolean' },
  updateOne: UPDATE,
  updateMany: UPDATE,
  replaceOne: REPLACE,
  deleteOne: FILTERED,
  deleteMany: FILTERED,
  findOneAndUpdate: { ...UPDATE, ...RETURNING },
  findOneAndReplace: { ...REPLACE, ...RETURNING },
  findOneAndDelete: { ...FILTERED, projection: 'document', sort: 'document' },
  bulkWrite: { ordered: 'boolean', bypassDocumentValidation: 'boolean' }
}

const BULK_UPDATE: OptionSpec = {
  upsert: 'boolean',
  arrayFilters: 'documents',
  collation: 'document',
  hint: 'hint'
}

/** Option keys allowed inside one `bulkWrite` operation besides its required fields. */
export const BULK_OPERATION_OPTIONS: Readonly<Record<BulkWriteOperation, OptionSpec>> = {
  insertOne: {},
  updateOne: BULK_UPDATE,
  updateMany: BULK_UPDATE,
  replaceOne: { upsert: 'boolean', collation: 'document', hint: 'hint' },
  deleteOne: { collation: 'document', hint: 'hint' },
  deleteMany: { collation: 'document', hint: 'hint' }
}

/** Option pairs that choose the same thing (the document findOneAnd* returns); one of each at most. */
export const EXCLUSIVE_OPTIONS: readonly (readonly [string, string])[] = [
  ['returnDocument', 'returnNewDocument']
]

/** Narrows to a non-null object that is not an array. */
export const isDocument = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why `filter` cannot select the documents `method` writes, or null. */
export function filterError(method: WriteMethod, filter: unknown): string | null {
  return isDocument(filter) ? null : `${method}() filter must be an object`
}

/** Why `update` is neither an update-operator document nor an update pipeline, or null. */
export function updateError(update: unknown): string | null {
  if (Array.isArray(update)) {
    if (update.length === 0) return 'An update pipeline needs at least one stage'
    for (const [index, stage] of update.entries()) {
      const keys = isDocument(stage) ? Object.keys(stage) : []
      if (keys.length !== 1 || !UPDATE_PIPELINE_STAGES.has(keys[0]!)) {
        return `Update pipeline stage ${index + 1} must be one of ${[...UPDATE_PIPELINE_STAGES].join(', ')}`
      }
    }
    return null
  }
  if (!isDocument(update)) {
    return 'The update must be an object of update operators or a pipeline array'
  }
  const keys = Object.keys(update)
  if (keys.length === 0) return 'The update needs at least one operator such as $set'
  const operators = keys.filter((key) => key.startsWith('$')).length
  if (operators === 0) {
    return 'The update needs operators such as $set; replaceOne replaces whole documents'
  }
  if (operators !== keys.length) return "The update can't mix operators with plain fields"
  return null
}

/** Why `replacement` cannot replace a document, or null. */
export function replacementError(replacement: unknown): string | null {
  if (!isDocument(replacement)) return 'The replacement must be a document'
  return Object.keys(replacement).some((key) => key.startsWith('$'))
    ? "A replacement can't contain update operators; updateOne applies operators"
    : null
}

/** Why `document` cannot be inserted, or null. */
export function insertDocumentError(document: unknown): string | null {
  return isDocument(document) ? null : 'Each inserted document must be an object'
}

/** Why `options` is not a valid options object for `method`, or null. */
export function writeOptionsError(method: WriteMethod, options: unknown): string | null {
  return optionsError(WRITE_OPTIONS[method], options, `${method}() options`)
}

/** Why `operations` is not a valid `bulkWrite` argument, or null. */
export function bulkWriteError(operations: unknown): string | null {
  if (!Array.isArray(operations) || operations.length === 0) {
    return 'bulkWrite() expects a non-empty array of operations'
  }
  for (const [index, entry] of operations.entries()) {
    const at = `bulkWrite() operation ${index + 1}`
    const keys = isDocument(entry) ? Object.keys(entry) : []
    const name = keys[0]
    if (keys.length !== 1 || !isBulkWriteOperation(name)) {
      return `${at} must be one of { ${BULK_WRITE_OPERATIONS.join(' | ')}: { … } }`
    }
    const body = (entry as Record<string, unknown>)[name]
    if (!isDocument(body)) return `${at}: ${name} needs an object`
    const fields: readonly string[] = BULK_OPERATION_FIELDS[name]
    for (const field of fields) {
      if (!(field in body)) return `${at}: ${name} needs "${field}"`
    }
    const fieldError = bulkFieldError(name, body)
    if (fieldError !== null) return `${at}: ${fieldError}`
    const rest = Object.fromEntries(Object.entries(body).filter(([key]) => !fields.includes(key)))
    const restError = optionsError(BULK_OPERATION_OPTIONS[name], rest, `${at} (${name})`)
    if (restError !== null) return restError
  }
  return null
}

function bulkFieldError(name: BulkWriteOperation, body: Record<string, unknown>): string | null {
  if (name === 'insertOne') return insertDocumentError(body['document'])
  if (!isDocument(body['filter'])) return 'the filter must be an object'
  if (name === 'updateOne' || name === 'updateMany') return updateError(body['update'])
  if (name === 'replaceOne') return replacementError(body['replacement'])
  return null
}

function optionsError(spec: OptionSpec, options: unknown, what: string): string | null {
  if (!isDocument(options)) return `${what} must be an object`
  for (const [key, value] of Object.entries(options)) {
    const kind = spec[key]
    if (kind === undefined) {
      const known = Object.keys(spec)
      return known.length === 0
        ? `${what}: no options are supported`
        : `${what}: unknown option "${key}"; supported: ${known.join(', ')}`
    }
    const error = valueError(kind, value)
    if (error !== null) return `${what}: "${key}" ${error}`
  }
  for (const [a, b] of EXCLUSIVE_OPTIONS) {
    if (a in options && b in options) return `${what}: use ${a} or ${b}, not both`
  }
  return null
}

function valueError(kind: WriteOptionKind, value: unknown): string | null {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false'
    case 'document':
      return isDocument(value) ? null : 'must be an object'
    case 'documents':
      return Array.isArray(value) && value.every(isDocument) ? null : 'must be an array of objects'
    case 'hint':
      return typeof value === 'string' || isDocument(value)
        ? null
        : 'must be an index name or key pattern'
    case 'returnDocument':
      return value === 'before' || value === 'after' ? null : 'must be "before" or "after"'
  }
}

const isBulkWriteOperation = (name: string | undefined): name is BulkWriteOperation =>
  (BULK_WRITE_OPERATIONS as readonly (string | undefined)[]).includes(name)
