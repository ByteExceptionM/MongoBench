/**
 * Export the current find result as JSON / CSV / TSV.
 *
 * JSON: pretty-printed canonical EJSON array — round-trips back into Mongo
 * via tools like `mongoimport --jsonArray` since BSON types stay wrapped
 * (`{$oid: …}`, `{$date: …}`, …).
 *
 * CSV / TSV: flat one-row-per-doc with a header row built from the union
 * of every document's top-level keys. BSON values render the same way the
 * table cell does (ObjectId hex, ISO date in connection TZ, etc.) so a
 * spreadsheet reader sees them as text.
 */
import { extractColumns, inspectBson } from './bsonDisplay'
import type { DocumentEnvelope, UuidEncoding } from '@shared/types'

export type ExportFormat = 'json' | 'csv' | 'tsv'

type ExportOptions = {
  uuidEncoding: UuidEncoding
  timezone: string
}

export function exportToString(
  format: ExportFormat,
  documents: DocumentEnvelope[],
  options: ExportOptions
): string {
  if (format === 'json') return exportJson(documents)
  return exportDelimited(documents, format === 'csv' ? ',' : '\t', options)
}

export function mimeTypeFor(format: ExportFormat): string {
  if (format === 'json') return 'application/json'
  if (format === 'csv') return 'text/csv'
  return 'text/tab-separated-values'
}

export function extensionFor(format: ExportFormat): string {
  return format
}

function exportJson(documents: DocumentEnvelope[]): string {
  const docs = documents.map((env) => {
    if (env.canonical && env.canonical.length > 0) {
      try {
        return JSON.parse(env.canonical)
      } catch {
        return env.data
      }
    }
    return env.data
  })
  return JSON.stringify(docs, null, 2)
}

function exportDelimited(
  documents: DocumentEnvelope[],
  delimiter: string,
  options: ExportOptions
): string {
  const columns = extractColumns(documents)
  const escape = (raw: string): string => {
    // CSV/TSV escaping: wrap in quotes when the cell contains the delimiter,
    // a quote, or a newline. Existing quotes are doubled. Tabs in text are
    // also escaped under TSV — a literal tab inside a TSV cell would shift
    // every subsequent column.
    const needsQuoting =
      raw.includes(delimiter) || raw.includes('"') || raw.includes('\n') || raw.includes('\r')
    if (!needsQuoting) return raw
    return `"${raw.replace(/"/g, '""')}"`
  }

  const headerRow = columns.map(escape).join(delimiter)
  const rows = documents.map((doc) => {
    const cells = columns.map((col) => {
      if (!(col in doc.data)) return ''
      return escape(renderCell(doc.data[col], options))
    })
    return cells.join(delimiter)
  })
  return [headerRow, ...rows].join('\r\n')
}

/**
 * Render a value as the spreadsheet sees it. Primitives stay primitive,
 * BSON wrappers go through `inspectBson` so dates render in the user's
 * timezone, ObjectIds become hex strings, etc. Nested objects/arrays
 * fall back to a JSON string so no information is lost — just flattened.
 */
function renderCell(value: unknown, options: ExportOptions): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    return JSON.stringify(value)
  }

  if (typeof value === 'object') {
    const inspected = inspectBson(value, options)
    if (inspected.kind === 'object') return JSON.stringify(value)
    return inspected.display
  }
  return String(value)
}
