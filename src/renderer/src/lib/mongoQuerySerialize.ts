/**
 * Render a JS value tree (relaxed-EJSON shape, with `$oid` / `$date` / …
 * wrappers) as a MongoDB shell-flavored string. Inverse of
 * `parseMongoQuery` from `mongoQueryLang.ts` — round-trip is intended
 * to be lossless for every BSON kind the shell can express.
 *
 *   { $oid: "…" }                                    →  ObjectId("…")
 *   { $date: "…" } / { $date: { $numberLong: ms } }  →  ISODate("…")
 *   { $numberLong: "…" } / Int / Decimal / Double    →  NumberLong("…") / NumberInt(…) / NumberDecimal("…") / number
 *   { $uuid: "…" }                                   →  UUID("…")
 *   { $binary: { base64, subType: "04" } }           →  UUID("…")    (decoded)
 *   { $binary: { base64, subType: "03" } } + java    →  JUUID("…")   (decoded with java byte order)
 *   { $binary: { base64, subType: x } }              →  BinData(<int>, "…")
 *   { $regularExpression: { pattern, options } }     →  /pattern/options
 *   { $timestamp: { t, i } }                         →  Timestamp(t, i)
 *   { $minKey: 1 } / { $maxKey: 1 }                  →  MinKey() / MaxKey()
 *   { $undefined: true }                             →  undefined
 *   { $symbol: "…" } / { $code: "…", $scope?: … }    →  Symbol("…") / Code("…", scope)
 *   { $ref: "…", $id: …, $db?: "…" }                 →  DBRef("…", id [, "…"])
 */
import type { UuidEncoding } from '@shared/types'
import { formatIsoInZone } from './dateZone'

export type SerializeOptions = {
  uuidEncoding?: UuidEncoding
  /** Spaces of indentation. Set to 0 for a compact one-liner. */
  indent?: number
  /**
   * IANA timezone for rendering ISODate values. The emitted string carries
   * an explicit offset so it round-trips back to the same UTC instant when
   * the user saves.
   */
  timezone?: string
}

export function serializeMongoValue(value: unknown, options: SerializeOptions = {}): string {
  const indent = options.indent ?? 2
  const ctx: Ctx = {
    uuidEncoding: options.uuidEncoding ?? 'default',
    timezone: options.timezone ?? 'UTC',
    indentSize: indent,
    indentStr: indent > 0 ? ' '.repeat(indent) : '',
    nl: indent > 0 ? '\n' : '',
    sep: indent > 0 ? ': ' : ':',
    listSep: indent > 0 ? ', ' : ','
  }
  return write(value, 0, ctx)
}

type Ctx = {
  uuidEncoding: UuidEncoding
  timezone: string
  indentSize: number
  indentStr: string
  nl: string
  sep: string
  listSep: string
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/

function write(value: unknown, depth: number, ctx: Ctx): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return JSON.stringify(String(value))
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return writeArray(value, depth, ctx)
  if (typeof value === 'object') {
    const helper = matchHelper(value as Record<string, unknown>, ctx)
    if (helper !== null) return helper
    return writeObject(value as Record<string, unknown>, depth, ctx)
  }
  return JSON.stringify(value)
}

function writeArray(arr: unknown[], depth: number, ctx: Ctx): string {
  if (arr.length === 0) return '[]'
  if (ctx.indentSize === 0) {
    return '[' + arr.map((v) => write(v, depth + 1, ctx)).join(ctx.listSep) + ']'
  }
  const inner = ctx.indentStr.repeat(depth + 1)
  const closer = ctx.indentStr.repeat(depth)
  return (
    '[' +
    ctx.nl +
    arr.map((v) => inner + write(v, depth + 1, ctx)).join(',' + ctx.nl) +
    ctx.nl +
    closer +
    ']'
  )
}

function writeObject(obj: Record<string, unknown>, depth: number, ctx: Ctx): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const inner = ctx.indentStr.repeat(depth + 1)
  const closer = ctx.indentStr.repeat(depth)
  const writeKey = (k: string): string => (IDENT_RE.test(k) ? k : JSON.stringify(k))
  const lines = keys.map((k) => `${inner}${writeKey(k)}${ctx.sep}${write(obj[k], depth + 1, ctx)}`)
  if (ctx.indentSize === 0) {
    return '{' + lines.map((l) => l.trimStart()).join(ctx.listSep) + '}'
  }
  return '{' + ctx.nl + lines.join(',' + ctx.nl) + ctx.nl + closer + '}'
}

/**
 * Returns the shell-helper rendering for a recognized EJSON wrapper, or
 * `null` if `obj` is just a regular nested object.
 */
function matchHelper(obj: Record<string, unknown>, ctx: Ctx): string | null {
  const keys = Object.keys(obj)

  if (keys.length === 1 && typeof obj['$oid'] === 'string') {
    return `ObjectId(${JSON.stringify(obj['$oid'])})`
  }

  if (keys.length === 1 && '$date' in obj) {
    const raw = obj['$date']
    const iso = dateToIso(raw, ctx.timezone)
    if (iso !== null) return `ISODate(${JSON.stringify(iso)})`
  }

  if (keys.length === 1 && typeof obj['$numberLong'] === 'string') {
    return `NumberLong(${JSON.stringify(obj['$numberLong'])})`
  }
  if (keys.length === 1 && typeof obj['$numberInt'] === 'string') {
    return `NumberInt(${obj['$numberInt']})`
  }
  if (keys.length === 1 && typeof obj['$numberDecimal'] === 'string') {
    return `NumberDecimal(${JSON.stringify(obj['$numberDecimal'])})`
  }
  if (keys.length === 1 && typeof obj['$numberDouble'] === 'string') {
    const n = Number(obj['$numberDouble'])
    if (Number.isFinite(n)) return String(n)
    return `NumberDouble(${JSON.stringify(obj['$numberDouble'])})`
  }

  if (keys.length === 1 && typeof obj['$uuid'] === 'string') {
    return `UUID(${JSON.stringify(obj['$uuid'])})`
  }

  if (keys.length === 1 && isPlainRecord(obj['$binary'])) {
    return renderBinary(obj['$binary'] as Record<string, unknown>, ctx)
  }

  if (
    keys.length === 1 &&
    isPlainRecord(obj['$regularExpression']) &&
    typeof (obj['$regularExpression'] as Record<string, unknown>)['pattern'] === 'string'
  ) {
    const r = obj['$regularExpression'] as { pattern: string; options?: string }
    const escaped = r.pattern.replace(/(^|[^\\])\//g, '$1\\/')
    return `/${escaped}/${typeof r.options === 'string' ? r.options : ''}`
  }

  if (keys.length === 1 && isPlainRecord(obj['$timestamp'])) {
    const t = obj['$timestamp'] as { t?: unknown; i?: unknown }
    if (typeof t.t === 'number' && typeof t.i === 'number') {
      return `Timestamp(${t.t}, ${t.i})`
    }
  }

  if (keys.length === 1 && obj['$minKey'] !== undefined) return 'MinKey()'
  if (keys.length === 1 && obj['$maxKey'] !== undefined) return 'MaxKey()'
  if (keys.length === 1 && obj['$undefined'] === true) return 'undefined'

  if (keys.length === 1 && typeof obj['$symbol'] === 'string') {
    return `Symbol(${JSON.stringify(obj['$symbol'])})`
  }

  if (
    typeof obj['$code'] === 'string' &&
    (keys.length === 1 || (keys.length === 2 && '$scope' in obj))
  ) {
    if (keys.length === 1) return `Code(${JSON.stringify(obj['$code'])})`
    return `Code(${JSON.stringify(obj['$code'])}, ${write(obj['$scope'], 0, ctx)})`
  }

  if (
    typeof obj['$ref'] === 'string' &&
    '$id' in obj &&
    (keys.length === 2 || (keys.length === 3 && typeof obj['$db'] === 'string'))
  ) {
    const args = [JSON.stringify(obj['$ref']), write(obj['$id'], 0, ctx)]
    if (typeof obj['$db'] === 'string') args.push(JSON.stringify(obj['$db']))
    return `DBRef(${args.join(', ')})`
  }

  return null
}

function dateToIso(raw: unknown, tz: string): string | null {
  if (typeof raw === 'string') return formatIsoInZone(raw, tz)
  if (isPlainRecord(raw) && typeof raw['$numberLong'] === 'string') {
    const ms = Number(raw['$numberLong'])
    if (Number.isFinite(ms)) return formatIsoInZone(new Date(ms), tz)
  }
  return null
}

function renderBinary(bin: Record<string, unknown>, ctx: Ctx): string {
  const base64 = typeof bin['base64'] === 'string' ? bin['base64'] : ''
  const subTypeHex = typeof bin['subType'] === 'string' ? bin['subType'].toLowerCase() : '00'

  if (subTypeHex === '04') {
    const decoded = decodeStandardUuid(base64)
    if (decoded) return `UUID(${JSON.stringify(decoded)})`
  }
  if (subTypeHex === '03' && ctx.uuidEncoding === 'java') {
    const decoded = decodeJavaLegacyUuid(base64)
    if (decoded) return `JUUID(${JSON.stringify(decoded)})`
  }
  const subTypeNum = parseInt(subTypeHex, 16)
  return `BinData(${Number.isFinite(subTypeNum) ? subTypeNum : 0}, ${JSON.stringify(base64)})`
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function decodeBase64ToBytes(b64: string): Uint8Array | null {
  if (b64.length === 0) return null
  try {
    const binary =
      typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
    if (binary.length !== 16) return null
    const out = new Uint8Array(16)
    for (let i = 0; i < 16; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let h = ''
  for (let i = 0; i < bytes.length; i++) h += bytes[i]!.toString(16).padStart(2, '0')
  return h
}

function formatHex(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function decodeStandardUuid(b64: string): string | null {
  const bytes = decodeBase64ToBytes(b64)
  if (!bytes) return null
  return formatHex(bytesToHex(bytes))
}

function decodeJavaLegacyUuid(b64: string): string | null {
  const bytes = decodeBase64ToBytes(b64)
  if (!bytes) return null
  const reordered = new Uint8Array(16)
  for (let i = 0; i < 8; i++) reordered[i] = bytes[7 - i]!
  for (let i = 0; i < 8; i++) reordered[8 + i] = bytes[15 - i]!
  return formatHex(bytesToHex(reordered))
}
