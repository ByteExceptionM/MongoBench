/**
 * Field schema inference over canonical-EJSON documents. Runs in main (sampling a
 * collection) and in the renderer (folding loaded documents into a sampled schema).
 */
import type { BsonTypeName, CollectionSchema, SchemaField, TypeCounts } from './types'

export const MAX_SCHEMA_DEPTH = 8
export const MAX_SCHEMA_FIELDS = 1000
export const MAX_TRACKED_VALUES = 20
export const MAX_VALUE_LENGTH = 100
export const MAX_ARRAY_ELEMENTS = 50
export const MAP_KEY_LIMIT = 64
export const MAP_ID_MIN_KEYS = 8
export const MAP_ID_RATIO = 0.8
export const ID_KEY_RE =
  /^(?:[0-9a-f]{24}|[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|\d+)$/i

const TRACKED_TYPES: ReadonlySet<BsonTypeName> = new Set<BsonTypeName>([
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'objectId',
  'uuid',
  'uuidLegacy',
  'date'
])

type FieldState = {
  docCount: number
  types: TypeCounts
  elementTypes: TypeCounts
  values: Map<string, number>
  valuesTruncated: boolean
  mapLike: boolean
  /** Distinct child keys seen so far; drives the map-like decision. */
  childKeys: Set<string>
  idKeys: number
  /** Sequence number of the last document that contained the path. */
  seenIn: number
}

/**
 * Streaming schema inference over canonical-EJSON documents; `seed` continues an existing schema.
 * @param seed schema whose counters, values and map-like flags new documents add to
 * @returns `add` folds in one canonical document; `build` snapshots the schema
 */
export function createSchemaBuilder(seed?: CollectionSchema): {
  add: (canonicalDoc: unknown) => void
  build: () => CollectionSchema
} {
  const fields = new Map<string, FieldState>()
  let sampleSize = seed?.sampleSize ?? 0
  let truncated = seed?.truncated ?? false
  for (const field of seed?.fields ?? []) fields.set(field.path, seededState(field))

  const touch = (path: string): FieldState | null => {
    let state = fields.get(path)
    if (!state) {
      if (fields.size >= MAX_SCHEMA_FIELDS) {
        truncated = true
        return null
      }
      state = emptyState()
      fields.set(path, state)
    }
    if (state.seenIn !== sampleSize) {
      state.seenIn = sampleSize
      state.docCount++
    }
    return state
  }

  const collapse = (parent: string, state: FieldState): void => {
    state.mapLike = true
    state.childKeys = new Set()
    state.idKeys = 0
    const prefix = `${parent}.`
    for (const [path, child] of [...fields]) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const dot = rest.indexOf('.')
      if ((dot === -1 ? rest : rest.slice(0, dot)) === '*') continue
      const target = `${prefix}*${dot === -1 ? '' : rest.slice(dot)}`
      fields.delete(path)
      const existing = fields.get(target)
      fields.set(target, existing ? mergeStates(existing, child, sampleSize) : child)
    }
  }

  const childPath = (parent: string, key: string): string => {
    if (parent === '') return key
    const state = fields.get(parent)
    if (state && !state.mapLike && !state.childKeys.has(key)) {
      state.childKeys.add(key)
      if (ID_KEY_RE.test(key)) state.idKeys++
      const keys = state.childKeys.size
      if (
        keys > MAP_KEY_LIMIT ||
        (keys >= MAP_ID_MIN_KEYS && state.idKeys >= MAP_ID_RATIO * keys)
      ) {
        collapse(parent, state)
      }
    }
    return `${parent}.${state?.mapLike ? '*' : key}`
  }

  const recordChildren = (parent: string, obj: Record<string, unknown>, depth: number): void => {
    for (const key of Object.keys(obj)) {
      // `$`-prefixed keys cannot be addressed with dot notation.
      if (key.startsWith('$')) continue
      recordValue(childPath(parent, key), obj[key], depth + 1)
    }
  }

  const recordElements = (
    path: string,
    state: FieldState,
    elements: readonly unknown[],
    depth: number,
    nesting: number
  ): void => {
    for (const element of elements.slice(0, MAX_ARRAY_ELEMENTS)) {
      const type = classifyCanonical(element)
      increment(state.elementTypes, type)
      if (type === 'array') {
        // Nested arrays keep the path, as Mongo dot paths traverse them.
        if (nesting < MAX_SCHEMA_DEPTH) {
          recordElements(path, state, element as unknown[], depth, nesting + 1)
        }
        continue
      }
      trackValue(state, type, element)
      if (type === 'object' && depth < MAX_SCHEMA_DEPTH) {
        recordChildren(path, element as Record<string, unknown>, depth)
      }
    }
  }

  const recordValue = (path: string, value: unknown, depth: number): void => {
    const state = touch(path)
    if (!state) return
    const type = classifyCanonical(value)
    increment(state.types, type)
    if (type === 'array') {
      recordElements(path, state, value as unknown[], depth, 0)
      return
    }
    trackValue(state, type, value)
    if (type === 'object' && depth < MAX_SCHEMA_DEPTH) {
      recordChildren(path, value as Record<string, unknown>, depth)
    }
  }

  return {
    add: (canonicalDoc) => {
      if (classifyCanonical(canonicalDoc) !== 'object') return
      sampleSize++
      recordChildren('', canonicalDoc as Record<string, unknown>, 0)
    },
    build: () => ({
      sampleSize,
      fields: [...fields]
        .sort(([a], [b]) => compareText(a, b))
        .map(([path, state]) => toSchemaField(path, state)),
      truncated
    })
  }
}

/**
 * Field at a dot path; segments below a map-like object resolve to its `*` child.
 * @param path dot path as written in a query; numeric segments below arrays are skipped
 * @returns the field, or undefined when the schema has no such path
 */
export function resolveSchemaField(
  schema: CollectionSchema,
  path: string
): SchemaField | undefined {
  return resolveField(indexFields(schema), path)
}

/**
 * `resolveSchemaField` over fields keyed by their path.
 * @param fields every field of a schema, keyed by `SchemaField.path`
 * @returns the field, or undefined when there is no such path
 */
export function resolveField(
  fields: ReadonlyMap<string, SchemaField>,
  path: string
): SchemaField | undefined {
  return fields.get(canonicalPath(fields, path))
}

/**
 * Direct children of `parentPath` ('' = root), excluding `*` entries.
 * @param parentPath dot path, resolved through map-like objects
 * @returns children in schema order; empty below a map-like object
 */
export function childFields(schema: CollectionSchema, parentPath: string): SchemaField[] {
  const parent = parentPath === '' ? '' : canonicalPath(indexFields(schema), parentPath)
  const prefix = parent === '' ? '' : `${parent}.`
  return schema.fields.filter((field) => {
    if (!field.path.startsWith(prefix)) return false
    const rest = field.path.slice(prefix.length)
    return rest !== '' && rest !== '*' && !rest.includes('.')
  })
}

/**
 * Every addressable field (no `*` segments); map-like objects contribute their own field.
 * @returns fields in schema order
 */
export function addressableFields(schema: CollectionSchema): SchemaField[] {
  return schema.fields.filter((field) => isAddressable(field.path))
}

/**
 * Paths of `addressableFields`.
 * @returns dot paths in schema order
 */
export function schemaFieldPaths(schema: CollectionSchema): string[] {
  return addressableFields(schema).map((field) => field.path)
}

/**
 * Most frequent type, ignoring null/undefined unless nothing else occurs.
 * @returns null when `counts` is absent or all zero
 */
export function dominantType(counts: TypeCounts | undefined): BsonTypeName | null {
  if (!counts) return null
  let best: BsonTypeName | null = null
  let bestCount = 0
  for (const [type, count] of Object.entries(counts) as [BsonTypeName, number][]) {
    if (type === 'null' || type === 'undefined' || !count) continue
    if (count > bestCount) {
      best = type
      bestCount = count
    }
  }
  if (best) return best
  const nulls = counts.null ?? 0
  const undefinedCount = counts.undefined ?? 0
  if (nulls === 0 && undefinedCount === 0) return null
  return nulls >= undefinedCount ? 'null' : 'undefined'
}

/**
 * BSON type of one canonical-EJSON value.
 * @param value parsed canonical EJSON; a plain number is classified as double
 */
export function classifyCanonical(value: unknown): BsonTypeName {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'double'
  if (Array.isArray(value)) return 'array'
  if (typeof value !== 'object') return 'undefined'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 1) {
    switch (keys[0]) {
      case '$oid':
        return 'objectId'
      case '$date':
        return 'date'
      case '$numberInt':
        return 'int'
      case '$numberLong':
        return 'long'
      case '$numberDouble':
        return 'double'
      case '$numberDecimal':
        return 'decimal'
      case '$binary':
        return binaryType(obj['$binary'])
      case '$regularExpression':
        return 'regex'
      case '$timestamp':
        return 'timestamp'
      case '$minKey':
        return 'minKey'
      case '$maxKey':
        return 'maxKey'
      case '$symbol':
        return 'symbol'
      case '$code':
        return 'javascript'
      case '$dbPointer':
        return 'dbPointer'
      case '$undefined':
        return 'undefined'
    }
  }
  if (keys.length === 2 && '$code' in obj && '$scope' in obj) return 'javascript'
  if (typeof obj['$ref'] === 'string' && '$id' in obj) return 'dbRef'
  return 'object'
}

function binaryType(binary: unknown): BsonTypeName {
  const subType =
    typeof binary === 'object' && binary !== null
      ? (binary as Record<string, unknown>)['subType']
      : undefined
  const code = typeof subType === 'string' ? parseInt(subType, 16) : NaN
  if (code === 4) return 'uuid'
  if (code === 3) return 'uuidLegacy'
  return 'binData'
}

function emptyState(): FieldState {
  return {
    docCount: 0,
    types: {},
    elementTypes: {},
    values: new Map(),
    valuesTruncated: false,
    mapLike: false,
    childKeys: new Set(),
    idKeys: 0,
    seenIn: -1
  }
}

function seededState(field: SchemaField): FieldState {
  return {
    ...emptyState(),
    docCount: field.docCount,
    types: { ...field.types },
    elementTypes: { ...field.elementTypes },
    values: new Map((field.values ?? []).map((v) => [v.ejson, v.count])),
    valuesTruncated: field.valuesTruncated ?? false,
    mapLike: field.mapLike ?? false
  }
}

function mergeStates(a: FieldState, b: FieldState, sampleSize: number): FieldState {
  const values = new Map(a.values)
  for (const [ejson, count] of b.values) values.set(ejson, (values.get(ejson) ?? 0) + count)
  const overflow = values.size > MAX_TRACKED_VALUES
  const kept = overflow ? new Map(sortValues(values).slice(0, MAX_TRACKED_VALUES)) : values
  const childKeys = new Set([...a.childKeys, ...b.childKeys])
  // Leaves the current document to the next touch() unless a merged key already counted it.
  const cap = Math.max(a.seenIn, b.seenIn) === sampleSize ? sampleSize : sampleSize - 1
  return {
    // Approximation: a document holding several of the merged keys counts once per key.
    docCount: Math.min(cap, a.docCount + b.docCount),
    types: addCounts(a.types, b.types),
    elementTypes: addCounts(a.elementTypes, b.elementTypes),
    values: kept,
    valuesTruncated: overflow || a.valuesTruncated || b.valuesTruncated,
    mapLike: a.mapLike || b.mapLike,
    childKeys,
    idKeys: [...childKeys].filter((key) => ID_KEY_RE.test(key)).length,
    seenIn: Math.max(a.seenIn, b.seenIn)
  }
}

/**
 * Sum of two type counts.
 * @returns a new object; `a` and `b` are not changed
 */
export function addCounts(a: TypeCounts, b: TypeCounts): TypeCounts {
  const out: TypeCounts = { ...a }
  for (const [type, count] of Object.entries(b) as [BsonTypeName, number][]) {
    out[type] = (out[type] ?? 0) + count
  }
  return out
}

function increment(counts: TypeCounts, type: BsonTypeName): void {
  counts[type] = (counts[type] ?? 0) + 1
}

function trackValue(state: FieldState, type: BsonTypeName, value: unknown): void {
  if (!TRACKED_TYPES.has(type)) return
  if (type === 'string' && (value as string).length > MAX_VALUE_LENGTH) return
  const ejson = JSON.stringify(value)
  const count = state.values.get(ejson)
  if (count !== undefined) state.values.set(ejson, count + 1)
  else if (state.values.size >= MAX_TRACKED_VALUES) state.valuesTruncated = true
  else state.values.set(ejson, 1)
}

function sortValues(values: Map<string, number>): [string, number][] {
  return [...values].sort(([a, ca], [b, cb]) => cb - ca || compareText(a, b))
}

function toSchemaField(path: string, state: FieldState): SchemaField {
  const field: SchemaField = { path, docCount: state.docCount, types: { ...state.types } }
  if (Object.keys(state.elementTypes).length > 0) field.elementTypes = { ...state.elementTypes }
  if (state.values.size > 0) {
    field.values = sortValues(state.values).map(([ejson, count]) => ({ ejson, count }))
  }
  if (state.valuesTruncated) field.valuesTruncated = true
  if (state.mapLike) field.mapLike = true
  return field
}

const fieldIndexes = new WeakMap<CollectionSchema, Map<string, SchemaField>>()

function indexFields(schema: CollectionSchema): Map<string, SchemaField> {
  let index = fieldIndexes.get(schema)
  if (!index) {
    index = new Map(schema.fields.map((field) => [field.path, field]))
    fieldIndexes.set(schema, index)
  }
  return index
}

function canonicalPath(index: ReadonlyMap<string, SchemaField>, path: string): string {
  let current = ''
  for (const segment of path.split('.')) {
    const parent = current === '' ? undefined : index.get(current)
    if (parent?.mapLike) {
      current = `${current}.*`
      continue
    }
    // `items.0.name` addresses an element; elements share their array's path.
    if (parent?.types.array && /^\d+$/.test(segment) && !index.has(`${current}.${segment}`)) {
      continue
    }
    current = current === '' ? segment : `${current}.${segment}`
  }
  return current
}

function isAddressable(path: string): boolean {
  return !path.split('.').includes('*')
}

/**
 * Orders strings by UTF-16 code units, as the default sort does.
 * @returns negative, zero or positive
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
