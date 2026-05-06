import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Copy, Eye, FilePlus2, Link2, Loader2, Minus, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { queryKeys } from '@/lib/queryClient'
import { useTabsStore } from '@/store/tabs'
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
const COL_MIN_WIDTH = 72
const COL_SOFT_MAX_WIDTH = 320
const CHECKBOX_COL_WIDTH = 36
/** Approx. width of one monospace character at `text-xs` (12px). */
const CHAR_WIDTH_PX = 7
/** Cell padding + kind-label badge + spacer between badge and value. */
const VALUE_CELL_OVERHEAD = 65
/** Header padding + room for the resize handle. */
const HEADER_OVERHEAD = 28

type RowMenuState = {
  mode: EditorMode | null
  envelope: DocumentEnvelope | null
}

type PendingDelete =
  | { kind: 'one'; envelope: DocumentEnvelope }
  | { kind: 'many'; ids: string[] }
  | null

export function DocumentTable({
  documents,
  connectionId,
  db,
  coll,
  uuidEncoding,
  timezone
}: {
  documents: DocumentEnvelope[]
  connectionId: string
  db: string
  coll: string
  uuidEncoding: UuidEncoding
  timezone: string
}) {
  const columns = useMemo(() => extractColumns(documents), [documents])
  const [editorState, setEditorState] = useState<RowMenuState>({ mode: null, envelope: null })
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [activeLookup, setActiveLookup] = useState<{ docId: string; ref: ExtractedRef } | null>(
    null
  )
  const lastClickedIdRef = useRef<string | null>(null)
  const openTab = useTabsStore((s) => s.open)

  const collectionsQuery = useQuery({
    queryKey: queryKeys.collections(connectionId, db),
    queryFn: () => api.collections.list({ connectionId, db }),
    enabled: activeLookup?.ref.kind === 'oid'
  })

  /** User-set widths; auto-estimated widths fill in for the rest. */
  const [userColumnWidths, setUserColumnWidths] = useState<Record<string, number>>({})

  // Reset manual widths when the *coll* changes — different schema means
  // different "natural" widths. Filter/sort within the same coll keeps them.
  useEffect(() => {
    setUserColumnWidths({})
  }, [connectionId, db, coll])

  const autoColumnWidths = useMemo(() => {
    const widths: Record<string, number> = {}
    for (const col of columns) {
      let longestValue = 1
      for (const doc of documents) {
        if (!(col in doc.data)) continue
        const inspected = inspectBson(doc.data[col], { uuidEncoding, timezone })
        const visible = Math.min(inspected.display.length, MAX_CELL_CHARS + 1)
        if (visible > longestValue) longestValue = visible
      }
      const valueW = longestValue * CHAR_WIDTH_PX + VALUE_CELL_OVERHEAD
      const headerW = col.length * CHAR_WIDTH_PX + HEADER_OVERHEAD
      const natural = Math.max(valueW, headerW)
      widths[col] = Math.max(COL_MIN_WIDTH, Math.min(COL_SOFT_MAX_WIDTH, natural))
    }
    return widths
  }, [columns, documents, uuidEncoding, timezone])

  const getColWidth = (col: string): number =>
    userColumnWidths[col] ?? autoColumnWidths[col] ?? COL_MIN_WIDTH

  const startColumnResize = (col: string, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = getColWidth(col)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      const delta = ev.clientX - startX
      const next = Math.max(COL_MIN_WIDTH, startWidth + delta)
      setUserColumnWidths((prev) => ({ ...prev, [col]: next }))
    }
    const onUp = (): void => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const queryClient = useQueryClient()

  // Drop selections that no longer correspond to any visible document
  // (e.g. after a query change or pagination).
  useEffect(() => {
    const visible = new Set(documents.map((d) => d.id))
    setSelected((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (visible.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [documents])

  const deleteOneMutation = useMutation({
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

  const deleteManyMutation = useMutation({
    mutationFn: (ids: string[]) => api.query.deleteMany({ connectionId, db, coll, ids }),
    onSuccess: (result) => {
      toast.success(
        `Deleted ${result.deletedCount} document${result.deletedCount === 1 ? '' : 's'}`
      )
      void queryClient.invalidateQueries({ queryKey: ['find'] })
      void queryClient.invalidateQueries({ queryKey: ['count'] })
      setSelected(new Set())
      setPendingDelete(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Bulk delete failed: ${message}`)
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

  /**
   * All checkbox interactions go through this single onClick handler.
   *
   * `preventDefault()` is unconditionally called so the native input
   * toggle never runs — selection state is driven entirely from React.
   * Mixing `preventDefault` on the click *and* an `onChange` toggler
   * was racy: the controlled `checked` prop sometimes still fired
   * `onChange`, which then *reverted* the selection we'd just applied
   * (the user saw "selected, then immediately deselected").
   */
  /**
   * Apply a range select/deselect from `lastClickedIdRef` to `id`.
   * The target state matches what a plain click on `id` would do:
   *   - clicking an unselected box → range becomes selected
   *   - clicking a selected box   → range becomes deselected
   *
   * Returns true when a range was applied, false when there's no anchor
   * yet so the caller should fall back to a single toggle.
   */
  const applyRangeFromAnchor = (id: string): boolean => {
    if (lastClickedIdRef.current === null || lastClickedIdRef.current === id) return false
    const indices = documents.map((d) => d.id)
    const a = indices.indexOf(lastClickedIdRef.current)
    const b = indices.indexOf(id)
    if (a === -1 || b === -1) return false
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const targetSelected = !selected.has(id)
    setSelected((prev) => {
      const next = new Set(prev)
      for (let i = lo; i <= hi; i++) {
        const docId = indices[i]!
        if (targetSelected) next.add(docId)
        else next.delete(docId)
      }
      return next
    })
    lastClickedIdRef.current = id
    return true
  }

  const handleRowCheckboxClick = (id: string, event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey && applyRangeFromAnchor(id)) return
    toggleSingle(id)
  }

  const toggleSingle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastClickedIdRef.current = id
  }

  /**
   * Row-body click — implements the standard file-explorer modifier rules
   * so Ctrl/Cmd-click and Shift-click work even outside the checkbox cell.
   * Plain click is intentionally a no-op so the user doesn't accidentally
   * lose their selection by clicking somewhere to read a value.
   */
  const handleRowClick = (id: string, event: React.MouseEvent<HTMLElement>) => {
    const ctrlOrCmd = event.ctrlKey || event.metaKey
    if (event.shiftKey) {
      event.preventDefault()
      // Drop any text-selection range so the row stays readable.
      window.getSelection()?.removeAllRanges()
      if (!applyRangeFromAnchor(id)) toggleSingle(id)
      return
    }
    if (ctrlOrCmd) {
      event.preventDefault()
      window.getSelection()?.removeAllRanges()
      toggleSingle(id)
    }
    // No modifier: leave selection alone (user is just reading a cell).
  }

  const allVisibleSelected = documents.length > 0 && documents.every((d) => selected.has(d.id))
  const someVisibleSelected = !allVisibleSelected && documents.some((d) => selected.has(d.id))
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        for (const d of documents) next.delete(d.id)
        return next
      }
      const next = new Set(prev)
      for (const d of documents) next.add(d.id)
      return next
    })
    lastClickedIdRef.current = null
  }

  const clearSelection = () => {
    setSelected(new Set())
    lastClickedIdRef.current = null
  }

  if (documents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No documents match the current filter.
      </div>
    )
  }

  const selectionCount = selected.size

  return (
    <>
      <div className="flex h-full flex-col">
        {selectionCount > 0 && (
          <SelectionBar
            count={selectionCount}
            onClear={clearSelection}
            onDelete={() => setPendingDelete({ kind: 'many', ids: Array.from(selected) })}
          />
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          <table
            className="border-separate border-spacing-0 font-mono text-xs"
            style={{ tableLayout: 'fixed' }}
          >
            <colgroup>
              <col style={{ width: CHECKBOX_COL_WIDTH }} />
              {columns.map((col) => (
                <col key={col} style={{ width: getColWidth(col) }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
              <tr>
                <th className="border-b border-r border-border/60 px-2 py-2 text-center">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected}
                    onClick={() => toggleSelectAllVisible()}
                    aria-label={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                  />
                </th>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="relative border-b border-r border-border/60 px-3 py-2 text-left font-medium text-muted-foreground"
                  >
                    <span className="block truncate" title={col}>
                      {col}
                    </span>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      onMouseDown={(e) => startColumnResize(col, e)}
                      onDoubleClick={() =>
                        // Double-click resets to the auto-estimated width.
                        setUserColumnWidths((prev) => {
                          if (!(col in prev)) return prev
                          const { [col]: _drop, ...rest } = prev
                          return rest
                        })
                      }
                      className="group absolute right-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize"
                      title="Drag to resize · double-click to auto-fit"
                    >
                      <div className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-primary/60 group-active:bg-primary" />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const isSelected = selected.has(doc.id)
                const lookupRef = activeLookup?.docId === doc.id ? activeLookup.ref : null
                return (
                  <ContextMenu
                    key={doc.id}
                    onOpenChange={(open) => {
                      if (!open && activeLookup?.docId === doc.id) setActiveLookup(null)
                    }}
                  >
                    <ContextMenuTrigger asChild>
                      <tr
                        onClick={(e) => handleRowClick(doc.id, e)}
                        onMouseDown={(e) => {
                          // Prevent native text-selection range expansion when the
                          // user shift-clicks across rows.
                          if (e.shiftKey) e.preventDefault()
                        }}
                        className={cn(
                          'select-none data-[state=open]:bg-accent/40',
                          isSelected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-accent/30'
                        )}
                      >
                        <td
                          className="w-9 border-b border-r border-border/30 px-2 py-1.5 text-center align-middle"
                          onClick={(e) => e.stopPropagation()}
                          onContextMenu={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected}
                            onClick={(e) => handleRowCheckboxClick(doc.id, e)}
                            aria-label={isSelected ? 'Deselect document' : 'Select document'}
                          />
                        </td>
                        {columns.map((col) => (
                          <Cell
                            key={col}
                            value={doc.data[col]}
                            present={col in doc.data}
                            uuidEncoding={uuidEncoding}
                            timezone={timezone}
                            onContextMenu={() => {
                              const ref = col === '_id' ? null : extractRef(doc.data[col])
                              if (ref) setActiveLookup({ docId: doc.id, ref })
                              else setActiveLookup(null)
                            }}
                          />
                        ))}
                      </tr>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {lookupRef?.kind === 'dbref' && (
                        <>
                          <ContextMenuItem
                            onSelect={() =>
                              openTab({
                                connectionId,
                                db: lookupRef.db ?? db,
                                coll: lookupRef.ref,
                                filter: `{ _id: ObjectId("${lookupRef.oid}") }`
                              })
                            }
                          >
                            <Link2 className="h-4 w-4" />
                            <span className="truncate">
                              Open referenced doc in{' '}
                              <span className="font-mono">
                                {lookupRef.db ? `${lookupRef.db}.` : ''}
                                {lookupRef.ref}
                              </span>
                            </span>
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                        </>
                      )}
                      {lookupRef?.kind === 'oid' && (
                        <>
                          <ContextMenuSub>
                            <ContextMenuSubTrigger className="gap-2">
                              <Link2 className="h-4 w-4" />
                              Lookup ObjectId in…
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent className="max-h-72 overflow-y-auto">
                              {collectionsQuery.isLoading && (
                                <ContextMenuItem disabled>
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Loading…
                                </ContextMenuItem>
                              )}
                              {(() => {
                                const others = (collectionsQuery.data ?? []).filter(
                                  (c) => c.name !== coll
                                )
                                if (collectionsQuery.isLoading) return null
                                if (others.length === 0) {
                                  return (
                                    <ContextMenuItem disabled>No other collections</ContextMenuItem>
                                  )
                                }
                                return others.map((c) => (
                                  <ContextMenuItem
                                    key={c.name}
                                    onSelect={() =>
                                      openTab({
                                        connectionId,
                                        db,
                                        coll: c.name,
                                        filter: `{ _id: ObjectId("${lookupRef.oid}") }`
                                      })
                                    }
                                  >
                                    <span className="truncate font-mono text-xs">{c.name}</span>
                                  </ContextMenuItem>
                                ))
                              })()}
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                          <ContextMenuSeparator />
                        </>
                      )}
                      <ContextMenuItem
                        onSelect={() => setEditorState({ mode: 'view', envelope: doc })}
                      >
                        <Eye className="h-4 w-4" />
                        View
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => setEditorState({ mode: 'edit', envelope: doc })}
                      >
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
                        onSelect={() => setPendingDelete({ kind: 'one', envelope: doc })}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocumentEditorDialog
        mode={editorState.mode}
        envelope={editorState.envelope}
        connectionId={connectionId}
        db={db}
        coll={coll}
        uuidEncoding={uuidEncoding}
        timezone={timezone}
        onClose={() => setEditorState({ mode: null, envelope: null })}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (open) return
          if (deleteOneMutation.isPending || deleteManyMutation.isPending) return
          setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          {pendingDelete?.kind === 'one' && (
            <>
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
                <AlertDialogCancel disabled={deleteOneMutation.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={deleteOneMutation.isPending}
                  onClick={(e) => {
                    e.preventDefault()
                    if (pendingDelete?.kind === 'one') {
                      deleteOneMutation.mutate(pendingDelete.envelope)
                    }
                  }}
                >
                  {deleteOneMutation.isPending && <Loader2 className="animate-spin" />}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}

          {pendingDelete?.kind === 'many' && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {pendingDelete.ids.length} document
                  {pendingDelete.ids.length === 1 ? '' : 's'}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  These documents will be permanently removed from{' '}
                  <span className="font-mono text-foreground">
                    {db}.{coll}
                  </span>
                  . This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteManyMutation.isPending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={deleteManyMutation.isPending}
                  onClick={(e) => {
                    e.preventDefault()
                    if (pendingDelete?.kind === 'many') {
                      deleteManyMutation.mutate(pendingDelete.ids)
                    }
                  }}
                >
                  {deleteManyMutation.isPending && <Loader2 className="animate-spin" />}
                  Delete {pendingDelete.ids.length}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SelectionBar({
  count,
  onClear,
  onDelete
}: {
  count: number
  onClear: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b bg-primary/10 px-4 text-xs">
      <div className="flex items-center gap-3">
        <span className="font-medium text-primary">
          {count} document{count === 1 ? '' : 's'} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="destructive" className="h-7 px-2" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete selected
        </Button>
      </div>
    </div>
  )
}

/**
 * Custom checkbox — implemented as a styled button instead of a native
 * `<input type="checkbox">`. The native checkbox has a built-in toggle on
 * click that fights React's controlled `checked` prop when we
 * `preventDefault` for shift-range selection: the visual state ends up
 * out of sync with React state ("selected, but no checkmark"). A button
 * has no default toggle, so React owns the visual state alone.
 */
function Checkbox({
  checked,
  indeterminate,
  onClick,
  'aria-label': ariaLabel
}: {
  checked: boolean
  indeterminate?: boolean
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  'aria-label'?: string
}) {
  const showMixed = !!indeterminate && !checked
  const filled = checked || showMixed
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={showMixed ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
        filled
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-transparent hover:border-primary/60'
      )}
    >
      {checked && !showMixed && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      {showMixed && <Minus className="h-2.5 w-2.5" strokeWidth={3} />}
    </button>
  )
}

function Cell({
  value,
  present,
  uuidEncoding,
  timezone,
  onContextMenu
}: {
  value: unknown
  present: boolean
  uuidEncoding: UuidEncoding
  timezone: string
  onContextMenu?: () => void
}) {
  if (!present) {
    return (
      <td
        className="select-none border-b border-r border-border/30 px-3 py-1.5 text-muted-foreground/40"
        onContextMenu={onContextMenu}
      >
        —
      </td>
    )
  }
  const inspected = inspectBson(value, { uuidEncoding, timezone })
  const truncated =
    inspected.display.length > MAX_CELL_CHARS
      ? `${inspected.display.slice(0, MAX_CELL_CHARS)}…`
      : inspected.display

  return (
    <td
      className="truncate border-b border-r border-border/30 px-3 py-1.5"
      title={inspected.display}
      onContextMenu={onContextMenu}
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

const OID_RE = /^[a-f0-9]{24}$/i

type ExtractedRef =
  | { kind: 'oid'; oid: string }
  | { kind: 'dbref'; ref: string; oid: string; db?: string }

/** Returns the hex string when `value` is an EJSON ObjectId, else null. */
function objectIdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const oid = (value as Record<string, unknown>)['$oid']
  if (typeof oid !== 'string' || !OID_RE.test(oid)) return null
  return oid
}

/**
 * Recognises a value the user can right-click to "jump to":
 *   - plain ObjectId — needs the user to pick a target collection
 *   - DBRef ({ $ref, $id, $db? }) where $id is an ObjectId — target collection
 *     is encoded in the value, so we can offer a one-click action
 *
 * Only ObjectId-keyed DBRefs are handled. DBRefs with non-OID `$id` (string,
 * number, etc.) are rare and deliberately skipped — building the right filter
 * for those would require type-aware quoting we don't need yet.
 */
function extractRef(value: unknown): ExtractedRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (typeof r['$ref'] === 'string' && r['$ref'].length > 0 && '$id' in r) {
    const innerOid = objectIdOf(r['$id'])
    if (innerOid === null) return null
    const dbref: { kind: 'dbref'; ref: string; oid: string; db?: string } = {
      kind: 'dbref',
      ref: r['$ref'],
      oid: innerOid
    }
    if (typeof r['$db'] === 'string' && r['$db'].length > 0) dbref.db = r['$db']
    return dbref
  }
  const oid = objectIdOf(value)
  return oid !== null ? { kind: 'oid', oid } : null
}

function prettyJson(canonical: string): string {
  try {
    return JSON.stringify(JSON.parse(canonical), null, 2)
  } catch {
    return canonical
  }
}
