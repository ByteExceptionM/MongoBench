import { BSON, EJSON, type Document } from 'bson'
import { createHash } from 'node:crypto'
import { isDocument } from '@shared/writeOps'

/**
 * EJSON helpers — the only place in the main process that touches
 * BSON/EJSON conversion. All driver values flow through here on their
 * way to the renderer, and all renderer-supplied JSON strings flow
 * through here on their way to the driver.
 *
 * See design spec §5.3.
 */

export type RelaxedDocument = Record<string, unknown>

// Not driver options: per operation they would also turn server error codes into Int32 and stop retries.
const DOCUMENT_DECODE_OPTIONS = { promoteValues: false, bsonRegExp: true } as const

/** Driver options for replies read decoded: Int64 and regexes stay exact; error codes stay numbers. */
export const REPLY_DECODE_OPTIONS = { promoteLongs: false, bsonRegExp: true } as const

/**
 * Decodes a document read with `raw: true`, keeping every stored BSON type for canonical EJSON.
 * @param bytes one raw document as the driver returns it
 */
export function decodeDocument(bytes: Uint8Array): Document {
  return BSON.deserialize(bytes, DOCUMENT_DECODE_OPTIONS)
}

/** Convert a BSON document to its relaxed-EJSON object form (display); Int64 stays `{ $numberLong }`. */
export function toRelaxed(doc: unknown): RelaxedDocument {
  return EJSON.serialize(wrapInt64(doc) as object, { relaxed: true }) as RelaxedDocument
}

/** Convert a BSON value to its canonical-EJSON string (stable identity). */
export function toCanonicalString(value: unknown): string {
  return EJSON.stringify(value, { relaxed: false })
}

/** Convert a BSON value to its canonical-EJSON object form (every BSON type wrapped). */
export function toCanonical(value: unknown): unknown {
  return EJSON.serialize(value as object, { relaxed: false })
}

// Relaxed EJSON turns every Long into a JS number, which rounds beyond 2^53.
function wrapInt64(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapInt64)
  if (typeof value !== 'object' || value === null) return value
  if ('_bsontype' in value) {
    // Longs inside a DBRef's fields or a Code scope stay relaxed; EJSON serializes those itself.
    return value._bsontype === 'Long' ? { $numberLong: String(value) } : value
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__') {
      Object.defineProperty(out, key, {
        value: wrapInt64(entry),
        writable: true,
        enumerable: true,
        configurable: true
      })
    } else {
      out[key] = wrapInt64(entry)
    }
  }
  return out
}

/**
 * Parse a user-supplied EJSON/JSON string into a BSON document. Empty or
 * whitespace-only input becomes `{}`. Relaxed mode is allowed so users
 * can paste plain JSON or `{ _id: ObjectId("…") }`-style EJSON.
 */
export function parseFilter(input: string | undefined): Record<string, unknown> {
  if (input === undefined) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}
  const parsed = parseRelaxed(trimmed)
  if (!isDocument(parsed)) {
    throw new Error('Filter must be a JSON object')
  }
  return parsed
}

/** Parses relaxed EJSON from the user; `$numberLong` becomes a bigint, which stays exact beyond 2^53. */
export function parseRelaxed(input: string): unknown {
  return EJSON.parse(input, { relaxed: true, useBigInt64: true })
}

/** sha-256 of a value's canonical-EJSON form. Used for optimistic concurrency in M3. */
export function canonicalHash(value: unknown): string {
  return hashCanonicalString(toCanonicalString(value))
}

/** `canonicalHash` for a value whose canonical-EJSON string is already at hand. */
export function hashCanonicalString(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex')
}
