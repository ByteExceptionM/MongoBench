/**
 * Ranked completion items for a classified cursor position: field paths from the sampled
 * schema, typed constructors and sample values, operators, stages and shell methods.
 */
import type {
  BsonTypeName,
  CollectionSchema,
  SchemaField,
  TypeCounts,
  UuidEncoding
} from '@shared/types'
import {
  addCounts,
  addressableFields,
  childFields,
  classifyCanonical,
  compareText,
  dominantType,
  resolveSchemaField
} from '@shared/collectionSchema'
import { UNSUPPORTED_STAGES, WRITE_STAGES } from '@shared/pipeline'
import { BULK_WRITE_OPERATIONS, UPDATE_PIPELINE_STAGES } from '@shared/writeOps'
import { formatIsoInZone } from '../dateZone'
import { isBareKey, serializeMongoValue } from '../mongoQuerySerialize'
import {
  ACCUMULATORS,
  ARG_SPECS,
  ARRAY_MODIFIERS,
  CONSTRUCTOR_TYPES,
  EJSON_WRAPPERS,
  EXPRESSION_OPERATORS,
  FIELD_OPERATORS,
  GEO_KEYS,
  JSON_SCHEMA_KEYS,
  NUMERIC_TYPES,
  POSITIONAL_SEGMENT,
  PROJECTION_OPERATORS,
  QUERY_TOP_OPERATORS,
  SHELL_METHODS,
  STAGES,
  SYSTEM_VARIABLES,
  TEXT_KEYS,
  TYPE_ALIASES,
  UPDATE_OPERATORS,
  WINDOW_KEY,
  typeAlias,
  withoutPositional,
  type ArgKind,
  type ArrayModifierOwner,
  type KeyDef,
  type OperatorFit,
  type OperatorForm,
  type StageDef,
  type TypeClass
} from './catalog'
import type {
  ArrayIdentifier,
  CompletionContext,
  FieldSource,
  Nesting,
  Position,
  Prefer,
  Variable
} from './context'
import { applyStages, join } from './pipelineFlow'

export type SuggestionKind =
  | 'field'
  | 'operator'
  | 'stage'
  | 'expression'
  | 'accumulator'
  | 'constructor'
  | 'value'
  | 'literal'
  | 'enum'
  | 'typeAlias'
  | 'collection'
  | 'method'
  | 'variable'

export type Suggestion = {
  label: string
  description?: string
  /** Markdown. */
  documentation?: string
  kind: SuggestionKind
  insertText: string
  /** `insertText` is Monaco snippet syntax; otherwise plain text. */
  snippet: boolean
  filterText: string
  /** `<tier a-e><4-digit rank>`. */
  sortText: string
  preselect?: boolean
  /** Re-open suggestions after inserting. */
  retrigger?: boolean
}

export type SuggestEnv = {
  coll: string
  collections: readonly string[]
  /** Effective schema of a collection; null when unknown or not loaded. */
  schemaOf: (coll: string) => CollectionSchema | null
  uuidEncoding: UuidEncoding
  timezone: string
  now: Date
  shellMethods: readonly string[]
  cursorMethods: readonly string[]
  /** Cursor methods allowed after `aggregate(…)`. */
  aggregateCursorMethods: readonly string[]
  /** `db.`-prefixed shell accessor of a collection, e.g. `db.users` or `db.getCollection("my logs")`. */
  collectionAccessor: (coll: string) => string
}

export type SuggestTrigger = { kind: 'invoke' } | { kind: 'character'; char: string }

/** `range` is the text offsets the chosen item replaces. */
export type SuggestResult = { items: Suggestion[]; range: { start: number; end: number } }

/**
 * Ranked suggestions for a classified cursor position; empty when `trigger` does not fit the position.
 * @param env collection names, schemas and display settings of the editor
 * @returns items plus the replace range; the range is valid even when items are empty
 */
export function suggest(
  ctx: CompletionContext,
  env: SuggestEnv,
  trigger: SuggestTrigger
): SuggestResult {
  const range = replaceRange(ctx)
  if (ctx.position.at === 'none') return { items: [], range }
  const char = trigger.kind === 'character' ? trigger.char : null
  if (char !== null && !triggerFits(ctx, char)) return { items: [], range }
  const builder = new Builder(ctx, env)
  const items = builder.build()
  // The generic constructors of an unsampled field are not worth opening for a typed colon or space.
  if ((char === ':' || char === ' ') && builder.unknownField) return { items: [], range }
  return { items, range }
}

type At = Position['at']
type Tier = 'a' | 'b' | 'c' | 'd' | 'e'
type Item = Omit<Suggestion, 'sortText'>
type Ctor = Pick<
  Suggestion,
  'label' | 'insertText' | 'snippet' | 'filterText' | 'kind' | 'retrigger' | 'preselect'
>
type Sample = { value: unknown; text: string; filter: string; count: number }
type FieldInfo = Pick<Item, 'description' | 'documentation'>

const KEY_POSITIONS = new Set<At>([
  'queryKey',
  'operatorKey',
  'elemMatchKey',
  'textKey',
  'jsonSchemaKey',
  'geoKey',
  'projectionKey',
  'projectionOperatorKey',
  'sortKey',
  'stageKey',
  'stageArgKey',
  'newFieldKey',
  'accumulatorKey',
  'expressionKey',
  'operatorArgKey',
  'documentKey',
  'updateKey',
  'updateFieldKey',
  'arrayFilterKey',
  'bulkOperationKey'
])
const VALUE_POSITIONS = new Set<At>([
  'rootValue',
  'queryValue',
  'ctorArg',
  'typeAlias',
  'literal',
  'projectionValue',
  'sortValue',
  'expressionValue',
  'fieldName',
  'collectionName',
  'documentValue',
  'updateValue'
])
const DOCUMENT_POSITIONS = new Set<At>(['documentKey', 'documentValue'])
const SHELL_DOT_POSITIONS = new Set<At>(['shellCollection', 'shellMethod', 'shellCursorMethod'])
const DOTTED_VALUE_POSITIONS = new Set<At>(['expressionValue', 'fieldName', 'projectionValue'])
const EMPTY_SLOT_FOLLOWERS = new Set(['', ',', '}', ']'])
const ARRAY_OPERATORS = new Set(['$in', '$nin', '$all'])
const COMPARABLE = new Set<BsonTypeName>([
  'int',
  'long',
  'double',
  'decimal',
  'date',
  'string',
  'objectId',
  'timestamp',
  'uuid'
])
const DESCENDING_SORT = new Set<BsonTypeName>(['date', 'objectId', 'timestamp'])
const UNKNOWN_FIELD_TYPES: readonly BsonTypeName[] = [
  'objectId',
  'date',
  'uuid',
  'uuidLegacy',
  'long',
  'decimal',
  'int',
  'timestamp',
  'regex',
  'string',
  'bool',
  'null',
  'object',
  'array',
  'binData',
  'minKey',
  'maxKey'
]
const VARIABLE_PATH = /^\$\$(\w+)\.(.*)$/
// Schemas and their fields never change once built, so work derived from them is kept with them.
const FIELD_INFOS = new WeakMap<SchemaField, Map<string, FieldInfo>>()
const RANKED_FIELDS = new WeakMap<CollectionSchema, [string, SchemaField][]>()

function replaceRange(ctx: CompletionContext): { start: number; end: number } {
  const { token } = ctx
  const isKey = KEY_POSITIONS.has(ctx.position.at)
  // Keys re-insert the closing quote they replace; values insert content only and keep it.
  if (token.closeQuoteEnd !== null) {
    return { start: token.start, end: isKey ? token.closeQuoteEnd : token.closeQuoteEnd - 1 }
  }
  return { start: token.start, end: isKey && !token.quote ? token.dottedEnd : token.wordEnd }
}

function triggerFits(ctx: CompletionContext, char: string): boolean {
  const { position, token } = ctx
  const at = position.at
  const isKey = KEY_POSITIONS.has(at)
  // Enter accepts the preselected item, so a typed colon or space must not offer to replace a value.
  const emptySlot =
    token.prevNonBlank === ':' &&
    token.wordEnd === token.cursor &&
    EMPTY_SLOT_FOLLOWERS.has(token.nextChar)
  if (ctx.kind === 'document') {
    if (char === '"' || char === "'") return at === 'documentKey'
    if (char === ':' || char === ' ') return at === 'documentValue' && emptySlot
    return false
  }
  switch (char) {
    case '"':
    case "'":
      return isKey || VALUE_POSITIONS.has(at)
    case '$':
      return isKey || at === 'expressionValue' || (at === 'projectionValue' && token.quote !== null)
    case ':':
    case ' ':
      return VALUE_POSITIONS.has(at) && emptySlot
    case '.':
      return (
        SHELL_DOT_POSITIONS.has(at) ||
        ((isKey || DOTTED_VALUE_POSITIONS.has(at)) && token.prefix.includes('.'))
      )
    case '{':
      return isKey
    case '[':
      return (
        at === 'stageElement' ||
        at === 'bulkOperationElement' ||
        (position.at === 'queryValue' && position.inArray)
      )
    default:
      return false
  }
}

class Builder {
  /** The value items are only the generic constructors of an unsampled field. */
  unknownField = false
  private readonly items: Suggestion[] = []
  private readonly labels = new Set<string>()
  private readonly ranks: Record<Tier, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 }
  private readonly flows = new Map<FieldSource, CollectionSchema | null>()
  private readonly inString: boolean
  /** Queries compare numbers across types; documents (the document editor, inserts, update values) keep exact types. */
  private readonly query: boolean

  constructor(
    private readonly ctx: CompletionContext,
    private readonly env: SuggestEnv
  ) {
    this.inString = ctx.token.quote !== null
    this.query = ctx.kind !== 'document' && !DOCUMENT_POSITIONS.has(ctx.position.at)
  }

  build(): Suggestion[] {
    const p = this.ctx.position
    switch (p.at) {
      case 'rootValue':
        this.rootValue(p.expect)
        break
      case 'queryKey':
        this.fieldKeys(p.source, p.present, p.base, { childrenOnly: p.childrenOnly })
        if (p.topLevel && !this.ctx.token.prefix.includes('.')) {
          const tier = this.ctx.token.prefix.startsWith('$') ? 'a' : 'c'
          this.keyDefs(QUERY_TOP_OPERATORS, p.present, tier, 'operator')
        }
        break
      case 'operatorKey':
        this.operatorKeys(p.source, p.field, p.present)
        break
      case 'elemMatchKey':
        this.elemMatchKeys(p.source, p.field, p.present)
        break
      case 'queryValue':
        this.queryValue(p)
        break
      case 'ctorArg':
        this.ctorArg(p.source, p.field, p.ctor)
        break
      case 'typeAlias':
        this.typeAliases(p.source, p.field)
        break
      case 'literal':
        this.literals(p.values, p.preferred)
        break
      case 'textKey':
        this.keyDefs(TEXT_KEYS, p.present, 'c', 'operator')
        break
      case 'jsonSchemaKey':
        this.keyDefs(JSON_SCHEMA_KEYS, p.present, 'c', 'literal')
        break
      case 'geoKey':
        this.keyDefs(GEO_KEYS, p.present, 'c', 'operator')
        break
      case 'projectionKey':
      case 'sortKey':
        this.fieldKeys(p.source, p.present, '', { pinId: true })
        break
      case 'projectionValue':
        this.projectionValue(p.source, p.field, p.mode)
        break
      case 'projectionOperatorKey':
        this.projectionOperatorKeys(p.source, p.field, p.present)
        break
      case 'sortValue':
        this.sortValue(p.source, p.field)
        break
      case 'stageElement':
        this.stageElements(p.stageIndex, p.nested, p.finalWrite === true)
        break
      case 'stageKey':
        if (p.present.length === 0) this.stageKeys(p.stageIndex, p.nested, p.finalWrite === true)
        break
      case 'stageArgKey':
        this.argKeys(p.stage, p.present)
        break
      case 'operatorArgKey':
        this.argKeys(p.operator, p.present)
        break
      case 'newFieldKey':
        this.newFieldKeys(p.source, p.present, p.group)
        break
      case 'accumulatorKey':
        this.accumulatorKeys(p.window, p.present)
        break
      case 'expressionKey':
        if (p.present.some((key) => key.startsWith('$'))) break
        if (p.literalBase !== undefined) {
          this.fieldKeys(p.source, p.present, p.literalBase, { childrenOnly: true })
        }
        this.expressionKeys(p.present, 'c', this.preferredClass(p.prefer))
        break
      case 'expressionValue':
        this.expressionValue(p.source, p.vars, p.prefer)
        break
      case 'fieldName':
        this.fieldNames(p.source, p.prefer, p.renaming)
        break
      case 'collectionName':
        this.collectionNames()
        break
      case 'shellRoot':
        this.shellRoot()
        break
      case 'shellCollection':
        this.shellCollections()
        break
      case 'shellMethod':
        this.collectionSegments(p.coll)
        this.methods(this.env.shellMethods)
        break
      case 'shellCursorMethod': {
        const allowed =
          p.head === 'find'
            ? this.env.cursorMethods
            : p.head === 'aggregate'
              ? this.env.aggregateCursorMethods
              : []
        this.methods(allowed.filter((m) => !p.used.includes(m)))
        break
      }
      case 'documentKey':
        this.documentKeys(p.coll, p.path, p.present, p.modifiersOf)
        break
      case 'documentValue': {
        const schema = this.env.schemaOf(p.coll)
        this.valueModel(
          schema ? resolveSchemaField(schema, p.path) : undefined,
          schema,
          [],
          p.element
        )
        if (p.modifiersOf && !this.inString) {
          this.addTemplate(
            'c',
            '{ $each: [ … ] }',
            `{ ${this.innerKey('$each')}: [$0] }`,
            '$each',
            true
          )
        }
        break
      }
      case 'updateKey':
        this.keyDefs(UPDATE_OPERATORS, p.present, 'c', 'operator')
        break
      case 'updateFieldKey':
        this.updateFieldKeys(p.source, p.op, p.present)
        break
      case 'updateValue':
        this.updateValue(p.source, p.op, p.field)
        break
      case 'arrayFilterKey':
        this.arrayFilterKeys(p.source, p.identifiers, p.present)
        break
      case 'bulkOperationElement':
        if (!this.inString) this.bulkOperations(true)
        break
      case 'bulkOperationKey':
        this.bulkOperations(false)
        break
    }
    return this.items
  }

  private add(tier: Tier, item: Item): void {
    if (this.labels.has(item.label)) return
    this.labels.add(item.label)
    const suggestion: Suggestion = {
      ...item,
      sortText: `${tier}${String(this.ranks[tier]++).padStart(4, '0')}`
    }
    if (!item.preselect || this.items.some((i) => i.preselect)) delete suggestion.preselect
    if (!item.retrigger) delete suggestion.retrigger
    this.items.push(suggestion)
  }

  private flow(source: FieldSource): CollectionSchema | null {
    if (!this.flows.has(source)) {
      const base = this.env.schemaOf(source.coll)
      this.flows.set(
        source,
        source.stages.length === 0 ? base : applyStages(base, source.stages, this.env.schemaOf)
      )
    }
    return this.flows.get(source) ?? null
  }

  private field(
    source: FieldSource,
    path: string
  ): { field: SchemaField | undefined; schema: CollectionSchema | null } {
    const schema = this.flow(source)
    return { field: schema ? resolveSchemaField(schema, path) : undefined, schema }
  }

  /** Type class `prefer` asks for; a referenced field stands for its own (element) type. */
  private preferredClass(prefer: Prefer | undefined): TypeClass | null {
    if (prefer === undefined) return null
    if (typeof prefer === 'string') return prefer
    const { field } = this.field(prefer.source, prefer.path)
    const type = field ? queryType(field) : null
    // Numbers compare across numeric types.
    return type !== null && NUMERIC_TYPES.has(type) ? 'number' : type
  }

  /** A key in the editor's style, then `: ` and `template` unless a colon already follows. */
  private keyInsert(
    name: string,
    template: string | null,
    retrigger: boolean
  ): Pick<Item, 'insertText' | 'snippet' | 'retrigger'> {
    const { token, keyQuote } = this.ctx
    const withValue = !token.colonFollows
    const snippet = withValue && template !== null
    const text = token.quote
      ? escapeInQuotes(name, token.quote) + token.quote
      : keyQuote === '"' || !isBareKey(name)
        ? JSON.stringify(name)
        : name
    const head = snippet ? snippetEscape(text) : text
    if (!withValue) return { insertText: head, snippet: false, retrigger: false }
    return { insertText: `${head}: ${template ?? ''}`, snippet, retrigger }
  }

  /** Renders a key inside a template in the same style as the key being inserted. */
  private readonly innerKey = (key: string): string => {
    const quote = this.ctx.token.quote ?? this.ctx.keyQuote
    return snippetEscape(quote ? `${quote}${escapeInQuotes(key, quote)}${quote}` : key)
  }

  private keyItem(def: KeyDef, kind: SuggestionKind): Item {
    const template = def.template ? def.template(this.innerKey) : null
    return {
      label: def.name,
      kind,
      ...this.keyInsert(def.name, template, def.retrigger ?? template === null),
      filterText: def.name,
      documentation: def.doc
    }
  }

  private keyDefs(
    defs: readonly KeyDef[],
    present: readonly string[],
    tier: Tier,
    kind: SuggestionKind
  ): void {
    for (const def of defs) if (!present.includes(def.name)) this.add(tier, this.keyItem(def, kind))
  }

  /** Field paths of `source` as keys relative to `base`; a dotted prefix narrows to that parent's children. */
  private fieldKeys(
    source: FieldSource,
    present: readonly string[],
    base: string,
    options: { pinId?: boolean; childrenOnly?: boolean } = {}
  ): void {
    const schema = this.flow(source)
    const prefix = this.ctx.token.prefix
    const dot = prefix.lastIndexOf('.')
    let entries: [string, SchemaField | undefined][] = []
    if (schema && options.childrenOnly) {
      if (dot === -1) entries = childFields(schema, base).map((f) => [lastSegment(f.path), f])
    } else if (schema && dot !== -1) {
      const parent = prefix.slice(0, dot)
      entries = childFields(schema, join(base, parent)).map((f) => [
        `${parent}.${lastSegment(f.path)}`,
        f
      ])
    } else if (schema) {
      const under = base === '' ? '' : `${base}.`
      entries = addressableFields(schema)
        .filter((f) => f.path.startsWith(under))
        .map((f) => [f.path.slice(under.length), f])
    }
    // Stored documents always have an _id; a known stage output has one only if it lists it.
    const idPossible = source.stages.length === 0 || !schema
    if (options.pinId && idPossible && dot === -1 && !entries.some(([name]) => name === '_id'))
      entries.push(['_id', undefined])
    this.addFieldKeys(entries, present, schema)
  }

  /** Field paths an update operator changes; fields inside array elements are addressed through `$[]`. */
  private updateFieldKeys(source: FieldSource, op: string, present: readonly string[]): void {
    const schema = this.flow(source)
    if (!schema) return
    const prefix = this.ctx.token.prefix
    const dot = prefix.lastIndexOf('.')
    let entries: [string, SchemaField][]
    if (dot === -1) {
      entries = addressableFields(schema).map((f) => [elementPath(schema, f.path), f])
    } else {
      const parent = prefix.slice(0, dot)
      const path = withoutPositional(parent)
      // Updates do not reach into array elements on their own; a typed positional segment does.
      const through = isArrayField(schema, path) && !POSITIONAL_SEGMENT.test(lastSegment(parent))
      entries = childFields(schema, path).map((f) => [
        `${parent}${through ? '.$[]' : ''}.${lastSegment(f.path)}`,
        f
      ])
    }
    entries = entries.filter(([name]) => {
      // Updates cannot change _id; only the insert of an upsert sets it.
      if (op !== '$setOnInsert' && (name === '_id' || name.startsWith('_id.'))) return false
      // $rename cannot move fields of array elements.
      return op !== '$rename' || withoutPositional(name) === name
    })
    const prefer = UPDATE_OPERATORS.find((def) => def.name === op)?.fields ?? null
    this.addFieldKeys(entries, present, schema, prefer)
  }

  /** Field keys ranked by presence, `prefer`-typed fields first; present ones are left out. */
  private addFieldKeys(
    entries: [string, SchemaField | undefined][],
    present: readonly string[],
    schema: CollectionSchema | null,
    prefer: TypeClass | null = null
  ): void {
    for (const [name, field] of preferred(rankFields(entries), prefer)) {
      if (present.includes(name)) continue
      this.add('b', {
        label: name,
        kind: 'field',
        ...this.keyInsert(name, null, true),
        filterText: name,
        ...this.fieldInfo(field, schema)
      })
    }
  }

  /** `name` and `name.<subfield>` keys for the array each `$[name]` of the update stands for. */
  private arrayFilterKeys(
    source: FieldSource,
    identifiers: readonly ArrayIdentifier[],
    present: readonly string[]
  ): void {
    const schema = this.flow(source)
    const prefix = this.ctx.token.prefix
    const dot = prefix.lastIndexOf('.')
    for (const { name, path } of identifiers) {
      const entries: [string, SchemaField | undefined][] = []
      if (dot === -1) {
        entries.push([name, schema ? resolveSchemaField(schema, path) : undefined])
        const under = `${path}.`
        for (const field of schema ? addressableFields(schema) : []) {
          if (field.path.startsWith(under)) {
            entries.push([`${name}.${field.path.slice(under.length)}`, field])
          }
        }
      } else {
        const parent = prefix.slice(0, dot)
        const [head, ...rest] = parent.split('.')
        if (head !== name || !schema) continue
        const parentPath = rest.length === 0 ? path : join(path, rest.join('.'))
        for (const field of childFields(schema, parentPath)) {
          entries.push([`${parent}.${lastSegment(field.path)}`, field])
        }
      }
      this.addFieldKeys(entries, present, schema)
    }
  }

  private operatorKeys(source: FieldSource, path: string, present: readonly string[]): void {
    const { field, schema } = this.field(source, path)
    const { prefix } = this.ctx.token
    // A typed letter matches inside operator names; only fitting operators are worth that.
    const fittingOnly = prefix !== '' && !prefix.startsWith('$')
    for (const op of FIELD_OPERATORS) {
      if (present.includes(op.name)) continue
      if (op.fits === 'regexOption' && !present.includes('$regex')) continue
      const fit = !field || fits(op.fits, field, schema)
      if (fit || !fittingOnly) this.add(fit ? 'c' : 'e', this.keyItem(op, 'operator'))
    }
    const type = field ? queryType(field) : null
    const wrapper = type ? EJSON_WRAPPERS[type] : undefined
    if (wrapper && !present.includes(wrapper.name))
      this.add('e', this.keyItem(wrapper, 'constructor'))
  }

  private elemMatchKeys(source: FieldSource, path: string, present: readonly string[]): void {
    this.fieldKeys(source, present, path)
    const { field, schema } = this.field(source, path)
    const element = field
      ? { ...field, types: field.elementTypes ?? {}, elementTypes: undefined }
      : undefined
    for (const op of FIELD_OPERATORS) {
      if (present.includes(op.name)) continue
      if (op.fits === 'regexOption' && !present.includes('$regex')) continue
      if (!element || fits(op.fits, element, schema)) this.add('c', this.keyItem(op, 'operator'))
    }
    this.keyDefs(
      QUERY_TOP_OPERATORS.filter((op) => ['$and', '$or', '$nor'].includes(op.name)),
      present,
      'c',
      'operator'
    )
  }

  private stageKeys(stageIndex: number, nested: Nesting | undefined, finalWrite: boolean): void {
    for (const stage of STAGES) {
      if (stageRuns(stage, stageIndex, nested, finalWrite)) {
        this.add(stageTier(stage), this.keyItem(stage, 'stage'))
      }
    }
  }

  private argKeys(owner: string, present: readonly string[]): void {
    for (const spec of ARG_SPECS[owner] ?? []) {
      if (present.includes(spec.name)) continue
      if (spec.excludes !== undefined && present.includes(spec.excludes)) continue
      const { template, retrigger } = argTemplate(spec.kind)
      this.add(spec.required ? 'b' : 'c', {
        label: spec.name,
        kind: 'field',
        ...this.keyInsert(spec.name, template, retrigger),
        filterText: spec.name,
        description: spec.required ? 'required' : undefined
      })
    }
  }

  private newFieldKeys(source: FieldSource, present: readonly string[], group: boolean): void {
    if (group && !present.includes('_id')) {
      this.add('b', {
        label: '_id',
        kind: 'field',
        ...this.keyInsert('_id', null, true),
        filterText: '_id'
      })
    }
    const schema = this.flow(source)
    if (!schema) return
    for (const [name, field] of rankedFields(schema)) {
      if (present.includes(name)) continue
      this.add('e', {
        label: name,
        kind: 'field',
        ...this.keyInsert(name, null, true),
        filterText: name,
        ...this.fieldInfo(field, schema),
        // A $group outputs only its _id and accumulators, so nothing of the input is overwritten.
        ...(group ? {} : { description: 'overwrite' })
      })
    }
  }

  private accumulatorKeys(window: boolean, present: readonly string[]): void {
    // An accumulator object holds one operator, plus the window bounds in a window function.
    if (!present.some((key) => key !== 'window')) {
      for (const def of ACCUMULATORS) {
        if (def.windowOnly && !window) continue
        this.add('c', this.keyItem(def, 'accumulator'))
      }
    }
    if (window && !present.includes('window')) this.add('d', this.keyItem(WINDOW_KEY, 'literal'))
  }

  /** Expression operators at `tier`, those returning the `preferred` type class at tier `b`. */
  private expressionKeys(
    present: readonly string[],
    tier: Tier,
    preferred: TypeClass | null = null
  ): void {
    const operators = [...EXPRESSION_OPERATORS].sort((a, b) => compareText(a.name, b.name))
    for (const op of operators) {
      if (present.includes(op.name)) continue
      const { template, retrigger } = formTemplate(op.form)
      this.add(preferred !== null && inClass(op.returns, preferred) ? 'b' : tier, {
        label: op.name,
        kind: 'expression',
        ...this.keyInsert(op.name, template, retrigger),
        filterText: op.name,
        description: op.returns,
        documentation: op.doc
      })
    }
  }

  private projectionOperatorKeys(
    source: FieldSource,
    path: string,
    present: readonly string[]
  ): void {
    this.fieldKeys(source, present, path)
    const { field } = this.field(source, path)
    if (field && dominantType(field.types) === 'array') {
      this.keyDefs(PROJECTION_OPERATORS, present, 'c', 'operator')
      this.expressionKeys(present, 'e')
      return
    }
    // Any other field is computed; expressions go first, so `$slice` keeps its expression form.
    const meta = PROJECTION_OPERATORS.filter((def) => def.name === '$meta')
    this.keyDefs(meta, present, 'c', 'operator')
    this.expressionKeys(present, 'c')
    this.keyDefs(PROJECTION_OPERATORS, present, 'e', 'operator')
  }

  private documentKeys(
    coll: string,
    path: string,
    present: readonly string[],
    modifiersOf: ArrayModifierOwner | undefined
  ): void {
    if (modifiersOf) {
      // The object holds either modifiers or the fields of a pushed element document.
      const modifiers = present.some((key) => key.startsWith('$'))
      if (modifiers || present.length === 0) {
        this.keyDefs(ARRAY_MODIFIERS[modifiersOf], present, 'c', 'operator')
      }
      if (modifiers) return
    }
    const schema = this.env.schemaOf(coll)
    if (!schema) return
    // Keys of a map-like object are data, not a fixed set worth suggesting.
    if (path !== '' && resolveSchemaField(schema, path)?.mapLike) return
    const entries = childFields(schema, path).map((f): [string, SchemaField] => [
      lastSegment(f.path),
      f
    ])
    this.addFieldKeys(entries, present, schema)
  }

  /** A literal in a value slot; a space follows a colon typed without one. */
  private valueText(literal: string): string {
    return (this.ctx.token.charBefore === ':' ? ' ' : '') + literal
  }

  private quotedContent(text: string): string {
    const { quote, closeQuoteEnd } = this.ctx.token
    const content = escapeInQuotes(text, quote ?? '"')
    // Strings never span lines, so no closing quote on the cursor line means none at all.
    return quote !== null && closeQuoteEnd === null ? content + quote : content
  }

  /** `text` as a string literal in a value slot, or as the content of the string the cursor is in. */
  private stringText(text: string): string {
    return this.inString ? this.quotedContent(text) : this.valueText(JSON.stringify(text))
  }

  private rootValue(expect: 'object' | 'array'): void {
    if (this.inString) return
    const object = expect === 'object'
    this.add('a', {
      label: object ? '{ … }' : '[ … ]',
      kind: 'value',
      insertText: this.valueText(object ? '{ $0 }' : '[$0]'),
      snippet: true,
      filterText: object ? '{' : '[',
      preselect: true,
      retrigger: true
    })
  }

  private queryValue(p: Extract<Position, { at: 'queryValue' }>): void {
    if (p.operator === '$size') return
    const { field, schema } = this.field(p.source, p.field)
    if (p.operator === '$regex') {
      if (!this.inString)
        for (const ctor of this.constructors('regex', field))
          this.add('a', { ...ctor, preselect: true })
      return
    }
    if (p.operator !== null && ARRAY_OPERATORS.has(p.operator) && !p.inArray) {
      this.arrayOfValues(field)
      return
    }
    this.valueModel(field, schema, p.siblings, true)
  }

  /** `[<constructor>]` for `$in` / `$nin` / `$all` before the array is typed. */
  private arrayOfValues(field: SchemaField | undefined): void {
    if (this.inString) return
    if (!field) this.unknownField = true
    const type = field ? queryType(field) : null
    const ctor = type ? this.constructors(type, field).find((c) => c.snippet) : undefined
    this.add('a', {
      label: ctor ? `[${ctor.label}]` : '[ … ]',
      kind: ctor ? 'constructor' : 'value',
      // The array, not the constructor inside it, follows the colon.
      insertText: this.valueText(ctor ? `[${ctor.insertText.trimStart()}]` : '[$0]'),
      snippet: true,
      filterText: '[',
      preselect: true,
      retrigger: true
    })
  }

  /** Constructor for the field's type, sample values, minor-type constructors and null. */
  private valueModel(
    field: SchemaField | undefined,
    schema: CollectionSchema | null,
    siblings: readonly string[],
    element: boolean
  ): void {
    if (!field) {
      if (!this.inString) this.unknownValues()
      return
    }
    const counts =
      (this.query || element) && dominantType(field.types) === 'array'
        ? (field.elementTypes ?? {})
        : field.types
    const type = dominantType(counts)
    // Tracked values of an array field are its elements, not candidates for the whole value.
    const samples = type === 'array' ? [] : this.samples(field, siblings)
    if (this.inString) {
      for (const sample of samples) {
        if (typeof sample.value !== 'string') continue
        this.add('b', {
          label: sample.text,
          kind: 'value',
          insertText: this.quotedContent(sample.value),
          snippet: false,
          filterText: sample.value,
          description: `${sample.count}×`
        })
      }
      return
    }
    const total = sumCounts(counts)
    const info = this.fieldInfo(field, schema)
    const ctors = type ? this.constructors(type, field) : []
    const share = type ? percent(counts[type] ?? 0, total) : 0
    const values = field.values ?? []
    const enumLike =
      !field.valuesTruncated && values.length > 0 && sumValueCounts(values) >= 2 * values.length
    // A string enum's most frequent value fits better than the empty "…" constructor.
    const sampleFirst = enumLike && (ctors.length === 0 || type === 'string')
    for (const ctor of ctors) {
      this.add('a', {
        ...ctor,
        preselect: !sampleFirst && (ctor.preselect ?? true),
        description: `${type} · ${share}%`,
        documentation: info.documentation
      })
    }
    const shown = enumLike ? samples : samples.slice(0, 3)
    shown.forEach((sample, i) => {
      this.add(enumLike ? 'b' : 'd', {
        label: sample.text,
        kind: 'value',
        insertText: this.valueText(sample.text),
        snippet: false,
        filterText: sample.filter,
        description: enumLike ? `${sample.count}×` : 'example',
        preselect: sampleFirst && i === 0
      })
    })
    for (const [minor, count] of sortedTypes(counts)) {
      if (minor === type || minor === 'null' || minor === 'undefined') continue
      for (const ctor of this.constructors(minor, field)) {
        this.add('d', {
          ...ctor,
          preselect: false,
          description: `${minor} · ${percent(count, total)}%`
        })
      }
    }
    if (type !== 'null' && (this.query || (counts.null ?? 0) > 0)) {
      this.add('d', {
        label: 'null',
        kind: 'literal',
        insertText: this.valueText('null'),
        snippet: false,
        filterText: 'null'
      })
    }
  }

  private unknownValues(): void {
    this.unknownField = true
    for (const type of UNKNOWN_FIELD_TYPES) {
      if (type === 'uuidLegacy' && this.env.uuidEncoding !== 'java') continue
      for (const ctor of this.constructors(type, undefined))
        this.add('e', { ...ctor, preselect: false })
    }
  }

  private constructors(type: BsonTypeName, field: SchemaField | undefined): Ctor[] {
    const snippet = (label: string, text: string, filterText: string, retrigger = false): Ctor => ({
      label,
      insertText: this.valueText(text),
      snippet: true,
      filterText,
      kind: 'constructor',
      retrigger
    })
    const plain = (text: string, kind: SuggestionKind, preselect?: boolean): Ctor => ({
      label: text,
      insertText: this.valueText(text),
      snippet: false,
      filterText: text,
      kind,
      preselect
    })
    switch (type) {
      case 'objectId':
        return [snippet('ObjectId("…")', 'ObjectId("$0")', 'ObjectId')]
      case 'date': {
        const now = snippetEscape(formatIsoInZone(this.env.now, this.env.timezone))
        return [snippet('ISODate("…")', `ISODate("\${0:${now}}")`, 'ISODate')]
      }
      case 'uuid':
        return [snippet('UUID("…")', 'UUID("$0")', 'UUID')]
      case 'uuidLegacy':
        return this.env.uuidEncoding === 'java'
          ? [snippet('JUUID("…")', 'JUUID("$0")', 'JUUID')]
          : [snippet('BinData(3, "…")', 'BinData(3, "$0")', 'BinData')]
      case 'binData':
        return [snippet('BinData(0, "…")', 'BinData(0, "$0")', 'BinData')]
      case 'long':
        return [snippet('NumberLong("…")', 'NumberLong("${0:0}")', 'NumberLong')]
      case 'decimal':
        return [snippet('NumberDecimal("…")', 'NumberDecimal("${0:0}")', 'NumberDecimal')]
      case 'int':
        // Numbers compare across numeric types in queries, so only the document editor needs NumberInt.
        return this.query ? [] : [snippet('NumberInt(…)', 'NumberInt(${0:0})', 'NumberInt')]
      case 'timestamp': {
        const seconds = Math.floor(this.env.now.getTime() / 1000)
        return [snippet('Timestamp(…)', `Timestamp(\${1:${seconds}}, \${2:1})`, 'Timestamp')]
      }
      case 'regex':
        return [snippet('/…/', '/$0/', '/')]
      case 'string':
        return [snippet('"…"', '"$0"', '"')]
      case 'bool': {
        const trues = valueCount(field, 'true')
        const falses = valueCount(field, 'false')
        return [
          plain('true', 'literal', trues >= falses),
          plain('false', 'literal', falses > trues)
        ]
      }
      case 'null':
        return [plain('null', 'literal')]
      case 'object':
        return [snippet('{ … }', '{ $0 }', '{', true)]
      case 'array':
        return [snippet('[ … ]', '[$0]', '[', true)]
      case 'minKey':
        return [plain('MinKey', 'constructor')]
      case 'maxKey':
        return [plain('MaxKey', 'constructor')]
      case 'javascript':
        return [snippet('Code("…")', 'Code("$0")', 'Code')]
      default:
        return []
    }
  }

  /** Tracked values of `field` rendered as literals, minus those already in the enclosing array. */
  private samples(field: SchemaField, siblings: readonly string[]): Sample[] {
    const out: Sample[] = []
    for (const { ejson, count } of field.values ?? []) {
      const value = parseJson(ejson)
      if (value === undefined) continue
      const text = this.render(value)
      if (siblings.includes(text)) continue
      out.push({ value, text, filter: typeof value === 'string' ? value : text, count })
    }
    return out
  }

  private render(value: unknown): string {
    if (this.query) {
      const number = plainNumber(value)
      if (number !== null) return number
    }
    return serializeMongoValue(value, {
      uuidEncoding: this.env.uuidEncoding,
      timezone: this.env.timezone,
      indent: 0
    })
  }

  private ctorArg(source: FieldSource, path: string | null, ctor: string): void {
    const type = CONSTRUCTOR_TYPES[ctor]
    if (path === null || !type) return
    const { field } = this.field(source, path)
    for (const { ejson } of field?.values ?? []) {
      const value = parseJson(ejson)
      if (classifyCanonical(value) !== type) continue
      const arg = this.constructorArgument(value, type)
      if (!arg || (this.inString && !arg.quoted)) continue
      this.add('b', {
        label: arg.text,
        kind: 'value',
        insertText: this.inString
          ? this.quotedContent(arg.text)
          : arg.quoted
            ? JSON.stringify(arg.text)
            : arg.text,
        snippet: false,
        filterText: arg.text,
        description: 'example'
      })
    }
  }

  /** The single argument of a value's shell-helper rendering, e.g. the hex of `ObjectId("…")`. */
  private constructorArgument(
    value: unknown,
    type: BsonTypeName
  ): { text: string; quoted: boolean } | null {
    const rendered = serializeMongoValue(value, {
      uuidEncoding: this.env.uuidEncoding,
      timezone: this.env.timezone,
      indent: 0
    })
    const match = /^(\w+)\((.*)\)$/s.exec(rendered)
    if (!match || CONSTRUCTOR_TYPES[match[1]!] !== type) return null
    const inner = match[2]!
    if (/^-?[\d.]+$/.test(inner)) return { text: inner, quoted: false }
    const text = parseJson(inner)
    return typeof text === 'string' ? { text, quoted: true } : null
  }

  private typeAliases(source: FieldSource, path: string): void {
    const { field } = this.field(source, path)
    const observed = field
      ? sortedTypes(addCounts(field.types, field.elementTypes ?? {})).map(([type]) =>
          typeAlias(type)
        )
      : []
    observed.forEach((alias) => this.add('b', this.aliasItem(alias)))
    TYPE_ALIASES.forEach((alias) => this.add('c', this.aliasItem(alias)))
  }

  private aliasItem(alias: string): Item {
    return {
      label: alias,
      kind: 'typeAlias',
      insertText: this.stringText(alias),
      snippet: false,
      filterText: alias
    }
  }

  private literals(values: readonly string[], preferred: string | undefined): void {
    for (const value of values) {
      const quoted = value.startsWith('"')
      if (this.inString && !quoted) continue
      const content = quoted ? String(parseJson(value)) : value
      this.add(value === preferred ? 'a' : 'b', {
        label: value,
        kind: quoted ? 'enum' : 'literal',
        insertText: this.inString ? this.quotedContent(content) : this.valueText(value),
        snippet: false,
        filterText: content,
        preselect: value === preferred
      })
    }
  }

  private projectionValue(
    source: FieldSource,
    path: string,
    mode: 'include' | 'exclude' | null
  ): void {
    if (this.inString) {
      this.fieldRefs(source, null, 'b')
      return
    }
    const first = path === '_id' || mode === 'exclude' ? '0' : '1'
    this.addLiteral('a', first, true)
    this.addLiteral('b', first === '1' ? '0' : '1')
    this.addLiteral('c', 'true')
    this.addLiteral('c', 'false')
    const { field } = this.field(source, path)
    if (field && dominantType(field.types) === 'array') {
      this.addTemplate(
        'c',
        `{ $slice: … }`,
        `{ ${this.innerKey('$slice')}: \${0:10} }`,
        '$slice',
        false
      )
      this.addTemplate(
        'c',
        `{ $elemMatch: … }`,
        `{ ${this.innerKey('$elemMatch')}: { $0 } }`,
        '$elemMatch',
        true
      )
    }
    this.addTemplate(
      'd',
      '{ $meta: "textScore" }',
      `{ ${this.innerKey('$meta')}: "textScore" }`,
      '$meta',
      false
    )
    this.fieldRefs(source, null, 'e')
  }

  private sortValue(source: FieldSource, path: string): void {
    if (this.inString) return
    const { field } = this.field(source, path)
    const type = field ? queryType(field) : null
    const descending = type !== null && DESCENDING_SORT.has(type)
    this.addLiteral('a', descending ? '-1' : '1', true)
    this.addLiteral('b', descending ? '1' : '-1')
    this.addTemplate(
      'd',
      '{ $meta: "textScore" }',
      `{ ${this.innerKey('$meta')}: "textScore" }`,
      '$meta',
      false
    )
  }

  private addLiteral(tier: Tier, text: string, preselect = false): void {
    this.add(tier, {
      label: text,
      kind: 'literal',
      insertText: this.valueText(text),
      snippet: false,
      filterText: text,
      preselect
    })
  }

  private addTemplate(
    tier: Tier,
    label: string,
    text: string,
    filterText: string,
    retrigger: boolean
  ): void {
    this.add(tier, {
      label,
      kind: 'value',
      insertText: this.valueText(text),
      snippet: true,
      filterText,
      retrigger
    })
  }

  private stageElements(
    stageIndex: number,
    nested: Nesting | undefined,
    finalWrite: boolean
  ): void {
    if (this.inString) return
    for (const stage of STAGES) {
      if (!stageRuns(stage, stageIndex, nested, finalWrite)) continue
      const value = stage.template ? stage.template(this.innerKey) : '{ $0 }'
      this.add(stageTier(stage), {
        label: stage.name,
        kind: 'stage',
        insertText: this.valueText(`{ ${this.innerKey(stage.name)}: ${value} }`),
        snippet: true,
        filterText: stage.name,
        documentation: stage.doc,
        retrigger: stage.retrigger
      })
    }
  }

  /** Values of the update operators whose values are not documents. */
  private updateValue(source: FieldSource, op: string, path: string): void {
    if (this.inString) return
    switch (op) {
      case '$inc':
        this.addLiteral('a', '1', true)
        this.addLiteral('b', '-1')
        break
      case '$mul':
        this.addLiteral('a', '2', true)
        this.addLiteral('b', '-1')
        break
      case '$unset':
        // The value is ignored; an empty string is the convention.
        this.addLiteral('a', '""', true)
        break
      case '$pop':
        for (const [tier, text, description] of [
          ['a', '1', 'last element'],
          ['b', '-1', 'first element']
        ] as const) {
          this.add(tier, {
            label: text,
            kind: 'literal',
            insertText: this.valueText(text),
            snippet: false,
            filterText: text,
            description,
            preselect: tier === 'a'
          })
        }
        break
      case '$currentDate': {
        const { field } = this.field(source, path)
        const timestamp = field !== undefined && queryType(field) === 'timestamp'
        this.addLiteral(timestamp ? 'b' : 'a', 'true', !timestamp)
        for (const type of ['date', 'timestamp']) {
          const preselect = timestamp && type === 'timestamp'
          this.add(preselect ? 'a' : 'b', {
            label: `{ $type: "${type}" }`,
            kind: 'value',
            insertText: this.valueText(`{ ${this.innerKey('$type')}: "${type}" }`),
            snippet: true,
            filterText: type,
            preselect
          })
        }
        break
      }
      case '$bit':
        for (const operation of ['and', 'or', 'xor']) {
          this.addTemplate(
            'c',
            `{ ${operation}: … }`,
            `{ ${this.innerKey(operation)}: $0 }`,
            operation,
            false
          )
        }
        break
    }
  }

  /** The `bulkWrite` operations, as wrapped array elements or as the key of one. */
  private bulkOperations(element: boolean): void {
    for (const name of BULK_WRITE_OPERATIONS) {
      const documentation = SHELL_METHODS[name]?.doc
      this.add(
        'c',
        element
          ? {
              label: name,
              kind: 'method',
              insertText: this.valueText(`{ ${this.innerKey(name)}: { $0 } }`),
              snippet: true,
              filterText: name,
              documentation,
              retrigger: true
            }
          : {
              label: name,
              kind: 'method',
              ...this.keyInsert(name, '{ $0 }', true),
              filterText: name,
              documentation
            }
      )
    }
  }

  private expressionValue(
    source: FieldSource,
    vars: readonly Variable[],
    prefer: Prefer | undefined
  ): void {
    const variablePath = VARIABLE_PATH.exec(this.ctx.token.prefix)
    if (variablePath) {
      this.variableFields(vars, variablePath[1]!, variablePath[2]!)
      return
    }
    this.fieldRefs(source, this.preferredClass(prefer), 'b')
    for (const name of [...vars.map((v) => v.name), ...SYSTEM_VARIABLES]) {
      const ref = `$$${name}`
      this.add('c', {
        label: ref,
        kind: 'variable',
        insertText: this.stringText(ref),
        snippet: false,
        filterText: ref
      })
    }
    if (this.inString) return
    for (const literal of ['true', 'false', 'null']) this.addLiteral('d', literal)
    this.add('d', {
      label: '{ $operator }',
      kind: 'expression',
      insertText: this.valueText('{ $0 }'),
      snippet: true,
      filterText: '{',
      retrigger: true
    })
  }

  /** `$$name.<subfield>` references below the field variable `name` holds; `rest` is the path typed after it. */
  private variableFields(vars: readonly Variable[], name: string, rest: string): void {
    // An inner binding of a name shadows the outer ones.
    const field = [...vars].reverse().find((v) => v.name === name)?.field
    const schema = field ? this.flow(field.source) : null
    if (!field || !schema) return
    const dot = rest.lastIndexOf('.')
    const path = dot === -1 ? field.path : join(field.path, rest.slice(0, dot))
    const head = `$$${name}.${rest.slice(0, dot + 1)}`
    const children = childFields(schema, path).map((f): [string, SchemaField] => [
      lastSegment(f.path),
      f
    ])
    for (const [child, info] of rankFields(children)) {
      this.addFieldText('b', head + child, info, schema)
    }
  }

  /** `"$path"` references to the fields of `source`, `prefer`-typed fields first. */
  private fieldRefs(source: FieldSource, prefer: TypeClass | null, tier: Tier): void {
    const schema = this.flow(source)
    if (!schema) return
    for (const [path, field] of preferred(rankedFields(schema), prefer)) {
      this.addFieldText(tier, `$${path}`, field, schema)
    }
  }

  private fieldNames(
    source: FieldSource,
    prefer: Prefer | undefined,
    renaming: string | undefined
  ): void {
    const schema = this.flow(source)
    if (!schema) return
    for (const [path, field] of preferred(rankedFields(schema), this.preferredClass(prefer))) {
      if (renaming !== undefined && !renamesTo(schema, renaming, path)) continue
      this.addFieldText('b', path, field, schema)
    }
  }

  /** A field path or reference inserted as a string value. */
  private addFieldText(
    tier: Tier,
    text: string,
    field: SchemaField,
    schema: CollectionSchema
  ): void {
    this.add(tier, {
      label: text,
      kind: 'field',
      insertText: this.stringText(text),
      snippet: false,
      filterText: text,
      ...this.fieldInfo(field, schema)
    })
  }

  private collectionNames(): void {
    const item = (name: string): Item => ({
      label: name,
      kind: 'collection',
      insertText: this.stringText(name),
      snippet: false,
      filterText: name
    })
    for (const name of this.env.collections) if (name !== this.env.coll) this.add('b', item(name))
    this.add('c', item(this.env.coll))
  }

  private shellRoot(): void {
    if (this.inString) return
    const accessor = this.env.collectionAccessor(this.env.coll)
    const escaped = snippetEscape(accessor)
    this.add('a', {
      label: `${accessor}.find({ … })`,
      kind: 'method',
      insertText: `${escaped}.find({ $0 })`,
      snippet: true,
      filterText: `${accessor}.find`,
      preselect: true,
      retrigger: true
    })
    this.add('b', {
      label: 'db',
      kind: 'variable',
      insertText: 'db.',
      snippet: false,
      filterText: 'db',
      retrigger: true
    })
    this.add('c', {
      label: `${accessor}.aggregate([ … ])`,
      kind: 'method',
      insertText: `${escaped}.aggregate([$0])`,
      snippet: true,
      filterText: `${accessor}.aggregate`,
      retrigger: true
    })
  }

  private shellCollections(): void {
    // Renaming the collection of an existing chain keeps its `.method(…)`.
    const keepDot = this.ctx.token.nextChar === '.'
    for (const name of [this.env.coll, ...this.env.collections]) {
      const member = this.env.collectionAccessor(name).slice('db.'.length)
      this.add(member === name ? 'b' : 'c', {
        label: name,
        kind: 'collection',
        insertText: keepDot ? member : `${member}.`,
        snippet: false,
        filterText: name,
        retrigger: !keepDot
      })
    }
  }

  /** Next name segments of dot-addressable collections below `coll`, e.g. `events` after `db.game.`. */
  private collectionSegments(coll: string): void {
    const keepDot = this.ctx.token.nextChar === '.'
    const prefix = `${coll}.`
    for (const name of this.env.collections) {
      if (!name.startsWith(prefix) || this.env.collectionAccessor(name) !== `db.${name}`) continue
      const segment = name.slice(prefix.length).split('.')[0]!
      this.add('b', {
        label: segment,
        kind: 'collection',
        insertText: keepDot ? segment : `${segment}.`,
        snippet: false,
        filterText: segment,
        retrigger: !keepDot
      })
    }
  }

  private methods(names: readonly string[]): void {
    // Renaming a method in front of its existing argument list keeps that list.
    const keepArgs = this.ctx.token.nextChar === '('
    for (const name of names) {
      const def = SHELL_METHODS[name]
      this.add('c', {
        label: name,
        kind: 'method',
        insertText: keepArgs ? name : (def?.template ?? `${name}($0)`),
        snippet: !keepArgs,
        filterText: name,
        documentation: def?.doc,
        retrigger: !keepArgs && def?.retrigger
      })
    }
  }

  private fieldInfo(field: SchemaField | undefined, schema: CollectionSchema | null): FieldInfo {
    if (!field) return {}
    const sampleSize = schema?.sampleSize ?? 0
    // Sample values render per editor kind and display settings.
    const key = `${sampleSize} ${this.query} ${this.env.uuidEncoding} ${this.env.timezone}`
    let infos = FIELD_INFOS.get(field)
    if (!infos) {
      infos = new Map()
      FIELD_INFOS.set(field, infos)
    }
    let info = infos.get(key)
    if (!info) {
      info = this.describeField(field, sampleSize)
      infos.set(key, info)
    }
    return info
  }

  private describeField(field: SchemaField, sampleSize: number): FieldInfo {
    const type = dominantType(field.types) ?? 'unknown'
    const presence = sampleSize > 0 ? ` · ${percent(field.docCount, sampleSize)}%` : ''
    const lines = [`\`${field.path}\``, `types: ${typeBreakdown(field.types)}`]
    if (field.elementTypes) lines.push(`elements: ${typeBreakdown(field.elementTypes)}`)
    if (sampleSize > 0)
      lines.push(`present in ${field.docCount} of ${sampleSize} sampled documents`)
    const values = (field.values ?? []).slice(0, 5).map(({ ejson, count }) => {
      const value = parseJson(ejson)
      return value === undefined ? null : `\`${this.render(value)}\` ×${count}`
    })
    const shown = values.filter((v): v is string => v !== null)
    if (shown.length > 0)
      lines.push(`values: ${shown.join(', ')}${field.valuesTruncated ? ', …' : ''}`)
    return {
      description: field.mapLike ? 'map · keys vary' : `${type}${presence}`,
      documentation: lines.join('\n\n')
    }
  }
}

function argTemplate(kind: ArgKind): { template: string | null; retrigger: boolean } {
  if (typeof kind === 'object')
    return 'enum' in kind
      ? { template: null, retrigger: true }
      : { template: '{ $0 }', retrigger: true }
  switch (kind) {
    case 'collection':
    case 'fieldPath':
      return { template: '"$0"', retrigger: true }
    case 'string':
      return { template: '"$0"', retrigger: false }
    case 'fieldPaths':
    case 'pipeline':
      return { template: '[$0]', retrigger: true }
    case 'array':
      return { template: '[$0]', retrigger: false }
    case 'arrayRef':
      return { template: '"\\$$0"', retrigger: true }
    case 'arrayFilters':
      return { template: '[{ $0 }]', retrigger: true }
    case 'query':
    case 'sort':
    case 'projection':
    case 'update':
    case 'document':
    case 'accumulators':
    case 'windowOutput':
    case 'fillOutput':
    case 'vars':
    case 'object':
      return { template: '{ $0 }', retrigger: true }
    case 'expression':
    case 'dateExpr':
    case 'boolExpr':
    case 'bool':
      return { template: null, retrigger: true }
    case 'number':
    case 'any':
      return { template: null, retrigger: false }
  }
}

function formTemplate(form: OperatorForm): { template: string | null; retrigger: boolean } {
  switch (form) {
    case 'positional':
      return { template: '[$0]', retrigger: true }
    case 'single':
      return { template: null, retrigger: true }
    case 'named':
      return { template: '{ $0 }', retrigger: true }
    case 'none':
      return { template: '{}', retrigger: false }
  }
}

function fits(fit: OperatorFit, field: SchemaField, schema: CollectionSchema | null): boolean {
  const top = dominantType(field.types)
  const element = top === 'array' ? dominantType(field.elementTypes) : top
  switch (fit) {
    case 'always':
      return true
    case 'comparable':
      return element !== null && COMPARABLE.has(element)
    case 'string':
    case 'regexOption':
      return element === 'string'
    case 'array':
      return top === 'array'
    case 'integer':
      return element === 'int' || element === 'long'
    case 'geo':
      return top === 'object'
        ? isGeoJson(field, schema)
        : top === 'array' && element !== null && NUMERIC_TYPES.has(element)
  }
}

/** A GeoJSON object has `type` and `coordinates`; any other embedded document is no geometry. */
function isGeoJson(field: SchemaField, schema: CollectionSchema | null): boolean {
  const names = schema ? childFields(schema, field.path).map((f) => lastSegment(f.path)) : []
  return names.includes('type') && names.includes('coordinates')
}

/** Whether `stage` can run at `index` of a pipeline nested as `nested`; `finalWrite`: a write stage may end the pipeline there. */
function stageRuns(
  stage: StageDef,
  index: number,
  nested: Nesting | undefined,
  finalWrite: boolean
): boolean {
  // A change stream never ends; only a shell aggregate may end with a write.
  if (UNSUPPORTED_STAGES.has(stage.name)) return false
  if (WRITE_STAGES.has(stage.name)) return finalWrite
  if (nested === 'update') return UPDATE_PIPELINE_STAGES.has(stage.name)
  if (stage.subPipelineOnly && nested !== 'sub') return false
  // A $facet branch accepts no first-stage-only stage and no further $facet.
  if (nested === 'facet') return !stage.firstOnly && stage.name !== '$facet'
  return !stage.firstOnly || index === 0
}

/** Stages that write a collection rank last. */
function stageTier(stage: StageDef): Tier {
  return WRITE_STAGES.has(stage.name) ? 'e' : 'c'
}

function isArrayField(schema: CollectionSchema, path: string): boolean {
  return dominantType(resolveSchemaField(schema, path)?.types) === 'array'
}

/** `path` with `$[]` after each array it passes through, the way an update reaches every element. */
function elementPath(schema: CollectionSchema, path: string): string {
  const segments = path.split('.')
  return segments
    .map((segment, i) =>
      i < segments.length - 1 && isArrayField(schema, segments.slice(0, i + 1).join('.'))
        ? `${segment}.$[]`
        : segment
    )
    .join('.')
}

/** Whether `$rename` can move `from` to `to`: not onto _id, not along its own path, not into array elements. */
function renamesTo(schema: CollectionSchema, from: string, to: string): boolean {
  if (to === '_id' || to.startsWith('_id.')) return false
  if (to === from || to.startsWith(`${from}.`) || from.startsWith(`${to}.`)) return false
  return elementPath(schema, to) === to
}

function inClass(type: BsonTypeName | null | undefined, cls: TypeClass): boolean {
  if (!type) return false
  return cls === 'number' ? NUMERIC_TYPES.has(type) : type === cls
}

/** Type a query compares against: the element type of an array field. */
function queryType(field: SchemaField): BsonTypeName | null {
  const top = dominantType(field.types)
  return top === 'array' ? (dominantType(field.elementTypes) ?? top) : top
}

/** `_id` first, then by presence, depth and name. */
function rankFields<T extends SchemaField | undefined>(entries: [string, T][]): [string, T][] {
  return [...entries].sort(([a, fa], [b, fb]) => {
    if (a === '_id' || b === '_id') return a === '_id' ? (b === '_id' ? 0 : -1) : 1
    return (
      (fb?.docCount ?? 0) - (fa?.docCount ?? 0) ||
      a.split('.').length - b.split('.').length ||
      compareText(a, b)
    )
  })
}

/** `addressableFields` of `schema` by path, in `rankFields` order. */
function rankedFields(schema: CollectionSchema): readonly [string, SchemaField][] {
  let ranked = RANKED_FIELDS.get(schema)
  if (!ranked) {
    ranked = rankFields(addressableFields(schema).map((f) => [f.path, f]))
    RANKED_FIELDS.set(schema, ranked)
  }
  return ranked
}

function preferred<T extends SchemaField | undefined>(
  entries: readonly [string, T][],
  prefer: TypeClass | null
): readonly [string, T][] {
  if (prefer === null) return entries
  const matches = (field: SchemaField | undefined): boolean =>
    field !== undefined && inClass(dominantType(field.types), prefer)
  return [...entries.filter(([, f]) => matches(f)), ...entries.filter(([, f]) => !matches(f))]
}

function sortedTypes(counts: TypeCounts): [BsonTypeName, number][] {
  return (Object.entries(counts) as [BsonTypeName, number][])
    .filter(([, count]) => count > 0)
    .sort(([a, ca], [b, cb]) => cb - ca || compareText(a, b))
}

function typeBreakdown(counts: TypeCounts): string {
  const total = sumCounts(counts)
  return sortedTypes(counts)
    .map(([type, count]) => `${type} ${percent(count, total)}%`)
    .join(' · ')
}

function sumCounts(counts: TypeCounts): number {
  return Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

function sumValueCounts(values: readonly { count: number }[]): number {
  return values.reduce((sum, value) => sum + value.count, 0)
}

function valueCount(field: SchemaField | undefined, ejson: string): number {
  return field?.values?.find((value) => value.ejson === ejson)?.count ?? 0
}

function percent(count: number, total: number): number {
  return total > 0 ? Math.round((count * 100) / total) : 0
}

/** `$numberInt` and finite `$numberDouble` as plain numbers; null for anything else. */
function plainNumber(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const wrapper = value as Record<string, unknown>
  const raw = wrapper['$numberInt'] ?? wrapper['$numberDouble']
  if (typeof raw !== 'string' || Object.keys(wrapper).length !== 1) return null
  const number = Number(raw)
  return Number.isFinite(number) ? String(number) : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function snippetEscape(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&')
}

function escapeInQuotes(text: string, quote: '"' | "'"): string {
  const json = JSON.stringify(text).slice(1, -1)
  return quote === '"' ? json : json.replace(/\\"/g, '"').replace(/'/g, "\\'")
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1)
}
