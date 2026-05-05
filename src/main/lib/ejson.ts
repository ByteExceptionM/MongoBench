import { EJSON } from 'bson'
import { createHash } from 'node:crypto'

/**
 * EJSON helpers — the only place in the main process that touches
 * BSON/EJSON conversion. All driver values flow through here on their
 * way to the renderer, and all renderer-supplied JSON strings flow
 * through here on their way to the driver.
 *
 * See design spec §5.3.
 */

export type RelaxedDocument = Record<string, unknown>

/** Convert a BSON document to its relaxed-EJSON object form (display). */
export function toRelaxed(doc: unknown): RelaxedDocument {
  return EJSON.serialize(doc as object, { relaxed: true }) as RelaxedDocument
}

/** Convert a BSON value to its canonical-EJSON string (stable identity). */
export function toCanonicalString(value: unknown): string {
  return EJSON.stringify(value, { relaxed: false })
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
  const parsed = EJSON.parse(trimmed, { relaxed: true })
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Filter must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** sha-256 of a value's canonical-EJSON form. Used for optimistic concurrency in M3. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(toCanonicalString(value)).digest('hex')
}
