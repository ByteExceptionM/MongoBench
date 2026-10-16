import { checkPipeline } from './aggregationPipeline'
import { ParseError, Parser, tokenize, type PunctValue, type Token } from './mongoQueryLang'
import { serializeMongoValue, type SerializeOptions } from './mongoQuerySerialize'
import { finalWriteStage } from '@shared/pipeline'
import { MAX_INSERT_DOCUMENTS, WRITE_METHODS, type WriteMethod, type WriteOp } from '@shared/types'
import {
  WRITE_ARGUMENTS,
  bulkWriteError,
  filterError,
  insertDocumentError,
  isDocument,
  replacementError,
  updateError,
  writeOptionsError
} from '@shared/writeOps'

/**
 * Parses the subset of mongosh that Shell mode runs, reads and writes:
 *
 *   db.<coll>.find(filter?, projection?)[.sort(s)][.skip(n)][.limit(n)][.projection(p)][.toArray()][.pretty()]
 *   db.<coll>.findOne(filter?, projection?)
 *   db.<coll>.aggregate(pipeline)[.toArray()]          (a final $out / $merge makes it a write)
 *   db.<coll>.countDocuments(filter?)  /  count(filter?)  /  estimatedDocumentCount()
 *   db.<coll>.distinct(field, filter?)
 *   db.<coll>.insertOne(document, options?)  /  insertMany(documents, options?)
 *   db.<coll>.updateOne / updateMany / findOneAndUpdate(filter, update, options?)
 *   db.<coll>.replaceOne / findOneAndReplace(filter, replacement, options?)
 *   db.<coll>.deleteOne / deleteMany / findOneAndDelete(filter, options?)
 *   db.<coll>.bulkWrite(operations, options?)
 *
 * `<coll>` is any collection of the tab's database, written `db.name`, `db.a.b`,
 * `db["name"]` or `db.getCollection("name")`. Comments and a trailing `;` are allowed.
 * Write arguments are checked with the rules of `@shared/writeOps`, which main applies too.
 */

/** Collection methods Shell mode runs that read; `aggregate` writes only when it ends in $out / $merge. */
export const SHELL_READ_METHODS = [
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'count',
  'estimatedDocumentCount',
  'distinct'
] as const
/** Collection methods Shell mode runs, reads then writes; also the list error messages and completion offer. */
export const SHELL_COLLECTION_METHODS = [...SHELL_READ_METHODS, ...WRITE_METHODS] as const
/** Calls that may follow `find(…)`. */
export const SHELL_CURSOR_METHODS = [
  'sort',
  'skip',
  'limit',
  'projection',
  'toArray',
  'pretty'
] as const
/** Calls that may follow `aggregate(…)`. */
export const SHELL_AGGREGATE_CURSOR_METHODS = ['toArray', 'pretty'] as const

export type ShellCountMethod = 'countDocuments' | 'count' | 'estimatedDocumentCount'

/** A command the shell can run; filters, projections, sorts, pipelines and write arguments are EJSON strings. */
export type ShellOp =
  | {
      kind: 'find'
      filter: string
      /** null when absent or empty: whole documents. */
      projection: string | null
      sort: string | null
      skip: number
      /** null when absent or `.limit(0)`: no limit. */
      limit: number | null
    }
  | { kind: 'findOne'; filter: string; projection: string | null }
  | { kind: 'aggregate'; pipeline: string; documentPreserving: boolean }
  | {
      kind: 'count'
      method: ShellCountMethod
      /** null only for estimatedDocumentCount. */
      filter: string | null
    }
  | { kind: 'distinct'; field: string; filter: string | null }
  | {
      kind: 'write'
      write: WriteOp
      /** Collection the write changes: the command's own, or the $out / $merge output (db null = same database). */
      writes: { db: string | null; coll: string }
    }

export type ShellCommand = { coll: string; op: ShellOp }

export type ShellParseResult =
  { ok: true; command: ShellCommand } | { ok: false; error: string; offset: number }

type CollectionMethod = (typeof SHELL_COLLECTION_METHODS)[number]
type CursorMethod = (typeof SHELL_CURSOR_METHODS)[number]
type Arg = { value: unknown; offset: number }
type Call = { name: string; offset: number; args: Arg[] }
type Target = { name: string; accessor: 'dot' | 'bracket' | 'getCollection' }
type ShellAst = { target: Target; method: Call; chain: Call[] }

const EXPECTED_COMMAND = 'Expected `db.<collection>.<method>(…)`'
const NON_IDENTIFIER_NAME =
  'Collection names that aren\'t plain identifiers need db.getCollection("name") or db["name"]'
const EMPTY_NAME = 'Collection name must not be empty'

// Maps, not object literals: a method name like `toString` must not hit the prototype.
const LEGACY_METHODS: ReadonlyMap<string, string> = new Map([
  ['insert', 'insertOne or insertMany'],
  ['update', 'updateOne, updateMany or replaceOne'],
  ['remove', 'deleteOne or deleteMany'],
  ['save', 'insertOne, or replaceOne with upsert: true'],
  ['findAndModify', 'findOneAndUpdate, findOneAndReplace or findOneAndDelete']
])
const ADMIN_METHODS: ReadonlyMap<string, string> = new Map([
  ['drop', 'Drop…'],
  ['createIndex', 'Indexes…'],
  ['createIndexes', 'Indexes…'],
  ['dropIndex', 'Indexes…'],
  ['dropIndexes', 'Indexes…'],
  ['renameCollection', 'Rename…']
])

// Matches the source up to a tokenizer stop that is still inside `db.<a>.<b>`.
const DOTTED_HEAD_RE = /^\s*db(?:\s*\.\s*[A-Za-z_$][\w$]*)+$/
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

/** Parses and checks one command; an error's offset points at the offending token. */
export function parseShellCommand(input: string): ShellParseResult {
  try {
    return { ok: true, command: compileShellAst(parseShellAst(input)) }
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, offset: e.offset }
    return { ok: false, error: e instanceof Error ? e.message : String(e), offset: 0 }
  }
}

/**
 * Why a write must be confirmed before it runs: it changes a whole collection; null otherwise.
 * @param db The tab's database; see `writeTargetName`.
 */
export function writeConfirmation(command: ShellCommand, db: string): string | null {
  const { op } = command
  if (op.kind !== 'write') return null
  const { write, writes } = op
  const target = writeTargetName(writes, db)
  switch (write.method) {
    case 'updateMany':
    case 'deleteMany':
      return isEmptyDocument(JSON.parse(write.filter))
        ? `${everyDocument(write.method, target)}.`
        : null
    case 'bulkWrite': {
      const operations = JSON.parse(write.operations) as Record<string, { filter?: unknown }>[]
      for (const [index, operation] of operations.entries()) {
        for (const [name, body] of Object.entries(operation)) {
          if ((name === 'updateMany' || name === 'deleteMany') && isEmptyDocument(body.filter)) {
            return `bulkWrite operation ${index + 1}: ${everyDocument(name, target)}.`
          }
        }
      }
      return null
    }
    case 'aggregate':
      return finalWriteStage(JSON.parse(write.pipeline) as unknown[]) === '$out'
        ? `$out replaces the collection ${target} with the pipeline output.`
        : null
    default:
      return null
  }
}

/** The collection a write changes, prefixed with its database only when that isn't `db`, the tab's. */
export function writeTargetName(writes: { db: string | null; coll: string }, db: string): string {
  return writes.db === null || writes.db === db ? writes.coll : `${writes.db}.${writes.coll}`
}

/** Re-prints a syntactically valid command; null on syntax errors. Comments are dropped. */
export function formatShellCommand(input: string, options: SerializeOptions): string | null {
  let ast: ShellAst
  try {
    ast = parseShellAst(input)
  } catch (e) {
    if (e instanceof ParseError) return null
    throw e
  }
  const pad = ' '.repeat(options.indent ?? 2)
  // Chained calls are printed at column 0 and shifted by `pad`, so they get that much less width.
  const chainOptions =
    options.printWidth === undefined
      ? options
      : { ...options, printWidth: options.printWidth - pad.length }
  const lines = [printCall(`${printTarget(ast.target)}.`, ast.method, options)]
  for (const call of ast.chain) {
    lines.push(pad + printCall('.', call, chainOptions).replace(/\n/g, `\n${pad}`))
  }
  return lines.join('\n')
}

/** `db.name` when `coll` is a dotted identifier path, else `db.getCollection("…")`. */
export function shellCollectionAccessor(coll: string): string {
  return DOTTED_IDENTIFIER_RE.test(coll)
    ? `db.${coll}`
    : `db.getCollection(${JSON.stringify(coll)})`
}

function parseShellAst(input: string): ShellAst {
  const parser = new Parser(tokenizeCommand(input), input)
  const end = input.length
  const head = parser.advance()
  if (head?.type !== 'ident' || head.value !== 'db') {
    throw new ParseError(EXPECTED_COMMAND, head?.offset ?? end)
  }
  const { target, method } = parseTarget(parser, end)
  const ast: ShellAst = { target, method: { ...method, args: parser.parseArgs() }, chain: [] }
  while (isPunct(parser.peek(), '.')) {
    const call = methodAfterDot(parser, end)
    ast.chain.push({ ...call, args: parser.parseArgs() })
  }
  let terminated = false
  while (isPunct(parser.peek(), ';')) {
    parser.advance()
    terminated = true
  }
  const rest = parser.peek()
  if (rest && terminated) throw new ParseError('Only one command per run', rest.offset)
  parser.expectEnd()
  return ast
}

function tokenizeCommand(input: string): Token[] {
  try {
    return tokenize(input, { shell: true })
  } catch (e) {
    // e.g. the "-" in db.player-data
    if (e instanceof ParseError && DOTTED_HEAD_RE.test(input.slice(0, e.offset))) {
      throw new ParseError(NON_IDENTIFIER_NAME, e.offset)
    }
    throw e
  }
}

function parseTarget(
  parser: Parser,
  end: number
): { target: Target; method: { name: string; offset: number } } {
  const next = parser.peek()
  if (isPunct(next, '[')) {
    parser.advance()
    const name = parser.advance()
    if (name?.type !== 'string') {
      throw new ParseError(
        'Expected the collection name as a string, e.g. db["name"]',
        name?.offset ?? end
      )
    }
    if (name.value === '') throw new ParseError(EMPTY_NAME, name.offset)
    parser.expectPunct(']')
    return {
      target: { name: name.value, accessor: 'bracket' },
      method: methodAfterDot(parser, end)
    }
  }
  if (!isPunct(next, '.')) {
    // `db.2024_logs` tokenizes as `db` followed by the number `.2024`.
    const dottedNumber = next?.type === 'number' && next.value.startsWith('.')
    throw new ParseError(dottedNumber ? NON_IDENTIFIER_NAME : EXPECTED_COMMAND, next?.offset ?? end)
  }
  const names: string[] = []
  for (;;) {
    parser.advance()
    const segment = parser.advance()
    if (segment?.type !== 'ident') {
      throw new ParseError(
        segment?.type === 'number' ? NON_IDENTIFIER_NAME : EXPECTED_COMMAND,
        segment?.offset ?? end
      )
    }
    const after = parser.peek()
    if (isPunct(after, '(')) {
      if (names.length > 0) {
        return {
          target: { name: names.join('.'), accessor: 'dot' },
          method: { name: segment.value, offset: segment.offset }
        }
      }
      if (segment.value === 'getCollection') {
        const name = getCollectionName(parser, segment.offset)
        return { target: { name, accessor: 'getCollection' }, method: methodAfterDot(parser, end) }
      }
      throw new ParseError(
        `\`db.${segment.value}()\` isn't supported; use db.<collection>.<method>(…)`,
        segment.offset
      )
    }
    names.push(segment.value)
    if (isPunct(after, '.')) continue
    if (after === undefined) throw new ParseError(EXPECTED_COMMAND, end)
    throw new ParseError(
      after.type === 'punct' ? EXPECTED_COMMAND : NON_IDENTIFIER_NAME,
      after.offset
    )
  }
}

function getCollectionName(parser: Parser, offset: number): string {
  const args = parser.parseArgs()
  const arg = args[0]
  if (args.length !== 1 || typeof arg?.value !== 'string') {
    throw new ParseError(
      'db.getCollection() expects the collection name as a string',
      arg?.offset ?? offset
    )
  }
  if (arg.value === '') throw new ParseError(EMPTY_NAME, arg.offset)
  return arg.value
}

function methodAfterDot(parser: Parser, end: number): { name: string; offset: number } {
  parser.expectPunct('.')
  const name = parser.advance()
  if (name?.type !== 'ident') {
    throw new ParseError('Expected a method name after "."', name?.offset ?? end)
  }
  return { name: name.value, offset: name.offset }
}

function compileShellAst(ast: ShellAst): ShellCommand {
  const { method } = ast
  if (!isCollectionMethod(method.name)) {
    throw new ParseError(unsupportedMethodMessage(method.name), method.offset)
  }
  return { coll: ast.target.name, op: compileOp(method.name, ast) }
}

function unsupportedMethodMessage(name: string): string {
  const replacement = LEGACY_METHODS.get(name)
  if (replacement !== undefined) return `\`${name}()\` is a legacy method; use ${replacement}`
  const menuItem = ADMIN_METHODS.get(name)
  if (menuItem !== undefined) {
    return `\`${name}()\` isn't supported here; use ${menuItem} in the explorer's collection menu`
  }
  return `Unsupported method \`${name}\`. Supported: ${SHELL_COLLECTION_METHODS.join(', ')}.`
}

function compileOp(name: CollectionMethod, ast: ShellAst): ShellOp {
  const { method } = ast
  switch (name) {
    case 'find':
      return compileFind(ast)
    case 'findOne': {
      rejectChain(ast)
      const [filter, projection] = argsUpTo(method, 2, 'findOne(filter, projection)')
      return {
        kind: 'findOne',
        filter: filterOf(filter, 'findOne()'),
        projection: projectionOf(projection, 'findOne() projection')
      }
    }
    case 'aggregate': {
      for (const call of ast.chain) {
        if (!isAggregateCursorMethod(call.name)) {
          throw new ParseError(`\`.${call.name}()\` can't follow aggregate(…)`, call.offset)
        }
        rejectArgs(call)
      }
      const [pipeline] = argsUpTo(method, 1, 'aggregate(pipeline)')
      if (pipeline === undefined) {
        throw new ParseError(
          'aggregate() expects the pipeline array, e.g. aggregate([{ $match: { … } }])',
          method.offset
        )
      }
      const checked = checkPipeline(pipeline.value, { allowFinalWrite: true })
      if (!checked.ok) throw new ParseError(checked.error, pipeline.offset)
      const stages = pipeline.value as unknown[]
      if (finalWriteStage(stages) === null) {
        return {
          kind: 'aggregate',
          pipeline: checked.ejson,
          documentPreserving: checked.documentPreserving
        }
      }
      return {
        kind: 'write',
        write: { method: 'aggregate', pipeline: checked.ejson },
        writes: outputCollection(stages, pipeline.offset)
      }
    }
    case 'countDocuments':
    case 'count': {
      rejectChain(ast)
      const [filter] = argsUpTo(method, 1, `${name}(filter)`)
      return { kind: 'count', method: name, filter: filterOf(filter, `${name}()`) }
    }
    case 'estimatedDocumentCount':
      rejectChain(ast)
      argsUpTo(method, 0, 'estimatedDocumentCount()')
      return { kind: 'count', method: name, filter: null }
    case 'distinct': {
      rejectChain(ast)
      const [field, filter] = argsUpTo(method, 2, 'distinct(field, filter)')
      if (typeof field?.value !== 'string' || field.value === '') {
        throw new ParseError(
          'distinct() expects a field name string',
          field?.offset ?? method.offset
        )
      }
      return {
        kind: 'distinct',
        field: field.value,
        filter: filter === undefined ? null : objectOf(filter, 'distinct() filter')
      }
    }
    default:
      rejectChain(ast)
      return {
        kind: 'write',
        write: compileWrite(name, method),
        writes: { db: null, coll: ast.target.name }
      }
  }
}

function compileWrite(name: WriteMethod, call: Call): WriteOp {
  const params = WRITE_ARGUMENTS[name]
  const usage = `Use ${name}(${[...params, 'options'].join(', ')})`
  const extra = call.args[params.length + 1]
  if (extra !== undefined) throw new ParseError(`Too many arguments. ${usage}`, extra.offset)
  const missing = params[call.args.length]
  if (missing !== undefined) throw new ParseError(`Missing ${missing}. ${usage}`, call.offset)
  const first = call.args[0]!
  const optionsArg = call.args[params.length]
  // Called last in each literal below, so arguments are checked in source order.
  const options = (): { options?: string } =>
    optionsArg === undefined
      ? {}
      : { options: ejsonOf(optionsArg, (value) => writeOptionsError(name, value)) }
  switch (name) {
    case 'insertOne':
      return { method: name, document: ejsonOf(first, insertDocumentError), ...options() }
    case 'insertMany':
      return { method: name, documents: insertManyDocuments(first), ...options() }
    case 'updateOne':
    case 'updateMany':
    case 'findOneAndUpdate':
      return {
        method: name,
        filter: ejsonOf(first, (value) => filterError(name, value)),
        update: ejsonOf(call.args[1]!, updateError),
        ...options()
      }
    case 'replaceOne':
    case 'findOneAndReplace':
      return {
        method: name,
        filter: ejsonOf(first, (value) => filterError(name, value)),
        replacement: ejsonOf(call.args[1]!, replacementError),
        ...options()
      }
    case 'deleteOne':
    case 'deleteMany':
    case 'findOneAndDelete':
      return {
        method: name,
        filter: ejsonOf(first, (value) => filterError(name, value)),
        ...options()
      }
    case 'bulkWrite':
      return { method: name, operations: ejsonOf(first, bulkWriteError), ...options() }
  }
}

function insertManyDocuments(arg: Arg): string[] {
  if (!Array.isArray(arg.value) || arg.value.length === 0) {
    throw new ParseError('insertMany() expects a non-empty array of documents', arg.offset)
  }
  if (arg.value.length > MAX_INSERT_DOCUMENTS) {
    throw new ParseError(
      `insertMany() takes at most ${MAX_INSERT_DOCUMENTS.toLocaleString('en-US')} documents per run`,
      arg.offset
    )
  }
  return arg.value.map((value: unknown) =>
    ejsonOf({ value, offset: arg.offset }, insertDocumentError)
  )
}

function ejsonOf(arg: Arg, error: (value: unknown) => string | null): string {
  const message = error(arg.value)
  if (message !== null) throw new ParseError(message, arg.offset)
  return JSON.stringify(arg.value)
}

function outputCollection(stages: unknown[], offset: number): { db: string | null; coll: string } {
  const [operator, spec] = Object.entries(stages[stages.length - 1] as object)[0]!
  const target = operator === '$merge' && isDocument(spec) ? spec['into'] : spec
  if (isName(target)) return { db: null, coll: target }
  if (isDocument(target) && isName(target['coll'])) {
    const db = target['db']
    if (db === undefined || isName(db)) return { db: db ?? null, coll: target['coll'] }
  }
  const example = operator === '$merge' ? '{ $merge: { into: "name" } }' : '{ $out: "name" }'
  throw new ParseError(
    `Stage ${stages.length}: ${operator} must name the output collection, e.g. ${example}`,
    offset
  )
}

function compileFind(ast: ShellAst): ShellOp {
  const [filterArg, projectionArg] = argsUpTo(ast.method, 2, 'find(filter, projection)')
  let projection = projectionOf(projectionArg, 'find() projection')
  let sort: string | null = null
  let skip = 0
  let limit: number | null = null
  const seen = new Set<string>()
  for (const call of ast.chain) {
    if (!isCursorMethod(call.name)) {
      throw new ParseError(
        call.name === 'count'
          ? `Cursor .count() isn't supported; use ${shellCollectionAccessor(ast.target.name)}.countDocuments(filter)`
          : `Unsupported cursor method .${call.name}(). Supported: ${SHELL_CURSOR_METHODS.join(', ')}`,
        call.offset
      )
    }
    if (seen.has(call.name)) throw new ParseError(`.${call.name}() specified twice`, call.offset)
    seen.add(call.name)
    switch (call.name) {
      case 'sort':
        sort = objectOf(onlyArg(call), '.sort() argument')
        break
      case 'projection':
        if (projectionArg !== undefined) {
          throw new ParseError(
            'Projection given twice: pass it to find(…) or .projection(…), not both',
            call.offset
          )
        }
        projection = projectionOf(onlyArg(call), '.projection() argument')
        break
      case 'skip':
        skip = countArg(call)
        break
      case 'limit': {
        // As in mongosh, limit(0) means no limit.
        const n = countArg(call)
        limit = n === 0 ? null : n
        break
      }
      case 'toArray':
      case 'pretty':
        rejectArgs(call)
        break
    }
  }
  return { kind: 'find', filter: filterOf(filterArg, 'find()'), projection, sort, skip, limit }
}

function argsUpTo(call: Call, max: number, signature: string): Arg[] {
  const extra = call.args[max]
  if (extra !== undefined) {
    throw new ParseError(
      `Too many arguments; options aren't supported. Use ${signature}`,
      extra.offset
    )
  }
  return call.args
}

function onlyArg(call: Call): Arg {
  const [arg, extra] = call.args
  if (arg === undefined || extra !== undefined) {
    throw new ParseError(`.${call.name}() expects one argument`, (extra ?? call).offset)
  }
  return arg
}

function rejectArgs(call: Call): void {
  const [arg] = call.args
  if (arg !== undefined) throw new ParseError(`.${call.name}() takes no arguments`, arg.offset)
}

function rejectChain(ast: ShellAst): void {
  const [call] = ast.chain
  if (call !== undefined) {
    throw new ParseError(`\`.${call.name}()\` can't follow ${ast.method.name}(…)`, call.offset)
  }
}

function countArg(call: Call): number {
  const arg = onlyArg(call)
  if (typeof arg.value !== 'number' || !Number.isSafeInteger(arg.value) || arg.value < 0) {
    throw new ParseError(`.${call.name}() expects a non-negative integer`, arg.offset)
  }
  return arg.value
}

function objectOf(arg: Arg, what: string): string {
  if (!isDocument(arg.value)) throw new ParseError(`${what} must be an object`, arg.offset)
  return JSON.stringify(arg.value)
}

function filterOf(arg: Arg | undefined, method: string): string {
  return arg === undefined ? '{}' : objectOf(arg, `${method} filter`)
}

function projectionOf(arg: Arg | undefined, what: string): string | null {
  if (arg === undefined) return null
  const ejson = objectOf(arg, what)
  return ejson === '{}' ? null : ejson
}

function printTarget(target: Target): string {
  switch (target.accessor) {
    case 'dot':
      return `db.${target.name}`
    case 'bracket':
      return `db[${JSON.stringify(target.name)}]`
    case 'getCollection':
      return `db.getCollection(${JSON.stringify(target.name)})`
  }
}

function printCall(head: string, call: Call, options: SerializeOptions): string {
  let text = `${head}${call.name}(`
  for (const [index, arg] of call.args.entries()) {
    if (index > 0) text += ', '
    const startColumn = text.length - text.lastIndexOf('\n') - 1
    text += serializeMongoValue(arg.value, { ...options, startColumn })
  }
  return `${text})`
}

const everyDocument = (method: 'updateMany' | 'deleteMany', coll: string): string =>
  `${method} with an empty filter ${method === 'updateMany' ? 'updates' : 'deletes'} every document in ${coll}`

const isEmptyDocument = (value: unknown): boolean =>
  isDocument(value) && Object.keys(value).length === 0

const isName = (value: unknown): value is string => typeof value === 'string' && value !== ''

const isPunct = (token: Token | undefined, value: PunctValue): boolean =>
  token?.type === 'punct' && token.value === value

const isCollectionMethod = (name: string): name is CollectionMethod =>
  (SHELL_COLLECTION_METHODS as readonly string[]).includes(name)

const isCursorMethod = (name: string): name is CursorMethod =>
  (SHELL_CURSOR_METHODS as readonly string[]).includes(name)

const isAggregateCursorMethod = (name: string): boolean =>
  (SHELL_AGGREGATE_CURSOR_METHODS as readonly string[]).includes(name)
