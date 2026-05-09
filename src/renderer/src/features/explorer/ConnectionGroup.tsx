import { type DragEvent, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  DatabaseZap,
  GripVertical,
  Loader2,
  Pencil,
  Plug,
  Power,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useExplorerStore } from '@/store/explorer'
import { useTabsStore } from '@/store/tabs'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { formatHostShort } from '@/lib/displayUri'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { CreateDatabaseDialog } from '@/features/collection/CreateDatabaseDialog'
import { DatabaseGroup } from './DatabaseGroup'
import type { ConnectionConfig } from '@shared/types'

export type DragHandlers = {
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragEnd: (e: DragEvent<HTMLElement>) => void
  onDragOver: (e: DragEvent<HTMLElement>) => void
  onDragLeave: (e: DragEvent<HTMLElement>) => void
  onDrop: (e: DragEvent<HTMLElement>) => void
}

type Props = {
  connection: ConnectionConfig
  onEdit: () => void
  onRequestDelete: () => void
  drag?: DragHandlers
  dropPosition?: 'before' | 'after' | null
}

export function ConnectionGroup({
  connection,
  onEdit,
  onRequestDelete,
  drag,
  dropPosition
}: Props) {
  const isActive = useAppStore((s) => s.activeConnectionIds.has(connection.id))
  const markConnected = useAppStore((s) => s.markConnected)
  const markDisconnected = useAppStore((s) => s.markDisconnected)
  const closeTabsForConnection = useTabsStore((s) => s.closeForConnection)
  const expanded = useExplorerStore((s) => s.expandedConnections.has(connection.id))
  const expandConnection = useExplorerStore((s) => s.expandConnection)
  const collapseConnection = useExplorerStore((s) => s.collapseConnection)
  const toggleConnection = useExplorerStore((s) => s.toggleConnection)
  const queryClient = useQueryClient()

  const [createDbOpen, setCreateDbOpen] = useState(false)
  // Start as `false` so the first effect run expands the row when the
  // component mounts already-connected (e.g. after app reload).
  const wasActive = useRef(false)

  useEffect(() => {
    if (isActive && !wasActive.current) expandConnection(connection.id)
    else if (!isActive && wasActive.current) collapseConnection(connection.id)
    wasActive.current = isActive
  }, [isActive, connection.id, expandConnection, collapseConnection])

  const connectMutation = useMutation({
    mutationFn: () => api.connections.connect(connection.id),
    onSuccess: () => {
      markConnected(connection.id)
      void queryClient.invalidateQueries({ queryKey: queryKeys.databases(connection.id) })
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Connect failed: ${message}`)
    }
  })

  const disconnectMutation = useMutation({
    mutationFn: () => api.connections.disconnect(connection.id),
    onSuccess: () => {
      markDisconnected(connection.id)
      closeTabsForConnection(connection.id)
    }
  })

  const busy = connectMutation.isPending || disconnectMutation.isPending
  const draggable = drag !== undefined && !expanded
  const canExpand = isActive

  const handleClick = () => {
    if (busy) return
    if (!isActive) {
      connectMutation.mutate()
      return
    }
    if (canExpand) toggleConnection(connection.id)
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.databases(connection.id) })
    void queryClient.invalidateQueries({ queryKey: ['collections', connection.id] })
  }

  return (
    <div
      className={cn(
        'select-none',
        dropPosition === 'before' && 'border-t-2 border-primary/70',
        dropPosition === 'after' && 'border-b-2 border-primary/70'
      )}
      draggable={draggable}
      onDragStart={draggable ? drag?.onDragStart : undefined}
      onDragEnd={draggable ? drag?.onDragEnd : undefined}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            disabled={busy}
            className={cn(
              'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors data-[state=open]:bg-accent/60',
              isActive ? 'cursor-pointer hover:bg-accent/60' : 'cursor-pointer hover:bg-accent/60'
            )}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : canExpand ? (
                expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )
              ) : draggable ? (
                <GripVertical className="h-3.5 w-3.5 opacity-0 group-hover:opacity-50" />
              ) : null}
            </span>
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                isActive ? 'bg-success shadow-[0_0_8px_hsl(var(--success))]' : 'bg-muted'
              )}
              aria-label={isActive ? 'Connected' : 'Disconnected'}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{connection.name}</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {formatHostShort(connection)}
              </div>
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[12rem]">
          {isActive ? (
            <>
              <ContextMenuItem onSelect={() => disconnectMutation.mutate()} disabled={busy}>
                <Power className="h-4 w-4" />
                Disconnect
              </ContextMenuItem>
              <ContextMenuItem onSelect={refresh}>
                <RefreshCw className="h-4 w-4" />
                Refresh databases
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => setCreateDbOpen(true)}>
                <DatabaseZap className="h-4 w-4" />
                New database…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : (
            <>
              <ContextMenuItem onSelect={() => connectMutation.mutate()} disabled={busy}>
                <Plug className="h-4 w-4" />
                Connect
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={onEdit}>
            <Pencil className="h-4 w-4" />
            Edit…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={onRequestDelete}
          >
            <Trash2 className="h-4 w-4" />
            Delete…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded && isActive && (
        <div className="ml-4 mt-0.5 border-l border-border/60 pl-2">
          <DatabaseGroup connectionId={connection.id} />
        </div>
      )}

      <CreateDatabaseDialog
        open={createDbOpen}
        connectionId={connection.id}
        onClose={() => setCreateDbOpen(false)}
      />
    </div>
  )
}
