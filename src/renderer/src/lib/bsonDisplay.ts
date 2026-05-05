import type { DocumentEnvelope, UuidEncoding } from '@shared/types'

export type BsonKind =
  | 'objectid'
  | 'date'
  | 'decimal'
  | 'long'
  | 'binary'
  | 'uuid'
  | 'regex'
  | 'string'
  | 'number'
  | 'bool'
  | 'null'
  | 'undefined'
  | 'array'
  | 'object'

export type InspectOptions = {
  /** Apply this connection's UUID encoding when rendering Binary values. */
  uuidEncoding?: UuidEncoding
}

export type Inspected = {
  kind: BsonKind
  display: string
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Format an ISO timestamp (or `Date`) as `dd.MM.yyyy HH:mm:ss:fff` in the
 * user's local timezone. Used for table cells; the view/edit dialogs keep
 * the raw canonical EJSON to preserve type precision.
 */
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

const formatDateValue = (input: string | number | Date): string => {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return String(input)
  return (
    `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

const longDateToFormatted = (long: string): string => {
  const ms = Number(long)
  if (!Number.isFinite(ms)) return long
  return formatDateValue(new Date(ms))
}

export function inspectBson(value: unknown, options: InspectOptions = {}): Inspected {
  if (value === null) return { kind: 'null', display: 'null' }
  if (value === undefined) return { kind: 'undefined', display: 'undefined' }
  if (Array.isArray(value)) return { kind: 'array', display: `Array(${value.length})` }

  if (typeof value === 'string') return { kind: 'string', display: value }
  if (typeof value === 'number') return { kind: 'number', display: String(value) }
  if (typeof value === 'boolean') return { kind: 'bool', display: value ? 'true' : 'false' }

  if (isPlainRecord(value)) {
    if (typeof value['$oid'] === 'string') {
      return { kind: 'objectid', display: value['$oid'] }
    }
    if ('$date' in value) {
      const raw = value['$date']
      if (typeof raw === 'string') return { kind: 'date', display: formatDateValue(raw) }
      if (isPlainRecord(raw) && typeof raw['$numberLong'] === 'string') {
        return { kind: 'date', display: longDateToFormatted(raw['$numberLong']) }
      }
      return { kind: 'date', display: String(raw) }
    }
    if (typeof value['$numberDecimal'] === 'string') {
      return { kind: 'decimal', display: value['$numberDecimal'] }
    }
    if (typeof value['$numberLong'] === 'string') {
      return { kind: 'long', display: value['$numberLong'] }
    }
    if (typeof value['$numberDouble'] === 'string') {
      return { kind: 'number', display: value['$numberDouble'] }
    }
    if (typeof value['$numberInt'] === 'string') {
      return { kind: 'number', display: value['$numberInt'] }
    }
    if (isPlainRecord(value['$binary'])) {
      const bin = value['$binary'] as { base64?: unknown; subType?: unknown }
      const base64 = typeof bin.base64 === 'string' ? bin.base64 : ''
      const subType = typeof bin.subType === 'string' ? bin.subType.toLowerCase() : ''
      const uuidEncoding = options.uuidEncoding ?? 'default'
      // subType 04 — BSON standard UUID, big-endian; always renderable.
      if (subType === '04') {
        const formatted = decodeStandardUuid(base64)
        if (formatted) return { kind: 'uuid', display: formatted }
      }
      // subType 03 — legacy UUID. Only decode when the connection asks us
      // to. Java legacy stores each 8-byte half in little-endian (historic
      // Java driver behaviour), so we reverse each half before formatting.
      if (subType === '03' && uuidEncoding === 'java') {
        const formatted = decodeJavaLegacyUuid(base64)
        if (formatted) return { kind: 'uuid', display: formatted }
      }
      return { kind: 'binary', display: 'Binary(…)' }
    }
    if ('$regularExpression' in value) {
      const r = value['$regularExpression']
      if (isPlainRecord(r) && typeof r['pattern'] === 'string') {
        const pattern = r['pattern']
        const flags = typeof r['options'] === 'string' ? r['options'] : ''
        return { kind: 'regex', display: `/${pattern}/${flags}` }
      }
      return { kind: 'regex', display: '/…/' }
    }
    const keys = Object.keys(value)
    return { kind: 'object', display: keys.length === 0 ? '{}' : `{${keys.length} fields}` }
  }

  return { kind: 'object', display: String(value) }
}

function decodeBase64ToBytes(b64: string): string | null {
  if (b64.length === 0) return null
  try {
    const binary = atob(b64)
    return binary.length === 16 ? binary : null
  } catch {
    return null
  }
}

const HEX_AT = (binary: string, i: number): string =>
  binary.charCodeAt(i).toString(16).padStart(2, '0')

const formatHex = (h: string): string =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`

/** BSON subType 04 — bytes are already in standard big-endian UUID order. */
function decodeStandardUuid(b64: string): string | null {
  const binary = decodeBase64ToBytes(b64)
  if (binary === null) return null
  let h = ''
  for (let i = 0; i < 16; i++) h += HEX_AT(binary, i)
  return formatHex(h)
}

/**
 * BSON subType 03 written by the legacy Java driver. The driver wrote
 * each 64-bit half (msb, then lsb) in little-endian. To get back to the
 * canonical UUID string we reverse each 8-byte half.
 */
function decodeJavaLegacyUuid(b64: string): string | null {
  const binary = decodeBase64ToBytes(b64)
  if (binary === null) return null
  let h = ''
  for (let i = 7; i >= 0; i--) h += HEX_AT(binary, i)
  for (let i = 15; i >= 8; i--) h += HEX_AT(binary, i)
  return formatHex(h)
}

export function extractColumns(documents: DocumentEnvelope[]): string[] {
  const seen = new Set<string>()
  for (const env of documents) {
    for (const key of Object.keys(env.data)) seen.add(key)
  }
  return ['_id', ...[...seen].filter((k) => k !== '_id')]
}

export function kindBadgeClass(kind: BsonKind): string {
  switch (kind) {
    case 'objectid':
      return 'text-primary'
    case 'date':
      return 'text-amber-300/90 dark:text-amber-300'
    case 'decimal':
    case 'long':
    case 'number':
      return 'text-sky-300/90'
    case 'string':
      return 'text-foreground'
    case 'bool':
      return 'text-fuchsia-300'
    case 'null':
    case 'undefined':
      return 'text-muted-foreground italic'
    case 'array':
    case 'object':
      return 'text-muted-foreground'
    case 'binary':
    case 'regex':
      return 'text-emerald-300/90'
    case 'uuid':
      return 'text-cyan-300'
  }
}

export function kindLabel(kind: BsonKind): string {
  switch (kind) {
    case 'objectid':
      return 'oid'
    case 'date':
      return 'date'
    case 'decimal':
      return 'dec128'
    case 'long':
      return 'long'
    case 'number':
      return 'num'
    case 'string':
      return 'str'
    case 'bool':
      return 'bool'
    case 'null':
      return 'null'
    case 'undefined':
      return 'undef'
    case 'array':
      return 'arr'
    case 'object':
      return 'obj'
    case 'binary':
      return 'bin'
    case 'regex':
      return 're'
    case 'uuid':
      return 'uuid'
  }
}
