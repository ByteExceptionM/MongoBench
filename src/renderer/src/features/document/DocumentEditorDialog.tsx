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
import type { DocumentEnvelope } from '@shared/types'

export type EditorMode = 'view' | 'edit' | 'duplicate'

type Props = {
  mode: EditorMode | null
  envelope: DocumentEnvelope | null
  connectionId: string
  db: string
  coll: string
  onClose: () => void
}

const TITLES: Record<EditorMode, string> = {
  view: 'View document',
  edit: 'Edit document',
  duplicate: 'Duplicate document'
}

const DESCRIPTIONS: Record<EditorMode, string> = {
  view: 'Read-only canonical EJSON. Hover field values for full content.',
  edit: 'Canonical EJSON — every BSON type is wrapped to preserve precision on save.',
  duplicate:
    'Canonical EJSON of the original. The _id has been removed so a new one will be assigned on insert.'
}

function canonicalOf(envelope: DocumentEnvelope): string {
  if (typeof envelope.canonical === 'string' && envelope.canonical.length > 0) {
    return envelope.canonical
  }
  // Defensive fallback for envelopes from older main builds (pre-M3) where
  // `canonical` was not populated. Uses the relaxed `data` field; loses
  // strict EJSON type fidelity but is still readable.
  return JSON.stringify(envelope.data ?? {}, null, 2)
}

function stripId(canonical: string): string {
  try {
    const parsed = JSON.parse(canonical) as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(parsed, '_id')) {
      const { _id: _omit, ...rest } = parsed
      return JSON.stringify(rest, null, 2)
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return canonical
  }
}

function pretty(canonical: string): string {
  try {
    return JSON.stringify(JSON.parse(canonical), null, 2)
  } catch {
    return canonical
  }
}

export function DocumentEditorDialog({ mode, envelope, connectionId, db, coll, onClose }: Props) {
  const open = mode !== null && envelope !== null
  const [value, setValue] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!envelope || !mode) return
    const canonical = canonicalOf(envelope)
    setValue(mode === 'duplicate' ? stripId(canonical) : pretty(canonical))
    setParseError(null)
    setServerError(null)
  }, [envelope, mode])

  const validation = useMemo(() => {
    if (mode === 'view') return null
    try {
      const parsed = JSON.parse(value) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'Document must be a JSON object'
      }
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid JSON'
    }
  }, [value, mode])

  useEffect(() => setParseError(validation), [validation])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!envelope || !mode) throw new Error('No document loaded')
      if (mode === 'edit') {
        return api.query.replaceOne({
          connectionId,
          db,
          coll,
          id: envelope.id,
          expectedHash: envelope.hash,
          replacement: value
        })
      }
      if (mode === 'duplicate') {
        return api.query.insertOne({ connectionId, db, coll, document: value })
      }
      throw new Error('Cannot save in view mode')
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['find'] })
      void queryClient.invalidateQueries({ queryKey: ['count'] })
      toast.success(mode === 'duplicate' ? 'Document inserted' : 'Document updated')
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

  if (!mode || !envelope) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{TITLES[mode]}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">
              {db}.{coll}
            </span>
            {' — '}
            {DESCRIPTIONS[mode]}
          </DialogDescription>
        </DialogHeader>

        <div className="h-[55vh] overflow-hidden rounded-md border">
          <Editor
            key={`${envelope.id}::${mode}`}
            height="100%"
            width="100%"
            value={value}
            language="json"
            theme="mongobench-dark"
            loading={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Loading editor…
              </div>
            }
            onChange={(v) => setValue(v ?? '')}
            options={{
              readOnly: mode === 'view',
              domReadOnly: mode === 'view',
              minimap: { enabled: false },
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              renderLineHighlight: 'gutter',
              padding: { top: 8, bottom: 8 }
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
            {mode === 'view' ? 'Close' : 'Cancel'}
          </Button>
          {mode !== 'view' && (
            <Button
              disabled={parseError !== null || saveMutation.isPending}
              onClick={() => {
                setServerError(null)
                saveMutation.mutate()
              }}
            >
              {saveMutation.isPending && <Loader2 className="animate-spin" />}
              {mode === 'edit' ? 'Save changes' : 'Insert'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
