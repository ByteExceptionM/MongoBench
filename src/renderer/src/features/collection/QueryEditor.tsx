import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { cn } from '@/lib/utils'

type Props = {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  hasError?: boolean
  placeholder?: string
  /** Minimum visible editor height in px. Defaults to one line (~24). */
  minHeight?: number
  /** Maximum height before vertical scroll. Defaults to ~5 lines. */
  maxHeight?: number
  /** Render the Run / Format actions absolutely over the editor's right edge. */
  actions?: React.ReactNode
  autoFocus?: boolean
  /**
   * Called when the user presses Shift+Alt+F. If provided, overrides
   * Monaco's built-in JSON formatter — useful because Monaco's JSON
   * formatter rejects MongoDB shell syntax (ObjectId(...) etc.).
   */
  onFormat?: () => void
  /**
   * Reports the editor's natural content height (pre-clamp) on every
   * change. Sister editors can use this to keep their heights in sync.
   */
  onContentHeightChange?: (px: number) => void
}

/**
 * MongoDB filter editor.
 *
 * Wraps Monaco with: JSON syntax highlighting, bracket auto-pairing,
 * format-on-paste, MongoDB operator IntelliSense (registered once via
 * `ensureProviderRegistered`), and a destructive-coloured border when
 * the value isn't valid JSON.
 */
export function QueryEditor({
  value,
  onChange,
  onSubmit,
  hasError,
  placeholder,
  minHeight = 30,
  maxHeight = 140,
  actions,
  autoFocus,
  onFormat,
  onContentHeightChange
}: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const submitRef = useRef(onSubmit)
  const formatRef = useRef(onFormat)
  const minHeightRef = useRef(minHeight)
  const maxHeightRef = useRef(maxHeight)
  const onContentHeightChangeRef = useRef(onContentHeightChange)
  const [contentHeight, setContentHeight] = useState(minHeight)
  useEffect(() => {
    submitRef.current = onSubmit
  }, [onSubmit])
  useEffect(() => {
    formatRef.current = onFormat
  }, [onFormat])
  useEffect(() => {
    onContentHeightChangeRef.current = onContentHeightChange
  }, [onContentHeightChange])
  // Re-clamp the visible height when the bounds change from outside —
  // e.g. a sister editor pushed our `minHeight` up to keep both rows the
  // same height.
  useEffect(() => {
    minHeightRef.current = minHeight
    maxHeightRef.current = maxHeight
    const editor = editorRef.current
    if (!editor) return
    const ch = editor.getContentHeight()
    setContentHeight(Math.min(Math.max(ch, minHeight), maxHeight))
  }, [minHeight, maxHeight])

  const handleMount: OnMount = (editor, m) => {
    editorRef.current = editor
    ensureProviderRegistered()

    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => submitRef.current())
    editor.addAction({
      id: 'mongobench.format',
      label: 'Format JSON',
      keybindings: [m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF],
      run: () => {
        if (formatRef.current) {
          formatRef.current()
        } else {
          void editor.getAction('editor.action.formatDocument')?.run()
        }
      }
    })

    const sync = () => {
      const ch = editor.getContentHeight()
      const next = Math.min(Math.max(ch, minHeightRef.current), maxHeightRef.current)
      setContentHeight(next)
      onContentHeightChangeRef.current?.(ch)
    }
    editor.onDidContentSizeChange(sync)
    sync()

    if (autoFocus) editor.focus()
  }

  const isEmpty = value.length === 0

  return (
    <div
      className={cn(
        'group relative flex w-full items-stretch rounded-md border bg-background transition-colors focus-within:ring-1 focus-within:ring-ring/60',
        hasError
          ? 'border-destructive ring-1 ring-destructive/40 focus-within:ring-destructive/60'
          : 'border-input'
      )}
    >
      <Editor
        height={contentHeight}
        width="100%"
        language="mongo-shell"
        theme="mongobench-dark"
        value={value}
        onMount={handleMount}
        onChange={(v) => onChange(v ?? '')}
        loading={<div className="px-3 py-1.5 text-xs text-muted-foreground">Loading editor…</div>}
        options={{
          minimap: { enabled: false },
          lineNumbers: 'off',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
          padding: { top: 6, bottom: 6 },
          formatOnPaste: true,
          formatOnType: true,
          renderLineHighlight: 'none',
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: 6,
          lineNumbersMinChars: 0,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'hidden',
            verticalScrollbarSize: 6,
            alwaysConsumeMouseWheel: false
          },
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'smart',
          tabCompletion: 'on',
          autoClosingBrackets: 'always',
          autoClosingQuotes: 'always',
          autoSurround: 'languageDefined',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: false }
        }}
      />
      {isEmpty && placeholder && (
        <div className="pointer-events-none absolute inset-0 flex items-center px-3 font-mono text-xs text-muted-foreground/55">
          {placeholder}
        </div>
      )}
      {actions && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1">
          <div className="pointer-events-auto flex items-center gap-1">{actions}</div>
        </div>
      )}
    </div>
  )
}

let providerRegistered = false

// Distinct top-level keys from the most recently fetched documents. The
// completion provider reads this directly so it doesn't have to be
// re-registered on every fetch — refreshing the cache is enough.
let documentFieldNames: string[] = []

export function setDocumentFieldNames(names: Iterable<string>): void {
  documentFieldNames = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
}

function ensureProviderRegistered(): void {
  if (providerRegistered) return
  providerRegistered = true

  monaco.languages.registerCompletionItemProvider('mongo-shell', {
    triggerCharacters: ['$', '"', 'I', 'O', 'N', 'U', 'D', 'B', 'T', 'M', '{', ',', ' '],
    provideCompletionItems(model, position) {
      const lineUpToCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      })

      // Three trigger contexts:
      //  - `$foo` (optionally with leading `"`) → MongoDB query operator
      //  - bare identifier prefix → mongo shell helper (ObjectId, ISODate, …)
      //  - after `{` or `,` (object key position) → cached document field names
      const opMatch = /"?\$[A-Za-z]*$/.exec(lineUpToCursor)
      const helperMatch = /(?:^|[\s:,[(])([A-Za-z][A-Za-z0-9]*)$/.exec(lineUpToCursor)
      const helperPrefix = helperMatch ? helperMatch[1]! : null
      const keyMatch = /(?:^|[{,])\s*("?)([A-Za-z_$][\w.]*)?$/.exec(lineUpToCursor)

      if (opMatch) {
        const range = new monaco.Range(
          position.lineNumber,
          position.column - opMatch[0].length,
          position.lineNumber,
          position.column
        )
        const suggestions = buildMongoCompletions().map((c): monaco.languages.CompletionItem => ({
          label: c.label,
          kind: c.kind ?? monaco.languages.CompletionItemKind.Keyword,
          insertText: c.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: c.doc },
          detail: c.detail,
          range,
          sortText: c.sortText ?? c.label
        }))
        return { suggestions }
      }

      const suggestions: monaco.languages.CompletionItem[] = []

      if (keyMatch && documentFieldNames.length > 0) {
        const hasQuote = keyMatch[1] === '"'
        const partial = keyMatch[2] ?? ''
        const startCol = position.column - partial.length - (hasQuote ? 1 : 0)
        const range = new monaco.Range(
          position.lineNumber,
          startCol,
          position.lineNumber,
          position.column
        )
        for (const name of documentFieldNames) {
          suggestions.push({
            label: name,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: `"${name}"`,
            filterText: name,
            detail: 'Document field',
            range,
            // Prefix '0' so field names sort above operators / helpers when
            // both contexts overlap (e.g. user typed a bare letter).
            sortText: `0_${name}`
          })
        }
      }

      if (helperPrefix) {
        const range = new monaco.Range(
          position.lineNumber,
          position.column - helperPrefix.length,
          position.lineNumber,
          position.column
        )
        for (const c of buildShellHelpers()) {
          suggestions.push({
            label: c.label,
            kind: c.kind ?? monaco.languages.CompletionItemKind.Keyword,
            insertText: c.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: c.doc },
            detail: c.detail,
            range,
            sortText: c.sortText ?? c.label
          })
        }
      }

      return { suggestions }
    }
  })
}

type CompletionDef = {
  label: string
  insertText: string
  doc: string
  detail: string
  kind?: monaco.languages.CompletionItemKind
  sortText?: string
}

// Always wraps in `"…"` to produce valid JSON keys regardless of whether
// the user already typed an opening quote (range covers the leading `"`).
const op = (
  label: string,
  insertText: string,
  doc: string,
  detail = 'MongoDB query operator'
): CompletionDef => ({
  label,
  insertText: `"${insertText}"`.replace(/^""/, '"'),
  doc,
  detail,
  kind: monaco.languages.CompletionItemKind.Function
})

// Comparison
const COMPARISON: CompletionDef[] = [
  op('$eq', '$eq": ${1:value}', 'Matches values equal to a specified value.'),
  op('$ne', '$ne": ${1:value}', 'Matches values not equal to a specified value.'),
  op('$gt', '$gt": ${1:value}', 'Matches values greater than a specified value.'),
  op('$gte', '$gte": ${1:value}', 'Matches values greater than or equal to a specified value.'),
  op('$lt', '$lt": ${1:value}', 'Matches values less than a specified value.'),
  op('$lte', '$lte": ${1:value}', 'Matches values less than or equal to a specified value.'),
  op('$in', '$in": [${1:values}]', 'Matches any of the values in the array.'),
  op('$nin', '$nin": [${1:values}]', 'Matches none of the values in the array.')
]

// Logical
const LOGICAL: CompletionDef[] = [
  op('$and', '$and": [\n\t{ $0 }\n]', 'Joins clauses with logical AND.'),
  op('$or', '$or": [\n\t{ $0 }\n]', 'Joins clauses with logical OR.'),
  op('$nor', '$nor": [\n\t{ $0 }\n]', 'Joins clauses with logical NOR.'),
  op('$not', '$not": { $0 }', 'Inverts the effect of an expression.')
]

// Element
const ELEMENT: CompletionDef[] = [
  op('$exists', '$exists": ${1|true,false|}', 'Matches documents that have or lack the field.'),
  op(
    '$type',
    '$type": "${1|double,string,object,array,binData,objectId,bool,date,null,regex,int,timestamp,long,decimal,minKey,maxKey|}"',
    'Matches documents whose field is one of the BSON types.'
  )
]

// Evaluation
const EVALUATION: CompletionDef[] = [
  op('$expr', '$expr": { $0 }', 'Allows the use of aggregation expressions inside the query.'),
  op('$jsonSchema', '$jsonSchema": { $0 }', 'Validates documents against a JSON Schema.'),
  op('$mod', '$mod": [${1:divisor}, ${2:remainder}]', 'Performs a modulo operation.'),
  op('$regex', '$regex": "${1:pattern}", "$options": "${2:i}"', 'Pattern match against a regex.'),
  op('$options', '$options": "${1:i}"', 'Regex options: i (case-insensitive), m, x, s.'),
  op('$text', '$text": { "$search": "${1:query}" }', 'Performs a text search.'),
  op('$search', '$search": "${1:query}"', 'Search string for a $text query.'),
  op('$language', '$language": "${1:english}"', 'Language to use for the text search.'),
  op('$caseSensitive', '$caseSensitive": ${1|true,false|}', 'Case-sensitive text search.'),
  op(
    '$diacriticSensitive',
    '$diacriticSensitive": ${1|true,false|}',
    'Diacritic-sensitive text search.'
  ),
  op(
    '$where',
    '$where": "${1:function() { return true; }}"',
    'Server-side JavaScript predicate (slow!).'
  )
]

// Array
const ARRAY_OPS: CompletionDef[] = [
  op('$all', '$all": [${1:values}]', 'Matches arrays containing all the specified elements.'),
  op(
    '$elemMatch',
    '$elemMatch": { $0 }',
    'Matches arrays with at least one element matching all criteria.'
  ),
  op('$size', '$size": ${1:n}', 'Matches arrays of the given length.')
]

// Bitwise
const BITWISE: CompletionDef[] = [
  op('$bitsAllClear', '$bitsAllClear": ${1:mask}', 'All bits in the mask are clear (0).'),
  op('$bitsAllSet', '$bitsAllSet": ${1:mask}', 'All bits in the mask are set (1).'),
  op('$bitsAnyClear', '$bitsAnyClear": ${1:mask}', 'Any bit in the mask is clear.'),
  op('$bitsAnySet', '$bitsAnySet": ${1:mask}', 'Any bit in the mask is set.')
]

// Geospatial
const GEO: CompletionDef[] = [
  op(
    '$geoIntersects',
    '$geoIntersects": { "$geometry": { "type": "${1:Point}", "coordinates": [${2:0}, ${3:0}] } }',
    'Selects geometries that intersect with a GeoJSON geometry.'
  ),
  op(
    '$geoWithin',
    '$geoWithin": { "$geometry": { "type": "${1:Polygon}", "coordinates": $2 } }',
    'Selects geometries within a bounding GeoJSON geometry.'
  ),
  op(
    '$near',
    '$near": { "$geometry": { "type": "Point", "coordinates": [${1:lng}, ${2:lat}] }, "$maxDistance": ${3:meters} }',
    'Returns docs ordered by proximity to a point.'
  ),
  op(
    '$nearSphere',
    '$nearSphere": { "$geometry": { "type": "Point", "coordinates": [${1:lng}, ${2:lat}] }, "$maxDistance": ${3:meters} }',
    'Like $near but uses spherical geometry.'
  ),
  op(
    '$geometry',
    '$geometry": { "type": "${1:Point}", "coordinates": ${2} }',
    'GeoJSON geometry helper.'
  ),
  op('$maxDistance', '$maxDistance": ${1:meters}', 'Max distance (meters) from $near point.'),
  op('$minDistance', '$minDistance": ${1:meters}', 'Min distance (meters) from $near point.'),
  op(
    '$box',
    '$box": [[${1:lngLow}, ${2:latLow}], [${3:lngHigh}, ${4:latHigh}]]',
    'Legacy bounding box for $geoWithin.'
  ),
  op(
    '$center',
    '$center": [[${1:lng}, ${2:lat}], ${3:radius}]',
    'Legacy circle (flat) for $geoWithin.'
  ),
  op(
    '$centerSphere',
    '$centerSphere": [[${1:lng}, ${2:lat}], ${3:radians}]',
    'Spherical circle for $geoWithin.'
  ),
  op(
    '$polygon',
    '$polygon": [[${1:lng1}, ${2:lat1}], [${3:lng2}, ${4:lat2}], [${5:lng3}, ${6:lat3}]]',
    'Legacy polygon for $geoWithin.'
  )
]

// Projection / cursor modifiers (used in projection field, but also valid in find spec)
const PROJECTION: CompletionDef[] = [
  op('$slice', '$slice": ${1:n}', 'Limit array elements in projection.', 'Projection operator'),
  op('$meta', '$meta": "${1|textScore,indexKey|}"', 'Project metadata.', 'Projection operator')
]

// EJSON wrappers — for value position (BSON types)
function buildEjsonWrappers(): CompletionDef[] {
  const nowIso = new Date().toISOString()
  const nowSec = Math.floor(Date.now() / 1000)
  return [
    op(
      '$oid',
      '$oid": "${1:507f1f77bcf86cd799439011}"',
      'EJSON: ObjectId wrapper.',
      'EJSON / BSON type'
    ),
    op(
      '$date',
      `$date": "\${1:${nowIso}}"`,
      'EJSON: Date wrapper (ISO-8601 string or { "$numberLong": "ms" }).',
      'EJSON / BSON type'
    ),
    op('$numberLong', '$numberLong": "${1:0}"', 'EJSON: 64-bit integer.', 'EJSON / BSON type'),
    op('$numberInt', '$numberInt": "${1:0}"', 'EJSON: 32-bit integer.', 'EJSON / BSON type'),
    op('$numberDouble', '$numberDouble": "${1:0.0}"', 'EJSON: 64-bit float.', 'EJSON / BSON type'),
    op(
      '$numberDecimal',
      '$numberDecimal": "${1:0}"',
      'EJSON: 128-bit decimal.',
      'EJSON / BSON type'
    ),
    op(
      '$binary',
      '$binary": { "base64": "${1:}", "subType": "${2:00}" }',
      'EJSON: BSON binary.',
      'EJSON / BSON type'
    ),
    op(
      '$timestamp',
      `$timestamp": { "t": \${1:${nowSec}}, "i": \${2:0} }`,
      'EJSON: BSON timestamp (replication).',
      'EJSON / BSON type'
    ),
    op(
      '$uuid',
      '$uuid": "${1:00000000-0000-0000-0000-000000000000}"',
      'EJSON: UUID (BSON binary subType 4).',
      'EJSON / BSON type'
    ),
    op(
      '$regularExpression',
      '$regularExpression": { "pattern": "${1:}", "options": "${2:i}" }',
      'EJSON: BSON regex (canonical).',
      'EJSON / BSON type'
    ),
    op('$symbol', '$symbol": "${1:}"', 'EJSON: deprecated BSON symbol.', 'EJSON / BSON type'),
    op('$code', '$code": "${1:function() {}}"', 'EJSON: BSON Code.', 'EJSON / BSON type'),
    op('$minKey', '$minKey": 1', 'EJSON: BSON MinKey marker.', 'EJSON / BSON type'),
    op('$maxKey', '$maxKey": 1', 'EJSON: BSON MaxKey marker.', 'EJSON / BSON type'),
    op('$undefined', '$undefined": true', 'EJSON: deprecated BSON Undefined.', 'EJSON / BSON type')
  ]
}

function buildMongoCompletions(): CompletionDef[] {
  return [
    ...COMPARISON,
    ...LOGICAL,
    ...ELEMENT,
    ...EVALUATION,
    ...ARRAY_OPS,
    ...BITWISE,
    ...GEO,
    ...PROJECTION,
    ...buildEjsonWrappers()
  ]
}

// Shell helpers — bare identifiers the user types in value position.
// The mongoQueryLang parser rewrites these into EJSON wrappers before the
// query is sent to the backend, so suggesting them as snippets is safe.
const helper = (
  label: string,
  insertText: string,
  doc: string,
  detail = 'mongo shell helper'
): CompletionDef => ({
  label,
  insertText,
  doc,
  detail,
  kind: monaco.languages.CompletionItemKind.Constructor
})

function buildShellHelpers(): CompletionDef[] {
  const nowIso = new Date().toISOString()
  const nowSec = Math.floor(Date.now() / 1000)
  return [
    helper('ObjectId', 'ObjectId("${1:507f1f77bcf86cd799439011}")', 'ObjectId hex literal.'),
    helper('ISODate', `ISODate("\${1:${nowIso}}")`, 'ISO-8601 date — defaults to now.'),
    helper('Date', `Date("\${1:${nowIso}}")`, 'Same as ISODate — defaults to now.'),
    helper('NumberLong', 'NumberLong("${1:0}")', 'BSON 64-bit integer.'),
    helper('NumberInt', 'NumberInt(${1:0})', 'BSON 32-bit integer.'),
    helper('NumberDecimal', 'NumberDecimal("${1:0}")', 'BSON 128-bit decimal.'),
    helper(
      'UUID',
      'UUID("${1:00000000-0000-0000-0000-000000000000}")',
      'UUID literal (BSON subType 04).'
    ),
    helper(
      'JUUID',
      'JUUID("${1:00000000-0000-0000-0000-000000000000}")',
      'Legacy Java-driver UUID (BSON subType 03, Java byte order).'
    ),
    helper('BinData', 'BinData(${1:0}, "${2:base64==}")', 'Binary data with subType.'),
    helper('Timestamp', `Timestamp(\${1:${nowSec}}, \${2:0})`, 'BSON timestamp (replication).'),
    helper('MinKey', 'MinKey', 'Sorts before any other BSON value.'),
    helper('MaxKey', 'MaxKey', 'Sorts after any other BSON value.'),
    helper('DBRef', 'DBRef("${1:coll}", ${2:id})', 'Document reference.'),
    helper('Code', 'Code("${1:function() {}}")', 'BSON Code value.'),
    helper(
      'RegExp',
      'RegExp("${1:pattern}", "${2:i}")',
      'Regex; equivalent to a /pattern/flags literal.'
    ),
    helper('true', 'true', 'Boolean true.', 'literal'),
    helper('false', 'false', 'Boolean false.', 'literal'),
    helper('null', 'null', 'Null value.', 'literal'),
    helper('undefined', 'undefined', 'BSON Undefined (deprecated).', 'literal')
  ]
}
