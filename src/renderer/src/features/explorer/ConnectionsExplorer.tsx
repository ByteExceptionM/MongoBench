import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'
import iconUrl from '@icon.png'
import { Button } from '@/components/ui/button'
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
import { ConnectionFormDialog } from '@/features/connections/ConnectionFormDialog'
import { ConnectionGroup, type DragHandlers } from './ConnectionGroup'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { useAppStore } from '@/store'
import { useTabsStore } from '@/store/tabs'
import type { ConnectionConfig } from '@shared/types'

export function ConnectionsExplorer() {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ConnectionConfig | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<ConnectionConfig | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<{ id: string; pos: 'before' | 'after' } | null>(
    null
  )
  const markDisconnected = useAppStore((s) => s.markDisconnected)
  const closeTabsForConnection = useTabsStore((s) => s.closeForConnection)
  const queryClient = useQueryClient()

  const {
    data: connections,
    isLoading,
    error
  } = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.connections.delete(id),
    onSuccess: (_, id) => {
      markDisconnected(id)
      closeTabsForConnection(id)
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections })
      toast.success(`${pendingDelete?.name ?? 'Connection'} deleted`)
      setPendingDelete(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Delete failed: ${message}`)
      setPendingDelete(null)
    }
  })

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => api.connections.reorder(ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.connections })
      const previous = queryClient.getQueryData<ConnectionConfig[]>(queryKeys.connections)
      if (previous) {
        const map = new Map(previous.map((c) => [c.id, c]))
        const next = ids.map((id) => map.get(id)).filter((c): c is ConnectionConfig => !!c)
        queryClient.setQueryData(queryKeys.connections, next)
      }
      return { previous }
    },
    onError: (_e, _ids, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKeys.connections, ctx.previous)
      toast.error('Reorder failed')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections })
    }
  })

  const buildDragHandlers = (id: string): DragHandlers => ({
    onDragStart: (e) => {
      setDragId(id)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
    },
    onDragEnd: () => {
      setDragId(null)
      setDragOverIdx(null)
    },
    onDragOver: (e) => {
      if (!dragId || dragId === id) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const pos: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      setDragOverIdx({ id, pos })
    },
    onDragLeave: () => {
      // No-op; the next dragover sets the new target.
    },
    onDrop: (e) => {
      e.preventDefault()
      if (!dragId || !connections) return
      const fromIdx = connections.findIndex((c) => c.id === dragId)
      const overIdx = connections.findIndex((c) => c.id === id)
      if (fromIdx < 0 || overIdx < 0 || fromIdx === overIdx) {
        setDragId(null)
        setDragOverIdx(null)
        return
      }
      const ids = connections.map((c) => c.id)
      ids.splice(fromIdx, 1)
      const insertAt =
        dragOverIdx?.pos === 'after' ? (fromIdx < overIdx ? overIdx : overIdx + 1) : overIdx
      ids.splice(insertAt, 0, dragId)
      reorderMutation.mutate(ids)
      setDragId(null)
      setDragOverIdx(null)
    }
  })

  const openCreate = () => {
    setEditing(undefined)
    setFormOpen(true)
  }

  const openEdit = (conn: ConnectionConfig) => {
    setEditing(conn)
    setFormOpen(true)
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-card/40">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <img src={iconUrl} alt="MongoBench" className="h-5 w-5 rounded" />
          <span className="text-sm font-semibold tracking-tight">MongoBench</span>
        </div>
        <Button size="icon" variant="ghost" onClick={openCreate} aria-label="New connection">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        )}

        {error instanceof ApiError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error.message}
          </div>
        )}

        {connections && connections.length === 0 && !isLoading && (
          <div className="px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No connections yet.</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              Add your first connection
            </Button>
          </div>
        )}

        {connections?.map((conn) => (
          <ConnectionGroup
            key={conn.id}
            connection={conn}
            onEdit={() => openEdit(conn)}
            onRequestDelete={() => setPendingDelete(conn)}
            drag={buildDragHandlers(conn.id)}
            dropPosition={dragOverIdx?.id === conn.id ? dragOverIdx.pos : null}
          />
        ))}
      </div>

      <ConnectionFormDialog open={formOpen} onOpenChange={setFormOpen} connection={editing} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleteMutation.isPending && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{pendingDelete?.name}</span> will be
              removed. The MongoDB instance itself is not affected. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (pendingDelete) deleteMutation.mutate(pendingDelete.id)
              }}
            >
              {deleteMutation.isPending && <Loader2 className="animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}
