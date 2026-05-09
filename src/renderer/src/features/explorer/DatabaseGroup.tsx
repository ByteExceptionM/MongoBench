import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  FolderPlus,
  Loader2,
  Plus,
  Trash2,
  Users
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { useExplorerStore } from '@/store/explorer'
import { useTabsStore } from '@/store/tabs'
import { Button } from '@/components/ui/button'
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
import { CreateCollectionDialog } from '@/features/collection/CreateCollectionDialog'
import { ManageUsersDialog } from '@/features/users/ManageUsersDialog'
import { CollectionLeaf } from './CollectionLeaf'
import type { DatabaseInfo } from '@shared/types'

export function DatabaseGroup({ connectionId }: { connectionId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.databases(connectionId),
    queryFn: () => api.databases.list(connectionId)
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        loading databases…
      </div>
    )
  }

  if (error instanceof ApiError) {
    return <div className="px-2 py-1 text-xs text-destructive">{error.message}</div>
  }

  if (!data || data.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">no databases</div>
  }

  return (
    <div>
      {data.map((db) => (
        <DatabaseRow key={db.name} connectionId={connectionId} db={db} />
      ))}
    </div>
  )
}

type DialogState = 'create-coll' | 'users' | 'drop' | null

function DatabaseRow({ connectionId, db }: { connectionId: string; db: DatabaseInfo }) {
  const expanded = useExplorerStore((s) => s.expandedDatabases.has(`${connectionId}::${db.name}`))
  const toggleDatabase = useExplorerStore((s) => s.toggleDatabase)
  const [dialog, setDialog] = useState<DialogState>(null)
  const queryClient = useQueryClient()
  const closeForDatabase = useTabsStore((s) => s.closeForDatabase)

  const dropMutation = useMutation({
    mutationFn: () => api.databases.drop({ connectionId, db: db.name }),
    onSuccess: () => {
      closeForDatabase(connectionId, db.name)
      void queryClient.invalidateQueries({ queryKey: queryKeys.databases(connectionId) })
      toast.success(`Dropped ${db.name}`)
      setDialog(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Drop failed: ${message}`)
      setDialog(null)
    }
  })

  const onCopy = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      await navigator.clipboard.writeText(db.name)
      toast.success('Database name copied')
    } catch {
      toast.error('Clipboard write blocked')
    }
  }

  const stop = (handler: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    handler()
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => toggleDatabase(connectionId, db.name)}
            className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60 data-[state=open]:bg-accent/60"
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </span>
            <span className="truncate font-medium">{db.name}</span>
            {db.empty && (
              <span className="rounded-sm bg-muted px-1 text-[9px] text-muted-foreground">
                empty
              </span>
            )}
            <Button
              asChild
              size="icon"
              variant="ghost"
              className="ml-auto h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label="New collection"
            >
              <span onClick={stop(() => setDialog('create-coll'))} role="button" tabIndex={0}>
                <Plus className="h-3 w-3" />
              </span>
            </Button>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setDialog('create-coll')}>
            <FolderPlus className="h-4 w-4" />
            New collection…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setDialog('users')}>
            <Users className="h-4 w-4" />
            Manage users…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void onCopy()}>
            <ClipboardCopy className="h-4 w-4" />
            Copy name
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={() => setDialog('drop')}
          >
            <Trash2 className="h-4 w-4" />
            Drop database…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded && (
        <div className="ml-4 border-l border-border/60 pl-2">
          <CollectionsList connectionId={connectionId} db={db.name} />
        </div>
      )}

      <CreateCollectionDialog
        open={dialog === 'create-coll'}
        connectionId={connectionId}
        db={db.name}
        onClose={() => setDialog(null)}
      />

      <ManageUsersDialog
        open={dialog === 'users'}
        connectionId={connectionId}
        db={db.name}
        onClose={() => setDialog(null)}
      />

      <AlertDialog
        open={dialog === 'drop'}
        onOpenChange={(o) => !o && !dropMutation.isPending && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop database?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">{db.name}</span> and all of its
              collections will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={dropMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                dropMutation.mutate()
              }}
            >
              {dropMutation.isPending && <Loader2 className="animate-spin" />}
              Drop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CollectionsList({ connectionId, db }: { connectionId: string; db: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.collections(connectionId, db),
    queryFn: () => api.collections.list({ connectionId, db })
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        loading…
      </div>
    )
  }

  if (error instanceof ApiError) {
    return <div className="px-2 py-1 text-[11px] text-destructive">{error.message}</div>
  }

  if (!data || data.length === 0) {
    return <div className="px-2 py-1 text-[11px] text-muted-foreground">no collections</div>
  }

  return (
    <div>
      {data.map((coll) => (
        <CollectionLeaf
          key={coll.name}
          connectionId={connectionId}
          db={db}
          name={coll.name}
          type={coll.type}
        />
      ))}
    </div>
  )
}
