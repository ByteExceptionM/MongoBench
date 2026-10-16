/**
 * Classifies the cursor of a query, pipeline, shell or document editor into a Mongo-semantic
 * position by walking the scanner's open frames with a grammar per container.
 */
import { BULK_WRITE_OPERATIONS } from '@shared/writeOps'
import {
  ACCUMULATOR_DEFS,
  ARG_SPECS,
  EXPRESSIONS,
  FIELD_OPERATORS,
  POSITIONAL_SEGMENT,
  SHELL_CURSOR_ARGS,
  SHELL_METHOD_ARGS,
  UPDATE_OPERATORS,
  bulkOperationOwner,
  optionsOwner,
  withoutPositional,
  type ArgKind,
  type ArrayModifierOwner,
  type ShellArg,
  type TypeClass
} from './catalog'
import {
  fieldRefPath,
  foreignCollection,
  join,
  projectionMode,
  type ProjectionMode
} from './pipelineFlow'
import {
  entryValue,
  scan,
  stringValue,
  toStages,
  type ArrayNode,
  type AstNode,
  type Frame,
  type ObjectNode,
  type StageAst,
  type TokenSpan
} from './scanner'

export type EditorKind = 'filter' | 'projection' | 'sort' | 'pipeline' | 'shell' | 'document'

/** Fields of `coll` as they look after `stages` ran. */
export type FieldSource = { coll: string; stages: readonly StageAst[] }

/** A field of a field source. */
export type FieldRef = { source: FieldSource; path: string }

/** Field type a value slot ranks first: a type class, or the type of a referenced field. */
export type Prefer = TypeClass | FieldRef

/** An aggregation variable; `field` is the field it holds (the elements, for an array). */
export type Variable = { name: string; field?: FieldRef }

/** A pipeline inside a `$facet` branch, inside a `$lookup` / `$unionWith` stage, or an update pipeline. */
export type Nesting = 'facet' | 'sub' | 'update'

/** A `$[name]` placeholder of an update and the array path it stands for. */
export type ArrayIdentifier = { name: string; path: string }

export type Position =
  | { at: 'none' }
  /** A value slot that takes an object or array, e.g. an empty filter. */
  | { at: 'rootValue'; expect: 'object' | 'array' }
  /** `base` is the `$elemMatch` path the keys are relative to; `childrenOnly` offers only its direct children. */
  | {
      at: 'queryKey'
      source: FieldSource
      base: string
      present: string[]
      topLevel: boolean
      childrenOnly?: boolean
    }
  | { at: 'operatorKey'; source: FieldSource; field: string; present: string[] }
  | { at: 'elemMatchKey'; source: FieldSource; field: string; present: string[] }
  | {
      at: 'queryValue'
      source: FieldSource
      field: string
      operator: string | null
      inArray: boolean
      /** Other elements of the enclosing array as normalized literals. */
      siblings: string[]
    }
  | { at: 'ctorArg'; source: FieldSource; field: string | null; ctor: string }
  | { at: 'typeAlias'; source: FieldSource; field: string }
  | { at: 'literal'; values: readonly string[]; preferred?: string }
  | { at: 'textKey' | 'jsonSchemaKey' | 'geoKey'; present: string[] }
  | { at: 'projectionKey'; source: FieldSource; present: string[] }
  | { at: 'projectionValue'; source: FieldSource; field: string; mode: ProjectionMode }
  /** Keys of a projection field's object: `$slice`, `$elemMatch`, `$meta`, subfields, expressions. */
  | { at: 'projectionOperatorKey'; source: FieldSource; field: string; present: string[] }
  | { at: 'sortKey'; source: FieldSource; present: string[] }
  | { at: 'sortValue'; source: FieldSource; field: string }
  /** `finalWrite`: `$out` / `$merge` may end the pipeline here. */
  | { at: 'stageElement'; stageIndex: number; nested?: Nesting; finalWrite?: boolean }
  | {
      at: 'stageKey'
      stageIndex: number
      present: string[]
      nested?: Nesting
      finalWrite?: boolean
    }
  /** Named arguments of a stage or nested stage object (`ARG_SPECS` owner); `present` includes those it cannot take. */
  | { at: 'stageArgKey'; stage: string; present: string[] }
  | { at: 'newFieldKey'; source: FieldSource; present: string[]; group: boolean }
  | { at: 'accumulatorKey'; window: boolean; present: string[] }
  /** `literalBase`: an object literal whose keys name subfields of that path ('' = root fields). */
  | {
      at: 'expressionKey'
      source: FieldSource
      present: string[]
      prefer?: Prefer
      literalBase?: string
    }
  | { at: 'expressionValue'; source: FieldSource; vars: readonly Variable[]; prefer?: Prefer }
  | { at: 'operatorArgKey'; operator: string; present: string[] }
  /** `renaming`: the field a `$rename` moves; the names are its targets. */
  | { at: 'fieldName'; source: FieldSource; prefer?: Prefer; renaming?: string }
  | { at: 'collectionName' }
  | { at: 'shellRoot' }
  | { at: 'shellCollection' }
  | { at: 'shellMethod'; coll: string }
  | { at: 'shellCursorMethod'; head: string; used: string[] }
  /** `modifiersOf`: the object is a `$push` / `$addToSet` value, which may hold that operator's modifiers. */
  | {
      at: 'documentKey'
      coll: string
      path: string
      present: string[]
      modifiersOf?: ArrayModifierOwner
    }
  /** `element`: the value is an element of the array at `path`. */
  | {
      at: 'documentValue'
      coll: string
      path: string
      element: boolean
      modifiersOf?: ArrayModifierOwner
    }
  | { at: 'updateKey'; present: string[] }
  /** Field paths an update operator changes; `present` includes those other operators change. */
  | { at: 'updateFieldKey'; source: FieldSource; op: string; present: string[] }
  /** Value of `$inc`, `$mul`, `$unset`, `$pop`, `$currentDate` or `$bit` for `field`. */
  | { at: 'updateValue'; source: FieldSource; op: string; field: string }
  | {
      at: 'arrayFilterKey'
      source: FieldSource
      identifiers: readonly ArrayIdentifier[]
      present: string[]
    }
  | { at: 'bulkOperationElement' }
  | { at: 'bulkOperationKey' }

export type CompletionContext = {
  kind: EditorKind
  position: Position
  token: TokenSpan
  /** Schemas the suggestions may need: the editor's/command's collection first, then $lookup/$graphLookup/$unionWith targets. */
  collections: string[]
  /** '"' when the text uses quoted keys and no unquoted ones; null means shell-style keys. */
  keyQuote: '"' | null
}

/**
 * Classifies the cursor position of `text` at `offset` for an editor of `kind` bound to collection `coll`.
 * @returns the position plus the token span and the collections whose schemas apply
 */
export function analyzeContext(
  text: string,
  offset: number,
  kind: EditorKind,
  coll: string
): CompletionContext {
  const root = kind === 'shell' ? 'shell' : kind === 'document' ? 'documents' : 'value'
  const result = scan(text, offset, root)
  const walker = new Walker(result.frames, coll)
  const position = result.dead ? NONE : walker.position(kind)
  return {
    kind,
    position,
    token: result.token,
    collections: walker.collections(),
    keyQuote: result.quotedKeys && !result.unquotedKeys ? '"' : null
  }
}

/** Grammar of the value a frame (or the cursor's slot) holds. */
type Grammar =
  | { g: 'opaque' }
  | { g: 'query'; source: FieldSource; base: string; topLevel: boolean; vars: readonly Variable[] }
  | { g: 'queryList'; source: FieldSource; base: string; vars: readonly Variable[] }
  /** Value of a query field: a literal, an operator object, an array or a constructor. */
  | { g: 'field'; source: FieldSource; field: string }
  | {
      g: 'opValue'
      source: FieldSource
      field: string
      operator: string | null
      inArray: boolean
      siblings: string[]
    }
  | { g: 'elemMatch'; source: FieldSource; field: string }
  | { g: 'literal'; values: readonly string[]; preferred?: string }
  | { g: 'typeAlias'; source: FieldSource; field: string }
  | { g: 'text' }
  | { g: 'geo' }
  | { g: 'jsonSchema'; source: FieldSource; base: string }
  | { g: 'jsonProps'; source: FieldSource; base: string }
  | { g: 'projection'; source: FieldSource }
  | { g: 'projField'; source: FieldSource; field: string; mode: ProjectionMode }
  | { g: 'sort'; source: FieldSource }
  | { g: 'sortField'; source: FieldSource; field: string }
  /** `writes`: the pipeline may end with `$out` / `$merge`. */
  | {
      g: 'pipeline'
      source: FieldSource
      vars: readonly Variable[]
      nested?: Nesting
      writes?: boolean
    }
  | {
      g: 'stage'
      source: FieldSource
      index: number
      vars: readonly Variable[]
      nested?: Nesting
      finalWrite?: boolean
    }
  /** `compared`: the arguments of a comparison, each preferring the type of a field another one references. */
  | {
      g: 'expression'
      source: FieldSource
      vars: readonly Variable[]
      prefer?: Prefer
      compared?: boolean
      literalBase?: string
    }
  | { g: 'opArgs'; operator: string; source: FieldSource; vars: readonly Variable[] }
  /** Named arguments of `ARG_SPECS[owner]`; `scalar` is the grammar of a non-object value, `update` the update `arrayFilters` refer to. */
  | {
      g: 'args'
      owner: string
      source: FieldSource
      vars: readonly Variable[]
      scalar?: Grammar
      update?: AstNode
    }
  /** `$addFields` / `$set` body, or a `$group` body when `group`. */
  | { g: 'newFields'; source: FieldSource; vars: readonly Variable[]; group: boolean }
  /** Named outputs whose values are accumulator objects. */
  | { g: 'outputs'; source: FieldSource; vars: readonly Variable[]; window: boolean }
  | { g: 'fillOutput'; source: FieldSource; vars: readonly Variable[] }
  | { g: 'accumulator'; source: FieldSource; vars: readonly Variable[]; window: boolean }
  | { g: 'facet'; source: FieldSource; vars: readonly Variable[] }
  | { g: 'letVars'; source: FieldSource; vars: readonly Variable[] }
  | { g: 'fieldName'; source: FieldSource; prefer?: Prefer; renaming?: string }
  | { g: 'collection' }
  /** An object stored at `path` of a document ('' = the document itself). */
  | { g: 'document'; coll: string; path: string }
  | { g: 'docValue'; coll: string; path: string; element: boolean }
  /** An array whose elements all have grammar `of`. */
  | { g: 'list'; of: Grammar }
  | { g: 'update'; source: FieldSource }
  /** The object under update operator `op`; `taken` are the fields other operators change. */
  | { g: 'updateFields'; source: FieldSource; op: string; taken: readonly string[] }
  | { g: 'updateValue'; source: FieldSource; op: string; field: string }
  /** Value of a `$push` / `$addToSet` field: an element, or an object of modifiers. */
  | { g: 'arrayPush'; coll: string; path: string; op: ArrayModifierOwner }
  /** `$push` `$sort` by direction or by element fields. */
  | { g: 'elementSort'; coll: string; path: string }
  /** Value of a `$pull` field: an element or a condition on the elements. */
  | { g: 'pull'; source: FieldSource; field: string }
  | { g: 'bulkOperation'; source: FieldSource }
  | { g: 'arrayFilters'; source: FieldSource; identifiers: readonly ArrayIdentifier[] }
  /** One `arrayFilters` condition; `used`: identifiers the other conditions filter. */
  | {
      g: 'arrayFilter'
      source: FieldSource
      identifiers: readonly ArrayIdentifier[]
      used: readonly string[]
    }

const NONE: Position = { at: 'none' }
const ROOT_OBJECT: Position = { at: 'rootValue', expect: 'object' }
const ROOT_ARRAY: Position = { at: 'rootValue', expect: 'array' }
const OPAQUE: Grammar = { g: 'opaque' }
const COLLECTION: Grammar = { g: 'collection' }
const BOOL: Grammar = { g: 'literal', values: ['true', 'false'] }
const SORT_DIRECTION: Grammar = { g: 'literal', values: ['1', '-1'], preferred: '1' }
const LOGICAL = new Set(['$and', '$or', '$nor'])
const GEO_OPERATORS = new Set(
  FIELD_OPERATORS.filter((op) => op.fits === 'geo').map((op) => op.name)
)
const UPDATE_OPERATOR_NAMES = new Set(UPDATE_OPERATORS.map((op) => op.name))
const BULK_OPERATIONS: ReadonlySet<string> = new Set(BULK_WRITE_OPERATIONS)
const ARRAY_IDENTIFIER = /^\$\[([a-z][A-Za-z0-9]*)\]$/

class Walker {
  private readonly sources: FieldSource[] = []
  private commandColl: string | null = null

  constructor(
    private readonly frames: readonly Frame[],
    private readonly coll: string
  ) {}

  position(kind: EditorKind): Position {
    switch (kind) {
      case 'filter':
        return this.resolve(
          { g: 'query', source: this.source(this.coll), base: '', topLevel: true, vars: [] },
          0
        )
      case 'projection':
        return this.resolve({ g: 'projection', source: this.source(this.coll) }, 0)
      case 'sort':
        return this.resolve({ g: 'sort', source: this.source(this.coll) }, 0)
      case 'pipeline':
        return this.resolve({ g: 'pipeline', source: this.source(this.coll), vars: [] }, 0)
      case 'document':
        return this.resolve({ g: 'document', coll: this.coll, path: '' }, 0)
      case 'shell':
        return this.shell()
    }
  }

  collections(): string[] {
    const out: string[] = []
    const add = (name: string | null): void => {
      if (name && !out.includes(name)) out.push(name)
    }
    add(this.commandColl ?? this.coll)
    for (const source of this.sources) {
      add(source.coll)
      collectTargets(source.stages, add)
    }
    return out
  }

  private source(coll: string, stages: readonly StageAst[] = []): FieldSource {
    const source = { coll, stages }
    this.sources.push(source)
    return source
  }

  private resolve(grammar: Grammar, depth: number): Position {
    const frame = this.frames[depth]
    if (!frame) return this.slot(grammar)
    switch (frame.f) {
      case 'object':
        if (frame.slot === 'key') return this.key(grammar, frame.node)
        if (frame.slot === 'value' && frame.key !== null) {
          return this.resolve(this.child(grammar, frame.key, frame.node), depth + 1)
        }
        return NONE
      case 'array':
        if (frame.slot !== 'element') return NONE
        return this.resolve(this.element(grammar, frame.node, frame.index, frame.more), depth + 1)
      case 'call':
        if (frame.slot !== 'arg' || frame.argIndex !== 0 || depth !== this.frames.length - 1) {
          return NONE
        }
        return this.ctorArg(grammar, frame.callee)
      case 'chain':
        return NONE
    }
  }

  /** The cursor sits directly in a value slot of `grammar`, possibly on a partial word or string. */
  private slot(grammar: Grammar): Position {
    switch (grammar.g) {
      case 'query':
      case 'elemMatch':
      case 'text':
      case 'geo':
      case 'jsonSchema':
      case 'jsonProps':
      case 'projection':
      case 'sort':
      case 'opArgs':
      case 'newFields':
      case 'outputs':
      case 'fillOutput':
      case 'facet':
      case 'letVars':
      case 'document':
      case 'update':
      case 'updateFields':
      case 'arrayFilter':
        return ROOT_OBJECT
      case 'queryList':
      case 'pipeline':
      case 'list':
      case 'arrayFilters':
        return ROOT_ARRAY
      case 'field':
      case 'pull':
        return {
          at: 'queryValue',
          source: grammar.source,
          field: grammar.field,
          operator: null,
          inArray: false,
          siblings: []
        }
      case 'opValue':
        return {
          at: 'queryValue',
          source: grammar.source,
          field: grammar.field,
          operator: grammar.operator,
          inArray: grammar.inArray,
          siblings: grammar.siblings
        }
      case 'literal':
        return { at: 'literal', values: grammar.values, preferred: grammar.preferred }
      case 'typeAlias':
        return { at: 'typeAlias', source: grammar.source, field: grammar.field }
      case 'projField':
        return {
          at: 'projectionValue',
          source: grammar.source,
          field: grammar.field,
          mode: grammar.mode
        }
      case 'sortField':
        return { at: 'sortValue', source: grammar.source, field: grammar.field }
      case 'stage':
        return {
          at: 'stageElement',
          stageIndex: grammar.index,
          nested: grammar.nested,
          finalWrite: grammar.finalWrite
        }
      case 'expression':
        return {
          at: 'expressionValue',
          source: grammar.source,
          vars: grammar.vars,
          prefer: grammar.prefer
        }
      case 'args':
        return grammar.scalar ? this.slot(grammar.scalar) : ROOT_OBJECT
      case 'fieldName':
        return {
          at: 'fieldName',
          source: grammar.source,
          prefer: grammar.prefer,
          renaming: grammar.renaming
        }
      case 'collection':
        return { at: 'collectionName' }
      case 'docValue':
        return {
          at: 'documentValue',
          coll: grammar.coll,
          path: grammar.path,
          element: grammar.element
        }
      case 'arrayPush':
        return {
          at: 'documentValue',
          coll: grammar.coll,
          path: grammar.path,
          element: true,
          modifiersOf: grammar.op
        }
      case 'updateValue':
        return { at: 'updateValue', source: grammar.source, op: grammar.op, field: grammar.field }
      case 'elementSort':
        return this.slot(SORT_DIRECTION)
      case 'bulkOperation':
        return { at: 'bulkOperationElement' }
      case 'accumulator':
      case 'opaque':
        return NONE
    }
  }

  /** The cursor sits in the key slot of an object whose grammar is `grammar`. */
  private key(grammar: Grammar, node: ObjectNode): Position {
    const present = node.entries.map((entry) => entry.key)
    switch (grammar.g) {
      case 'query':
        return {
          at: 'queryKey',
          source: grammar.source,
          base: grammar.base,
          present,
          topLevel: grammar.topLevel
        }
      case 'jsonProps':
        // Property names are literal keys of one level, never dotted paths.
        return {
          at: 'queryKey',
          source: grammar.source,
          base: grammar.base,
          present,
          topLevel: false,
          childrenOnly: true
        }
      case 'field':
        return { at: 'operatorKey', source: grammar.source, field: grammar.field, present }
      case 'elemMatch':
      case 'pull':
        return { at: 'elemMatchKey', source: grammar.source, field: grammar.field, present }
      case 'text':
        return { at: 'textKey', present }
      case 'geo':
        return { at: 'geoKey', present }
      case 'jsonSchema':
        return { at: 'jsonSchemaKey', present }
      case 'projection':
        return { at: 'projectionKey', source: grammar.source, present }
      case 'projField':
        return {
          at: 'projectionOperatorKey',
          source: grammar.source,
          field: grammar.field,
          present
        }
      case 'sort':
        return { at: 'sortKey', source: grammar.source, present }
      case 'stage':
        return {
          at: 'stageKey',
          stageIndex: grammar.index,
          present,
          nested: grammar.nested,
          finalWrite: grammar.finalWrite
        }
      case 'expression':
        return {
          at: 'expressionKey',
          source: grammar.source,
          present,
          prefer: grammar.prefer,
          literalBase: grammar.literalBase
        }
      case 'opArgs':
        return { at: 'operatorArgKey', operator: grammar.operator, present }
      case 'args': {
        // A pipeline-style update takes no arrayFilters.
        const pipeline = (grammar.update ?? entryValue(node, 'update'))?.n === 'array'
        return {
          at: 'stageArgKey',
          stage: grammar.owner,
          present: pipeline ? [...present, 'arrayFilters'] : present
        }
      }
      case 'newFields':
        return { at: 'newFieldKey', source: grammar.source, present, group: grammar.group }
      case 'outputs':
      case 'fillOutput':
      case 'facet':
        return { at: 'newFieldKey', source: grammar.source, present, group: false }
      case 'accumulator':
        return { at: 'accumulatorKey', window: grammar.window, present }
      case 'document':
      case 'docValue':
      case 'elementSort':
        return { at: 'documentKey', coll: grammar.coll, path: grammar.path, present }
      case 'arrayPush':
        return {
          at: 'documentKey',
          coll: grammar.coll,
          path: grammar.path,
          present,
          modifiersOf: grammar.op
        }
      case 'update':
        return { at: 'updateKey', present }
      case 'updateFields':
        return {
          at: 'updateFieldKey',
          source: grammar.source,
          op: grammar.op,
          present: [...present, ...grammar.taken]
        }
      case 'bulkOperation':
        // An operation object names exactly one operation.
        return present.length === 0 ? { at: 'bulkOperationKey' } : NONE
      case 'arrayFilter':
        return {
          at: 'arrayFilterKey',
          source: grammar.source,
          identifiers: filteredIdentifiers(grammar, present),
          present
        }
      default:
        return NONE
    }
  }

  /** Grammar of the value under `key` of `node`, an object whose grammar is `grammar`. */
  private child(grammar: Grammar, key: string, node: ObjectNode): Grammar {
    switch (grammar.g) {
      case 'query':
        return queryChild(grammar.source, grammar.base, grammar.vars, key)
      case 'jsonProps':
        return { g: 'jsonSchema', source: grammar.source, base: join(grammar.base, key) }
      case 'field':
        return operatorChild(grammar.source, grammar.field, key)
      case 'elemMatch':
      case 'pull':
        if (LOGICAL.has(key))
          return { g: 'queryList', source: grammar.source, base: grammar.field, vars: [] }
        if (key.startsWith('$')) return operatorChild(grammar.source, grammar.field, key)
        return { g: 'field', source: grammar.source, field: join(grammar.field, key) }
      case 'text':
        return key === '$caseSensitive' || key === '$diacriticSensitive' ? BOOL : OPAQUE
      case 'jsonSchema':
        return jsonSchemaChild(grammar.source, grammar.base, key)
      case 'projection':
        return { g: 'projField', source: grammar.source, field: key, mode: projectionMode(node) }
      case 'projField':
        return projectionOperatorChild(grammar, key)
      case 'sort':
        return { g: 'sortField', source: grammar.source, field: key }
      case 'sortField':
        return key === '$meta'
          ? { g: 'literal', values: ['"textScore"'], preferred: '"textScore"' }
          : OPAQUE
      case 'stage':
        return stageBody(grammar.source, grammar.vars, key)
      case 'expression':
        if (grammar.literalBase !== undefined && !key.startsWith('$')) {
          return {
            g: 'expression',
            source: grammar.source,
            vars: grammar.vars,
            literalBase: join(grammar.literalBase, key)
          }
        }
        return operand(grammar.source, grammar.vars, key)
      case 'opArgs':
        return operatorArg(grammar.operator, grammar.source, grammar.vars, key, node)
      case 'args':
        return this.namedArg(grammar, key, node)
      case 'newFields':
        if (grammar.group && key !== '_id') {
          return { g: 'accumulator', source: grammar.source, vars: grammar.vars, window: false }
        }
        // An object literal extends the field in $set, and names a compound key in a $group _id.
        return {
          g: 'expression',
          source: grammar.source,
          vars: grammar.vars,
          literalBase: grammar.group ? '' : key
        }
      case 'outputs':
        return {
          g: 'accumulator',
          source: grammar.source,
          vars: grammar.vars,
          window: grammar.window
        }
      case 'fillOutput':
        return { g: 'args', owner: '$fill.output', source: grammar.source, vars: grammar.vars }
      case 'accumulator':
        if (key === 'window' && grammar.window) {
          return { g: 'args', owner: 'window', source: grammar.source, vars: grammar.vars }
        }
        return {
          g: 'expression',
          source: grammar.source,
          vars: grammar.vars,
          prefer: ACCUMULATOR_DEFS.get(key)?.args
        }
      case 'facet':
        return { g: 'pipeline', source: grammar.source, vars: grammar.vars, nested: 'facet' }
      case 'letVars':
        return { g: 'expression', source: grammar.source, vars: grammar.vars }
      case 'document':
      case 'docValue':
        return { g: 'docValue', coll: grammar.coll, path: join(grammar.path, key), element: false }
      case 'update':
        return UPDATE_OPERATOR_NAMES.has(key)
          ? { g: 'updateFields', source: grammar.source, op: key, taken: takenFields(node, key) }
          : OPAQUE
      case 'updateFields':
        return updateFieldValue(grammar.source, grammar.op, key)
      case 'arrayPush':
        return arrayPushChild(grammar, key)
      case 'elementSort':
        return SORT_DIRECTION
      case 'bulkOperation':
        return BULK_OPERATIONS.has(key)
          ? { g: 'args', owner: bulkOperationOwner(key), source: grammar.source, vars: [] }
          : OPAQUE
      case 'arrayFilter': {
        const [name, ...rest] = key.split('.')
        const identifier = grammar.identifiers.find((id) => id.name === name)
        if (!identifier) return OPAQUE
        return {
          g: 'field',
          source: grammar.source,
          field: rest.length === 0 ? identifier.path : join(identifier.path, rest.join('.'))
        }
      }
      default:
        return OPAQUE
    }
  }

  /** Grammar of the element at `index` of `node`, an array whose grammar is `grammar`; `more`: elements follow it. */
  private element(grammar: Grammar, node: ArrayNode, index: number, more: boolean): Grammar {
    switch (grammar.g) {
      case 'queryList':
        return {
          g: 'query',
          source: grammar.source,
          base: grammar.base,
          topLevel: grammar.base === '',
          vars: grammar.vars
        }
      case 'field':
      case 'pull':
        return {
          g: 'opValue',
          source: grammar.source,
          field: grammar.field,
          operator: null,
          inArray: true,
          siblings: siblingsOf(node)
        }
      case 'opValue':
        return { ...grammar, inArray: true, siblings: siblingsOf(node) }
      case 'pipeline': {
        const stages = [...grammar.source.stages, ...toStages(node.items)]
        return {
          g: 'stage',
          source: this.source(grammar.source.coll, stages),
          index,
          vars: grammar.vars,
          nested: grammar.nested,
          finalWrite: grammar.writes && !more
        }
      }
      case 'update':
        // An update given as an array is an update pipeline.
        return this.element(
          { g: 'pipeline', source: grammar.source, vars: [], nested: 'update' },
          node,
          index,
          more
        )
      case 'list':
        return grammar.of
      case 'arrayPush':
        return { g: 'docValue', coll: grammar.coll, path: grammar.path, element: true }
      case 'arrayFilters':
        return {
          g: 'arrayFilter',
          source: grammar.source,
          identifiers: grammar.identifiers,
          used: node.items.flatMap((item) =>
            item.n === 'object' ? item.entries.map((entry) => firstSegment(entry.key)) : []
          )
        }
      case 'expression':
        return {
          g: 'expression',
          source: grammar.source,
          vars: grammar.vars,
          prefer: grammar.compared ? comparedField(grammar.source, node) : grammar.prefer
        }
      case 'typeAlias':
      case 'jsonSchema':
      case 'fieldName':
      case 'document':
        return grammar
      case 'docValue':
        return { ...grammar, element: true }
      default:
        return OPAQUE
    }
  }

  private ctorArg(grammar: Grammar, ctor: string): Position {
    switch (grammar.g) {
      case 'field':
      case 'opValue':
      case 'pull':
        return { at: 'ctorArg', source: grammar.source, field: grammar.field, ctor }
      case 'expression':
        return { at: 'ctorArg', source: grammar.source, field: null, ctor }
      case 'docValue':
      case 'arrayPush':
        return { at: 'ctorArg', source: this.source(grammar.coll), field: grammar.path, ctor }
      default:
        return NONE
    }
  }

  /** Named arguments; `$lookup`-like stages read some from their target collection, `arrayFilters` from the update. */
  private namedArg(
    grammar: Extract<Grammar, { g: 'args' }>,
    key: string,
    node: ObjectNode
  ): Grammar {
    const { owner, source, vars } = grammar
    const target = (name: string): FieldSource =>
      this.source(stringValue(entryValue(node, name)) ?? '')
    switch (owner) {
      case '$lookup':
        if (key === 'foreignField') {
          const local = stringValue(entryValue(node, 'localField'))
          return {
            g: 'fieldName',
            source: target('from'),
            prefer: local === null ? undefined : { source, path: local }
          }
        }
        // A $lookup pipeline sees only the variables bound in `let`.
        if (key === 'pipeline')
          return {
            g: 'pipeline',
            source: target('from'),
            vars: boundVariables(entryValue(node, 'let'), source),
            nested: 'sub'
          }
        break
      case '$graphLookup':
        if (key === 'connectFromField' || key === 'connectToField')
          return { g: 'fieldName', source: target('from') }
        if (key === 'restrictSearchWithMatch')
          return { g: 'query', source: target('from'), base: '', topLevel: true, vars: [] }
        break
      case '$unionWith':
        if (key === 'pipeline') {
          return { g: 'pipeline', source: target('coll'), vars: [], nested: 'sub' }
        }
        break
    }
    const spec = ARG_SPECS[owner]?.find((arg) => arg.name === key)
    if (spec?.kind === 'arrayFilters') {
      const update = grammar.update ?? entryValue(node, 'update')
      return { g: 'arrayFilters', source, identifiers: arrayIdentifiers(update) }
    }
    return spec ? argGrammar(spec.kind, source, vars) : OPAQUE
  }

  private shell(): Position {
    const chain = this.frames[0]
    if (chain?.f !== 'chain') return NONE
    const call = this.frames[1]
    if (!call) return this.chainPosition(chain)
    if (call.f !== 'call' || call.slot !== 'arg' || call.receiver[0] !== 'db') return NONE
    const coll = call.receiver.slice(1).join('.')
    if (coll === '') {
      return call.callee === 'getCollection' && call.argIndex === 0
        ? this.resolve(COLLECTION, 2)
        : NONE
    }
    this.commandColl = coll
    const head = chain.calls[0]
    const table: Readonly<Record<string, readonly ShellArg[]>> = !head
      ? SHELL_METHOD_ARGS
      : head.name === 'find'
        ? SHELL_CURSOR_ARGS
        : {}
    const args = table[call.callee] ?? []
    const arg = args[call.argIndex]
    if (!arg) return NONE
    // A write's options read the update for the `$[identifier]`s its arrayFilters filter.
    const update = call.args[args.indexOf('update')]
    return this.resolve(shellArg(arg, this.source(coll), call.callee, update), 2)
  }

  private chainPosition(chain: Extract<Frame, { f: 'chain' }>): Position {
    if (chain.segments.length === 0) return { at: 'shellRoot' }
    if (chain.segments[0] !== 'db' || !chain.afterDot) return NONE
    const coll = chain.segments.slice(1).join('.')
    if (coll === '') return chain.calls.length === 0 ? { at: 'shellCollection' } : NONE
    this.commandColl = coll
    const [head, ...rest] = chain.calls
    if (!head) return { at: 'shellMethod', coll }
    return { at: 'shellCursorMethod', head: head.name, used: rest.map((call) => call.name) }
  }
}

function queryChild(
  source: FieldSource,
  base: string,
  vars: readonly Variable[],
  key: string
): Grammar {
  if (LOGICAL.has(key)) return { g: 'queryList', source, base, vars }
  if (key === '$expr') return { g: 'expression', source, vars, prefer: 'bool' }
  if (key === '$text') return { g: 'text' }
  if (key === '$jsonSchema') return { g: 'jsonSchema', source, base: '' }
  if (key.startsWith('$')) return OPAQUE
  return { g: 'field', source, field: join(base, key) }
}

function operatorChild(source: FieldSource, field: string, op: string): Grammar {
  switch (op) {
    case '$in':
    case '$nin':
    case '$all':
    case '$eq':
    case '$ne':
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$regex':
    case '$size':
      return { g: 'opValue', source, field, operator: op, inArray: false, siblings: [] }
    case '$not':
      return { g: 'field', source, field }
    case '$elemMatch':
      return { g: 'elemMatch', source, field }
    case '$exists':
      return { g: 'literal', values: ['true', 'false'], preferred: 'true' }
    case '$type':
      return { g: 'typeAlias', source, field }
    case '$options':
      return { g: 'literal', values: ['"i"', '"m"', '"x"', '"s"', '"im"'] }
  }
  if (GEO_OPERATORS.has(op)) return { g: 'geo' }
  if (op.startsWith('$')) return OPAQUE
  // A plain key inside a field's object is an embedded-document match.
  return {
    g: 'opValue',
    source,
    field: join(field, op),
    operator: null,
    inArray: false,
    siblings: []
  }
}

function jsonSchemaChild(source: FieldSource, base: string, key: string): Grammar {
  switch (key) {
    case 'properties':
      return { g: 'jsonProps', source, base }
    case 'items':
      return { g: 'jsonSchema', source, base }
    case 'bsonType':
      return { g: 'typeAlias', source, field: base }
    case 'required':
      // Required names are relative to the schema's level; only the top level maps to field paths.
      return base === '' ? { g: 'fieldName', source } : OPAQUE
    default:
      return OPAQUE
  }
}

function projectionOperatorChild(
  grammar: Extract<Grammar, { g: 'projField' }>,
  key: string
): Grammar {
  if (key === '$elemMatch') return { g: 'elemMatch', source: grammar.source, field: grammar.field }
  if (key === '$meta') {
    return {
      g: 'literal',
      values: ['"textScore"', '"indexKey"', '"searchScore"', '"searchHighlights"'],
      preferred: '"textScore"'
    }
  }
  if (key === '$slice') return OPAQUE
  if (key.startsWith('$')) return operand(grammar.source, [], key)
  return { ...grammar, field: join(grammar.field, key) }
}

function operand(source: FieldSource, vars: readonly Variable[], op: string): Grammar {
  const def = EXPRESSIONS.get(op)
  if (def?.form === 'named') return { g: 'opArgs', operator: op, source, vars }
  const args = def?.args
  if (args === 'compared') return { g: 'expression', source, vars, compared: true }
  return { g: 'expression', source, vars, prefer: args }
}

function operatorArg(
  operator: string,
  source: FieldSource,
  vars: readonly Variable[],
  key: string,
  node: ObjectNode
): Grammar {
  const spec = ARG_SPECS[operator]?.find((arg) => arg.name === key)
  const grammar = spec ? argGrammar(spec.kind, source, vars) : OPAQUE
  const bound = argVariables(operator, key, node, source)
  if (grammar.g !== 'expression' || bound.length === 0) return grammar
  return { ...grammar, vars: [...vars, ...bound] }
}

/** Variables an operator binds for its argument `key`. */
function argVariables(
  operator: string,
  key: string,
  node: ObjectNode,
  source: FieldSource
): Variable[] {
  const input = entryValue(node, 'input')
  switch (operator) {
    case '$let':
      return key === 'in' ? boundVariables(entryValue(node, 'vars'), source) : []
    case '$map':
    case '$filter':
      if (key !== 'in' && key !== 'cond') return []
      return [variable(stringValue(entryValue(node, 'as')) ?? 'this', input, source)]
    case '$reduce':
      return key === 'in' ? [{ name: 'value' }, variable('this', input, source)] : []
    default:
      return []
  }
}

/** Variables named by the keys of a `let` / `vars` object. */
function boundVariables(node: AstNode | null | undefined, source: FieldSource): Variable[] {
  if (node?.n !== 'object') return []
  return node.entries.map((entry) => variable(entry.key, entry.value, source))
}

/** Variable `name` holding `value`; bound to a field when `value` references one. */
function variable(name: string, value: AstNode | null | undefined, source: FieldSource): Variable {
  const path = fieldPath(value)
  return path === null ? { name } : { name, field: { source, path } }
}

/** The field another argument of a comparison references. */
function comparedField(source: FieldSource, node: ArrayNode): FieldRef | undefined {
  for (const item of node.items) {
    const path = fieldPath(item)
    if (path !== null) return { source, path }
  }
  return undefined
}

/** Path of a `"$path"` field reference; null for anything else, `"$$var"` and a bare `"$"` included. */
function fieldPath(node: AstNode | null | undefined): string | null {
  const path = fieldRefPath(stringValue(node))
  return path === '' ? null : path
}

function stageBody(source: FieldSource, vars: readonly Variable[], name: string): Grammar {
  switch (name) {
    case '$match':
      return { g: 'query', source, base: '', topLevel: true, vars }
    case '$project':
      return { g: 'projection', source }
    case '$addFields':
    case '$set':
      return { g: 'newFields', source, vars, group: false }
    case '$group':
      return { g: 'newFields', source, vars, group: true }
    case '$unset':
      return { g: 'fieldName', source }
    case '$sort':
      return { g: 'sort', source }
    case '$replaceWith':
    case '$sortByCount':
    case '$redact':
      return { g: 'expression', source, vars }
    case '$facet':
      return { g: 'facet', source, vars }
    case '$unwind':
      return {
        g: 'args',
        owner: name,
        source,
        vars,
        scalar: { g: 'expression', source, vars, prefer: 'array' }
      }
    case '$unionWith':
    case '$out':
    case '$merge':
      return { g: 'args', owner: name, source, vars, scalar: COLLECTION }
  }
  return ARG_SPECS[name] ? { g: 'args', owner: name, source, vars } : OPAQUE
}

function argGrammar(kind: ArgKind, source: FieldSource, vars: readonly Variable[]): Grammar {
  if (typeof kind === 'object') {
    return 'enum' in kind
      ? { g: 'literal', values: kind.enum }
      : { g: 'args', owner: kind.args, source, vars }
  }
  switch (kind) {
    case 'expression':
      return { g: 'expression', source, vars }
    case 'dateExpr':
      return { g: 'expression', source, vars, prefer: 'date' }
    case 'boolExpr':
      return { g: 'expression', source, vars, prefer: 'bool' }
    case 'arrayRef':
      return { g: 'expression', source, vars, prefer: 'array' }
    case 'query':
      return { g: 'query', source, base: '', topLevel: true, vars }
    case 'sort':
      return { g: 'sort', source }
    case 'projection':
      return { g: 'projection', source }
    case 'update':
      return { g: 'update', source }
    case 'document':
      return { g: 'document', coll: source.coll, path: '' }
    case 'fieldPath':
    case 'fieldPaths':
      return { g: 'fieldName', source }
    case 'collection':
      return COLLECTION
    case 'pipeline':
      return { g: 'pipeline', source, vars, nested: 'sub' }
    case 'accumulators':
      return { g: 'outputs', source, vars, window: false }
    case 'windowOutput':
      return { g: 'outputs', source, vars, window: true }
    case 'fillOutput':
      return { g: 'fillOutput', source, vars }
    case 'vars':
      return { g: 'letVars', source, vars }
    case 'bool':
      return BOOL
    default:
      return OPAQUE
  }
}

function shellArg(
  arg: ShellArg,
  source: FieldSource,
  method: string,
  update: AstNode | undefined
): Grammar {
  const document: Grammar = { g: 'document', coll: source.coll, path: '' }
  switch (arg) {
    case 'query':
      return { g: 'query', source, base: '', topLevel: true, vars: [] }
    case 'projection':
      return { g: 'projection', source }
    case 'pipeline':
      // A shell aggregate may write its output with a final $out / $merge.
      return { g: 'pipeline', source, vars: [], writes: true }
    case 'sort':
      return { g: 'sort', source }
    case 'fieldName':
      return { g: 'fieldName', source }
    case 'document':
      return document
    case 'documents':
      return { g: 'list', of: document }
    case 'update':
      return { g: 'update', source }
    case 'bulkOperations':
      return { g: 'list', of: { g: 'bulkOperation', source } }
    case 'options':
      return { g: 'args', owner: optionsOwner(method), source, vars: [], update }
  }
}

/** Grammar of the value update operator `op` gives `key`, a field path that may address array elements. */
function updateFieldValue(source: FieldSource, op: string, key: string): Grammar {
  const path = withoutPositional(key)
  const element = POSITIONAL_SEGMENT.test(key.slice(key.lastIndexOf('.') + 1))
  const coll = source.coll
  switch (op) {
    case '$set':
    case '$setOnInsert':
    case '$min':
    case '$max':
      return { g: 'docValue', coll, path, element }
    case '$pullAll':
      return { g: 'docValue', coll, path, element: false }
    case '$push':
    case '$addToSet':
      return { g: 'arrayPush', coll, path, op }
    case '$pull':
      return { g: 'pull', source, field: path }
    case '$rename':
      return { g: 'fieldName', source, renaming: path }
    case '$currentDate':
    case '$bit':
      return {
        g: 'args',
        owner: `${op}.field`,
        source,
        vars: [],
        scalar: { g: 'updateValue', source, op, field: path }
      }
    default:
      return { g: 'updateValue', source, op, field: path }
  }
}

function arrayPushChild(grammar: Extract<Grammar, { g: 'arrayPush' }>, key: string): Grammar {
  const { coll, path } = grammar
  if (key === '$each') return { g: 'docValue', coll, path, element: false }
  if (key === '$sort') return { g: 'elementSort', coll, path }
  if (key.startsWith('$')) return OPAQUE
  // A plain key makes the pushed element a document.
  return { g: 'docValue', coll, path: join(path, key), element: false }
}

/** Field paths the other operators of an update document change. */
function takenFields(update: ObjectNode, op: string): string[] {
  return update.entries.flatMap((entry) =>
    entry.key !== op && entry.value?.n === 'object'
      ? entry.value.entries.map((field) => field.key)
      : []
  )
}

/** `$[name]` placeholders in the field paths of an update document, with the array path each stands for. */
function arrayIdentifiers(update: AstNode | null | undefined): ArrayIdentifier[] {
  const out: ArrayIdentifier[] = []
  if (update?.n !== 'object') return out
  for (const operator of update.entries) {
    if (operator.value?.n !== 'object') continue
    for (const { key } of operator.value.entries) {
      const path: string[] = []
      for (const segment of key.split('.')) {
        const name = ARRAY_IDENTIFIER.exec(segment)?.[1]
        if (name !== undefined && !out.some((id) => id.name === name)) {
          out.push({ name, path: path.join('.') })
        }
        if (!POSITIONAL_SEGMENT.test(segment)) path.push(segment)
      }
    }
  }
  return out
}

/** Identifiers one condition may filter: the one its keys name, else those no other condition filters. */
function filteredIdentifiers(
  grammar: Extract<Grammar, { g: 'arrayFilter' }>,
  present: readonly string[]
): ArrayIdentifier[] {
  const named = grammar.identifiers.filter((id) =>
    present.some((key) => firstSegment(key) === id.name)
  )
  if (named.length > 0) return named
  return grammar.identifiers.filter((id) => !grammar.used.includes(id.name))
}

function firstSegment(path: string): string {
  const dot = path.indexOf('.')
  return dot === -1 ? path : path.slice(0, dot)
}

function siblingsOf(node: ArrayNode): string[] {
  return node.items.map(literalText).filter((text): text is string => text !== null)
}

/** Source-independent text of a literal, comparable with rendered sample values. */
function literalText(node: AstNode): string | null {
  switch (node.n) {
    case 'string':
      return JSON.stringify(node.value)
    case 'number':
      return String(Number(node.raw))
    case 'ident':
      return node.name
    case 'call': {
      const args = node.args.map(literalText)
      return args.every((arg) => arg !== null) ? `${node.callee}(${args.join(', ')})` : null
    }
    default:
      return null
  }
}

function collectTargets(stages: readonly StageAst[], add: (name: string | null) => void): void {
  for (const stage of stages) {
    switch (stage.name) {
      case '$lookup':
      case '$graphLookup':
      case '$unionWith':
        add(foreignCollection(stage))
        collectPipeline(entryValue(stage.body, 'pipeline'), add)
        break
      case '$facet':
        if (stage.body?.n === 'object') {
          for (const entry of stage.body.entries) collectPipeline(entry.value, add)
        }
        break
    }
  }
}

function collectPipeline(
  node: AstNode | null | undefined,
  add: (name: string | null) => void
): void {
  if (node?.n === 'array') collectTargets(toStages(node.items), add)
}
