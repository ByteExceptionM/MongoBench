import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api'
import { parseMongoDocuments, parseMongoQuery } from '@/lib/mongoQueryLang'
import { serializeMongoValue } from '@/lib/mongoQuerySerialize'
import type { DocumentEnvelope, UuidEncoding } from '@shared/types'

export type EditorMode = 'view' | 'edit' | 'duplicate' | 'insert'

type Props = {
  mode: EditorMode | null
  /** Required for view / edit / duplicate. Ignored for insert. */
  envelope: DocumentEnvelope | null
  connectionId: string
  db: string
  coll: string
  uuidEncoding: UuidEncoding
  /** IANA zone for ISODate display. Saves convert back to UTC ms. */
  timezone: string
  onClose: () => void
}

const TITLES: Record<EditorMode, string> = {
  view: 'View document',
  edit: 'Edit document',
  duplicate: 'Duplicate document',
  insert: 'Insert documents'
}

const DESCRIPTIONS: Record<EditorMode, string> = {
  view: 'Read-only — BSON types render as ObjectId / ISODate / UUID / NumberLong / NumberDecimal.',
  edit: 'Edit using mongo shell syntax — ObjectId("…"), ISODate("…"), NumberLong("…"), UUID/JUUID, regex literals.',
  duplicate: 'A copy with the original _id removed. Save inserts a new document with a fresh _id.',
  insert:
    'Multiple documents, one after another newline, comma-separated or JSON array. Leave _id out for a fresh ObjectId.'
}

const INSERT_TEMPLATE = '{\n  \n}'

/**
 * Read the canonical EJSON document carried by an envelope, then re-render
 * it as MongoDB-shell-syntax text. Falls back to the relaxed `data` view
 * if the envelope predates M3 (no canonical string set).
 */
function shellRenderOf(
  envelope: DocumentEnvelope,
  uuidEncoding: UuidEncoding,
  timezone: string
): string {
  const source =
    envelope.canonical && envelope.canonical.length > 0
      ? safeJsonParse(envelope.canonical)
      : envelope.data
  return serializeMongoValue(source, { uuidEncoding, timezone, indent: 2 })
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function stripIdShell(input: string, uuidEncoding: UuidEncoding, timezone: string): string {
  const parsed = parseMongoQuery(input)
  if (!parsed.ok) return input
  const value = parsed.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return input
  const obj = value as Record<string, unknown>
  if (!('_id' in obj)) return input
  const { _id: _omit, ...rest } = obj
  return serializeMongoValue(rest, { uuidEncoding, timezone, indent: 2 })
}

export function DocumentEditorDialog({
  mode,
  envelope,
  connectionId,
  db,
  coll,
  uuidEncoding,
  timezone,
  onClose
}: Props) {
  const open = mode !== null && (mode === 'insert' || envelope !== null)
  const [value, setValue] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!mode) return
    setServerError(null)
    if (mode === 'insert') {
      setValue(INSERT_TEMPLATE)
      return
    }
    if (!envelope) return
    const rendered = shellRenderOf(envelope, uuidEncoding, timezone)
    setValue(mode === 'duplicate' ? stripIdShell(rendered, uuidEncoding, timezone) : rendered)
  }, [envelope, mode, uuidEncoding, timezone])

  const compiled = useMemo<
    { ok: true; ejson: string; documents: string[] } | { ok: false; error: string }
  >(() => {
    if (mode === 'view' || mode === null) return { ok: true, ejson: '', documents: [] }
    if (mode === 'insert') {
      const parsed = parseMongoDocuments(value)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      if (parsed.documents.length === 0) return { ok: false, error: 'Enter at least one document' }
      return { ok: true, ejson: '', documents: parsed.documents }
    }
    const parsed = parseMongoQuery(value)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return { ok: false, error: 'Document must be an object' }
    }
    return { ok: true, ejson: parsed.ejson, documents: [] }
  }, [value, mode])

  const manyCount = compiled.ok ? compiled.documents.length : 0

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!mode) throw new Error('No editor mode')
      if (!compiled.ok) throw new Error(compiled.error)
      if (mode === 'edit') {
        if (!envelope) throw new Error('No document loaded')
        return api.query.replaceOne({
          connectionId,
          db,
          coll,
          id: envelope.id,
          expectedHash: envelope.hash,
          replacement: compiled.ejson
        })
      }
      if (mode === 'insert') {
        return api.query.insertMany({ connectionId, db, coll, documents: compiled.documents })
      }
      if (mode === 'duplicate') {
        return api.query.insertOne({ connectionId, db, coll, document: compiled.ejson })
      }
      throw new Error('Cannot save in view mode')
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['find'] })
      void queryClient.invalidateQueries({ queryKey: ['count'] })
      const successMessage =
        mode === 'edit'
          ? 'Document updated'
          : mode === 'duplicate'
            ? 'Document duplicated'
            : `Inserted ${manyCount} document${manyCount === 1 ? '' : 's'}`
      toast.success(successMessage)
      onClose()
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      setServerError(message)
    }
  })

  const handleOpenChange = (next: boolean) => {
    if (!next && !saveMutation.isPending) onClose()
  }

  if (!mode) return null

  // Insert needs neither envelope nor _id; the others can't render without one.
  if (mode !== 'insert' && !envelope) return null

  const parseError = compiled.ok ? null : compiled.error
  const isReadOnly = mode === 'view'
  const ctaLabel =
    mode === 'edit'
      ? 'Save changes'
      : mode === 'duplicate'
        ? 'Insert duplicate'
        : manyCount > 0
          ? `Insert ${manyCount} document${manyCount === 1 ? '' : 's'}`
          : 'Insert documents'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[92vh] w-[95vw] max-w-[1400px] flex-col gap-4 sm:!max-w-[1400px]">
        <DialogHeader>
          <DialogTitle>{TITLES[mode]}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">
              {db}.{coll}
            </span>
            {' — '}
            {DESCRIPTIONS[mode]}
            {timezone !== 'UTC' && (
              <>
                {' '}
                <span className="text-muted-foreground/80">
                  Dates show in <span className="font-mono text-foreground">{timezone}</span> and
                  save back as UTC.
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div
          className={
            'min-h-0 flex-1 overflow-hidden rounded-md border ' +
            (parseError ? 'border-destructive ring-1 ring-destructive/40' : '')
          }
        >
          <Editor
            key={mode === 'insert' ? 'insert' : `${envelope?.id}::${mode}`}
            height="100%"
            width="100%"
            value={value}
            language="mongo-shell"
            theme="mongobench-dark"
            loading={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Loading editor…
              </div>
            }
            onChange={(v) => setValue(v ?? '')}
            options={{
              readOnly: isReadOnly,
              domReadOnly: isReadOnly,
              minimap: { enabled: false },
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              renderLineHighlight: 'gutter',
              padding: { top: 8, bottom: 8 },
              autoClosingBrackets: 'always',
              autoClosingQuotes: 'always',
              bracketPairColorization: { enabled: true }
            }}
          />
        </div>

        {(parseError || serverError) && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {serverError ?? parseError}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            {isReadOnly ? 'Close' : 'Cancel'}
          </Button>
          {!isReadOnly && (
            <Button
              disabled={parseError !== null || saveMutation.isPending}
              onClick={() => {
                setServerError(null)
                saveMutation.mutate()
              }}
            >
              {saveMutation.isPending && <Loader2 className="animate-spin" />}
              {ctaLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
