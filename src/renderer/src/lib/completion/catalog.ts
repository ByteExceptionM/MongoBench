/**
 * Static completion data: query, update and expression operators, stages, accumulators,
 * argument grammars, write options and shell methods. Templates are Monaco snippet text;
 * literal `$` stays escaped.
 */
import type { BsonTypeName, WriteMethod } from '@shared/types'
import {
  BULK_OPERATION_FIELDS,
  BULK_OPERATION_OPTIONS,
  BULK_WRITE_OPERATIONS,
  EXCLUSIVE_OPTIONS,
  WRITE_ARGUMENTS,
  WRITE_OPTIONS,
  type WriteArgument,
  type WriteField,
  type WriteOptionKind
} from '@shared/writeOps'

/** Snippet text of the value after `key: `; `k` renders an inner key in the editor's key style. */
export type Template = (k: (key: string) => string) => string

export type KeyDef = {
  name: string
  doc: string
  /** Value template; absent inserts only `key: `. */
  template?: Template
  /** Re-open suggestions after inserting; defaults to true for keys without a template. */
  retrigger?: boolean
}

const OBJECT: Template = () => '{ $0 }'
const ARRAY: Template = () => '[$0]'
const STRING: Template = () => '"$0"'
const FIELD_REF: Template = () => '"\\$$0"'

export const QUERY_TOP_OPERATORS: readonly KeyDef[] = [
  {
    name: '$and',
    doc: 'Matches when every clause matches.',
    template: () => '[{ $0 }]',
    retrigger: true
  },
  {
    name: '$or',
    doc: 'Matches when any clause matches.',
    template: () => '[{ $0 }]',
    retrigger: true
  },
  {
    name: '$nor',
    doc: 'Matches when no clause matches.',
    template: () => '[{ $0 }]',
    retrigger: true
  },
  {
    name: '$expr',
    doc: 'Evaluates an aggregation expression per document.',
    template: OBJECT,
    retrigger: true
  },
  {
    name: '$text',
    doc: 'Text search on a text index.',
    template: (k) => `{ ${k('$search')}: "$0" }`
  },
  {
    name: '$jsonSchema',
    doc: 'Matches documents valid against a JSON Schema.',
    template: OBJECT,
    retrigger: true
  },
  {
    name: '$where',
    doc: 'Server-side JavaScript predicate; slow, avoid on large collections.',
    template: STRING
  },
  {
    name: '$comment',
    doc: 'Attaches a comment to the query in logs and profiler output.',
    template: STRING
  }
]

/** Field types an operator fits; `regexOption` is offered only next to `$regex`. */
export type OperatorFit =
  'always' | 'comparable' | 'string' | 'regexOption' | 'array' | 'integer' | 'geo'

export type FieldOperator = KeyDef & { fits: OperatorFit }

const GEOMETRY: (type: string) => Template = (type) => (k) =>
  `{ ${k('$geometry')}: { ${k('type')}: "\${1:${type}}", ${k('coordinates')}: [$0] } }`
const NEAR: Template = (k) =>
  `{ ${k('$geometry')}: { ${k('type')}: "Point", ${k('coordinates')}: [\${1:lng}, \${2:lat}] }, ${k('$maxDistance')}: \${0:1000} }`

export const FIELD_OPERATORS: readonly FieldOperator[] = [
  { name: '$eq', doc: 'Equal to a value.', fits: 'always' },
  { name: '$ne', doc: 'Not equal to a value.', fits: 'always' },
  { name: '$gt', doc: 'Greater than a value.', fits: 'comparable' },
  { name: '$gte', doc: 'Greater than or equal to a value.', fits: 'comparable' },
  { name: '$lt', doc: 'Less than a value.', fits: 'comparable' },
  { name: '$lte', doc: 'Less than or equal to a value.', fits: 'comparable' },
  {
    name: '$in',
    doc: 'Equal to any value in the array.',
    fits: 'always',
    template: ARRAY,
    retrigger: true
  },
  {
    name: '$nin',
    doc: 'Equal to none of the values in the array.',
    fits: 'always',
    template: ARRAY,
    retrigger: true
  },
  { name: '$exists', doc: 'The field is present (true) or missing (false).', fits: 'always' },
  { name: '$type', doc: 'The value has one of the BSON types.', fits: 'always' },
  {
    name: '$not',
    doc: 'Inverts an operator expression.',
    fits: 'always',
    template: OBJECT,
    retrigger: true
  },
  { name: '$regex', doc: 'Matches a regular expression.', fits: 'string', template: () => '/$0/' },
  { name: '$options', doc: 'Flags for $regex: i, m, x, s.', fits: 'regexOption' },
  {
    name: '$all',
    doc: 'The array contains all the values.',
    fits: 'array',
    template: ARRAY,
    retrigger: true
  },
  {
    name: '$elemMatch',
    doc: 'An array element matches all conditions.',
    fits: 'array',
    template: OBJECT,
    retrigger: true
  },
  { name: '$size', doc: 'The array has this many elements.', fits: 'array', retrigger: false },
  {
    name: '$mod',
    doc: 'value % divisor === remainder.',
    fits: 'integer',
    template: () => '[${1:divisor}, ${2:remainder}]'
  },
  { name: '$bitsAllSet', doc: 'All bits of the mask are set.', fits: 'integer', retrigger: false },
  {
    name: '$bitsAllClear',
    doc: 'All bits of the mask are clear.',
    fits: 'integer',
    retrigger: false
  },
  { name: '$bitsAnySet', doc: 'Any bit of the mask is set.', fits: 'integer', retrigger: false },
  {
    name: '$bitsAnyClear',
    doc: 'Any bit of the mask is clear.',
    fits: 'integer',
    retrigger: false
  },
  {
    name: '$geoWithin',
    doc: 'Geometry lies within a shape.',
    fits: 'geo',
    template: GEOMETRY('Polygon')
  },
  {
    name: '$geoIntersects',
    doc: 'Geometry intersects a shape.',
    fits: 'geo',
    template: GEOMETRY('Point')
  },
  {
    name: '$near',
    doc: 'Nearest to a point (planar), closest first.',
    fits: 'geo',
    template: NEAR
  },
  {
    name: '$nearSphere',
    doc: 'Nearest to a point (spherical), closest first.',
    fits: 'geo',
    template: NEAR
  }
]

/** Extended-JSON wrapper key matching a field type, e.g. `$oid` for objectId. */
export const EJSON_WRAPPERS: Partial<Record<BsonTypeName, KeyDef>> = {
  objectId: { name: '$oid', doc: 'Extended JSON ObjectId.', template: STRING },
  date: { name: '$date', doc: 'Extended JSON date (ISO-8601 string).', template: STRING },
  int: { name: '$numberInt', doc: 'Extended JSON 32-bit integer.', template: STRING },
  long: { name: '$numberLong', doc: 'Extended JSON 64-bit integer.', template: STRING },
  double: { name: '$numberDouble', doc: 'Extended JSON double.', template: STRING },
  decimal: { name: '$numberDecimal', doc: 'Extended JSON 128-bit decimal.', template: STRING },
  uuid: { name: '$uuid', doc: 'Extended JSON UUID.', template: STRING },
  binData: {
    name: '$binary',
    doc: 'Extended JSON binary.',
    template: (k) => `{ ${k('base64')}: "$1", ${k('subType')}: "\${0:00}" }`
  },
  timestamp: {
    name: '$timestamp',
    doc: 'Extended JSON timestamp.',
    template: (k) => `{ ${k('t')}: $1, ${k('i')}: \${0:1} }`
  },
  regex: {
    name: '$regularExpression',
    doc: 'Extended JSON regular expression.',
    template: (k) => `{ ${k('pattern')}: "$1", ${k('options')}: "$0" }`
  }
}

export const TEXT_KEYS: readonly KeyDef[] = [
  { name: '$search', doc: 'Terms to search for.', template: STRING },
  { name: '$language', doc: 'Language for stemming and stop words.', template: STRING },
  { name: '$caseSensitive', doc: 'Case-sensitive search.' },
  { name: '$diacriticSensitive', doc: 'Diacritic-sensitive search.' }
]

export const JSON_SCHEMA_KEYS: readonly KeyDef[] = [
  { name: 'bsonType', doc: 'Allowed BSON type(s).' },
  { name: 'required', doc: 'Fields that must be present.', template: ARRAY, retrigger: true },
  { name: 'properties', doc: 'Schemas of named fields.', template: OBJECT, retrigger: true },
  { name: 'additionalProperties', doc: 'Allow fields not listed in properties.' },
  { name: 'enum', doc: 'Allowed values.', template: ARRAY },
  { name: 'minimum', doc: 'Minimum number.', retrigger: false },
  { name: 'maximum', doc: 'Maximum number.', retrigger: false },
  { name: 'minLength', doc: 'Minimum string length.', retrigger: false },
  { name: 'maxLength', doc: 'Maximum string length.', retrigger: false },
  { name: 'pattern', doc: 'Regular expression a string must match.', template: STRING },
  { name: 'items', doc: 'Schema of array elements.', template: OBJECT, retrigger: true },
  { name: 'minItems', doc: 'Minimum array length.', retrigger: false },
  { name: 'maxItems', doc: 'Maximum array length.', retrigger: false },
  { name: 'uniqueItems', doc: 'Array elements must be unique.' },
  { name: 'description', doc: 'Human-readable description.', template: STRING },
  { name: 'title', doc: 'Short title.', template: STRING }
]

export const GEO_KEYS: readonly KeyDef[] = [
  {
    name: '$geometry',
    doc: 'GeoJSON geometry.',
    template: (k) => `{ ${k('type')}: "\${1:Point}", ${k('coordinates')}: [$0] }`
  },
  { name: '$maxDistance', doc: 'Maximum distance (meters for GeoJSON).', retrigger: false },
  { name: '$minDistance', doc: 'Minimum distance (meters for GeoJSON).', retrigger: false },
  {
    name: '$box',
    doc: 'Legacy rectangle: bottom-left and top-right corners.',
    template: () => '[[$1], [$0]]'
  },
  { name: '$center', doc: 'Legacy circle on a plane.', template: () => '[[$1], ${0:radius}]' },
  {
    name: '$centerSphere',
    doc: 'Circle on a sphere, radius in radians.',
    template: () => '[[$1], ${0:radians}]'
  },
  { name: '$polygon', doc: 'Legacy polygon.', template: () => '[[$0]]' }
]

/** Operators of a projection field's object. */
export const PROJECTION_OPERATORS: readonly KeyDef[] = [
  { name: '$slice', doc: 'First n elements, or [skip, n].', retrigger: false },
  {
    name: '$elemMatch',
    doc: 'First element matching a condition.',
    template: OBJECT,
    retrigger: true
  },
  {
    name: '$meta',
    doc: 'Metadata such as the text search score.',
    template: () => '"${0:textScore}"'
  }
]

export type UpdateOperatorDef = KeyDef & {
  /** Type of the fields it applies to. */
  fields?: TypeClass
}

const update = (name: string, doc: string, fields?: TypeClass): UpdateOperatorDef => ({
  name,
  doc,
  template: OBJECT,
  retrigger: true,
  fields
})

/** Update operators; each takes an object keyed by field paths. */
export const UPDATE_OPERATORS: readonly UpdateOperatorDef[] = [
  update('$set', 'Sets fields to values.'),
  update('$unset', 'Removes fields.'),
  update('$inc', 'Adds to numeric fields.', 'number'),
  update('$mul', 'Multiplies numeric fields.', 'number'),
  update('$rename', 'Renames fields.'),
  update('$min', 'Sets fields to the value if it is smaller.'),
  update('$max', 'Sets fields to the value if it is larger.'),
  update('$currentDate', 'Sets fields to the current date or timestamp.', 'date'),
  update('$setOnInsert', 'Sets fields only when an upsert inserts.'),
  update('$push', 'Appends to arrays.', 'array'),
  update('$addToSet', 'Adds to arrays unless already present.', 'array'),
  update('$pop', 'Removes the first (-1) or last (1) array element.', 'array'),
  update('$pull', 'Removes array elements matching a condition.', 'array'),
  update('$pullAll', 'Removes every listed value from arrays.', 'array'),
  update('$bit', 'Bitwise and, or, xor of integer fields.', 'number')
]

/** Update path segments `$`, `$[]` and `$[name]`, which address array elements. */
export const POSITIONAL_SEGMENT = /^\$(?:\[\w*\])?$/

/** Schema path of an update path: its positional segments dropped, as elements share their array's path. */
export function withoutPositional(path: string): string {
  return path
    .split('.')
    .filter((segment) => !POSITIONAL_SEGMENT.test(segment))
    .join('.')
}

/** Update operator whose value may be an object of modifiers. */
export type ArrayModifierOwner = '$push' | '$addToSet'

/** Modifiers of a `$push` / `$addToSet` value. */
export const ARRAY_MODIFIERS: Readonly<Record<ArrayModifierOwner, readonly KeyDef[]>> = {
  $push: [
    { name: '$each', doc: 'Appends each element of the array.', template: ARRAY, retrigger: true },
    { name: '$position', doc: 'Index to insert at.', retrigger: false },
    {
      name: '$slice',
      doc: 'Keeps the first n, or with -n the last n, elements.',
      retrigger: false
    },
    { name: '$sort', doc: 'Sorts the array: 1, -1 or by element fields.' }
  ],
  $addToSet: [
    { name: '$each', doc: 'Adds each element of the array.', template: ARRAY, retrigger: true }
  ]
}

/** `$type` aliases. */
export const TYPE_ALIASES: readonly string[] = [
  'double',
  'string',
  'object',
  'array',
  'binData',
  'undefined',
  'objectId',
  'bool',
  'date',
  'null',
  'regex',
  'dbPointer',
  'javascript',
  'symbol',
  'int',
  'timestamp',
  'long',
  'decimal',
  'minKey',
  'maxKey',
  'number'
]

/** `$type` alias of a sampled type. */
export function typeAlias(type: BsonTypeName): string {
  if (type === 'uuid' || type === 'uuidLegacy') return 'binData'
  if (type === 'dbRef') return 'object'
  return type
}

export type StageDef = KeyDef & {
  /** Valid only as the first stage of a pipeline. */
  firstOnly?: boolean
  /** Valid only in a `$lookup` / `$unionWith` pipeline; a collection aggregate rejects it. */
  subPipelineOnly?: boolean
}

export const STAGES: readonly StageDef[] = [
  { name: '$match', doc: 'Filters documents with a query.', template: OBJECT, retrigger: true },
  {
    name: '$project',
    doc: 'Includes, excludes or computes fields.',
    template: OBJECT,
    retrigger: true
  },
  {
    name: '$group',
    doc: 'Groups by _id and accumulates per group.',
    template: (k) => `{ ${k('_id')}: $0 }`,
    retrigger: true
  },
  { name: '$sort', doc: 'Sorts documents.', template: OBJECT, retrigger: true },
  { name: '$limit', doc: 'Passes the first n documents.', template: () => '${0:10}' },
  { name: '$skip', doc: 'Skips the first n documents.', template: () => '${0:0}' },
  {
    name: '$lookup',
    doc: 'Joins documents of another collection.',
    template: (k) => `{ ${k('from')}: "$0" }`,
    retrigger: true
  },
  {
    name: '$unwind',
    doc: 'Outputs one document per array element.',
    template: FIELD_REF,
    retrigger: true
  },
  { name: '$addFields', doc: 'Adds or overwrites fields.', template: OBJECT, retrigger: true },
  { name: '$set', doc: 'Alias of $addFields.', template: OBJECT, retrigger: true },
  { name: '$unset', doc: 'Removes fields.', template: STRING, retrigger: true },
  {
    name: '$count',
    doc: 'Outputs one document with the document count.',
    template: () => '"${0:count}"'
  },
  {
    name: '$sample',
    doc: 'Picks n random documents.',
    template: (k) => `{ ${k('size')}: \${0:10} }`
  },
  {
    name: '$replaceRoot',
    doc: 'Replaces each document with an embedded one.',
    template: (k) => `{ ${k('newRoot')}: "\\$$0" }`,
    retrigger: true
  },
  {
    name: '$replaceWith',
    doc: 'Replaces each document with an expression result.',
    template: OBJECT
  },
  {
    name: '$sortByCount',
    doc: 'Groups by an expression and counts, largest first.',
    template: FIELD_REF,
    retrigger: true
  },
  { name: '$facet', doc: 'Runs several sub-pipelines on the same input.', template: OBJECT },
  { name: '$bucket', doc: 'Groups into buckets by boundaries.', template: OBJECT },
  { name: '$bucketAuto', doc: 'Groups into a number of evenly filled buckets.', template: OBJECT },
  {
    name: '$unionWith',
    doc: 'Appends documents of another collection.',
    template: (k) => `{ ${k('coll')}: "$0" }`,
    retrigger: true
  },
  { name: '$graphLookup', doc: 'Recursive lookup over a collection.', template: OBJECT },
  {
    name: '$setWindowFields',
    doc: 'Computes window functions over sorted partitions.',
    template: OBJECT
  },
  { name: '$densify', doc: 'Fills gaps in a sequence of values.', template: OBJECT },
  { name: '$fill', doc: 'Fills null and missing values.', template: OBJECT },
  { name: '$redact', doc: 'Restricts content by $$DESCEND / $$PRUNE / $$KEEP.', template: OBJECT },
  {
    name: '$geoNear',
    doc: 'Orders documents by distance to a point.',
    template: OBJECT,
    firstOnly: true
  },
  { name: '$collStats', doc: 'Collection statistics.', template: OBJECT, firstOnly: true },
  { name: '$indexStats', doc: 'Index usage statistics.', template: OBJECT, firstOnly: true },
  {
    name: '$documents',
    doc: 'Literal input documents.',
    template: ARRAY,
    firstOnly: true,
    subPipelineOnly: true
  },
  {
    name: '$changeStream',
    doc: 'Change stream (does not end).',
    template: OBJECT,
    firstOnly: true
  },
  { name: '$search', doc: 'Atlas Search full-text query.', template: OBJECT, firstOnly: true },
  { name: '$searchMeta', doc: 'Atlas Search metadata.', template: OBJECT, firstOnly: true },
  { name: '$vectorSearch', doc: 'Atlas Vector Search.', template: OBJECT, firstOnly: true },
  { name: '$listSessions', doc: 'Sessions (config database).', template: OBJECT, firstOnly: true },
  { name: '$listSearchIndexes', doc: 'Atlas Search indexes.', template: OBJECT, firstOnly: true },
  { name: '$planCacheStats', doc: 'Plan cache entries.', template: OBJECT, firstOnly: true },
  { name: '$out', doc: 'Writes the output to a collection.', template: STRING },
  { name: '$merge', doc: 'Merges the output into a collection.', template: OBJECT }
]

/** A BSON type, or `number` for any numeric type. */
export type TypeClass = BsonTypeName | 'number'

/** BSON types of the `number` type class. */
export const NUMERIC_TYPES: ReadonlySet<BsonTypeName> = new Set<BsonTypeName>([
  'int',
  'long',
  'double',
  'decimal'
])

/** Grammar of a named argument's value. */
export type ArgKind =
  | 'expression'
  /** An expression that yields a date. */
  | 'dateExpr'
  /** An expression that yields a bool. */
  | 'boolExpr'
  | 'arrayRef'
  | 'query'
  | 'sort'
  | 'projection'
  /** Update operators document or update pipeline. */
  | 'update'
  /** A whole document of the collection. */
  | 'document'
  /** Conditions on the array elements the update's `$[identifier]`s stand for. */
  | 'arrayFilters'
  | 'fieldPath'
  | 'fieldPaths'
  | 'collection'
  | 'pipeline'
  | 'accumulators'
  | 'windowOutput'
  | 'fillOutput'
  | 'vars'
  | 'bool'
  | 'number'
  | 'string'
  | 'object'
  | 'array'
  | 'any'
  | { enum: readonly string[] }
  /** Object with the named arguments of `ARG_SPECS[args]`. */
  | { args: string }

export type ArgSpec = {
  name: string
  kind: ArgKind
  required?: boolean
  /** An argument that cannot be given together with this one. */
  excludes?: string
}

const quoted = (values: readonly string[]): readonly string[] =>
  values.map((v) => JSON.stringify(v))
const TIME_UNITS = quoted([
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond'
])
const WEEKDAYS = quoted([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
])

const req = (name: string, kind: ArgKind): ArgSpec => ({ name, kind, required: true })
const opt = (name: string, kind: ArgKind): ArgSpec => ({ name, kind })

/** `ARG_SPECS` owner of a write method's options object. */
export const optionsOwner = (method: string): string => `${method}.options`

/** `ARG_SPECS` owner of the body of a `bulkWrite` operation. */
export const bulkOperationOwner = (operation: string): string => `bulkWrite.${operation}`

// Most used first; options not listed here follow in their WRITE_OPTIONS order.
const OPTION_ORDER = [
  'upsert',
  'returnDocument',
  'returnNewDocument',
  'projection',
  'sort',
  'arrayFilters',
  'ordered',
  'bypassDocumentValidation',
  'hint',
  'collation',
  'let'
]

function optionSpecs(options: Readonly<Record<string, WriteOptionKind>>): ArgSpec[] {
  const rank = (name: string): number => {
    const index = OPTION_ORDER.indexOf(name)
    return index === -1 ? OPTION_ORDER.length : index
  }
  return Object.entries(options)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([name, kind]) => ({
      name,
      kind: optionKind(name, kind),
      excludes: EXCLUSIVE_OPTIONS.find((pair) => pair.includes(name))?.find((key) => key !== name)
    }))
}

function optionKind(name: string, kind: WriteOptionKind): ArgKind {
  if (name === 'sort' || name === 'projection' || name === 'arrayFilters') return name
  switch (kind) {
    case 'boolean':
      return 'bool'
    case 'returnDocument':
      return { enum: quoted(['after', 'before']) }
    default:
      return 'any'
  }
}

// Grammar of each write field, in bulkWrite operations and as a write method argument.
const FIELD_KINDS: Readonly<Record<WriteField, 'document' | 'query' | 'update'>> = {
  document: 'document',
  filter: 'query',
  update: 'update',
  replacement: 'document'
}

/** Named arguments of stages, nested stage objects and expression operators. */
export const ARG_SPECS: Readonly<Record<string, readonly ArgSpec[]>> = {
  $lookup: [
    req('from', 'collection'),
    opt('localField', 'fieldPath'),
    opt('foreignField', 'fieldPath'),
    req('as', 'string'),
    opt('let', 'vars'),
    opt('pipeline', 'pipeline')
  ],
  $graphLookup: [
    req('from', 'collection'),
    req('startWith', 'expression'),
    req('connectFromField', 'fieldPath'),
    req('connectToField', 'fieldPath'),
    req('as', 'string'),
    opt('maxDepth', 'number'),
    opt('depthField', 'string'),
    opt('restrictSearchWithMatch', 'query')
  ],
  $unwind: [
    req('path', 'arrayRef'),
    opt('includeArrayIndex', 'string'),
    opt('preserveNullAndEmptyArrays', 'bool')
  ],
  $bucket: [
    req('groupBy', 'expression'),
    req('boundaries', 'array'),
    opt('default', 'any'),
    opt('output', 'accumulators')
  ],
  $bucketAuto: [
    req('groupBy', 'expression'),
    req('buckets', 'number'),
    opt('output', 'accumulators'),
    opt('granularity', {
      enum: quoted([
        'R5',
        'R10',
        'R20',
        'R40',
        'R80',
        '1-2-5',
        'E6',
        'E12',
        'E24',
        'E48',
        'E96',
        'E192',
        'POWERSOF2'
      ])
    })
  ],
  $replaceRoot: [req('newRoot', 'expression')],
  $unionWith: [req('coll', 'collection'), opt('pipeline', 'pipeline')],
  $merge: [
    req('into', 'collection'),
    opt('on', 'fieldPaths'),
    opt('let', 'vars'),
    opt('whenMatched', { enum: quoted(['replace', 'keepExisting', 'merge', 'fail']) }),
    opt('whenNotMatched', { enum: quoted(['insert', 'discard', 'fail']) })
  ],
  $out: [opt('db', 'string'), req('coll', 'collection')],
  $sample: [req('size', 'number')],
  $setWindowFields: [
    opt('partitionBy', 'expression'),
    opt('sortBy', 'sort'),
    req('output', 'windowOutput')
  ],
  $densify: [
    req('field', 'fieldPath'),
    opt('partitionByFields', 'fieldPaths'),
    req('range', { args: '$densify.range' })
  ],
  '$densify.range': [
    req('step', 'number'),
    opt('unit', { enum: TIME_UNITS }),
    req('bounds', 'any')
  ],
  $fill: [
    opt('partitionBy', 'expression'),
    opt('partitionByFields', 'fieldPaths'),
    opt('sortBy', 'sort'),
    req('output', 'fillOutput')
  ],
  '$fill.output': [opt('value', 'expression'), opt('method', { enum: quoted(['linear', 'locf']) })],
  $geoNear: [
    req('near', 'any'),
    req('distanceField', 'string'),
    opt('spherical', 'bool'),
    opt('maxDistance', 'number'),
    opt('minDistance', 'number'),
    opt('query', 'query'),
    opt('includeLocs', 'string'),
    opt('distanceMultiplier', 'number'),
    opt('key', 'fieldPath')
  ],
  $collStats: [
    opt('latencyStats', 'object'),
    opt('storageStats', 'object'),
    opt('count', 'object'),
    opt('queryExecStats', 'object')
  ],
  window: [opt('documents', 'array'), opt('range', 'array'), opt('unit', { enum: TIME_UNITS })],
  $filter: [
    req('input', 'expression'),
    req('cond', 'boolExpr'),
    opt('as', 'string'),
    opt('limit', 'expression')
  ],
  $map: [req('input', 'expression'), opt('as', 'string'), req('in', 'expression')],
  $reduce: [req('input', 'expression'), req('initialValue', 'expression'), req('in', 'expression')],
  $firstN: [req('n', 'expression'), req('input', 'expression')],
  $lastN: [req('n', 'expression'), req('input', 'expression')],
  $maxN: [req('n', 'expression'), req('input', 'expression')],
  $minN: [req('n', 'expression'), req('input', 'expression')],
  $sortArray: [req('input', 'expression'), req('sortBy', 'any')],
  $zip: [
    req('inputs', 'expression'),
    opt('useLongestLength', 'bool'),
    opt('defaults', 'expression')
  ],
  $cond: [req('if', 'boolExpr'), req('then', 'expression'), req('else', 'expression')],
  $switch: [req('branches', 'array'), opt('default', 'expression')],
  $dateAdd: [
    req('startDate', 'dateExpr'),
    req('unit', { enum: TIME_UNITS }),
    req('amount', 'expression'),
    opt('timezone', 'expression')
  ],
  $dateSubtract: [
    req('startDate', 'dateExpr'),
    req('unit', { enum: TIME_UNITS }),
    req('amount', 'expression'),
    opt('timezone', 'expression')
  ],
  $dateDiff: [
    req('startDate', 'dateExpr'),
    req('endDate', 'dateExpr'),
    req('unit', { enum: TIME_UNITS }),
    opt('timezone', 'expression'),
    opt('startOfWeek', { enum: WEEKDAYS })
  ],
  $dateFromParts: [
    opt('year', 'expression'),
    opt('month', 'expression'),
    opt('day', 'expression'),
    opt('hour', 'expression'),
    opt('minute', 'expression'),
    opt('second', 'expression'),
    opt('millisecond', 'expression'),
    opt('isoWeekYear', 'expression'),
    opt('isoWeek', 'expression'),
    opt('isoDayOfWeek', 'expression'),
    opt('timezone', 'expression')
  ],
  $dateFromString: [
    req('dateString', 'expression'),
    opt('format', 'string'),
    opt('timezone', 'expression'),
    opt('onError', 'expression'),
    opt('onNull', 'expression')
  ],
  $dateToParts: [req('date', 'dateExpr'), opt('timezone', 'expression'), opt('iso8601', 'bool')],
  $dateToString: [
    req('date', 'dateExpr'),
    opt('format', 'string'),
    opt('timezone', 'expression'),
    opt('onNull', 'expression')
  ],
  $dateTrunc: [
    req('date', 'dateExpr'),
    req('unit', { enum: TIME_UNITS }),
    opt('binSize', 'expression'),
    opt('timezone', 'expression'),
    opt('startOfWeek', { enum: WEEKDAYS })
  ],
  $let: [req('vars', 'vars'), req('in', 'expression')],
  $getField: [req('field', 'string'), opt('input', 'expression')],
  $setField: [req('field', 'string'), req('input', 'expression'), req('value', 'expression')],
  $unsetField: [req('field', 'string'), req('input', 'expression')],
  $trim: [req('input', 'expression'), opt('chars', 'expression')],
  $ltrim: [req('input', 'expression'), opt('chars', 'expression')],
  $rtrim: [req('input', 'expression'), opt('chars', 'expression')],
  $regexFind: [req('input', 'expression'), req('regex', 'any'), opt('options', 'string')],
  $regexFindAll: [req('input', 'expression'), req('regex', 'any'), opt('options', 'string')],
  $regexMatch: [req('input', 'expression'), req('regex', 'any'), opt('options', 'string')],
  $replaceOne: [
    req('input', 'expression'),
    req('find', 'expression'),
    req('replacement', 'expression')
  ],
  $replaceAll: [
    req('input', 'expression'),
    req('find', 'expression'),
    req('replacement', 'expression')
  ],
  $convert: [
    req('input', 'expression'),
    req('to', {
      enum: quoted([
        'double',
        'string',
        'objectId',
        'bool',
        'date',
        'int',
        'long',
        'decimal',
        'binData'
      ])
    }),
    opt('onError', 'expression'),
    opt('onNull', 'expression')
  ],
  '$currentDate.field': [req('$type', { enum: quoted(['date', 'timestamp']) })],
  '$bit.field': [opt('and', 'number'), opt('or', 'number'), opt('xor', 'number')],
  ...Object.fromEntries(
    Object.entries(WRITE_OPTIONS).map(([method, options]) => [
      optionsOwner(method),
      optionSpecs(options)
    ])
  ),
  ...Object.fromEntries(
    BULK_WRITE_OPERATIONS.map((operation) => [
      bulkOperationOwner(operation),
      [
        ...BULK_OPERATION_FIELDS[operation].map((field) => req(field, FIELD_KINDS[field])),
        ...optionSpecs(BULK_OPERATION_OPTIONS[operation])
      ]
    ])
  )
}

/** How an expression operator takes its arguments. */
export type OperatorForm = 'positional' | 'single' | 'named' | 'none'

export type ExpressionOperator = {
  name: string
  doc: string
  form: OperatorForm
  returns?: BsonTypeName
  /** Type its arguments usually have; `compared`: the arguments are compared with each other. */
  args?: TypeClass | 'compared'
}

const expr = (
  name: string,
  form: OperatorForm,
  doc: string,
  returns?: BsonTypeName,
  args?: TypeClass | 'compared'
): ExpressionOperator => ({
  name,
  form,
  doc,
  returns,
  args
})

export const EXPRESSION_OPERATORS: readonly ExpressionOperator[] = [
  expr('$abs', 'single', 'Absolute value.', 'double', 'number'),
  expr('$add', 'positional', 'Sum of numbers, or a date plus milliseconds.', 'double', 'number'),
  expr('$ceil', 'single', 'Smallest integer ≥ the number.', 'double', 'number'),
  expr('$divide', 'positional', 'Divides the first number by the second.', 'double', 'number'),
  expr('$exp', 'single', 'e raised to the number.', 'double', 'number'),
  expr('$floor', 'single', 'Largest integer ≤ the number.', 'double', 'number'),
  expr('$ln', 'single', 'Natural logarithm.', 'double', 'number'),
  expr('$log', 'positional', 'Logarithm in a base.', 'double', 'number'),
  expr('$log10', 'single', 'Base-10 logarithm.', 'double', 'number'),
  expr('$mod', 'positional', 'Remainder of a division.', 'double', 'number'),
  expr('$multiply', 'positional', 'Product of numbers.', 'double', 'number'),
  expr('$pow', 'positional', 'Number raised to an exponent.', 'double', 'number'),
  expr('$round', 'positional', 'Rounds to a decimal place.', 'double', 'number'),
  expr('$sqrt', 'single', 'Square root.', 'double', 'number'),
  expr('$subtract', 'positional', 'Difference of numbers or dates.', 'double', 'number'),
  expr('$trunc', 'positional', 'Truncates to a decimal place.', 'double', 'number'),
  expr('$arrayElemAt', 'positional', 'Element at an index.'),
  expr('$arrayToObject', 'single', 'Converts [k, v] pairs to an object.', 'object', 'array'),
  expr('$concatArrays', 'positional', 'Concatenates arrays.', 'array', 'array'),
  expr('$filter', 'named', 'Elements that match a condition.', 'array'),
  expr('$first', 'single', 'First array element.', undefined, 'array'),
  expr('$firstN', 'named', 'First n array elements.', 'array'),
  expr('$in', 'positional', 'The value is in the array.', 'bool'),
  expr('$indexOfArray', 'positional', 'Index of a value in an array.', 'int'),
  expr('$isArray', 'positional', 'The value is an array.', 'bool'),
  expr('$last', 'single', 'Last array element.', undefined, 'array'),
  expr('$lastN', 'named', 'Last n array elements.', 'array'),
  expr('$map', 'named', 'Applies an expression to each element.', 'array'),
  expr('$maxN', 'named', 'n largest array elements.', 'array'),
  expr('$minN', 'named', 'n smallest array elements.', 'array'),
  expr('$objectToArray', 'single', 'Converts an object to [k, v] pairs.', 'array', 'object'),
  expr('$range', 'positional', 'Sequence of integers.', 'array'),
  expr('$reduce', 'named', 'Folds an array into one value.'),
  expr('$reverseArray', 'single', 'Array in reverse order.', 'array', 'array'),
  expr('$size', 'single', 'Number of array elements.', 'int', 'array'),
  expr('$slice', 'positional', 'Subset of an array.', 'array'),
  expr('$sortArray', 'named', 'Sorted array.', 'array'),
  expr('$zip', 'named', 'Transposes arrays.', 'array'),
  expr('$and', 'positional', 'True when every expression is true.', 'bool', 'bool'),
  expr('$or', 'positional', 'True when any expression is true.', 'bool', 'bool'),
  expr('$not', 'positional', 'Negates an expression.', 'bool', 'bool'),
  expr('$cmp', 'positional', '-1, 0 or 1 comparing two values.', 'int', 'compared'),
  expr('$eq', 'positional', 'Values are equal.', 'bool', 'compared'),
  expr('$ne', 'positional', 'Values are not equal.', 'bool', 'compared'),
  expr('$gt', 'positional', 'First value is greater.', 'bool', 'compared'),
  expr('$gte', 'positional', 'First value is greater or equal.', 'bool', 'compared'),
  expr('$lt', 'positional', 'First value is less.', 'bool', 'compared'),
  expr('$lte', 'positional', 'First value is less or equal.', 'bool', 'compared'),
  expr('$cond', 'named', 'If-then-else.'),
  expr('$ifNull', 'positional', 'First non-null value.'),
  expr('$switch', 'named', 'First branch whose case is true.'),
  expr('$dateAdd', 'named', 'Adds a time span to a date.', 'date'),
  expr('$dateDiff', 'named', 'Difference between dates in a unit.', 'long'),
  expr('$dateFromParts', 'named', 'Date from its parts.', 'date'),
  expr('$dateFromString', 'named', 'Parses a date string.', 'date'),
  expr('$dateSubtract', 'named', 'Subtracts a time span from a date.', 'date'),
  expr('$dateToParts', 'named', 'Parts of a date.', 'object'),
  expr('$dateToString', 'named', 'Formats a date.', 'string'),
  expr('$dateTrunc', 'named', 'Truncates a date to a unit.', 'date'),
  expr('$dayOfMonth', 'single', 'Day of month, 1-31.', 'int', 'date'),
  expr('$dayOfWeek', 'single', 'Day of week, 1 (Sunday) - 7.', 'int', 'date'),
  expr('$dayOfYear', 'single', 'Day of year, 1-366.', 'int', 'date'),
  expr('$hour', 'single', 'Hour, 0-23.', 'int', 'date'),
  expr('$isoDayOfWeek', 'single', 'ISO weekday, 1 (Monday) - 7.', 'int', 'date'),
  expr('$isoWeek', 'single', 'ISO week number.', 'int', 'date'),
  expr('$isoWeekYear', 'single', 'ISO week-numbering year.', 'int', 'date'),
  expr('$millisecond', 'single', 'Milliseconds, 0-999.', 'int', 'date'),
  expr('$minute', 'single', 'Minute, 0-59.', 'int', 'date'),
  expr('$month', 'single', 'Month, 1-12.', 'int', 'date'),
  expr('$second', 'single', 'Second, 0-60.', 'int', 'date'),
  expr('$week', 'single', 'Week of year, 0-53.', 'int', 'date'),
  expr('$year', 'single', 'Year.', 'int', 'date'),
  expr('$literal', 'single', 'A value taken literally, not as an expression.'),
  expr('$rand', 'none', 'Random number in [0, 1).', 'double'),
  expr('$let', 'named', 'Binds variables for an expression.'),
  expr('$getField', 'named', 'Value of a field, including names with $ or dots.'),
  expr('$setField', 'named', 'Object with a field set.', 'object'),
  expr('$unsetField', 'named', 'Object with a field removed.', 'object'),
  expr('$mergeObjects', 'positional', 'Merges objects.', 'object', 'object'),
  expr('$allElementsTrue', 'positional', 'No array element is false.', 'bool', 'array'),
  expr('$anyElementTrue', 'positional', 'Some array element is true.', 'bool', 'array'),
  expr(
    '$setDifference',
    'positional',
    'Elements of the first set not in the second.',
    'array',
    'array'
  ),
  expr('$setEquals', 'positional', 'Sets contain the same elements.', 'bool', 'array'),
  expr('$setIntersection', 'positional', 'Elements in every set.', 'array', 'array'),
  expr('$setIsSubset', 'positional', 'First set is a subset of the second.', 'bool', 'array'),
  expr('$setUnion', 'positional', 'Elements in any set.', 'array', 'array'),
  expr('$concat', 'positional', 'Concatenates strings.', 'string', 'string'),
  expr('$indexOfBytes', 'positional', 'Byte index of a substring.', 'int', 'string'),
  expr('$indexOfCP', 'positional', 'Code-point index of a substring.', 'int', 'string'),
  expr('$ltrim', 'named', 'Removes leading characters.', 'string'),
  expr('$regexFind', 'named', 'First regex match.', 'object'),
  expr('$regexFindAll', 'named', 'All regex matches.', 'array'),
  expr('$regexMatch', 'named', 'The string matches a regex.', 'bool'),
  expr('$replaceAll', 'named', 'Replaces every occurrence.', 'string'),
  expr('$replaceOne', 'named', 'Replaces the first occurrence.', 'string'),
  expr('$rtrim', 'named', 'Removes trailing characters.', 'string'),
  expr('$split', 'positional', 'Splits a string by a delimiter.', 'array', 'string'),
  expr('$strcasecmp', 'positional', 'Case-insensitive comparison.', 'int', 'string'),
  expr('$strLenBytes', 'single', 'Length in UTF-8 bytes.', 'int', 'string'),
  expr('$strLenCP', 'single', 'Length in code points.', 'int', 'string'),
  expr('$substrBytes', 'positional', 'Substring by bytes.', 'string', 'string'),
  expr('$substrCP', 'positional', 'Substring by code points.', 'string', 'string'),
  expr('$toLower', 'single', 'Lowercase string.', 'string', 'string'),
  expr('$toUpper', 'single', 'Uppercase string.', 'string', 'string'),
  expr('$trim', 'named', 'Removes leading and trailing characters.', 'string'),
  expr('$convert', 'named', 'Converts to a type, with error handling.'),
  expr('$isNumber', 'single', 'The value is a number.', 'bool'),
  expr('$toBool', 'single', 'Converts to bool.', 'bool'),
  expr('$toDate', 'single', 'Converts to date.', 'date'),
  expr('$toDecimal', 'single', 'Converts to decimal.', 'decimal'),
  expr('$toDouble', 'single', 'Converts to double.', 'double'),
  expr('$toInt', 'single', 'Converts to int.', 'int'),
  expr('$toLong', 'single', 'Converts to long.', 'long'),
  expr('$toObjectId', 'single', 'Converts to ObjectId.', 'objectId'),
  expr('$toString', 'single', 'Converts to string.', 'string'),
  expr('$type', 'single', 'BSON type name of the value.', 'string'),
  expr('$sum', 'positional', 'Sum of numbers.', 'double', 'number'),
  expr('$avg', 'positional', 'Average of numbers.', 'double', 'number'),
  expr('$max', 'positional', 'Largest value.'),
  expr('$min', 'positional', 'Smallest value.')
]

/** `EXPRESSION_OPERATORS` by name. */
export const EXPRESSIONS: ReadonlyMap<string, ExpressionOperator> = new Map(
  EXPRESSION_OPERATORS.map((op) => [op.name, op])
)

/** Result type of an accumulator: a BSON type, or derived from its argument. */
export type AccumulatorResult = BsonTypeName | 'arg' | 'argArray' | 'sum' | 'output'

export type AccumulatorDef = KeyDef & {
  returns: AccumulatorResult
  windowOnly?: boolean
  /** Type its argument usually has. */
  args?: TypeClass
}

const acc = (
  name: string,
  doc: string,
  returns: AccumulatorResult,
  template: Template,
  extra: { retrigger?: boolean; windowOnly?: boolean; args?: TypeClass } = {}
): AccumulatorDef => ({ name, doc, returns, template, ...extra })

const REF_ARG = { retrigger: true }
const NUMBER_REF_ARG = { retrigger: true, args: 'number' } as const

export const ACCUMULATORS: readonly AccumulatorDef[] = [
  acc('$sum', 'Sum; `1` counts documents.', 'sum', () => '${0:1}', { args: 'number' }),
  acc('$avg', 'Average.', 'double', FIELD_REF, NUMBER_REF_ARG),
  acc('$min', 'Smallest value.', 'arg', FIELD_REF, REF_ARG),
  acc('$max', 'Largest value.', 'arg', FIELD_REF, REF_ARG),
  acc('$first', 'Value of the first document.', 'arg', FIELD_REF, REF_ARG),
  acc('$last', 'Value of the last document.', 'arg', FIELD_REF, REF_ARG),
  acc('$push', 'Array of all values.', 'argArray', FIELD_REF, REF_ARG),
  acc('$addToSet', 'Array of distinct values.', 'argArray', FIELD_REF, REF_ARG),
  acc('$count', 'Number of documents.', 'int', () => '{}'),
  acc('$mergeObjects', 'Merges the objects.', 'arg', FIELD_REF, REF_ARG),
  acc('$stdDevPop', 'Population standard deviation.', 'double', FIELD_REF, NUMBER_REF_ARG),
  acc('$stdDevSamp', 'Sample standard deviation.', 'double', FIELD_REF, NUMBER_REF_ARG),
  acc(
    '$top',
    'Output of the top document by sortBy.',
    'output',
    (k) => `{ ${k('sortBy')}: { $1 }, ${k('output')}: "\\$$0" }`
  ),
  acc(
    '$bottom',
    'Output of the bottom document by sortBy.',
    'output',
    (k) => `{ ${k('sortBy')}: { $1 }, ${k('output')}: "\\$$0" }`
  ),
  acc(
    '$topN',
    'Outputs of the top n documents.',
    'array',
    (k) => `{ ${k('n')}: \${1:1}, ${k('sortBy')}: { $2 }, ${k('output')}: "\\$$0" }`
  ),
  acc(
    '$bottomN',
    'Outputs of the bottom n documents.',
    'array',
    (k) => `{ ${k('n')}: \${1:1}, ${k('sortBy')}: { $2 }, ${k('output')}: "\\$$0" }`
  ),
  acc(
    '$firstN',
    'First n values.',
    'array',
    (k) => `{ ${k('n')}: \${1:1}, ${k('input')}: "\\$$0" }`
  ),
  acc('$lastN', 'Last n values.', 'array', (k) => `{ ${k('n')}: \${1:1}, ${k('input')}: "\\$$0" }`),
  acc(
    '$maxN',
    'n largest values.',
    'array',
    (k) => `{ ${k('n')}: \${1:1}, ${k('input')}: "\\$$0" }`
  ),
  acc(
    '$minN',
    'n smallest values.',
    'array',
    (k) => `{ ${k('n')}: \${1:1}, ${k('input')}: "\\$$0" }`
  ),
  acc(
    '$median',
    'Approximate median.',
    'double',
    (k) => `{ ${k('input')}: "\\$$0", ${k('method')}: "approximate" }`
  ),
  acc(
    '$percentile',
    'Approximate percentiles.',
    'array',
    (k) => `{ ${k('input')}: "\\$$1", ${k('p')}: [\${0:0.95}], ${k('method')}: "approximate" }`
  ),
  acc('$rank', 'Rank by sortBy, with gaps.', 'int', () => '{}', { windowOnly: true }),
  acc('$denseRank', 'Rank by sortBy, without gaps.', 'int', () => '{}', { windowOnly: true }),
  acc('$documentNumber', 'Position in the partition.', 'int', () => '{}', { windowOnly: true }),
  acc(
    '$shift',
    'Value of a document at an offset.',
    'output',
    (k) => `{ ${k('output')}: "\\$$1", ${k('by')}: \${0:1} }`,
    { windowOnly: true }
  ),
  acc('$derivative', 'Rate of change.', 'double', (k) => `{ ${k('input')}: "\\$$0" }`, {
    windowOnly: true
  }),
  acc('$integral', 'Area under the curve.', 'double', (k) => `{ ${k('input')}: "\\$$0" }`, {
    windowOnly: true
  }),
  acc(
    '$expMovingAvg',
    'Exponential moving average.',
    'double',
    (k) => `{ ${k('input')}: "\\$$1", ${k('N')}: \${0:3} }`,
    { windowOnly: true }
  ),
  acc('$covariancePop', 'Population covariance.', 'double', () => '["\\$$1", "\\$$0"]', {
    windowOnly: true
  }),
  acc('$covarianceSamp', 'Sample covariance.', 'double', () => '["\\$$1", "\\$$0"]', {
    windowOnly: true
  }),
  acc('$linearFill', 'Fills nulls by linear interpolation.', 'arg', FIELD_REF, {
    retrigger: true,
    windowOnly: true
  }),
  acc('$locf', 'Fills nulls with the last non-null value.', 'arg', FIELD_REF, {
    retrigger: true,
    windowOnly: true
  })
]

/** `ACCUMULATORS` by name. */
export const ACCUMULATOR_DEFS: ReadonlyMap<string, AccumulatorDef> = new Map(
  ACCUMULATORS.map((def) => [def.name, def])
)

/** Window bounds next to a window accumulator. */
export const WINDOW_KEY: KeyDef = {
  name: 'window',
  doc: 'Window bounds: documents or range.',
  template: OBJECT,
  retrigger: true
}

/** BSON type each shell constructor produces. */
export const CONSTRUCTOR_TYPES: Readonly<Record<string, BsonTypeName>> = {
  ObjectId: 'objectId',
  ISODate: 'date',
  Date: 'date',
  NumberLong: 'long',
  Long: 'long',
  NumberInt: 'int',
  Int32: 'int',
  NumberDecimal: 'decimal',
  Decimal128: 'decimal',
  NumberDouble: 'double',
  Double: 'double',
  UUID: 'uuid',
  JUUID: 'uuidLegacy',
  BinData: 'binData',
  Timestamp: 'timestamp',
  Code: 'javascript',
  RegExp: 'regex',
  Symbol: 'symbol',
  DBRef: 'dbRef',
  MinKey: 'minKey',
  MaxKey: 'maxKey'
}

/** System variables, without the `$$` prefix. */
export const SYSTEM_VARIABLES: readonly string[] = [
  'ROOT',
  'CURRENT',
  'NOW',
  'REMOVE',
  'CLUSTER_TIME'
]

/** Grammar of a shell method argument; `options` is the options object of a write method. */
export type ShellArg =
  | 'query'
  | 'projection'
  | 'pipeline'
  | 'sort'
  | 'fieldName'
  | 'document'
  | 'documents'
  | 'update'
  | 'bulkOperations'
  | 'options'

const WRITE_ARGUMENT_KINDS: Readonly<Record<WriteArgument, ShellArg>> = {
  ...FIELD_KINDS,
  documents: 'documents',
  operations: 'bulkOperations'
}

/** Argument grammars of collection methods, by position. */
export const SHELL_METHOD_ARGS: Readonly<Record<string, readonly ShellArg[]>> = {
  find: ['query', 'projection'],
  findOne: ['query', 'projection'],
  aggregate: ['pipeline'],
  countDocuments: ['query'],
  count: ['query'],
  estimatedDocumentCount: [],
  distinct: ['fieldName', 'query'],
  ...Object.fromEntries(
    Object.entries(WRITE_ARGUMENTS).map(([method, args]): [string, ShellArg[]] => [
      method,
      [...args.map((arg) => WRITE_ARGUMENT_KINDS[arg]), 'options']
    ])
  )
}

/** Argument grammars of cursor methods after `find(…)`, by position. */
export const SHELL_CURSOR_ARGS: Readonly<Record<string, readonly ShellArg[]>> = {
  sort: ['sort'],
  projection: ['projection'],
  skip: [],
  limit: [],
  toArray: [],
  pretty: []
}

export type MethodDef = { template: string; doc: string; retrigger?: boolean }

const objectCall = (method: string, doc: string): MethodDef => ({
  template: `${method}({ $0 })`,
  doc,
  retrigger: true
})

const WRITE_METHOD_DEFS: Readonly<Record<WriteMethod, MethodDef>> = {
  insertOne: objectCall('insertOne', 'Inserts a document.'),
  insertMany: { template: 'insertMany([{ $0 }])', doc: 'Inserts documents.', retrigger: true },
  updateOne: objectCall('updateOne', 'Updates the first document matching a filter.'),
  updateMany: objectCall('updateMany', 'Updates every document matching a filter.'),
  replaceOne: objectCall('replaceOne', 'Replaces the first document matching a filter.'),
  deleteOne: objectCall('deleteOne', 'Deletes the first document matching a filter.'),
  deleteMany: objectCall('deleteMany', 'Deletes every document matching a filter.'),
  findOneAndUpdate: objectCall(
    'findOneAndUpdate',
    'Updates the first matching document and returns it.'
  ),
  findOneAndReplace: objectCall(
    'findOneAndReplace',
    'Replaces the first matching document and returns it.'
  ),
  findOneAndDelete: objectCall(
    'findOneAndDelete',
    'Deletes the first matching document and returns it.'
  ),
  bulkWrite: {
    template: 'bulkWrite([$0])',
    doc: 'Runs insert, update, replace and delete operations in one call.',
    retrigger: true
  }
}

/** Call templates of shell collection and cursor methods. */
export const SHELL_METHODS: Readonly<Record<string, MethodDef>> = {
  ...WRITE_METHOD_DEFS,
  find: objectCall('find', 'Documents matching a filter; chain sort, skip, limit, projection.'),
  findOne: objectCall('findOne', 'The first document matching a filter.'),
  aggregate: {
    template: 'aggregate([$0])',
    doc: 'Runs an aggregation pipeline; a final $out or $merge writes its output.',
    retrigger: true
  },
  countDocuments: objectCall('countDocuments', 'Exact count of matching documents.'),
  count: objectCall('count', 'Count; an empty filter uses the metadata estimate.'),
  estimatedDocumentCount: {
    template: 'estimatedDocumentCount()',
    doc: 'Count from collection metadata.'
  },
  distinct: { template: 'distinct("$0")', doc: 'Distinct values of a field.', retrigger: true },
  sort: objectCall('sort', 'Sort order.'),
  skip: { template: 'skip(${0:0})', doc: 'Skips documents.' },
  limit: { template: 'limit(${0:50})', doc: 'Maximum number of documents.' },
  projection: objectCall('projection', 'Fields to include or exclude.'),
  toArray: { template: 'toArray()', doc: 'All results as an array.' },
  pretty: { template: 'pretty()', doc: 'Formatted output (no effect here).' }
}
