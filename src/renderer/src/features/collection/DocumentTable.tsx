import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Eye, FilePlus2, Loader2, Pencil, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { DocumentEditorDialog, type EditorMode } from '@/features/document/DocumentEditorDialog'
import { api, ApiError } from '@/lib/api'
import { extractColumns, inspectBson, kindBadgeClass, kindLabel } from '@/lib/bsonDisplay'
import { cn } from '@/lib/utils'
import type { DocumentEnvelope, UuidEncoding } from '@shared/types'

const MAX_CELL_CHARS = 80

type RowMenuState = {
  mode: EditorMode | null
  envelope: DocumentEnvelope | null
}

export function DocumentTable({
  documents,
  connectionId,
  db,
  coll,
  uuidEncoding
}: {
  documents: DocumentEnvelope[]
  connectionId: string
  db: string
  coll: string
  uuidEncoding: UuidEncoding
}) {
  const columns = useMemo(() => extractColumns(documents), [documents])
  const [editorState, setEditorState] = useState<RowMenuState>({ mode: null, envelope: null })
  const [pendingDelete, setPendingDelete] = useState<DocumentEnvelope | null>(null)
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: (env: DocumentEnvelope) =>
      api.query.deleteOne({
        connectionId,
        db,
        coll,
        id: env.id,
        expectedHash: env.hash
      }),
    onSuccess: (result) => {
      if (result.deletedCount > 0) {
        toast.success('Document deleted')
        void queryClient.invalidateQueries({ queryKey: ['find'] })
        void queryClient.invalidateQueries({ queryKey: ['count'] })
      } else {
        toast.warning('Document was already gone')
      }
      setPendingDelete(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Delete failed: ${message}`)
      setPendingDelete(null)
    }
  })

  const onCopy = async (env: DocumentEnvelope) => {
    const source =
      typeof env.canonical === 'string' && env.canonical.length > 0
        ? env.canonical
        : JSON.stringify(env.data ?? {})
    try {
      await navigator.clipboard.writeText(prettyJson(source))
      toast.success('Copied as canonical EJSON')
    } catch {
      toast.error('Clipboard write blocked')
    }
  }

  if (documents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No documents match the current filter.
      </div>
    )
  }

  return (
    <>
      <div className="h-full overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className="border-b border-r border-border/60 px-3 py-2 text-left font-medium text-muted-foreground"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <ContextMenu key={doc.id}>
                <ContextMenuTrigger asChild>
                  <tr className="hover:bg-accent/30 data-[state=open]:bg-accent/40">
                    {columns.map((col) => (
                      <Cell
                        key={col}
                        value={doc.data[col]}
                        present={col in doc.data}
                        uuidEncoding={uuidEncoding}
                      />
                    ))}
                  </tr>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => setEditorState({ mode: 'view', envelope: doc })}>
                    <Eye className="h-4 w-4" />
                    View
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => setEditorState({ mode: 'edit', envelope: doc })}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => setEditorState({ mode: 'duplicate', envelope: doc })}
                  >
                    <FilePlus2 className="h-4 w-4" />
                    Duplicate
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void onCopy(doc)}>
                    <Copy className="h-4 w-4" />
                    Copy
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    onSelect={() => setPendingDelete(doc)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </tbody>
        </table>
      </div>

      <DocumentEditorDialog
        mode={editorState.mode}
        envelope={editorState.envelope}
        connectionId={connectionId}
        db={db}
        coll={coll}
        onClose={() => setEditorState({ mode: null, envelope: null })}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleteMutation.isPending && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This document will be removed from{' '}
              <span className="font-mono text-foreground">
                {db}.{coll}
              </span>
              . This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (pendingDelete) deleteMutation.mutate(pendingDelete)
              }}
            >
              {deleteMutation.isPending && <Loader2 className="animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Cell({
  value,
  present,
  uuidEncoding
}: {
  value: unknown
  present: boolean
  uuidEncoding: UuidEncoding
}) {
  if (!present) {
    return (
      <td className="border-b border-r border-border/30 px-3 py-1.5 text-muted-foreground/40 select-none">
        —
      </td>
    )
  }
  const inspected = inspectBson(value, { uuidEncoding })
  const truncated =
    inspected.display.length > MAX_CELL_CHARS
      ? `${inspected.display.slice(0, MAX_CELL_CHARS)}…`
      : inspected.display

  return (
    <td
      className="max-w-[420px] truncate border-b border-r border-border/30 px-3 py-1.5"
      title={inspected.display}
    >
      <span
        contentEditable={false}
        className="mr-1.5 select-none rounded-sm bg-muted/60 px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground"
      >
        {kindLabel(inspected.kind)}
      </span>
      <span className={cn('select-text truncate', kindBadgeClass(inspected.kind))}>
        {truncated}
      </span>
    </td>
  )
}

function prettyJson(canonical: string): string {
  try {
    return JSON.stringify(JSON.parse(canonical), null, 2)
  } catch {
    return canonical
  }
}
