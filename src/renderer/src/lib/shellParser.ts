import { parseMongoQuery } from './mongoQueryLang'

/**
 * Parses a small subset of mongosh syntax into a structured request the
 * renderer can dispatch through the existing `query.find` /
 * `query.aggregate` IPC channels.
 *
 * Supported shapes (whitespace and newlines anywhere are fine):
 *
 *   db.coll.find(<filter>?, <projection>?)[.sort(<sort>)][.skip(<n>)][.limit(<n>)]
 *   db.coll.findOne(<filter>?)
 *   db.coll.countDocuments(<filter>?)
 *   db.coll.count(<filter>?)
 *   db.coll.aggregate(<pipeline>)
 *
 * The collection name in the source is informational only — callers know
 * which tab they're in and pass that explicitly to the API. Mismatch
 * surfaces as a "wrong collection" parse error so the user notices.
 */

export type ShellOp =
  | {
      kind: 'find'
      filter: string
      projection: string | null
      sort: string | null
      skip: number | null
      limit: number | null
    }
  | { kind: 'findOne'; filter: string }
  | { kind: 'countDocuments'; filter: string }
  | { kind: 'aggregate'; pipeline: string }

export type ShellParseResult =
  | { ok: true; coll: string; op: ShellOp }
  | { ok: false; error: string }

const HEAD_RE = /^\s*db\s*\.\s*([A-Za-z_$][\w.$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/

export function parseShellCommand(input: string): ShellParseResult {
  const head = HEAD_RE.exec(input)
  if (!head) {
    return {
      ok: false,
      error: 'Expected `db.<collection>.<method>(…)`'
    }
  }
  const coll = head[1]!
  const method = head[2]!

  const argsStart = head.index + head[0].length
  const argsEnd = matchClosingParen(input, argsStart - 1)
  if (argsEnd < 0) {
    return { ok: false, error: 'Missing closing `)` for method call' }
  }
  const argsSrc = input.slice(argsStart, argsEnd).trim()

  switch (method) {
    case 'find': {
      const split = splitTopLevelArgs(argsSrc)
      if (!split.ok) return { ok: false, error: split.error }
      if (split.parts.length > 2) {
        return { ok: false, error: '`find` accepts at most 2 arguments' }
      }
      const filter = compileObject(split.parts[0] ?? '{}', 'filter')
      if (!filter.ok) return { ok: false, error: filter.error }
      const projection =
        split.parts[1] === undefined ? null : compileObject(split.parts[1], 'projection')
      if (projection !== null && !projection.ok) {
        return { ok: false, error: projection.error }
      }

      const trailer = parseTrailer(input.slice(argsEnd + 1))
      if (!trailer.ok) return { ok: false, error: trailer.error }

      return {
        ok: true,
        coll,
        op: {
          kind: 'find',
          filter: filter.ejson,
          projection: projection ? projection.ejson : null,
          sort: trailer.sort,
          skip: trailer.skip,
          limit: trailer.limit
        }
      }
    }
    case 'findOne': {
      const split = splitTopLevelArgs(argsSrc)
      if (!split.ok) return { ok: false, error: split.error }
      if (split.parts.length > 1) {
        return { ok: false, error: '`findOne` accepts at most 1 argument' }
      }
      const filter = compileObject(split.parts[0] ?? '{}', 'filter')
      if (!filter.ok) return { ok: false, error: filter.error }
      const trailer = expectNoTrailer(input.slice(argsEnd + 1))
      if (!trailer.ok) return { ok: false, error: trailer.error }
      return { ok: true, coll, op: { kind: 'findOne', filter: filter.ejson } }
    }
    case 'count':
    case 'countDocuments': {
      const split = splitTopLevelArgs(argsSrc)
      if (!split.ok) return { ok: false, error: split.error }
      if (split.parts.length > 1) {
        return { ok: false, error: `\`${method}\` accepts at most 1 argument` }
      }
      const filter = compileObject(split.parts[0] ?? '{}', 'filter')
      if (!filter.ok) return { ok: false, error: filter.error }
      const trailer = expectNoTrailer(input.slice(argsEnd + 1))
      if (!trailer.ok) return { ok: false, error: trailer.error }
      return { ok: true, coll, op: { kind: 'countDocuments', filter: filter.ejson } }
    }
    case 'aggregate': {
      const split = splitTopLevelArgs(argsSrc)
      if (!split.ok) return { ok: false, error: split.error }
      if (split.parts.length !== 1) {
        return { ok: false, error: '`aggregate` expects exactly 1 argument: the pipeline array' }
      }
      const parsed = parseMongoQuery(split.parts[0]!)
      if (!parsed.ok) return { ok: false, error: `pipeline: ${parsed.error}` }
      if (!Array.isArray(parsed.value)) {
        return { ok: false, error: 'pipeline must be an array' }
      }
      const trailer = expectNoTrailer(input.slice(argsEnd + 1))
      if (!trailer.ok) return { ok: false, error: trailer.error }
      return { ok: true, coll, op: { kind: 'aggregate', pipeline: parsed.ejson } }
    }
    default:
      return {
        ok: false,
        error: `Unsupported method: ${method}. Try find, findOne, aggregate, count, countDocuments.`
      }
  }
}

type CompiledObject = { ok: true; ejson: string } | { ok: false; error: string }

function compileObject(src: string, label: string): CompiledObject {
  if (src.trim().length === 0) return { ok: true, ejson: '{}' }
  const parsed = parseMongoQuery(src)
  if (!parsed.ok) return { ok: false, error: `${label}: ${parsed.error}` }
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: false, error: `${label}: must be an object` }
  }
  return { ok: true, ejson: parsed.ejson }
}

type TrailerResult =
  | { ok: true; sort: string | null; skip: number | null; limit: number | null }
  | { ok: false; error: string }

function parseTrailer(rest: string): TrailerResult {
  let s = rest.trim()
  let sort: string | null = null
  let skip: number | null = null
  let limit: number | null = null

  while (s.length > 0) {
    if (!s.startsWith('.')) {
      return { ok: false, error: `Unexpected trailing content: ${truncate(s)}` }
    }
    const callMatch = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(s)
    if (!callMatch) return { ok: false, error: `Expected chained method call after '.'` }
    const name = callMatch[1]!
    const argsStart = callMatch[0].length
    const argsEnd = matchClosingParen(s, argsStart - 1)
    if (argsEnd < 0) return { ok: false, error: `Missing closing ')' on .${name}(...)` }
    const argSrc = s.slice(argsStart, argsEnd).trim()

    switch (name) {
      case 'sort': {
        if (sort !== null) return { ok: false, error: '.sort() specified twice' }
        const compiled = compileObject(argSrc, 'sort')
        if (!compiled.ok) return { ok: false, error: compiled.error }
        sort = compiled.ejson
        break
      }
      case 'skip': {
        if (skip !== null) return { ok: false, error: '.skip() specified twice' }
        const n = parseNonNegativeInt(argSrc, 'skip')
        if (n === null) return { ok: false, error: '.skip() expects a non-negative integer' }
        skip = n
        break
      }
      case 'limit': {
        if (limit !== null) return { ok: false, error: '.limit() specified twice' }
        const n = parseNonNegativeInt(argSrc, 'limit')
        if (n === null) return { ok: false, error: '.limit() expects a non-negative integer' }
        limit = n
        break
      }
      case 'toArray':
      case 'pretty':
        // No-ops in this client — silently accept.
        if (argSrc.length > 0) return { ok: false, error: `.${name}() takes no arguments` }
        break
      default:
        return {
          ok: false,
          error: `Unsupported chained method: .${name}(). Try sort, skip, limit.`
        }
    }
    s = s.slice(argsEnd + 1).trim()
  }

  return { ok: true, sort, skip, limit }
}

function expectNoTrailer(rest: string): TrailerResult {
  const r = parseTrailer(rest)
  if (!r.ok) return r
  // Ignore the read fields; just propagate ok-ness.
  return { ok: true, sort: null, skip: null, limit: null }
}

function parseNonNegativeInt(src: string, _label: string): number | null {
  if (!/^\d+$/.test(src.trim())) return null
  const n = Number.parseInt(src.trim(), 10)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * Returns the index of the `)` matching the `(` at `openIdx`, ignoring
 * parens inside string literals. -1 if unbalanced.
 */
function matchClosingParen(src: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '"' || ch === "'") {
      i = skipString(src, i)
      if (i < 0) return -1
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/**
 * Walk past a `"..."` or `'...'` string literal starting at `i` (which
 * must point at the opening quote). Returns the index past the closing
 * quote, or -1 if unterminated.
 */
function skipString(src: string, i: number): number {
  const quote = src[i]
  i++
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i++
  }
  return -1
}

type SplitResult = { ok: true; parts: string[] } | { ok: false; error: string }

/**
 * Split arguments by top-level commas, respecting nested (), [], {}, and
 * string literals. Handles `find({a: 1}, {a: 0})` correctly.
 */
function splitTopLevelArgs(src: string): SplitResult {
  if (src.length === 0) return { ok: true, parts: [] }
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '"' || ch === "'") {
      const next = skipString(src, i)
      if (next < 0) return { ok: false, error: 'Unterminated string literal' }
      i = next - 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth < 0) return { ok: false, error: 'Unmatched bracket in arguments' }
    } else if (ch === ',' && depth === 0) {
      parts.push(src.slice(start, i).trim())
      start = i + 1
    }
  }
  if (depth !== 0) return { ok: false, error: 'Unmatched bracket in arguments' }
  parts.push(src.slice(start).trim())
  return { ok: true, parts }
}

function truncate(s: string): string {
  return s.length > 40 ? s.slice(0, 37) + '…' : s
}
