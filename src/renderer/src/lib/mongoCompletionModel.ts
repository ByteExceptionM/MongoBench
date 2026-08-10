export type QueryRole = 'filter' | 'sort' | 'projection'

export type EditorCompletionContext =
  | { kind: 'query'; role: QueryRole }
  | { kind: 'pipeline' }
  | { kind: 'shell'; coll: string; collections: readonly string[] }

export const QUERY_COMPLETION_CONTEXT: EditorCompletionContext = { kind: 'query', role: 'filter' }
export const SORT_COMPLETION_CONTEXT: EditorCompletionContext = { kind: 'query', role: 'sort' }
export const PROJECTION_COMPLETION_CONTEXT: EditorCompletionContext = {
  kind: 'query',
  role: 'projection'
}
export const PIPELINE_COMPLETION_CONTEXT: EditorCompletionContext = { kind: 'pipeline' }

export type SuggestionKind =
  | 'operator'
  | 'stage'
  | 'expression'
  | 'update'
  | 'ejson'
  | 'field'
  | 'fieldPath'
  | 'helper'
  | 'literal'
  | 'value'
  | 'method'
  | 'collection'
  | 'database'
  | 'command'

export type CompletionItemData = {
  label: string
  insertText: string
  filterText: string
  doc: string
  detail: string
  kind: SuggestionKind
  sortText: string
  retrigger: boolean
}

export type CompletionGroup = {
  prefixLength: number
  consumeTrailingQuote: boolean
  items: CompletionItemData[]
}

export type CompletionRequest = {
  context: EditorCompletionContext
  textUpToCursor: string
  lineUpToCursor: string
  charAfterCursor: string
  fieldNames: readonly string[]
}

type Signature = readonly [label: string, value: string, doc: string]

type BracketEntry = { char: '{' | '[' | '('; index: number }

type BracketScan = { stack: BracketEntry[]; inString: boolean }

type StagePosition = 'array' | 'object'

export function resolveCompletions(request: CompletionRequest): CompletionGroup[] {
  const { context, textUpToCursor, lineUpToCursor, charAfterCursor, fieldNames } = request
  const scan = scanBrackets(textUpToCursor)
  const call = enclosingCall(textUpToCursor, scan)

  if (context.kind === 'shell') {
    const structural = shellStructureGroup(context, textUpToCursor, scan)
    if (structural) return [structural]
  }

  const valueMatch = /:\s*(-?\d*)$/.exec(lineUpToCursor)
  if (valueMatch) {
    const values = valueSignatures(context, call)
    if (values) {
      return [
        {
          prefixLength: (valueMatch[1] ?? '').length,
          consumeTrailingQuote: false,
          items: plainItems(values, 'value', 'Value')
        }
      ]
    }
  }

  const operatorMatch = /"?\$[A-Za-z0-9]*$/.exec(lineUpToCursor)
  if (operatorMatch) {
    const quoted = operatorMatch[0].startsWith('"')
    const group: CompletionGroup = {
      prefixLength: operatorMatch[0].length,
      consumeTrailingQuote: quoted && charAfterCursor === '"',
      items: []
    }
    const stagePosition = stagePositionOf(context, textUpToCursor, scan)
    if (stagePosition) {
      group.items = keyItems(AGGREGATION_STAGES, 'stage', 'Aggregation stage', quoted, {
        wrapInObject: stagePosition === 'array'
      })
      return [group]
    }
    if (isUpdatePosition(context, call)) {
      group.items = keyItems(UPDATE_OPERATORS, 'update', 'Update operator', quoted)
      return [group]
    }
    group.items = operatorItems(context, textUpToCursor, scan, quoted)
    if (isAggregationSource(context, textUpToCursor)) {
      group.items.push(...fieldPathItems(fieldNames, quoted))
    }
    return [group]
  }

  const groups: CompletionGroup[] = []

  const keyMatch = /(?:^|[{,])\s*("?)([A-Za-z_$][\w.]*)?$/.exec(lineUpToCursor)
  if (keyMatch && fieldNames.length > 0) {
    const quoted = keyMatch[1] === '"'
    const partial = keyMatch[2] ?? ''
    groups.push({
      prefixLength: partial.length + (quoted ? 1 : 0),
      consumeTrailingQuote: quoted && charAfterCursor === '"',
      items: fieldNames.map((name) => ({
        label: name,
        insertText: '"' + name + '"',
        filterText: (quoted ? '"' : '') + name,
        doc: 'Top level field of the documents in this collection.',
        detail: 'Document field',
        kind: 'field' as const,
        sortText: '0_' + name,
        retrigger: false
      }))
    })
  }

  const helperMatch = /(?:^|[\s:,[(])([A-Za-z][A-Za-z0-9]*)$/.exec(lineUpToCursor)
  if (helperMatch) {
    groups.push({
      prefixLength: (helperMatch[1] ?? '').length,
      consumeTrailingQuote: false,
      items: shellHelperItems()
    })
  }

  return groups
}

function shellStructureGroup(
  context: { coll: string; collections: readonly string[] },
  text: string,
  scan: BracketScan
): CompletionGroup | null {
  if (scan.inString || scan.stack.length > 0) return null

  const chainMatch = /\)\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(text)
  if (chainMatch) {
    return group(chainMatch[1], chainMethodItems(headMethodOf(text)))
  }

  const methodMatch = /^\s*db\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(text)
  if (methodMatch) {
    return group(methodMatch[1], methodItems(COLLECTION_METHODS))
  }

  const collectionMatch = /^\s*db\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(text)
  if (collectionMatch) {
    return group(collectionMatch[1], collectionItems(context.coll, context.collections))
  }

  const rootMatch = /^\s*([A-Za-z_$][\w$]*)?$/.exec(text)
  if (rootMatch) {
    return group(rootMatch[1], rootItems(context.coll))
  }

  return null
}

function collectionItems(coll: string, collections: readonly string[]): CompletionItemData[] {
  const names = collections.includes(coll) ? collections : [coll, ...collections]
  return names.map((name) => ({
    label: name,
    insertText: name + '.',
    filterText: name,
    doc:
      name === coll
        ? 'Collection of the current tab.'
        : 'Another collection of this database. Results replace the tab content.',
    detail: 'Collection',
    kind: 'collection' as const,
    sortText: (name === coll ? '0_' : '1_') + name,
    retrigger: true
  }))
}

function group(prefix: string | undefined, items: CompletionItemData[]): CompletionGroup {
  return { prefixLength: (prefix ?? '').length, consumeTrailingQuote: false, items }
}

function headMethodOf(text: string): string | null {
  const head = /^\s*db\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text)
  return head?.[1] ?? null
}

function rootItems(coll: string): CompletionItemData[] {
  return [
    {
      label: 'db',
      insertText: 'db.',
      filterText: 'db',
      doc: 'Shell handle for the current database.',
      detail: 'mongo shell',
      kind: 'database',
      sortText: '0_db',
      retrigger: true
    },
    {
      label: 'db.' + coll + '.find',
      insertText: 'db.' + coll + '.find({ $0 })',
      filterText: 'db.' + coll + '.find',
      doc: 'Query documents in this collection.',
      detail: 'mongo shell command',
      kind: 'command',
      sortText: '1_find',
      retrigger: false
    },
    {
      label: 'db.' + coll + '.aggregate',
      insertText: 'db.' + coll + '.aggregate([\n\t{ $0 }\n])',
      filterText: 'db.' + coll + '.aggregate',
      doc: 'Run an aggregation pipeline on this collection.',
      detail: 'mongo shell command',
      kind: 'command',
      sortText: '1_aggregate',
      retrigger: false
    }
  ]
}

function methodItems(signatures: readonly Signature[]): CompletionItemData[] {
  return signatures.map(([label, insertText, doc]) => ({
    label,
    insertText,
    filterText: label,
    doc,
    detail: 'mongo shell method',
    kind: 'method' as const,
    sortText: label,
    retrigger: false
  }))
}

function chainMethodItems(headMethod: string | null): CompletionItemData[] {
  if (headMethod === 'find') return methodItems(CURSOR_METHODS)
  if (headMethod !== null && WRITE_METHOD_NAMES.has(headMethod)) return []
  return methodItems(NO_ARGUMENT_METHODS)
}

function keyItems(
  signatures: readonly Signature[],
  kind: SuggestionKind,
  detail: string,
  quoted: boolean,
  options?: { wrapInObject?: boolean }
): CompletionItemData[] {
  return signatures.map(([label, value, doc]) => {
    const body = '"' + label + '": ' + value
    return {
      label,
      insertText: options?.wrapInObject ? '{ ' + body + ' }' : body,
      filterText: (quoted ? '"' : '') + label,
      doc,
      detail,
      kind,
      sortText: label,
      retrigger: false
    }
  })
}

function operatorItems(
  context: EditorCompletionContext,
  text: string,
  scan: BracketScan,
  quoted: boolean
): CompletionItemData[] {
  const ejson = keyItems(ejsonWrappers(), 'ejson', 'EJSON / BSON type', quoted)
  if (!usesAggregationExpressions(context, text, scan)) {
    return [...keyItems(QUERY_OPERATORS, 'operator', 'MongoDB query operator', quoted), ...ejson]
  }
  return [
    ...keyItems(AGGREGATION_EXPRESSIONS, 'expression', 'Aggregation expression', quoted),
    ...ejson
  ]
}

function fieldPathItems(fieldNames: readonly string[], quoted: boolean): CompletionItemData[] {
  return fieldNames.map((name) => ({
    label: '$' + name,
    insertText: '"$' + name + '"',
    filterText: (quoted ? '"' : '') + '$' + name,
    doc: 'References the `' + name + '` field of the current document.',
    detail: 'Field path',
    kind: 'fieldPath' as const,
    sortText: '0_' + name,
    retrigger: false
  }))
}

function shellHelperItems(): CompletionItemData[] {
  return [
    ...shellHelpers().map(([label, insertText, doc]) => ({
      label,
      insertText,
      filterText: label,
      doc,
      detail: 'mongo shell helper',
      kind: 'helper' as const,
      sortText: label,
      retrigger: false
    })),
    ...LITERALS.map(([label, insertText, doc]) => ({
      label,
      insertText,
      filterText: label,
      doc,
      detail: 'literal',
      kind: 'literal' as const,
      sortText: label,
      retrigger: false
    }))
  ]
}

export type SignatureInfo = {
  label: string
  doc: string
  parameters: { label: string; doc: string }[]
  activeParameter: number
}

/** Parameter hints for the call the cursor currently sits in. */
export function resolveSignature(textUpToCursor: string): SignatureInfo | null {
  const scan = scanBrackets(textUpToCursor)
  if (scan.inString) return null
  const call = enclosingCall(textUpToCursor, scan)
  if (!call) return null
  const definition = CALL_SIGNATURES[call.name]
  if (!definition) return null
  return {
    label: call.name + '(' + definition.parameters.map(([name]) => name).join(', ') + ')',
    doc: definition.doc,
    parameters: definition.parameters.map(([name, doc]) => ({ label: name, doc })),
    activeParameter: Math.min(call.argIndex, Math.max(0, definition.parameters.length - 1))
  }
}

export type SymbolDescription = {
  label: string
  entries: { detail: string; doc: string }[]
}

/** Documentation shown when hovering an operator, helper or method. */
export function describeSymbol(label: string): SymbolDescription | null {
  const entries = symbolIndex().get(label)
  return entries ? { label, entries } : null
}

let symbolIndexCache: Map<string, { detail: string; doc: string }[]> | null = null

function symbolIndex(): Map<string, { detail: string; doc: string }[]> {
  if (symbolIndexCache) return symbolIndexCache
  const index = new Map<string, { detail: string; doc: string }[]>()
  const add = (signatures: readonly Signature[], detail: string): void => {
    for (const [label, , doc] of signatures) {
      const existing = index.get(label)
      if (existing) existing.push({ detail, doc })
      else index.set(label, [{ detail, doc }])
    }
  }
  add(QUERY_OPERATORS, 'MongoDB query operator')
  add(AGGREGATION_STAGES, 'Aggregation stage')
  add(AGGREGATION_EXPRESSIONS, 'Aggregation expression')
  add(UPDATE_OPERATORS, 'Update operator')
  add(ejsonWrappers(), 'EJSON / BSON type')
  add(shellHelpers(), 'mongo shell helper')
  add(COLLECTION_METHODS, 'Collection method')
  add(CURSOR_METHODS, 'Cursor method')
  add(LITERALS, 'Literal')
  symbolIndexCache = index
  return index
}

type CallSignature = { doc: string; parameters: ReadonlyArray<readonly [string, string]> }

const FILTER_PARAM = ['filter', 'Query predicate, for example `{ status: "active" }`.'] as const
const OPTIONS_PARAM = ['options', 'Only `{ upsert: true }` is supported here.'] as const

const CALL_SIGNATURES: Record<string, CallSignature> = {
  find: {
    doc: 'Returns the documents matching the filter.',
    parameters: [FILTER_PARAM, ['projection', 'Fields to include (1) or exclude (0).']]
  },
  findOne: { doc: 'Returns the first matching document.', parameters: [FILTER_PARAM] },
  count: { doc: 'Counts the matching documents.', parameters: [FILTER_PARAM] },
  countDocuments: { doc: 'Counts the matching documents.', parameters: [FILTER_PARAM] },
  aggregate: {
    doc: 'Runs an aggregation pipeline.',
    parameters: [['pipeline', 'Array of stage objects, for example `[{ $match: { … } }]`.']]
  },
  insertOne: {
    doc: 'Inserts a single document.',
    parameters: [['document', 'The document to insert.']]
  },
  insertMany: {
    doc: 'Inserts several documents.',
    parameters: [['documents', 'Array of documents to insert.']]
  },
  updateOne: {
    doc: 'Applies update operators to the first matching document.',
    parameters: [
      FILTER_PARAM,
      ['update', 'Update operators such as `{ $set: { … } }`, or a pipeline.'],
      OPTIONS_PARAM
    ]
  },
  updateMany: {
    doc: 'Applies update operators to every matching document.',
    parameters: [
      FILTER_PARAM,
      ['update', 'Update operators such as `{ $set: { … } }`, or a pipeline.'],
      OPTIONS_PARAM
    ]
  },
  replaceOne: {
    doc: 'Replaces the first matching document entirely.',
    parameters: [FILTER_PARAM, ['replacement', 'The full replacement document.'], OPTIONS_PARAM]
  },
  deleteOne: { doc: 'Deletes the first matching document.', parameters: [FILTER_PARAM] },
  deleteMany: { doc: 'Deletes every matching document.', parameters: [FILTER_PARAM] },
  sort: {
    doc: 'Orders the result set.',
    parameters: [['spec', 'Field to direction map, 1 ascending and -1 descending.']]
  },
  skip: { doc: 'Skips the first n documents.', parameters: [['n', 'Non-negative integer.']] },
  limit: { doc: 'Caps the result size.', parameters: [['n', 'Non-negative integer.']] },
  ObjectId: { doc: 'ObjectId literal.', parameters: [['hex', '24 character hex string.']] },
  ISODate: { doc: 'Date literal.', parameters: [['iso', 'ISO-8601 date string.']] },
  Date: { doc: 'Date literal.', parameters: [['iso', 'ISO-8601 date string.']] },
  NumberLong: { doc: 'BSON 64 bit integer.', parameters: [['value', 'Integer as a string.']] },
  NumberInt: { doc: 'BSON 32 bit integer.', parameters: [['value', 'Integer value.']] },
  NumberDecimal: { doc: 'BSON 128 bit decimal.', parameters: [['value', 'Decimal as a string.']] },
  UUID: { doc: 'UUID literal.', parameters: [['uuid', 'Canonical UUID string.']] },
  JUUID: { doc: 'Legacy Java driver UUID.', parameters: [['uuid', 'Canonical UUID string.']] },
  BinData: {
    doc: 'Binary data.',
    parameters: [
      ['subType', 'BSON binary subtype, for example 0.'],
      ['base64', 'Payload as base64.']
    ]
  },
  Timestamp: {
    doc: 'BSON replication timestamp.',
    parameters: [
      ['t', 'Seconds since the epoch.'],
      ['i', 'Ordinal within the second.']
    ]
  },
  DBRef: {
    doc: 'Document reference.',
    parameters: [
      ['coll', 'Referenced collection.'],
      ['id', 'Referenced _id.']
    ]
  },
  Code: { doc: 'BSON code value.', parameters: [['source', 'JavaScript source.']] },
  RegExp: {
    doc: 'Regular expression.',
    parameters: [
      ['pattern', 'Regex pattern.'],
      ['flags', 'Regex flags such as i or m.']
    ]
  }
}

type EnclosingCall = { name: string; argIndex: number }

function enclosingCall(text: string, scan: BracketScan): EnclosingCall | null {
  for (let i = scan.stack.length - 1; i >= 0; i--) {
    const entry = scan.stack[i]!
    if (entry.char !== '(') continue
    const head = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, entry.index))
    if (!head) return null
    return { name: head[1]!, argIndex: countTopLevelCommas(text.slice(entry.index + 1)) }
  }
  return null
}

function countTopLevelCommas(text: string): number {
  let depth = 0
  let commas = 0
  let i = 0
  while (i < text.length) {
    const char = text.charAt(i)
    if (char === '"' || char === "'") {
      const end = skipStringLiteral(text, i)
      if (end < 0) return commas
      i = end
      continue
    }
    if (char === '{' || char === '[' || char === '(') depth++
    else if (char === '}' || char === ']' || char === ')') depth--
    else if (char === ',' && depth === 0) commas++
    i++
  }
  return commas
}

function isUpdatePosition(context: EditorCompletionContext, call: EnclosingCall | null): boolean {
  if (context.kind !== 'shell' || call === null) return false
  return (call.name === 'updateOne' || call.name === 'updateMany') && call.argIndex === 1
}

function valueSignatures(
  context: EditorCompletionContext,
  call: EnclosingCall | null
): readonly Signature[] | null {
  if (context.kind === 'query') {
    if (context.role === 'sort') return SORT_VALUES
    if (context.role === 'projection') return PROJECTION_VALUES
    return null
  }
  if (context.kind !== 'shell' || call === null) return null
  if (call.name === 'sort') return SORT_VALUES
  if (call.name === 'find' && call.argIndex === 1) return PROJECTION_VALUES
  return null
}

function plainItems(
  signatures: readonly Signature[],
  kind: SuggestionKind,
  detail: string
): CompletionItemData[] {
  return signatures.map(([label, insertText, doc]) => ({
    label,
    insertText,
    filterText: label,
    doc,
    detail,
    kind,
    sortText: label,
    retrigger: false
  }))
}

const SORT_VALUES: readonly Signature[] = [
  ['1', '1', 'Ascending order.'],
  ['-1', '-1', 'Descending order.']
]

const PROJECTION_VALUES: readonly Signature[] = [
  ['1', '1', 'Include the field.'],
  ['0', '0', 'Exclude the field.']
]

function isAggregationSource(context: EditorCompletionContext, text: string): boolean {
  if (context.kind === 'pipeline') return true
  if (context.kind === 'shell') return /\baggregate\s*\(/.test(text)
  return false
}

function stagePositionOf(
  context: EditorCompletionContext,
  text: string,
  scan: BracketScan
): StagePosition | null {
  if (!isAggregationSource(context, text)) return null
  const top = scan.stack[scan.stack.length - 1]
  if (!top) return null
  if (top.char === '[') return 'array'
  if (top.char === '{' && scan.stack[scan.stack.length - 2]?.char === '[') return 'object'
  return null
}

function usesAggregationExpressions(
  context: EditorCompletionContext,
  text: string,
  scan: BracketScan
): boolean {
  if (!isAggregationSource(context, text)) return false
  const stage = enclosingStage(text, scan)
  if (!stage) return false
  return stage.name !== '$match' || stage.body.includes('$expr')
}

function enclosingStage(text: string, scan: BracketScan): { name: string; body: string } | null {
  const index = scan.stack.findIndex(
    (entry, i) => entry.char === '{' && scan.stack[i - 1]?.char === '['
  )
  const entry = index < 0 ? undefined : scan.stack[index]
  if (!entry) return null
  const body = text.slice(entry.index + 1)
  const name = /^\s*"?(\$[A-Za-z]\w*)"?\s*:/.exec(body)?.[1]
  return name ? { name, body } : null
}

function scanBrackets(text: string): BracketScan {
  const stack: BracketEntry[] = []
  let i = 0
  while (i < text.length) {
    const char = text.charAt(i)
    if (char === '"' || char === "'") {
      const end = skipStringLiteral(text, i)
      if (end < 0) return { stack, inString: true }
      i = end
      continue
    }
    if (char === '{' || char === '[' || char === '(') stack.push({ char, index: i })
    else if (char === '}' || char === ']' || char === ')') stack.pop()
    i++
  }
  return { stack, inString: false }
}

function skipStringLiteral(text: string, start: number): number {
  const quote = text.charAt(start)
  let i = start + 1
  while (i < text.length) {
    const char = text.charAt(i)
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === quote) return i + 1
    i++
  }
  return -1
}

const COLLECTION_METHODS: readonly Signature[] = [
  ['find', 'find({ $0 })', 'Returns the documents matching the filter.'],
  ['findOne', 'findOne({ $0 })', 'Returns the first document matching the filter.'],
  ['aggregate', 'aggregate([\n\t{ $0 }\n])', 'Runs an aggregation pipeline.'],
  ['countDocuments', 'countDocuments({ $0 })', 'Counts the documents matching the filter.'],
  ['count', 'count({ $0 })', 'Counts the documents matching the filter.'],
  ['insertOne', 'insertOne({ $0 })', 'Inserts a single document.'],
  ['insertMany', 'insertMany([\n\t{ $0 }\n])', 'Inserts several documents.'],
  [
    'updateOne',
    'updateOne({ $1 }, { "$set": { $0 } })',
    'Applies update operators to the first matching document.'
  ],
  [
    'updateMany',
    'updateMany({ $1 }, { "$set": { $0 } })',
    'Applies update operators to every matching document.'
  ],
  ['replaceOne', 'replaceOne({ $1 }, { $0 })', 'Replaces the first matching document entirely.'],
  ['deleteOne', 'deleteOne({ $0 })', 'Deletes the first matching document.'],
  ['deleteMany', 'deleteMany({ $0 })', 'Deletes every matching document.']
]

const WRITE_METHOD_NAMES: ReadonlySet<string> = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany'
])

const NO_ARGUMENT_METHODS: readonly Signature[] = [
  ['toArray', 'toArray()', 'Materialises the cursor. Accepted and ignored here.'],
  ['pretty', 'pretty()', 'Formats the output. Accepted and ignored here.']
]

const CURSOR_METHODS: readonly Signature[] = [
  ['sort', 'sort({ ${1:field}: ${2:-1} })', 'Orders the result set.'],
  ['skip', 'skip(${1:0})', 'Skips the first n documents.'],
  ['limit', 'limit(${1:50})', 'Caps the number of returned documents.'],
  ...NO_ARGUMENT_METHODS
]

const QUERY_OPERATORS: readonly Signature[] = [
  ['$eq', '${1:value}', 'Matches values equal to a specified value.'],
  ['$ne', '${1:value}', 'Matches values not equal to a specified value.'],
  ['$gt', '${1:value}', 'Matches values greater than a specified value.'],
  ['$gte', '${1:value}', 'Matches values greater than or equal to a specified value.'],
  ['$lt', '${1:value}', 'Matches values less than a specified value.'],
  ['$lte', '${1:value}', 'Matches values less than or equal to a specified value.'],
  ['$in', '[${1:values}]', 'Matches any of the values in the array.'],
  ['$nin', '[${1:values}]', 'Matches none of the values in the array.'],
  ['$and', '[\n\t{ $0 }\n]', 'Joins clauses with logical AND.'],
  ['$or', '[\n\t{ $0 }\n]', 'Joins clauses with logical OR.'],
  ['$nor', '[\n\t{ $0 }\n]', 'Joins clauses with logical NOR.'],
  ['$not', '{ $0 }', 'Inverts the effect of an expression.'],
  ['$exists', '${1|true,false|}', 'Matches documents that have or lack the field.'],
  [
    '$type',
    '"${1|double,string,object,array,binData,objectId,bool,date,null,regex,int,timestamp,long,decimal,minKey,maxKey|}"',
    'Matches documents whose field is one of the BSON types.'
  ],
  ['$expr', '{ $0 }', 'Allows the use of aggregation expressions inside the query.'],
  ['$jsonSchema', '{ $0 }', 'Validates documents against a JSON Schema.'],
  ['$mod', '[${1:divisor}, ${2:remainder}]', 'Performs a modulo operation.'],
  ['$regex', '"${1:pattern}", "$options": "${2:i}"', 'Pattern match against a regex.'],
  ['$options', '"${1:i}"', 'Regex options: i (case insensitive), m, x, s.'],
  ['$text', '{ "$search": "${1:query}" }', 'Performs a text search.'],
  ['$search', '"${1:query}"', 'Search string of a $text query.'],
  ['$language', '"${1:english}"', 'Language used for the text search.'],
  ['$caseSensitive', '${1|true,false|}', 'Case sensitive text search.'],
  ['$diacriticSensitive', '${1|true,false|}', 'Diacritic sensitive text search.'],
  ['$where', '"${1:this.field === value}"', 'Server side JavaScript predicate (slow).'],
  ['$all', '[${1:values}]', 'Matches arrays containing all specified elements.'],
  ['$elemMatch', '{ $0 }', 'Matches arrays with an element matching all criteria.'],
  ['$size', '${1:n}', 'Matches arrays of the given length.'],
  ['$bitsAllClear', '${1:mask}', 'All bits of the mask are clear (0).'],
  ['$bitsAllSet', '${1:mask}', 'All bits of the mask are set (1).'],
  ['$bitsAnyClear', '${1:mask}', 'Any bit of the mask is clear.'],
  ['$bitsAnySet', '${1:mask}', 'Any bit of the mask is set.'],
  [
    '$geoIntersects',
    '{ "$geometry": { "type": "${1:Point}", "coordinates": [${2:0}, ${3:0}] } }',
    'Selects geometries intersecting a GeoJSON geometry.'
  ],
  [
    '$geoWithin',
    '{ "$geometry": { "type": "${1:Polygon}", "coordinates": ${2:[[[0, 0]]]} } }',
    'Selects geometries within a bounding GeoJSON geometry.'
  ],
  [
    '$near',
    '{ "$geometry": { "type": "Point", "coordinates": [${1:lng}, ${2:lat}] }, "$maxDistance": ${3:meters} }',
    'Returns documents ordered by proximity to a point.'
  ],
  [
    '$nearSphere',
    '{ "$geometry": { "type": "Point", "coordinates": [${1:lng}, ${2:lat}] }, "$maxDistance": ${3:meters} }',
    'Like $near but uses spherical geometry.'
  ],
  ['$geometry', '{ "type": "${1:Point}", "coordinates": ${2:[0, 0]} }', 'GeoJSON geometry helper.'],
  ['$maxDistance', '${1:meters}', 'Maximum distance in meters from the $near point.'],
  ['$minDistance', '${1:meters}', 'Minimum distance in meters from the $near point.'],
  [
    '$box',
    '[[${1:lngLow}, ${2:latLow}], [${3:lngHigh}, ${4:latHigh}]]',
    'Legacy bounding box for $geoWithin.'
  ],
  ['$center', '[[${1:lng}, ${2:lat}], ${3:radius}]', 'Legacy flat circle for $geoWithin.'],
  ['$centerSphere', '[[${1:lng}, ${2:lat}], ${3:radians}]', 'Spherical circle for $geoWithin.'],
  [
    '$polygon',
    '[[${1:lng1}, ${2:lat1}], [${3:lng2}, ${4:lat2}], [${5:lng3}, ${6:lat3}]]',
    'Legacy polygon for $geoWithin.'
  ],
  ['$slice', '${1:n}', 'Limits the array elements returned by a projection.'],
  ['$meta', '"${1|textScore,indexKey|}"', 'Projects document metadata.']
]

const UPDATE_OPERATORS: readonly Signature[] = [
  ['$set', '{ "${1:field}": ${2:value} }', 'Sets the value of a field.'],
  ['$unset', '{ "${1:field}": "" }', 'Removes a field.'],
  ['$inc', '{ "${1:field}": ${2:1} }', 'Increments a numeric field.'],
  ['$mul', '{ "${1:field}": ${2:2} }', 'Multiplies a numeric field.'],
  ['$rename', '{ "${1:field}": "${2:newName}" }', 'Renames a field.'],
  ['$min', '{ "${1:field}": ${2:value} }', 'Only updates when the new value is smaller.'],
  ['$max', '{ "${1:field}": ${2:value} }', 'Only updates when the new value is larger.'],
  ['$currentDate', '{ "${1:field}": true }', 'Sets a field to the current date.'],
  ['$setOnInsert', '{ "${1:field}": ${2:value} }', 'Sets fields only on an upsert insert.'],
  ['$push', '{ "${1:field}": ${2:value} }', 'Appends a value to an array.'],
  ['$addToSet', '{ "${1:field}": ${2:value} }', 'Appends a value only when it is missing.'],
  ['$pull', '{ "${1:field}": ${2:value} }', 'Removes matching values from an array.'],
  ['$pullAll', '{ "${1:field}": [${2:values}] }', 'Removes all listed values from an array.'],
  ['$pop', '{ "${1:field}": ${2|1,-1|} }', 'Removes the first (-1) or last (1) array element.'],
  ['$each', '[${1:values}]', 'Modifier for $push and $addToSet to add several values.'],
  ['$slice', '${1:10}', 'Modifier for $push that trims the array.'],
  ['$sort', '{ "${1:field}": ${2:-1} }', 'Modifier for $push that orders the array.'],
  ['$position', '${1:0}', 'Modifier for $push that sets the insert position.'],
  ['$bit', '{ "${1:field}": { "and": ${2:1} } }', 'Bitwise update of an integer field.']
]

const AGGREGATION_STAGES: readonly Signature[] = [
  ['$addFields', '{ "${1:field}": ${2:expression} }', 'Adds new fields to the documents.'],
  [
    '$bucket',
    '{ "groupBy": "$${1:field}", "boundaries": [${2:0, 10}], "default": "${3:other}", "output": { $0 } }',
    'Groups documents into buckets by the given boundaries.'
  ],
  [
    '$bucketAuto',
    '{ "groupBy": "$${1:field}", "buckets": ${2:5} }',
    'Groups documents into evenly distributed buckets.'
  ],
  ['$changeStream', '{ }', 'Returns a change stream cursor for the collection.'],
  ['$collStats', '{ "storageStats": { } }', 'Returns statistics about the collection.'],
  ['$count', '"${1:count}"', 'Counts the documents at this point of the pipeline.'],
  [
    '$densify',
    '{ "field": "${1:field}", "range": { "step": ${2:1}, "unit": "${3:day}", "bounds": "${4:full}" } }',
    'Creates the missing documents of a sequence.'
  ],
  ['$documents', '[${1:documents}]', 'Emits literal documents into the pipeline.'],
  ['$facet', '{ "${1:name}": [\n\t\t$0\n\t] }', 'Runs several sub pipelines on the same input.'],
  [
    '$fill',
    '{ "output": { "${1:field}": { "method": "${2|linear,locf|}" } } }',
    'Fills in missing field values.'
  ],
  [
    '$geoNear',
    '{ "near": { "type": "Point", "coordinates": [${1:lng}, ${2:lat}] }, "distanceField": "${3:distance}" }',
    'Orders the documents by proximity to a point.'
  ],
  [
    '$graphLookup',
    '{ "from": "${1:collection}", "startWith": "$${2:field}", "connectFromField": "${3:field}", "connectToField": "${4:field}", "as": "${5:result}" }',
    'Performs a recursive search on a collection.'
  ],
  [
    '$group',
    '{ "_id": "$${1:field}", "${2:count}": { "$sum": 1 } }',
    'Groups documents by a key and applies accumulators.'
  ],
  ['$indexStats', '{ }', 'Returns usage statistics for every index.'],
  ['$limit', '${1:10}', 'Passes only the first n documents on.'],
  [
    '$lookup',
    '{ "from": "${1:collection}", "localField": "${2:field}", "foreignField": "${3:_id}", "as": "${4:result}" }',
    'Performs a left outer join with another collection.'
  ],
  ['$match', '{ $0 }', 'Filters the documents with a query predicate.'],
  ['$merge', '{ "into": "${1:collection}" }', 'Writes the results into a collection.'],
  ['$out', '"${1:collection}"', 'Replaces a collection with the pipeline results.'],
  ['$project', '{ "${1:field}": 1 }', 'Includes, excludes or computes fields.'],
  ['$redact', '"$$${1|DESCEND,PRUNE,KEEP|}"', 'Restricts documents based on their content.'],
  ['$replaceRoot', '{ "newRoot": "$${1:field}" }', 'Promotes a sub document to the top level.'],
  ['$replaceWith', '"$${1:field}"', 'Shorthand for $replaceRoot.'],
  ['$sample', '{ "size": ${1:10} }', 'Selects a random sample of documents.'],
  [
    '$search',
    '{ "index": "${1:default}", "text": { "query": "${2:query}", "path": "${3:field}" } }',
    'Atlas Search full text query.'
  ],
  ['$set', '{ "${1:field}": ${2:expression} }', 'Adds or overwrites fields. Alias of $addFields.'],
  [
    '$setWindowFields',
    '{ "partitionBy": "$${1:field}", "sortBy": { "${2:field}": 1 }, "output": { $0 } }',
    'Computes window function output over partitions.'
  ],
  ['$skip', '${1:0}', 'Skips the first n documents.'],
  ['$sort', '{ "${1:field}": ${2:-1} }', 'Orders the documents.'],
  ['$sortByCount', '"$${1:field}"', 'Groups by an expression and sorts by descending count.'],
  [
    '$unionWith',
    '{ "coll": "${1:collection}", "pipeline": [\n\t\t$0\n\t] }',
    'Combines the results of two collections.'
  ],
  ['$unset', '"${1:field}"', 'Removes fields from the documents.'],
  [
    '$unwind',
    '{ "path": "$${1:field}", "preserveNullAndEmptyArrays": ${2|true,false|} }',
    'Deconstructs an array field into one document per element.'
  ]
]

const AGGREGATION_EXPRESSIONS: readonly Signature[] = [
  ['$abs', '${1:number}', 'Absolute value.'],
  ['$add', '[${1:expression}, ${2:expression}]', 'Adds numbers or a date and numbers.'],
  ['$ceil', '${1:number}', 'Smallest integer greater than or equal to the number.'],
  ['$divide', '[${1:dividend}, ${2:divisor}]', 'Divides two numbers.'],
  ['$exp', '${1:exponent}', 'Raises e to the given exponent.'],
  ['$floor', '${1:number}', 'Largest integer less than or equal to the number.'],
  ['$ln', '${1:number}', 'Natural logarithm.'],
  ['$log', '[${1:number}, ${2:base}]', 'Logarithm in the given base.'],
  ['$log10', '${1:number}', 'Logarithm in base 10.'],
  ['$mod', '[${1:dividend}, ${2:divisor}]', 'Remainder of a division.'],
  ['$multiply', '[${1:expression}, ${2:expression}]', 'Multiplies numbers.'],
  ['$pow', '[${1:number}, ${2:exponent}]', 'Raises a number to an exponent.'],
  ['$round', '[${1:number}, ${2:place}]', 'Rounds to a whole number or decimal place.'],
  ['$sqrt', '${1:number}', 'Square root.'],
  ['$subtract', '[${1:minuend}, ${2:subtrahend}]', 'Subtracts numbers or dates.'],
  ['$trunc', '[${1:number}, ${2:place}]', 'Truncates to a whole number or decimal place.'],
  ['$arrayElemAt', '[${1:array}, ${2:index}]', 'Element of an array at the given index.'],
  ['$arrayToObject', '${1:array}', 'Converts key value pairs into a document.'],
  ['$concatArrays', '[${1:array}, ${2:array}]', 'Concatenates arrays.'],
  [
    '$filter',
    '{ "input": "$${1:array}", "as": "${2:item}", "cond": { $0 } }',
    'Selects the array elements matching a condition.'
  ],
  ['$first', '"$${1:field}"', 'First element or first value of a group.'],
  ['$firstN', '{ "input": "$${1:array}", "n": ${2:3} }', 'First n elements of an array.'],
  ['$in', '[${1:value}, ${2:array}]', 'True when the value is contained in the array.'],
  ['$indexOfArray', '[${1:array}, ${2:value}]', 'Index of the first matching array element.'],
  ['$isArray', '${1:expression}', 'True when the expression is an array.'],
  ['$last', '"$${1:field}"', 'Last element or last value of a group.'],
  ['$lastN', '{ "input": "$${1:array}", "n": ${2:3} }', 'Last n elements of an array.'],
  [
    '$map',
    '{ "input": "$${1:array}", "as": "${2:item}", "in": { $0 } }',
    'Applies an expression to every array element.'
  ],
  ['$objectToArray', '${1:object}', 'Converts a document into key value pairs.'],
  ['$range', '[${1:start}, ${2:end}, ${3:step}]', 'Generates a sequence of numbers.'],
  [
    '$reduce',
    '{ "input": "$${1:array}", "initialValue": ${2:0}, "in": { $0 } }',
    'Folds an array into a single value.'
  ],
  ['$reverseArray', '${1:array}', 'Reverses an array.'],
  ['$size', '"$${1:array}"', 'Number of elements of an array.'],
  ['$slice', '[${1:array}, ${2:n}]', 'Subset of an array.'],
  [
    '$sortArray',
    '{ "input": "$${1:array}", "sortBy": { "${2:field}": 1 } }',
    'Sorts the elements of an array.'
  ],
  ['$zip', '{ "inputs": [${1:arrays}] }', 'Transposes arrays into an array of tuples.'],
  ['$and', '[${1:expression}, ${2:expression}]', 'Logical AND of expressions.'],
  ['$or', '[${1:expression}, ${2:expression}]', 'Logical OR of expressions.'],
  ['$not', '[${1:expression}]', 'Logical NOT of an expression.'],
  ['$cmp', '[${1:expression}, ${2:expression}]', 'Compares two values and returns -1, 0 or 1.'],
  ['$eq', '[${1:expression}, ${2:expression}]', 'True when both values are equal.'],
  ['$ne', '[${1:expression}, ${2:expression}]', 'True when both values differ.'],
  ['$gt', '[${1:expression}, ${2:expression}]', 'True when the first value is greater.'],
  ['$gte', '[${1:expression}, ${2:expression}]', 'True when the first value is greater or equal.'],
  ['$lt', '[${1:expression}, ${2:expression}]', 'True when the first value is smaller.'],
  ['$lte', '[${1:expression}, ${2:expression}]', 'True when the first value is smaller or equal.'],
  [
    '$cond',
    '{ "if": { $1 }, "then": ${2:value}, "else": ${3:value} }',
    'Ternary conditional expression.'
  ],
  ['$ifNull', '[${1:expression}, ${2:fallback}]', 'Returns a fallback when the value is null.'],
  [
    '$switch',
    '{ "branches": [\n\t{ "case": { $1 }, "then": ${2:value} }\n], "default": ${3:value} }',
    'Multi branch conditional expression.'
  ],
  ['$literal', '${1:value}', 'Returns the value without parsing it as an expression.'],
  [
    '$let',
    '{ "vars": { "${1:name}": ${2:value} }, "in": { $0 } }',
    'Binds variables for a sub expression.'
  ],
  [
    '$dateAdd',
    '{ "startDate": "$${1:field}", "unit": "${2|year,quarter,week,month,day,hour,minute,second|}", "amount": ${3:1} }',
    'Adds a time interval to a date.'
  ],
  [
    '$dateDiff',
    '{ "startDate": "$${1:field}", "endDate": "$${2:field}", "unit": "${3|year,quarter,week,month,day,hour,minute,second|}" }',
    'Difference between two dates in the given unit.'
  ],
  ['$dateFromString', '{ "dateString": "$${1:field}" }', 'Converts a string into a date.'],
  [
    '$dateSubtract',
    '{ "startDate": "$${1:field}", "unit": "${2|year,quarter,week,month,day,hour,minute,second|}", "amount": ${3:1} }',
    'Subtracts a time interval from a date.'
  ],
  ['$dateToParts', '{ "date": "$${1:field}" }', 'Splits a date into its components.'],
  [
    '$dateToString',
    '{ "date": "$${1:field}", "format": "${2:%Y-%m-%d}" }',
    'Formats a date as a string.'
  ],
  [
    '$dateTrunc',
    '{ "date": "$${1:field}", "unit": "${2|year,quarter,week,month,day,hour,minute,second|}" }',
    'Truncates a date to the given unit.'
  ],
  ['$dayOfMonth', '"$${1:field}"', 'Day of the month (1-31).'],
  ['$dayOfWeek', '"$${1:field}"', 'Day of the week (1 = Sunday).'],
  ['$dayOfYear', '"$${1:field}"', 'Day of the year (1-366).'],
  ['$hour', '"$${1:field}"', 'Hour of a date (0-23).'],
  ['$isoWeek', '"$${1:field}"', 'ISO week number.'],
  ['$isoWeekYear', '"$${1:field}"', 'ISO week year.'],
  ['$millisecond', '"$${1:field}"', 'Milliseconds of a date.'],
  ['$minute', '"$${1:field}"', 'Minute of a date (0-59).'],
  ['$month', '"$${1:field}"', 'Month of a date (1-12).'],
  ['$second', '"$${1:field}"', 'Seconds of a date (0-60).'],
  ['$week', '"$${1:field}"', 'Week of the year.'],
  ['$year', '"$${1:field}"', 'Year of a date.'],
  ['$concat', '[${1:expression}, ${2:expression}]', 'Concatenates strings.'],
  ['$ltrim', '{ "input": "$${1:field}" }', 'Removes leading whitespace.'],
  [
    '$regexFind',
    '{ "input": "$${1:field}", "regex": "${2:pattern}", "options": "${3:i}" }',
    'Returns the first regex match.'
  ],
  [
    '$regexFindAll',
    '{ "input": "$${1:field}", "regex": "${2:pattern}", "options": "${3:i}" }',
    'Returns all regex matches.'
  ],
  [
    '$regexMatch',
    '{ "input": "$${1:field}", "regex": "${2:pattern}", "options": "${3:i}" }',
    'True when the regex matches.'
  ],
  [
    '$replaceAll',
    '{ "input": "$${1:field}", "find": "${2:search}", "replacement": "${3:replacement}" }',
    'Replaces all occurrences of a substring.'
  ],
  [
    '$replaceOne',
    '{ "input": "$${1:field}", "find": "${2:search}", "replacement": "${3:replacement}" }',
    'Replaces the first occurrence of a substring.'
  ],
  ['$rtrim', '{ "input": "$${1:field}" }', 'Removes trailing whitespace.'],
  ['$split', '["$${1:field}", "${2:separator}"]', 'Splits a string into an array.'],
  ['$strLenCP', '"$${1:field}"', 'Number of code points of a string.'],
  ['$strcasecmp', '["$${1:field}", "${2:value}"]', 'Case insensitive string comparison.'],
  ['$substrCP', '["$${1:field}", ${2:start}, ${3:length}]', 'Substring by code points.'],
  ['$toLower', '"$${1:field}"', 'Converts a string to lower case.'],
  ['$toUpper', '"$${1:field}"', 'Converts a string to upper case.'],
  ['$trim', '{ "input": "$${1:field}" }', 'Removes leading and trailing whitespace.'],
  ['$addToSet', '"$${1:field}"', 'Collects the unique values of a group.'],
  ['$avg', '"$${1:field}"', 'Average of numeric values.'],
  [
    '$bottom',
    '{ "sortBy": { "${1:field}": 1 }, "output": "$${2:field}" }',
    'Bottom element of a group.'
  ],
  ['$count', '{ }', 'Counts the documents of a group.'],
  ['$max', '"$${1:field}"', 'Maximum value of a group.'],
  ['$mergeObjects', '["$${1:field}", "$${2:field}"]', 'Merges documents into a single document.'],
  ['$min', '"$${1:field}"', 'Minimum value of a group.'],
  ['$push', '"$${1:field}"', 'Collects all values of a group into an array.'],
  ['$stdDevPop', '"$${1:field}"', 'Population standard deviation.'],
  ['$stdDevSamp', '"$${1:field}"', 'Sample standard deviation.'],
  ['$sum', '${1:1}', 'Sum of numeric values.'],
  ['$top', '{ "sortBy": { "${1:field}": 1 }, "output": "$${2:field}" }', 'Top element of a group.'],
  [
    '$convert',
    '{ "input": "$${1:field}", "to": "${2|double,string,objectId,bool,date,int,long,decimal|}" }',
    'Converts a value into the given type.'
  ],
  ['$isNumber', '"$${1:field}"', 'True when the value is numeric.'],
  ['$toBool', '"$${1:field}"', 'Converts a value into a boolean.'],
  ['$toDate', '"$${1:field}"', 'Converts a value into a date.'],
  ['$toDecimal', '"$${1:field}"', 'Converts a value into a decimal.'],
  ['$toDouble', '"$${1:field}"', 'Converts a value into a double.'],
  ['$toInt', '"$${1:field}"', 'Converts a value into a 32 bit integer.'],
  ['$toLong', '"$${1:field}"', 'Converts a value into a 64 bit integer.'],
  ['$toObjectId', '"$${1:field}"', 'Converts a value into an ObjectId.'],
  ['$toString', '"$${1:field}"', 'Converts a value into a string.'],
  ['$type', '"$${1:field}"', 'BSON type of the value.']
]

function ejsonWrappers(): readonly Signature[] {
  const nowIso = new Date().toISOString()
  const nowSeconds = Math.floor(Date.now() / 1000)
  return [
    ['$oid', '"${1:507f1f77bcf86cd799439011}"', 'EJSON: ObjectId wrapper.'],
    ['$date', '"${1:' + nowIso + '}"', 'EJSON: date wrapper (ISO-8601 string).'],
    ['$numberLong', '"${1:0}"', 'EJSON: 64 bit integer.'],
    ['$numberInt', '"${1:0}"', 'EJSON: 32 bit integer.'],
    ['$numberDouble', '"${1:0.0}"', 'EJSON: 64 bit float.'],
    ['$numberDecimal', '"${1:0}"', 'EJSON: 128 bit decimal.'],
    ['$binary', '{ "base64": "${1:}", "subType": "${2:00}" }', 'EJSON: BSON binary.'],
    [
      '$timestamp',
      '{ "t": ${1:' + nowSeconds + '}, "i": ${2:0} }',
      'EJSON: BSON timestamp (replication).'
    ],
    ['$uuid', '"${1:00000000-0000-0000-0000-000000000000}"', 'EJSON: UUID (binary subType 4).'],
    [
      '$regularExpression',
      '{ "pattern": "${1:}", "options": "${2:i}" }',
      'EJSON: BSON regex (canonical form).'
    ],
    ['$symbol', '"${1:}"', 'EJSON: deprecated BSON symbol.'],
    ['$code', '"${1:function() {}}"', 'EJSON: BSON code.'],
    ['$minKey', '1', 'EJSON: BSON MinKey marker.'],
    ['$maxKey', '1', 'EJSON: BSON MaxKey marker.'],
    ['$undefined', 'true', 'EJSON: deprecated BSON undefined.']
  ]
}

function shellHelpers(): readonly Signature[] {
  const nowIso = new Date().toISOString()
  const nowSeconds = Math.floor(Date.now() / 1000)
  return [
    ['ObjectId', 'ObjectId("${1:507f1f77bcf86cd799439011}")', 'ObjectId hex literal.'],
    ['ISODate', 'ISODate("${1:' + nowIso + '}")', 'ISO-8601 date, defaults to now.'],
    ['Date', 'Date("${1:' + nowIso + '}")', 'Same as ISODate, defaults to now.'],
    ['NumberLong', 'NumberLong("${1:0}")', 'BSON 64 bit integer.'],
    ['NumberInt', 'NumberInt(${1:0})', 'BSON 32 bit integer.'],
    ['NumberDecimal', 'NumberDecimal("${1:0}")', 'BSON 128 bit decimal.'],
    ['UUID', 'UUID("${1:00000000-0000-0000-0000-000000000000}")', 'UUID literal (subType 04).'],
    [
      'JUUID',
      'JUUID("${1:00000000-0000-0000-0000-000000000000}")',
      'Legacy Java driver UUID (subType 03).'
    ],
    ['BinData', 'BinData(${1:0}, "${2:base64==}")', 'Binary data with subType.'],
    ['Timestamp', 'Timestamp(${1:' + nowSeconds + '}, ${2:0})', 'BSON timestamp (replication).'],
    ['MinKey', 'MinKey', 'Sorts before any other BSON value.'],
    ['MaxKey', 'MaxKey', 'Sorts after any other BSON value.'],
    ['DBRef', 'DBRef("${1:coll}", ${2:id})', 'Document reference.'],
    ['Code', 'Code("${1:function() {}}")', 'BSON code value.'],
    ['RegExp', 'RegExp("${1:pattern}", "${2:i}")', 'Regex, equivalent to a /pattern/flags literal.']
  ]
}

const LITERALS: readonly Signature[] = [
  ['true', 'true', 'Boolean true.'],
  ['false', 'false', 'Boolean false.'],
  ['null', 'null', 'Null value.'],
  ['undefined', 'undefined', 'BSON undefined (deprecated).']
]
