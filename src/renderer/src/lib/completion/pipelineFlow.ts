/**
 * Field set of a collection after pipeline stages, derived from its sampled schema and the
 * stage ASTs; expression result types are inferred where the expression makes them evident.
 */
import type { BsonTypeName, CollectionSchema, SchemaField, TypeCounts } from '@shared/types'
import { addCounts, compareText, dominantType, resolveField } from '@shared/collectionSchema'
import { ACCUMULATOR_DEFS, CONSTRUCTOR_TYPES, EXPRESSIONS, NUMERIC_TYPES } from './catalog'
import {
  entryValue,
  stringValue,
  toStages,
  type AstNode,
  type ObjectNode,
  type StageAst
} from './scanner'

type SchemaOf = (coll: string) => CollectionSchema | null

export type ProjectionMode = 'include' | 'exclude' | null

/**
 * Field set after `stages` run on documents shaped like `input`.
 * @param input sampled schema of the pipeline's collection; null when unknown
 * @param schemaOf schemas of `$lookup`, `$graphLookup` and `$unionWith` targets
 * @returns null when the output shape is unknown
 */
export function applyStages(
  input: CollectionSchema | null,
  stages: readonly StageAst[],
  schemaOf: SchemaOf
): CollectionSchema | null {
  const shape = runStages(input ? toShape(input) : null, stages, schemaOf)
  return shape ? toSchema(shape) : null
}

/**
 * Inclusion or exclusion of a projection object, decided by its non-`_id` entries.
 * @returns null while no entry decides it
 */
export function projectionMode(node: ObjectNode): ProjectionMode {
  let include = false
  for (const entry of node.entries) {
    if (entry.key === '_id' || !entry.value) continue
    if (isFalsyFlag(entry.value)) return 'exclude'
    include = true
  }
  return include ? 'include' : null
}

/**
 * Path of a `"$path"` field reference.
 * @returns '' for a bare `$`; null for a `$$variable`, any other string and null
 */
export function fieldRefPath(value: string | null): string | null {
  return value !== null && value.startsWith('$') && !value.startsWith('$$') ? value.slice(1) : null
}

/**
 * Collection a `$lookup`, `$graphLookup` or `$unionWith` stage reads.
 * @returns null when the stage names none
 */
export function foreignCollection(stage: StageAst): string | null {
  if (stage.name === '$unionWith') {
    return stringValue(stage.body) ?? stringValue(entryValue(stage.body, 'coll'))
  }
  return stringValue(entryValue(stage.body, 'from'))
}

type Shape = { sampleSize: number; truncated: boolean; fields: Map<string, SchemaField> }

type ExprInfo = {
  types: TypeCounts
  elementTypes?: TypeCounts
  /** Path of a plain field reference whose subtree is copied; '' for `$$ROOT`. */
  ref?: string
  /** The reference becomes the elements of an array (`$push: "$x"`). */
  refAsElements?: boolean
  /** Fields of an object literal. */
  children?: [string, ExprInfo][]
}

const UNKNOWN: ExprInfo = { types: {} }
const IDENT_TYPES: Readonly<Record<string, BsonTypeName>> = {
  true: 'bool',
  false: 'bool',
  null: 'null',
  undefined: 'undefined',
  MinKey: 'minKey',
  MaxKey: 'maxKey'
}
/** Stages whose output is not documents of the input collection. */
const FOREIGN_OUTPUT = new Set([
  '$collStats',
  '$indexStats',
  '$documents',
  '$changeStream',
  '$currentOp',
  '$listSessions',
  '$listSearchIndexes',
  '$planCacheStats',
  '$searchMeta'
])

function runStages(
  input: Shape | null,
  stages: readonly StageAst[],
  schemaOf: SchemaOf
): Shape | null {
  let shape = input
  for (const stage of stages) shape = applyStage(shape, stage, schemaOf)
  return shape
}

function applyStage(input: Shape | null, stage: StageAst, schemaOf: SchemaOf): Shape | null {
  const body = stage.body
  if (FOREIGN_OUTPUT.has(stage.name)) return null
  // Stages that compute fields still yield those fields when the input is unknown.
  const shape = input ?? emptyShape(null)
  switch (stage.name) {
    case '$project':
      return body?.n === 'object' ? project(shape, body) : input
    case '$addFields':
    case '$set':
      return body?.n === 'object' ? addFields(shape, body) : input
    case '$unset':
      return input && unset(input, body)
    case '$group':
      return body?.n === 'object' ? group(shape, body) : input
    case '$unwind':
      return input && unwind(input, body)
    case '$lookup':
      return lookup(shape, body, foreignCollection(stage), schemaOf)
    case '$graphLookup':
      return graphLookup(shape, body, foreignCollection(stage), schemaOf)
    case '$replaceRoot':
      return reroot(shape, entryValue(body, 'newRoot'))
    case '$replaceWith':
      return reroot(shape, body)
    case '$count': {
      const name = stringValue(body)
      return name ? derivedShape(shape, [[name, { types: one('int', weight(shape)) }]]) : null
    }
    case '$sortByCount':
      return derivedShape(shape, [
        ['_id', inferExpr(body, shape) ?? UNKNOWN],
        ['count', { types: one('int', weight(shape)) }]
      ])
    case '$bucket':
    case '$bucketAuto':
      return bucket(shape, body, stage.name === '$bucketAuto')
    case '$facet':
      return body?.n === 'object' ? facet(shape, body, schemaOf) : null
    case '$unionWith':
      return unionWith(input, body, foreignCollection(stage), schemaOf)
    case '$setWindowFields':
      return windowFields(shape, entryValue(body, 'output'))
    case '$geoNear': {
      const distance = stringValue(entryValue(body, 'distanceField'))
      if (!distance) return input
      const out = cloneShape(shape)
      setDerived(out, distance, { types: one('double', weight(shape)) }, shape)
      return out
    }
    default:
      return input
  }
}

function project(shape: Shape, body: ObjectNode): Shape {
  const id = body.entries.find((entry) => entry.key === '_id')
  const idExcluded = !!id?.value && isFalsyFlag(id.value)
  const mode = projectionMode(body)
  if (mode === 'exclude' || (mode === null && idExcluded)) {
    const out = cloneShape(shape)
    exclude(out, body, '')
    return out
  }
  const out = emptyShape(shape)
  if (!idExcluded) copySubtree(shape, '_id', '_id', out)
  include(out, shape, body, '')
  return out
}

function exclude(out: Shape, node: ObjectNode, prefix: string): void {
  for (const entry of node.entries) {
    if (!entry.value) continue
    const path = join(prefix, entry.key)
    if (isFalsyFlag(entry.value)) removeSubtree(out, path)
    else if (isObjectLiteral(entry.value)) exclude(out, entry.value, path)
  }
}

function include(out: Shape, shape: Shape, node: ObjectNode, prefix: string): void {
  for (const entry of node.entries) {
    const value = entry.value
    if (!value) continue
    const path = join(prefix, entry.key)
    if (isFalsyFlag(value)) continue
    if (isTruthyFlag(value)) {
      ensurePath(out, shape, path.slice(0, Math.max(0, path.lastIndexOf('.'))))
      copySubtree(shape, canonical(shape, path), path, out)
    } else if (isObjectLiteral(value)) {
      ensurePath(out, shape, path)
      include(out, shape, value, path)
    } else setDerived(out, path, inferExpr(value, shape) ?? UNKNOWN, shape)
  }
}

function addFields(shape: Shape, body: ObjectNode): Shape {
  const out = cloneShape(shape)
  const assign = (node: ObjectNode, prefix: string): void => {
    for (const entry of node.entries) {
      if (!entry.value) continue
      const path = join(prefix, entry.key)
      // An embedded object literal adds fields to the existing subdocument instead of replacing it.
      if (isObjectLiteral(entry.value)) {
        if (!out.fields.has(path)) {
          out.fields.set(path, {
            path,
            docCount: shape.sampleSize,
            types: one('object', weight(shape))
          })
        }
        assign(entry.value, path)
      } else setDerived(out, path, inferExpr(entry.value, shape) ?? UNKNOWN, shape)
    }
  }
  assign(body, '')
  return out
}

function unset(shape: Shape, body: AstNode | null): Shape {
  const names = body?.n === 'array' ? body.items.map(stringValue) : [stringValue(body)]
  const out = cloneShape(shape)
  for (const name of names) if (name) removeSubtree(out, name)
  return out
}

function group(shape: Shape, body: ObjectNode): Shape {
  const fields: [string, ExprInfo][] = []
  for (const entry of body.entries) {
    if (!entry.value) continue
    fields.push([
      entry.key,
      entry.key === '_id'
        ? (inferExpr(entry.value, shape) ?? UNKNOWN)
        : accumulatorInfo(entry.value, shape)
    ])
  }
  return derivedShape(shape, fields)
}

function unwind(shape: Shape, body: AstNode | null): Shape {
  const path = fieldRefPath(stringValue(body?.n === 'string' ? body : entryValue(body, 'path')))
  if (path === null) return shape
  const out = cloneShape(shape)
  const field = lookupField(shape, path)
  if (field) {
    const types = field.elementTypes ?? withoutType(field.types, 'array')
    const unwound: SchemaField = { ...field, types }
    delete unwound.elementTypes
    out.fields.set(field.path, unwound)
  }
  const index = stringValue(entryValue(body, 'includeArrayIndex'))
  if (index) setDerived(out, index, { types: one('long', weight(shape)) }, shape)
  return out
}

function lookup(
  shape: Shape,
  body: AstNode | null,
  from: string | null,
  schemaOf: SchemaOf
): Shape {
  let foreign = from ? schemaOf(from) : null
  const pipeline = entryValue(body, 'pipeline')
  if (pipeline?.n === 'array') foreign = applyStages(foreign, toStages(pipeline.items), schemaOf)
  return joined(shape, stringValue(entryValue(body, 'as')), foreign, null)
}

function graphLookup(
  shape: Shape,
  body: AstNode | null,
  from: string | null,
  schemaOf: SchemaOf
): Shape {
  const depth = stringValue(entryValue(body, 'depthField'))
  return joined(shape, stringValue(entryValue(body, 'as')), from ? schemaOf(from) : null, depth)
}

/** Adds `as` as an array of foreign documents. */
function joined(
  shape: Shape,
  as: string | null,
  foreign: CollectionSchema | null,
  depthField: string | null
): Shape {
  if (!as) return shape
  const w = weight(shape)
  const out = cloneShape(shape)
  removeSubtree(out, as)
  out.fields.set(as, {
    path: as,
    docCount: shape.sampleSize,
    types: one('array', w),
    elementTypes: one('object', w)
  })
  for (const field of foreign?.fields ?? []) {
    out.fields.set(`${as}.${field.path}`, { ...field, path: `${as}.${field.path}` })
  }
  if (depthField) {
    const path = `${as}.${depthField}`
    out.fields.set(path, { path, docCount: shape.sampleSize, types: one('long', w) })
  }
  return out
}

function reroot(shape: Shape, node: AstNode | null | undefined): Shape | null {
  if (!node) return null
  if (node.n === 'string') {
    if (node.value === '$$ROOT' || node.value === '$$CURRENT') return shape
    const path = fieldRefPath(node.value)
    if (path === null) return null
    const field = lookupField(shape, path)
    const out = emptyShape(shape)
    if (!field) return out
    const prefix = `${field.path}.`
    for (const [path, child] of shape.fields) {
      if (path.startsWith(prefix)) {
        out.fields.set(path.slice(prefix.length), { ...child, path: path.slice(prefix.length) })
      }
    }
    return out
  }
  if (node.n !== 'object') return null
  const first = node.entries[0]
  if (first?.key === '$mergeObjects') {
    const args = first.value?.n === 'array' ? first.value.items : first.value ? [first.value] : []
    const out = emptyShape(shape)
    for (const arg of args) {
      for (const [path, field] of reroot(shape, arg)?.fields ?? []) out.fields.set(path, field)
    }
    return out
  }
  if (first?.key.startsWith('$')) return null
  return derivedShape(
    shape,
    node.entries.map((entry) => [entry.key, inferExpr(entry.value, shape) ?? UNKNOWN])
  )
}

function bucket(shape: Shape, body: AstNode | null, auto: boolean): Shape {
  const groupBy = inferExpr(entryValue(body, 'groupBy') ?? null, shape)
  const boundaries = entryValue(body, 'boundaries')
  const bound = boundaries?.n === 'array' ? inferExpr(boundaries.items[0] ?? null, shape) : null
  const w = weight(shape)
  const id: ExprInfo = auto
    ? {
        types: one('object', w),
        children: [
          ['min', { types: groupBy?.types ?? {} }],
          ['max', { types: groupBy?.types ?? {} }]
        ]
      }
    : { types: bound?.types ?? {} }
  const output = entryValue(body, 'output')
  const fields: [string, ExprInfo][] = [['_id', id]]
  if (output?.n === 'object') {
    for (const entry of output.entries) {
      if (entry.value) fields.push([entry.key, accumulatorInfo(entry.value, shape)])
    }
  } else fields.push(['count', { types: one('int', w) }])
  return derivedShape(shape, fields)
}

function facet(shape: Shape, body: ObjectNode, schemaOf: SchemaOf): Shape {
  const w = weight(shape)
  const out = emptyShape(shape)
  for (const entry of body.entries) {
    if (entry.value?.n !== 'array') continue
    const branch = runStages(shape, toStages(entry.value.items), schemaOf)
    out.fields.set(entry.key, {
      path: entry.key,
      docCount: shape.sampleSize,
      types: one('array', w),
      elementTypes: one('object', w)
    })
    for (const [path, field] of branch?.fields ?? []) {
      out.fields.set(`${entry.key}.${path}`, { ...field, path: `${entry.key}.${path}` })
    }
  }
  return out
}

function unionWith(
  input: Shape | null,
  body: AstNode | null,
  coll: string | null,
  schemaOf: SchemaOf
): Shape | null {
  const pipeline = entryValue(body, 'pipeline')
  let other = coll ? schemaOf(coll) : null
  if (pipeline?.n === 'array') other = applyStages(other, toStages(pipeline.items), schemaOf)
  if (!other) return input
  const out = cloneShape(input ?? emptyShape(null))
  for (const field of other.fields)
    if (!out.fields.has(field.path)) out.fields.set(field.path, field)
  return out
}

function windowFields(shape: Shape, output: AstNode | null | undefined): Shape {
  const out = cloneShape(shape)
  if (output?.n !== 'object') return out
  for (const entry of output.entries) {
    if (entry.value) setDerived(out, entry.key, accumulatorInfo(entry.value, shape), shape)
  }
  return out
}

/** Result of `{ $acc: arg }`; window bounds next to the operator are ignored. */
function accumulatorInfo(node: AstNode, shape: Shape): ExprInfo {
  if (node.n !== 'object') return UNKNOWN
  const entry = node.entries.find((e) => e.key !== 'window')
  const def = entry && ACCUMULATOR_DEFS.get(entry.key)
  if (!entry || !def) return UNKNOWN
  const w = weight(shape)
  switch (def.returns) {
    case 'sum': {
      const type = dominantType(inferExpr(entry.value, shape)?.types)
      return { types: one(type && NUMERIC_TYPES.has(type) ? type : 'double', w) }
    }
    case 'arg':
      return inferExpr(entry.value, shape) ?? UNKNOWN
    case 'argArray': {
      const arg = inferExpr(entry.value, shape)
      if (arg?.ref !== undefined) return { ...arg, refAsElements: true }
      return { types: one('array', w), elementTypes: arg?.types ?? {} }
    }
    case 'output':
      return inferExpr(entryValue(entry.value, 'output') ?? null, shape) ?? UNKNOWN
    default:
      return { types: one(def.returns, w) }
  }
}

function inferExpr(node: AstNode | null, shape: Shape): ExprInfo | null {
  if (!node) return null
  const w = weight(shape)
  switch (node.n) {
    case 'string': {
      const value = node.value
      if (value === '$$ROOT' || value === '$$CURRENT') return { types: one('object', w), ref: '' }
      if (value.startsWith('$$')) return null
      const path = fieldRefPath(value)
      if (path !== null) {
        const field = lookupField(shape, path)
        if (!field) return UNKNOWN
        return { types: field.types, elementTypes: field.elementTypes, ref: field.path }
      }
      return { types: one('string', w) }
    }
    case 'number':
      return { types: one(numberType(node.raw), w) }
    case 'ident': {
      const type = IDENT_TYPES[node.name]
      return type ? { types: one(type, w) } : null
    }
    case 'regex':
      return { types: one('regex', w) }
    case 'call': {
      const type = CONSTRUCTOR_TYPES[node.callee]
      return type ? { types: one(type, w) } : null
    }
    case 'array': {
      const elementTypes = node.items.reduce<TypeCounts>(
        (counts, item) => addCounts(counts, inferExpr(item, shape)?.types ?? {}),
        {}
      )
      return { types: one('array', w), elementTypes }
    }
    case 'object': {
      const first = node.entries[0]
      if (first?.key.startsWith('$')) {
        if (first.key === '$literal') return literalInfo(first.value, w)
        const returns = EXPRESSIONS.get(first.key)?.returns
        return returns ? { types: one(returns, w) } : UNKNOWN
      }
      return {
        types: one('object', w),
        children: node.entries.map((entry) => [entry.key, inferExpr(entry.value, shape) ?? UNKNOWN])
      }
    }
  }
}

function literalInfo(node: AstNode | null, w: number): ExprInfo {
  if (node?.n === 'string') return { types: one('string', w) }
  if (node?.n === 'number') return { types: one(numberType(node.raw), w) }
  return UNKNOWN
}

/** Writes `info` at `path` of `out`, replacing the subtree there. */
function setDerived(out: Shape, path: string, info: ExprInfo, input: Shape): void {
  removeSubtree(out, path)
  const w = weight(input)
  if (info.ref !== undefined) {
    copySubtree(input, info.ref, path, out)
    const root = out.fields.get(path)
    const types = info.ref === '' ? one('object', w) : (root?.types ?? info.types)
    out.fields.set(
      path,
      info.refAsElements
        ? {
            path,
            docCount: root?.docCount ?? input.sampleSize,
            types: one('array', w),
            elementTypes: types
          }
        : { ...root, path, docCount: root?.docCount ?? input.sampleSize, types }
    )
    return
  }
  const field: SchemaField = { path, docCount: input.sampleSize, types: info.types }
  if (info.elementTypes && Object.keys(info.elementTypes).length > 0)
    field.elementTypes = info.elementTypes
  out.fields.set(path, field)
  for (const [key, child] of info.children ?? []) setDerived(out, `${path}.${key}`, child, input)
}

function derivedShape(input: Shape, fields: readonly [string, ExprInfo][]): Shape {
  const out = emptyShape(input)
  for (const [path, info] of fields) setDerived(out, path, info, input)
  return out
}

/** Copies the field at `from` and its descendants to `to`; `from === ''` copies every field below `to`. */
function copySubtree(input: Shape, from: string, to: string, out: Shape): void {
  for (const [path, field] of input.fields) {
    let target: string
    if (from === '') target = `${to}.${path}`
    else if (path === from) target = to
    else if (path.startsWith(`${from}.`)) target = to + path.slice(from.length)
    else continue
    out.fields.set(target, { ...field, path: target })
  }
}

function removeSubtree(shape: Shape, path: string): void {
  for (const key of [...shape.fields.keys()]) {
    if (key === path || key.startsWith(`${path}.`)) shape.fields.delete(key)
  }
}

/** Adds `path` and its ancestors as objects, which an inclusion projection keeps around included subfields. */
function ensurePath(out: Shape, input: Shape, path: string): void {
  if (path === '') return
  const segments = path.split('.')
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.')
    if (out.fields.has(prefix)) continue
    const field = lookupField(input, prefix)
    out.fields.set(
      prefix,
      field
        ? { ...field, path: prefix }
        : { path: prefix, docCount: input.sampleSize, types: one('object', weight(input)) }
    )
  }
}

function lookupField(shape: Shape, path: string): SchemaField | undefined {
  return shape.fields.get(path) ?? resolveField(shape.fields, path)
}

function canonical(shape: Shape, path: string): string {
  return lookupField(shape, path)?.path ?? path
}

function isFalsyFlag(node: AstNode): boolean {
  return (
    (node.n === 'number' && Number(node.raw) === 0) || (node.n === 'ident' && node.name === 'false')
  )
}

function isTruthyFlag(node: AstNode): boolean {
  return (
    (node.n === 'number' && Number(node.raw) !== 0) || (node.n === 'ident' && node.name === 'true')
  )
}

function isObjectLiteral(node: AstNode): node is ObjectNode {
  return node.n === 'object' && !node.entries[0]?.key.startsWith('$')
}

function numberType(raw: string): BsonTypeName {
  const value = Number(raw)
  return /[.eE]/.test(raw) || !Number.isInteger(value) || Math.abs(value) > 0x7fffffff
    ? 'double'
    : 'int'
}

function one(type: BsonTypeName, count: number): TypeCounts {
  const counts: TypeCounts = {}
  counts[type] = count
  return counts
}

function withoutType(counts: TypeCounts, type: BsonTypeName): TypeCounts {
  const out: TypeCounts = { ...counts }
  delete out[type]
  return out
}

/** Count used for derived types, so a derived field is never typeless. */
function weight(shape: Shape): number {
  return Math.max(1, shape.sampleSize)
}

function toShape(schema: CollectionSchema): Shape {
  return {
    sampleSize: schema.sampleSize,
    truncated: schema.truncated,
    fields: new Map(schema.fields.map((field) => [field.path, field]))
  }
}

function toSchema(shape: Shape): CollectionSchema {
  return {
    sampleSize: shape.sampleSize,
    truncated: shape.truncated,
    fields: [...shape.fields.values()].sort((a, b) => compareText(a.path, b.path))
  }
}

function emptyShape(like: Shape | null): Shape {
  return {
    sampleSize: like?.sampleSize ?? 0,
    truncated: like?.truncated ?? false,
    fields: new Map()
  }
}

function cloneShape(shape: Shape): Shape {
  return { ...shape, fields: new Map(shape.fields) }
}

/** Dot path of `key` below `base` ('' = the root). */
export function join(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`
}
