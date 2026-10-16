import { parseMongoQuery } from './mongoQueryLang'
import { serializeMongoValue, type SerializeOptions } from './mongoQuerySerialize'

/** Re-prints mongo-shell source with helpers preserved; null when blank or invalid. Comments are dropped. */
export function formatMongoSource(source: string, options: SerializeOptions): string | null {
  const parsed = parseMongoQuery(source)
  if (!parsed.ok || parsed.ejson === '') return null
  return serializeMongoValue(parsed.value, options)
}
