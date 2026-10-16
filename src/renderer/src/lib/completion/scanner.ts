/**
 * Tolerant lexer and prefix parser for completion. Accepts the `mongoQueryLang` surface
 * plus shell chains, never throws, and describes where the cursor sits: the open
 * containers from the root to the cursor (frames) and the partial word at the cursor.
 */

export type Punct = '{' | '}' | '[' | ']' | '(' | ')' | ':' | ',' | '.' | ';'

export type Token =
  | { t: 'punct'; v: Punct; start: number; end: number }
  | { t: 'string'; quote: '"' | "'"; value: string; closed: boolean; start: number; end: number }
  | { t: 'number'; raw: string; start: number; end: number }
  | { t: 'regex'; closed: boolean; start: number; end: number }
  | { t: 'ident'; v: string; start: number; end: number }
  | { t: 'comment'; closed: boolean; start: number; end: number }
  | { t: 'unknown'; start: number; end: number }

export type ObjectNode = { n: 'object'; entries: AstEntry[] }
export type ArrayNode = { n: 'array'; items: AstNode[] }
export type CallNode = { n: 'call'; callee: string; args: AstNode[] }
export type AstNode =
  | ObjectNode
  | ArrayNode
  | CallNode
  | { n: 'string'; value: string }
  | { n: 'number'; raw: string }
  | { n: 'regex' }
  /** true / false / null / MinKey / any other bare word. */
  | { n: 'ident'; name: string }
export type AstEntry = { key: string; value: AstNode | null }
export type StageAst = { name: string; body: AstNode | null }

export type Frame =
  | {
      f: 'object'
      node: ObjectNode
      slot: 'key' | 'afterKey' | 'value' | 'afterValue'
      key: string | null
    }
  | {
      f: 'array'
      node: ArrayNode
      slot: 'element' | 'afterElement'
      index: number
      /** Another element follows the cursor's one. */
      more: boolean
    }
  | {
      f: 'call'
      callee: string
      /** Chain segments the method is called on (`['db', 'users']`); empty for constructors. */
      receiver: readonly string[]
      argIndex: number
      slot: 'arg' | 'afterArg'
      args: AstNode[]
    }
  | {
      f: 'chain'
      /** `db` plus the collection-name segments. */
      segments: string[]
      calls: { name: string; args: AstNode[] }[]
      afterDot: boolean
    }

export type TokenSpan = {
  /** First char of the partial word; after the opening quote when inside a string. */
  start: number
  cursor: number
  /** End of the word characters after the cursor on the same line. */
  wordEnd: number
  /** `wordEnd` extended over `.segment`s, the end of an unquoted dotted key; `wordEnd` inside quotes. */
  dottedEnd: number
  quote: '"' | "'" | null
  /** Offset after the closing quote on the cursor line, if the string has one. */
  closeQuoteEnd: number | null
  /** The next non-blank char after the dotted word (or closing quote) is ':'. */
  colonFollows: boolean
  /** Next non-blank char on the cursor line after the word (or closing quote); '' at line end. */
  nextChar: string
  /** Char before `start`, or before the opening quote. */
  charBefore: string
  /** Last non-whitespace char before `start` (or the opening quote), across lines. */
  prevNonBlank: string
  prefix: string
}

export type ScanResult = {
  frames: Frame[]
  /** The cursor is in a comment, regex or number, right after a complete value, or after the input's grammar ended. */
  dead: boolean
  token: TokenSpan
  quotedKeys: boolean
  unquotedKeys: boolean
}

const MAX_SCAN_OFFSET = 1_000_000
const PUNCT = '{}[]():,.;'
const REGEX_AFTER = new Set<string>([':', ',', '[', '('])
const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const IDENT_RE = /[A-Za-z_$][\w$]*/y
const WORD_CHAR = /[\w$]/
const DOTTED_TAIL = /^(?:\.[A-Za-z_$][\w$]*)+/

/**
 * Tokenizes `text` like `mongoQueryLang`, plus `.` and `;`; unterminated strings, regexes and comments end the token.
 * @returns tokens in source order, comments included; never throws
 */
export function lex(text: string): Token[] {
  const out: Token[] = []
  const n = text.length
  let regexAllowed = true
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const start = i
      while (i < n && text[i] !== '\n') i++
      out.push({ t: 'comment', closed: true, start, end: i })
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
      out.push({ t: 'comment', closed: close !== -1, start, end: i })
      continue
    }
    if (c === '"' || c === "'") {
      const token = lexString(text, i, c)
      out.push(token)
      i = token.end
      regexAllowed = false
      continue
    }
    if (c === '/' && regexAllowed) {
      const token = lexRegex(text, i)
      out.push(token)
      i = token.end
      regexAllowed = false
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+') {
      NUMBER_RE.lastIndex = i
      const m = NUMBER_RE.exec(text)
      if (m && /\d/.test(m[0])) {
        out.push({ t: 'number', raw: m[0], start: i, end: i + m[0].length })
        i += m[0].length
        regexAllowed = false
        continue
      }
    }
    if (PUNCT.includes(c)) {
      out.push({ t: 'punct', v: c as Punct, start: i, end: i + 1 })
      regexAllowed = REGEX_AFTER.has(c)
      i++
      continue
    }
    IDENT_RE.lastIndex = i
    const ident = IDENT_RE.exec(text)
    if (ident) {
      out.push({ t: 'ident', v: ident[0], start: i, end: i + ident[0].length })
      i += ident[0].length
      regexAllowed = false
      continue
    }
    out.push({ t: 'unknown', start: i, end: i + 1 })
    regexAllowed = false
    i++
  }
  return out
}

function lexString(text: string, start: number, quote: '"' | "'"): Token {
  let value = ''
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === quote) return { t: 'string', quote, value, closed: true, start, end: i + 1 }
    if (ch === '\n') break
    if (ch === '\\') {
      const escaped = text[i + 1]
      if (escaped === undefined) {
        i++
        break
      }
      const hex = text.slice(i + 2, i + 6)
      if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      value += ESCAPES[escaped] ?? escaped
      i += 2
      continue
    }
    value += ch
    i++
  }
  return { t: 'string', quote, value, closed: false, start, end: i }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' }

function lexRegex(text: string, start: number): Token {
  let i = start + 1
  let inClass = false
  let closed = false
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      i += 2
      continue
    }
    if (ch === '\n') break
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      closed = true
      i++
      break
    }
    i++
  }
  if (closed) while (i < text.length && /[gimsuy]/.test(text[i]!)) i++
  return { t: 'regex', closed, start, end: i }
}

/**
 * Parses `text` up to `offset` tolerantly; `root` selects value, document-sequence or shell-chain grammar.
 * @param offset cursor offset into `text`
 * @returns the open frames at the cursor (empty = at the root slot), their objects completed with the entries after the cursor, and the partial token there
 */
export function scan(
  text: string,
  offset: number,
  root: 'value' | 'documents' | 'shell'
): ScanResult {
  const cursor = Math.max(0, Math.min(offset, text.length))
  if (cursor > MAX_SCAN_OFFSET) {
    return {
      frames: [],
      dead: true,
      token: span(text, cursor, cursor, null),
      quotedKeys: false,
      unquotedKeys: false
    }
  }
  const tokens = lex(text)
  let cut = tokens.findIndex((token) => token.start >= cursor)
  if (cut === -1) cut = tokens.length
  const prev = tokens[cut - 1]
  let parseEnd = cut
  let start = cursor
  let quoted: Extract<Token, { t: 'string' }> | null = null
  let dead = false
  if (prev && prev.end >= cursor) {
    switch (prev.t) {
      case 'ident':
        parseEnd = cut - 1
        start = prev.start
        break
      case 'string':
        if (cursor < prev.end || !prev.closed) {
          parseEnd = cut - 1
          quoted = prev
          start = prev.start + 1
        } else dead = true
        break
      case 'comment':
        dead = cursor < prev.end || !prev.closed || text.startsWith('//', prev.start)
        break
      case 'number':
      case 'regex':
        dead = true
        break
      case 'punct':
        dead = prev.v === '}' || prev.v === ']' || prev.v === ')'
        break
      case 'unknown':
        // A lone `-` starts a negative number (`-1` in a sort spec).
        if (text[prev.start] === '-') {
          parseEnd = cut - 1
          start = prev.start
        }
        break
    }
  }

  let frames: Frame[] = []
  if (!dead) {
    const parser = new PrefixParser(
      tokens.slice(0, parseEnd).filter((token) => token.t !== 'comment'),
      quoted ? -1 : start
    )
    if (parser.run(root)) {
      frames = parser.frames
      if (parser.dottedStart !== null) start = parser.dottedStart
      // The dotted tail of a word at the cursor (`addr|ess.city`) still belongs to that word.
      const restStart = prev?.t === 'ident' && parseEnd < cut ? skipDottedTail(tokens, cut) : cut
      const rest = tokens.slice(restStart).filter((token) => token.t !== 'comment')
      new PrefixParser(rest, -1).completeObjects(frames)
    } else dead = true
  }
  const keyStyles = detectKeyStyles(tokens, parseEnd < cut ? cut - 1 : -1)
  return { frames, dead, token: span(text, start, cursor, quoted), ...keyStyles }
}

/**
 * Stage list of a pipeline array's items; non-object and empty items are skipped.
 * @returns one entry per stage object, named by its first key
 */
export function toStages(items: readonly AstNode[]): StageAst[] {
  const stages: StageAst[] = []
  for (const item of items) {
    if (item.n !== 'object') continue
    const first = item.entries[0]
    if (first) stages.push({ name: first.key, body: first.value })
  }
  return stages
}

/**
 * Value of the last entry named `key` of an object node.
 * @returns undefined when `node` is not an object or has no such entry; null for an entry without value
 */
export function entryValue(
  node: AstNode | null | undefined,
  key: string
): AstNode | null | undefined {
  if (node?.n !== 'object') return undefined
  for (let i = node.entries.length - 1; i >= 0; i--) {
    const entry = node.entries[i]!
    if (entry.key === key) return entry.value
  }
  return undefined
}

/**
 * String content of a string node.
 * @returns null for any other node
 */
export function stringValue(node: AstNode | null | undefined): string | null {
  return node?.n === 'string' ? node.value : null
}

function span(
  text: string,
  start: number,
  cursor: number,
  quoted: Extract<Token, { t: 'string' }> | null
): TokenSpan {
  const newline = text.indexOf('\n', cursor)
  const lineEnd = newline === -1 ? text.length : newline
  let wordEnd = cursor
  while (wordEnd < lineEnd && WORD_CHAR.test(text[wordEnd]!)) wordEnd++
  const dotted = quoted ? null : DOTTED_TAIL.exec(text.slice(wordEnd, lineEnd))
  const dottedEnd = wordEnd + (dotted?.[0].length ?? 0)
  const closeQuoteEnd = quoted?.closed && quoted.end <= lineEnd ? quoted.end : null
  const outer = quoted ? quoted.start : start
  let before = outer - 1
  while (before >= 0 && /\s/.test(text[before]!)) before--
  return {
    start,
    cursor,
    wordEnd,
    dottedEnd,
    quote: quoted?.quote ?? null,
    closeQuoteEnd,
    colonFollows: nextNonBlank(text, closeQuoteEnd ?? dottedEnd, lineEnd) === ':',
    nextChar: nextNonBlank(text, closeQuoteEnd ?? wordEnd, lineEnd),
    charBefore: outer > 0 ? text[outer - 1]! : '',
    prevNonBlank: before >= 0 ? text[before]! : '',
    prefix: text.slice(start, cursor)
  }
}

/** Index after the `.segment`s from `i` on that directly continue the token before `i`. */
function skipDottedTail(tokens: readonly Token[], i: number): number {
  for (;;) {
    const before = tokens[i - 1]
    const next = tokens[i]
    if (!before || !next || next.start !== before.end) return i
    // `.0` lexes as one number token.
    if (next.t === 'number' && /^\.\d+$/.test(next.raw)) {
      i++
      continue
    }
    const segment = tokens[i + 1]
    if (!isPunct(next, '.') || segment?.t !== 'ident' || segment.start !== next.end) return i
    i += 2
  }
}

function nextNonBlank(text: string, from: number, lineEnd: number): string {
  let i = from
  while (i < lineEnd && /[ \t\r]/.test(text[i]!)) i++
  return i < lineEnd ? text[i]! : ''
}

function detectKeyStyles(
  tokens: readonly Token[],
  cursorToken: number
): { quotedKeys: boolean; unquotedKeys: boolean } {
  let quotedKeys = false
  let unquotedKeys = false
  const significant = tokens.filter((token, i) => token.t !== 'comment' && i !== cursorToken)
  for (let i = 0; i + 1 < significant.length; i++) {
    const next = significant[i + 1]!
    if (next.t !== 'punct' || next.v !== ':') continue
    const token = significant[i]!
    if (token.t === 'string') quotedKeys = true
    else if (token.t === 'ident') unquotedKeys = true
  }
  return { quotedKeys, unquotedKeys }
}

/** Thrown when the parser runs out of tokens, i.e. reaches the cursor. */
const CURSOR = { reached: true } as const

class PrefixParser {
  readonly frames: Frame[] = []
  /** Start of an unquoted dotted key (`address.ci|`) that ends at the cursor. */
  dottedStart: number | null = null
  private pos = 0

  constructor(
    private readonly tokens: readonly Token[],
    private readonly partialStart: number
  ) {}

  /** True when the cursor was reached inside the grammar; false when the input ended before it. */
  run(root: 'value' | 'documents' | 'shell'): boolean {
    try {
      if (root === 'value') this.parseValue()
      else if (root === 'documents') this.parseDocuments()
      else this.parseChain()
      return false
    } catch (e) {
      if (e === CURSOR) return true
      throw e
    }
  }

  /** Appends the entries after the cursor (this parser's tokens) to each open object of `frames` and marks open arrays with elements after it. */
  completeObjects(frames: readonly Frame[]): void {
    let level = frames.length - 1
    let depth = 0
    try {
      for (;;) {
        const frame = frames[level]
        if (!frame || frame.f === 'chain') return
        const token = this.need()
        // Keys are found by their colon, so a key typed above others without a comma still sees them.
        if (depth === 0 && frame.f === 'object' && isKeyToken(token)) {
          const entry = this.parseKey()
          if (isPunct(this.need(), ':')) {
            this.advance()
            frame.node.entries.push(entry)
            entry.value = this.parseValue()
          }
          continue
        }
        this.advance()
        if (token.t !== 'punct') continue
        if (depth === 0 && frame.f === 'array' && token.v === ',') {
          const next = this.peek()
          if (next && !isPunct(next, ']')) frame.more = true
        } else if (token.v === '{' || token.v === '[' || token.v === '(') depth++
        else if (token.v === '}' || token.v === ']' || token.v === ')') {
          if (depth > 0) depth--
          else level--
        }
      }
    } catch (e) {
      if (e !== CURSOR) throw e
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private need(): Token {
    const token = this.tokens[this.pos]
    if (!token) throw CURSOR
    return token
  }

  private advance(): Token {
    return this.tokens[this.pos++]!
  }

  private parseDocuments(): void {
    for (;;) {
      const token = this.need()
      if (isPunct(token, ',')) {
        this.advance()
        continue
      }
      const before = this.pos
      this.parseValue()
      if (this.pos === before) this.advance()
    }
  }

  private parseValue(): AstNode | null {
    const token = this.need()
    switch (token.t) {
      case 'punct':
        if (token.v === '{') return this.parseObject()
        if (token.v === '[') return this.parseArray()
        // Separators and closers belong to the enclosing container.
        if (token.v === ',' || token.v === '}' || token.v === ']' || token.v === ')') return null
        this.advance()
        return null
      case 'string':
        this.advance()
        return { n: 'string', value: token.value }
      case 'number':
        this.advance()
        return { n: 'number', raw: token.raw }
      case 'regex':
        this.advance()
        return { n: 'regex' }
      case 'ident':
        return this.parseIdentValue()
      default:
        this.advance()
        return null
    }
  }

  private parseIdentValue(): AstNode {
    let token = this.advance() as Extract<Token, { t: 'ident' }>
    if (token.v === 'new') {
      const next = this.need()
      if (next.t !== 'ident') return { n: 'ident', name: 'new' }
      token = this.advance() as Extract<Token, { t: 'ident' }>
    }
    const next = this.peek()
    if (next && isPunct(next, '(')) return this.parseCall(token.v, [])
    return { n: 'ident', name: token.v }
  }

  private parseCall(callee: string, receiver: readonly string[]): CallNode {
    this.advance()
    const node: CallNode = { n: 'call', callee, args: [] }
    const frame: Extract<Frame, { f: 'call' }> = {
      f: 'call',
      callee,
      receiver,
      argIndex: 0,
      slot: 'arg',
      args: node.args
    }
    this.parseItems(frame, ')', node.args, (index, after) => {
      frame.argIndex = index
      frame.slot = after ? 'afterArg' : 'arg'
    })
    return node
  }

  private parseArray(): ArrayNode {
    this.advance()
    const node: ArrayNode = { n: 'array', items: [] }
    const frame: Extract<Frame, { f: 'array' }> = {
      f: 'array',
      node,
      slot: 'element',
      index: 0,
      more: false
    }
    this.parseItems(frame, ']', node.items, (index, after) => {
      frame.index = index
      frame.slot = after ? 'afterElement' : 'element'
    })
    return node
  }

  /** Reads comma-separated values into `items` up to `close`; `slot` records the cursor's item index and whether it is past that item. */
  private parseItems(
    frame: Frame,
    close: Punct,
    items: AstNode[],
    slot: (index: number, after: boolean) => void
  ): void {
    this.frames.push(frame)
    let index = 0
    let after = false
    for (;;) {
      const token = this.need()
      if (this.leaveAt(token, close)) return
      // A comma, or a value written without one, starts the next item.
      if (after || isPunct(token, ',')) {
        index++
        after = false
        slot(index, false)
        if (isPunct(token, ',')) {
          this.advance()
          continue
        }
      }
      const value = this.parseValue()
      if (value) items.push(value)
      after = true
      slot(index, true)
    }
  }

  /** Pops the innermost frame at a closing bracket; only `close` is consumed, any other closes an enclosing container. */
  private leaveAt(token: Token, close: Punct): boolean {
    if (token.t !== 'punct' || (token.v !== '}' && token.v !== ']' && token.v !== ')')) return false
    if (token.v === close) this.advance()
    this.frames.pop()
    return true
  }

  private parseObject(): ObjectNode {
    this.advance()
    const node: ObjectNode = { n: 'object', entries: [] }
    const frame: Extract<Frame, { f: 'object' }> = { f: 'object', node, slot: 'key', key: null }
    this.frames.push(frame)
    let entry: AstEntry | null = null
    for (;;) {
      const token = this.need()
      if (this.leaveAt(token, '}')) return node
      switch (frame.slot) {
        case 'key':
          if (isPunct(token, ',')) this.advance()
          else if (token.t === 'string' || token.t === 'ident' || token.t === 'number') {
            entry = this.parseKey()
            node.entries.push(entry)
            frame.key = entry.key
            frame.slot = 'afterKey'
          } else if (isPunct(token, '{') || isPunct(token, '[')) {
            this.parseValue()
            frame.slot = 'afterValue'
          } else this.advance()
          break
        case 'afterKey':
          if (isPunct(token, ':')) {
            this.advance()
            frame.slot = 'value'
          } else if (isPunct(token, ',')) {
            this.advance()
            frame.slot = 'key'
            frame.key = null
          } else frame.slot = 'value'
          break
        case 'value': {
          if (isPunct(token, ',')) {
            this.advance()
            frame.slot = 'key'
            frame.key = null
            break
          }
          const value = this.parseValue()
          if (entry) entry.value = value
          frame.slot = 'afterValue'
          break
        }
        case 'afterValue':
          if (isPunct(token, ',')) this.advance()
          frame.slot = 'key'
          frame.key = null
          break
      }
    }
  }

  /** Reads a key; an unquoted dotted key running into the cursor stops the parse as a partial key. */
  private parseKey(): AstEntry {
    const first = this.advance()
    if (first.t === 'string') return { key: first.value, value: null }
    let key = first.t === 'ident' ? first.v : first.t === 'number' ? first.raw : ''
    let end = first.end
    if (first.t === 'ident') {
      for (;;) {
        const next = this.peek()
        if (next?.t === 'number' && next.start === end && /^\.\d+$/.test(next.raw)) {
          this.advance()
          key += next.raw
          end = next.end
          continue
        }
        if (!next || !isPunct(next, '.') || next.start !== end) break
        this.advance()
        end = next.end
        const segment = this.peek()
        if (!segment) {
          if (end === this.partialStart) {
            this.dottedStart = first.start
            throw CURSOR
          }
          break
        }
        if (segment.t !== 'ident' || segment.start !== end) break
        this.advance()
        key += `.${segment.v}`
        end = segment.end
      }
    }
    return { key, value: null }
  }

  /** `db (. name)* . method(args) (. method(args))* ;?` plus `db["name"]` and `db.getCollection("name")`. */
  private parseChain(): void {
    const frame: Extract<Frame, { f: 'chain' }> = {
      f: 'chain',
      segments: [],
      calls: [],
      afterDot: false
    }
    this.frames.push(frame)
    const head = this.need()
    if (head.t !== 'ident') return
    this.advance()
    frame.segments.push(head.v)
    for (;;) {
      const token = this.need()
      if (isPunct(token, '.')) {
        this.advance()
        frame.afterDot = true
        const name = this.need()
        if (name.t !== 'ident') return
        this.advance()
        frame.afterDot = false
        const open = this.peek()
        if (open && isPunct(open, '(')) {
          const call = this.parseCall(name.v, [...frame.segments])
          const target = stringValue(call.args[0])
          if (
            name.v === 'getCollection' &&
            frame.calls.length === 0 &&
            frame.segments.length === 1 &&
            target !== null
          ) {
            frame.segments.push(target)
          } else frame.calls.push({ name: name.v, args: call.args })
        } else if (frame.calls.length === 0) frame.segments.push(name.v)
        continue
      }
      if (isPunct(token, '[') && frame.calls.length === 0) {
        this.parseBracketAccess(frame)
        continue
      }
      if (isPunct(token, ';')) this.advance()
      return
    }
  }

  /** `db["name"]` behaves like `db.getCollection("name")`. */
  private parseBracketAccess(chain: Extract<Frame, { f: 'chain' }>): void {
    this.advance()
    const frame: Extract<Frame, { f: 'call' }> = {
      f: 'call',
      callee: 'getCollection',
      receiver: [...chain.segments],
      argIndex: 0,
      slot: 'arg',
      args: []
    }
    this.frames.push(frame)
    const value = this.parseValue()
    if (value) frame.args.push(value)
    frame.slot = 'afterArg'
    if (isPunct(this.need(), ']')) this.advance()
    this.frames.pop()
    const target = stringValue(value)
    if (target !== null) chain.segments.push(target)
  }
}

function isPunct(token: Token, value: Punct): boolean {
  return token.t === 'punct' && token.v === value
}

function isKeyToken(token: Token): boolean {
  return token.t === 'string' || token.t === 'ident' || token.t === 'number'
}
