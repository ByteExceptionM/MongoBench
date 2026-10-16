/**
 * Parses MongoDB-shell-flavored object literals into a value tree that
 * round-trips cleanly through `JSON.stringify` + `EJSON.parse(..., {relaxed:true})`
 * on the main side.
 *
 * Accepts everything plain JSON does, plus:
 *   - unquoted object keys                 `{ name: "ada" }`
 *   - single-quoted strings                `'foo'`
 *   - trailing commas                      `{ a: 1, }`
 *   - line / block comments                `// ...`  and  / *...* /
 *   - regex literals                       `/^foo/i`
 *   - integral doubles                     `5.0`, `1e3` stay doubles (`{"$numberDouble":"5.0"}`)
 *   - shell helpers:
 *       ObjectId("…")  /  ObjectId()       (mints a fresh id)
 *       ISODate("…")  /  new Date("…")  /  Date("…")
 *       NumberLong("…")  /  Long("…")
 *       NumberDecimal("…")  /  Decimal128("…")
 *       NumberInt(…)  /  Int32(…)
 *       NumberDouble(…)  /  Double(…)      (number, or "NaN" / "Infinity" / "-Infinity" / numeric string)
 *       UUID("…")
 *       BinData(subType, "base64")
 *       Timestamp(t, i)
 *       MinKey() / MinKey
 *       MaxKey() / MaxKey
 *       DBRef("coll", id [, "db"])
 *       Code("fn"[, scope])
 *       Symbol("…")
 *   - bare keywords:                       true, false, null, undefined
 *
 * Each helper is rewritten into its EJSON wrapper (`{"$oid":...}`,
 * `{"$date":...}`, …) — which the existing backend already understands.
 */
import { ObjectId } from 'bson'

export type ParseSuccess = { ok: true; ejson: string; value: unknown }
export type ParseFailure = { ok: false; error: string; offset: number }
export type ParseResult = ParseSuccess | ParseFailure

export function parseMongoQuery(input: string): ParseResult {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: true, ejson: '', value: null }
  }
  try {
    const tokens = tokenize(input)
    const parser = new Parser(tokens, input)
    const value = parser.parseValue()
    parser.expectEnd()
    return { ok: true, ejson: JSON.stringify(value), value }
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, error: e.message, offset: e.offset }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), offset: 0 }
  }
}

export type DocumentsParseSuccess = { ok: true; documents: string[] }
export type DocumentsParseResult = DocumentsParseSuccess | ParseFailure

export function parseMongoDocuments(input: string): DocumentsParseResult {
  if (input.trim().length === 0) {
    return { ok: true, documents: [] }
  }
  try {
    const tokens = tokenize(input)
    const parser = new Parser(tokens, input)
    const documents: string[] = []
    const skipCommas = (): void => {
      let sep = parser.peek()
      while (sep && sep.type === 'punct' && sep.value === ',') {
        parser.advance()
        sep = parser.peek()
      }
    }
    const pushDocument = (value: unknown, offset: number): void => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ParseError('Each document must be an object', offset)
      }
      documents.push(JSON.stringify(value))
    }
    skipCommas()
    while (parser.peek()) {
      const offset = parser.peek()!.offset
      const value = parser.parseValue()
      if (Array.isArray(value)) {
        for (const item of value) pushDocument(item, offset)
      } else {
        pushDocument(value, offset)
      }
      skipCommas()
    }
    return { ok: true, documents }
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, error: e.message, offset: e.offset }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), offset: 0 }
  }
}

/** A syntax error at `offset` (UTF-16 index into the parsed source). */
export class ParseError extends Error {
  constructor(
    message: string,
    public readonly offset: number
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

/** `.` and `;` only occur in shell mode. */
export type PunctValue = '{' | '}' | '[' | ']' | ':' | ',' | '(' | ')' | '.' | ';'

/** A lexical token; `offset` is the index of its first character. */
export type Token =
  | { type: 'punct'; value: PunctValue; offset: number }
  | { type: 'string'; value: string; offset: number }
  | { type: 'number'; value: string; offset: number }
  | { type: 'regex'; pattern: string; flags: string; offset: number }
  | { type: 'ident'; value: string; offset: number }

const REGEX_OK_AFTER = new Set<PunctValue>([':', ',', '[', '('])

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/

/**
 * Splits source into tokens, skipping whitespace and comments.
 * @param options.shell also emits `.` and `;` so command chains like `db.c.find()` tokenize.
 * @throws ParseError on characters or literals the language doesn't know.
 */
export function tokenize(src: string, options: { shell?: boolean } = {}): Token[] {
  const punctuation = options.shell ? '{}[]:,().;' : '{}[]:,()'
  const out: Token[] = []
  let i = 0
  let lastSignificant: Token | null = null

  const canStartRegex = (): boolean => {
    if (!lastSignificant) return true
    if (lastSignificant.type === 'punct' && REGEX_OK_AFTER.has(lastSignificant.value)) return true
    return false
  }

  while (i < src.length) {
    const c = src[i]!

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }

    // line comment
    if (c === '/' && src[i + 1] === '/') {
      i += 2
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      if (i >= src.length) throw new ParseError('Unterminated block comment', i)
      i += 2
      continue
    }

    // string literal — JSON-style escapes, both quote styles
    if (c === '"' || c === "'") {
      const start = i
      const quote = c
      i++
      let value = ''
      while (i < src.length && src[i] !== quote) {
        const ch = src[i]!
        if (ch === '\\') {
          const n = src[i + 1]
          if (n === undefined) throw new ParseError('Unterminated string', start)
          if (n === 'n') value += '\n'
          else if (n === 't') value += '\t'
          else if (n === 'r') value += '\r'
          else if (n === 'b') value += '\b'
          else if (n === 'f') value += '\f'
          else if (n === '0') value += '\0'
          else if (n === '\\' || n === '/' || n === '"' || n === "'") value += n
          else if (n === 'u') {
            const hex = src.slice(i + 2, i + 6)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new ParseError('Invalid \\u escape', i)
            }
            value += String.fromCharCode(parseInt(hex, 16))
            i += 4
          } else value += n
          i += 2
          continue
        }
        if (ch === '\n') throw new ParseError('Unterminated string', start)
        value += ch
        i++
      }
      if (src[i] !== quote) throw new ParseError('Unterminated string', start)
      i++
      const t: Token = { type: 'string', value, offset: start }
      out.push(t)
      lastSignificant = t
      continue
    }

    // regex literal — only after value-starting positions
    if (c === '/' && canStartRegex()) {
      const start = i
      i++
      let pattern = ''
      let inClass = false
      while (i < src.length) {
        const ch = src[i]!
        if (ch === '\\' && i + 1 < src.length) {
          pattern += ch + src[i + 1]
          i += 2
          continue
        }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        else if (ch === '\n') throw new ParseError('Unterminated regex', start)
        pattern += ch
        i++
      }
      if (src[i] !== '/') throw new ParseError('Unterminated regex', start)
      i++
      let flags = ''
      while (i < src.length && /[gimsuy]/.test(src[i]!)) {
        flags += src[i]
        i++
      }
      const t: Token = { type: 'regex', pattern, flags, offset: start }
      out.push(t)
      lastSignificant = t
      continue
    }

    // number
    const numMatch = NUMBER_RE.exec(src.slice(i))
    if (numMatch && ((c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+')) {
      // disambiguate: a leading +/- followed by no digit isn't a number
      const m = numMatch[0]
      if (/\d/.test(m)) {
        const t: Token = { type: 'number', value: m, offset: i }
        out.push(t)
        lastSignificant = t
        i += m.length
        continue
      }
    }

    // punctuation
    if (punctuation.includes(c)) {
      const t: Token = { type: 'punct', value: c as PunctValue, offset: i }
      out.push(t)
      lastSignificant = t
      i++
      continue
    }

    // identifier
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!
      const t: Token = { type: 'ident', value: m[0], offset: i }
      out.push(t)
      lastSignificant = t
      i += m[0].length
      continue
    }

    throw new ParseError(`Unexpected character "${c}"`, i)
  }

  return out
}

/** Recursive-descent parser over `tokenize` output; values come back as EJSON wrapper trees. */
export class Parser {
  private pos = 0
  constructor(
    private readonly tokens: Token[],
    private readonly src: string
  ) {}

  parseValue(): unknown {
    const t = this.peek()
    if (!t) throw new ParseError('Unexpected end of input', this.src.length)

    if (t.type === 'punct' && t.value === '{') return this.parseObject()
    if (t.type === 'punct' && t.value === '[') return this.parseArray()
    if (t.type === 'string') {
      this.advance()
      return t.value
    }
    if (t.type === 'number') {
      this.advance()
      return parseNumberLiteral(t.value, t.offset)
    }
    if (t.type === 'regex') {
      this.advance()
      return regexToEjson(t.pattern, t.flags)
    }
    if (t.type === 'ident') {
      return this.parseIdentValue()
    }
    throw new ParseError(`Unexpected token "${describe(t)}"`, t.offset)
  }

  parseObject(): Record<string, unknown> {
    const open = this.expectPunct('{')
    const obj: Record<string, unknown> = {}
    for (;;) {
      const t = this.peek()
      if (!t) throw new ParseError('Unterminated object', open.offset)
      if (t.type === 'punct' && t.value === '}') {
        this.advance()
        return obj
      }
      // Read key — string, number-as-string, or bare identifier
      let key: string
      if (t.type === 'string') {
        this.advance()
        key = t.value
      } else if (t.type === 'ident') {
        this.advance()
        key = t.value
      } else if (t.type === 'number') {
        this.advance()
        key = t.value
      } else {
        throw new ParseError(`Expected object key, got "${describe(t)}"`, t.offset)
      }
      this.expectPunct(':')
      const value = this.parseValue()
      // Assigning "__proto__" would call the prototype setter and drop the stored field.
      Object.defineProperty(obj, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
      const sep = this.peek()
      if (sep && sep.type === 'punct' && sep.value === ',') {
        this.advance()
        continue
      }
      if (sep && sep.type === 'punct' && sep.value === '}') {
        this.advance()
        return obj
      }
      throw new ParseError(
        `Expected "," or "}" after object value, got "${sep ? describe(sep) : 'end'}"`,
        sep?.offset ?? this.src.length
      )
    }
  }

  parseArray(): unknown[] {
    const open = this.expectPunct('[')
    const arr: unknown[] = []
    for (;;) {
      const t = this.peek()
      if (!t) throw new ParseError('Unterminated array', open.offset)
      if (t.type === 'punct' && t.value === ']') {
        this.advance()
        return arr
      }
      arr.push(this.parseValue())
      const sep = this.peek()
      if (sep && sep.type === 'punct' && sep.value === ',') {
        this.advance()
        continue
      }
      if (sep && sep.type === 'punct' && sep.value === ']') {
        this.advance()
        return arr
      }
      throw new ParseError(
        `Expected "," or "]" after array value, got "${sep ? describe(sep) : 'end'}"`,
        sep?.offset ?? this.src.length
      )
    }
  }

  /**
   * Resolves a bare identifier into a value: either a literal keyword
   * (true/false/null/undefined), an `ident()` helper call, or a
   * standalone helper marker (MinKey, MaxKey).
   *
   * Treats `new Date(…)` as an alias for `Date(…)` so users can paste
   * directly from the mongo shell.
   */
  parseIdentValue(): unknown {
    const t = this.advance()
    if (!t || t.type !== 'ident') throw new ParseError('expected identifier', t?.offset ?? 0)

    if (t.value === 'new') {
      const next = this.peek()
      if (!next || next.type !== 'ident') {
        throw new ParseError('Expected helper name after "new"', t.offset)
      }
      return this.parseIdentValue()
    }

    const name = t.value
    if (name === 'true') return true
    if (name === 'false') return false
    if (name === 'null') return null
    if (name === 'undefined') return { $undefined: true }
    if (name === 'NaN' || name === 'Infinity') {
      throw new ParseError(`${name} is not representable as JSON`, t.offset)
    }

    const next = this.peek()
    const hasArgs = next?.type === 'punct' && next.value === '('
    if (hasArgs) {
      const args = this.parseArgs().map((arg) => arg.value)
      return applyHelper(name, args, t.offset)
    }
    // Standalone helpers (no parens)
    if (name === 'MinKey') return { $minKey: 1 }
    if (name === 'MaxKey') return { $maxKey: 1 }

    throw new ParseError(`Unknown identifier "${name}"`, t.offset)
  }

  /** Parses `(value, …)`; each argument keeps the offset of its first token. */
  parseArgs(): Array<{ value: unknown; offset: number }> {
    this.expectPunct('(')
    const args: Array<{ value: unknown; offset: number }> = []
    if (
      this.peek()?.type === 'punct' &&
      (this.peek() as Token & { value: PunctValue }).value === ')'
    ) {
      this.advance()
      return args
    }
    for (;;) {
      const offset = this.peek()?.offset ?? this.src.length
      args.push({ value: this.parseValue(), offset })
      const sep = this.peek()
      if (sep && sep.type === 'punct' && sep.value === ',') {
        this.advance()
        continue
      }
      if (sep && sep.type === 'punct' && sep.value === ')') {
        this.advance()
        return args
      }
      throw new ParseError(
        `Expected "," or ")" in call args, got "${sep ? describe(sep) : 'end'}"`,
        sep?.offset ?? this.src.length
      )
    }
  }

  expectEnd(): void {
    const t = this.peek()
    if (t) throw new ParseError(`Unexpected trailing token "${describe(t)}"`, t.offset)
  }

  expectPunct(p: PunctValue): Token {
    const t = this.advance()
    if (!t || t.type !== 'punct' || t.value !== p) {
      throw new ParseError(
        `Expected "${p}" but got "${t ? describe(t) : 'end'}"`,
        t?.offset ?? this.src.length
      )
    }
    return t
  }

  peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  advance(): Token | undefined {
    return this.tokens[this.pos++]
  }
}

function applyHelper(name: string, rawArgs: unknown[], offset: number): unknown {
  // Number arguments configure the helper (`NumberLong(5.0)` means 5); a DBRef id is a stored value.
  const args = name === 'DBRef' ? rawArgs : rawArgs.map(plainNumber)
  switch (name) {
    case 'ObjectId':
    case 'objectId': {
      if (args.length === 0) return { $oid: new ObjectId().toHexString() }
      requireString(args[0], 'ObjectId', offset)
      return { $oid: args[0] as string }
    }
    case 'ISODate':
    case 'Date': {
      if (args.length === 0) return { $date: new Date().toISOString() }
      const a = args[0]
      if (typeof a === 'string') {
        // Main would store an unparseable date string as 1970-01-01 without an error.
        if (Number.isNaN(Date.parse(a))) throw new ParseError(`Invalid date "${a}"`, offset)
        return { $date: a }
      }
      if (typeof a === 'number') return { $date: { $numberLong: String(a) } }
      throw new ParseError(`${name}() argument must be a string or number`, offset)
    }
    case 'NumberLong':
    case 'Long': {
      const v = args[0]
      if (typeof v === 'string' || typeof v === 'number') return { $numberLong: String(v) }
      throw new ParseError(`${name}() argument must be a string or number`, offset)
    }
    case 'NumberInt':
    case 'Int32': {
      const v = args[0]
      if (typeof v === 'string' || typeof v === 'number') return { $numberInt: String(v) }
      throw new ParseError(`${name}() argument must be a string or number`, offset)
    }
    case 'NumberDecimal':
    case 'Decimal128': {
      const v = args[0]
      if (typeof v === 'string' || typeof v === 'number') return { $numberDecimal: String(v) }
      throw new ParseError(`${name}() argument must be a string or number`, offset)
    }
    case 'NumberDouble':
    case 'Double': {
      const v = args[0]
      if (typeof v === 'number') return { $numberDouble: Object.is(v, -0) ? '-0.0' : String(v) }
      if (typeof v === 'string' && (NON_FINITE_DOUBLES.has(v) || isFiniteDecimal(v))) {
        return { $numberDouble: v }
      }
      throw new ParseError(`${name}() argument must be a number or numeric string`, offset)
    }
    case 'UUID': {
      requireString(args[0], 'UUID', offset)
      return { $uuid: args[0] as string }
    }
    case 'JUUID': {
      // Legacy Java-driver UUID — subType 03 with each 8-byte half stored
      // in little-endian. We re-encode the canonical UUID string into that
      // byte order so the round-trip back through bson preserves the same
      // bytes the Java driver originally wrote.
      requireString(args[0], 'JUUID', offset)
      const base64 = encodeJavaLegacyUuid(args[0] as string)
      if (base64 === null) {
        throw new ParseError('JUUID() must be a UUID string', offset)
      }
      return { $binary: { base64, subType: '03' } }
    }
    case 'BinData': {
      const sub = args[0]
      const data = args[1]
      if (typeof sub !== 'number' || typeof data !== 'string') {
        throw new ParseError('BinData(subType: number, base64: string)', offset)
      }
      const subHex = (sub & 0xff).toString(16).padStart(2, '0')
      return { $binary: { base64: data, subType: subHex } }
    }
    case 'Timestamp': {
      const t = args[0]
      const inc = args[1] ?? 0
      if (typeof t !== 'number' || typeof inc !== 'number') {
        throw new ParseError('Timestamp(t: number, i: number)', offset)
      }
      return { $timestamp: { t, i: inc } }
    }
    case 'MinKey':
      return { $minKey: 1 }
    case 'MaxKey':
      return { $maxKey: 1 }
    case 'DBRef': {
      const collection = args[0]
      const id = args[1]
      const db = args[2]
      if (typeof collection !== 'string') {
        throw new ParseError('DBRef("coll", id [, "db"])', offset)
      }
      const ref: Record<string, unknown> = { $ref: collection, $id: id }
      if (db !== undefined) {
        if (typeof db !== 'string') throw new ParseError('DBRef db must be a string', offset)
        ref['$db'] = db
      }
      return ref
    }
    case 'Code': {
      const code = args[0]
      const scope = args[1]
      if (typeof code !== 'string') throw new ParseError('Code("fn" [, scope])', offset)
      if (scope === undefined) return { $code: code }
      return { $code: code, $scope: scope }
    }
    case 'Symbol': {
      requireString(args[0], 'Symbol', offset)
      return { $symbol: args[0] as string }
    }
    case 'RegExp': {
      const pattern = args[0]
      const flags = args[1] ?? ''
      if (typeof pattern !== 'string' || typeof flags !== 'string') {
        throw new ParseError('RegExp("pattern" [, "flags"])', offset)
      }
      return regexToEjson(pattern, flags)
    }
  }
  throw new ParseError(`Unknown helper "${name}(...)"`, offset)
}

function requireString(v: unknown, name: string, offset: number): void {
  if (typeof v !== 'string') {
    throw new ParseError(`${name}() expects a string argument`, offset)
  }
}

function regexToEjson(pattern: string, flags: string): unknown {
  return { $regularExpression: { pattern, options: flags } }
}

const NON_FINITE_DOUBLES = new Set(['NaN', 'Infinity', '-Infinity'])

// Main parses `$numberDouble` with parseFloat, which reads hex or blank strings differently than Number().
const isFiniteDecimal = (text: string): boolean =>
  NUMBER_RE.exec(text)?.[0] === text && Number.isFinite(Number(text))

function parseNumberLiteral(text: string, offset: number): unknown {
  const n = Number(text)
  if (!Number.isFinite(n)) throw new ParseError(`Invalid number "${text}"`, offset)
  // Main maps an integral JSON number to Int32/Int64; the literal's dot or exponent says it's a double.
  if (Number.isInteger(n) && /[.eE]/.test(text)) return { $numberDouble: text }
  return n
}

function plainNumber(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { $numberDouble?: unknown }).$numberDouble === 'string'
  ) {
    return Number((value as { $numberDouble: string }).$numberDouble)
  }
  return value
}

function encodeJavaLegacyUuid(uuid: string): string | null {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  // Reverse first 8 bytes (msb half) and last 8 bytes (lsb half).
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) out[i] = bytes[7 - i]!
  for (let i = 0; i < 8; i++) out[8 + i] = bytes[15 - i]!
  let binary = ''
  for (let i = 0; i < 16; i++) binary += String.fromCharCode(out[i]!)
  // Browser btoa exists; Node tests run in Node so polyfill via Buffer.
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(binary, 'binary').toString('base64')
}

function describe(t: Token): string {
  if (t.type === 'punct') return t.value
  if (t.type === 'string') return `"${t.value.slice(0, 12)}…"`
  if (t.type === 'number') return t.value
  if (t.type === 'regex') return `/${t.pattern}/${t.flags}`
  return t.value
}
