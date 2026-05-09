import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ClipboardCopy,
  Eye,
  FilePlus2,
  Info,
  KeyRound,
  Loader2,
  Pencil,
  Table,
  Trash2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useExplorerStore } from '@/store/explorer'
import { useTabsStore } from '@/store/tabs'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
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
import { CollectionInfoDialog } from '@/features/collection/CollectionInfoDialog'
import { IndexesDialog } from '@/features/collection/IndexesDialog'
import { RenameCollectionDialog } from '@/features/collection/RenameCollectionDialog'
import { DocumentEditorDialog } from '@/features/document/DocumentEditorDialog'
import { useQuery } from '@tanstack/react-query'

type DialogState = 'info' | 'rename' | 'drop' | 'indexes' | 'insert' | null

export function CollectionLeaf({
  connectionId,
  db,
  name,
  type
}: {
  connectionId: string
  db: string
  name: string
  type: 'collection' | 'view'
}) {
  const open = useTabsStore((s) => s.open)
  const closeForCollection = useTabsStore((s) => s.closeForCollection)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const tabId = `${connectionId}::${db}::${name}`
  const isActive = activeTabId === tabId
  const [dialog, setDialog] = useState<DialogState>(null)
  const queryClient = useQueryClient()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const revealTarget = useExplorerStore((s) => s.revealTarget)
  const revealNonce = useExplorerStore((s) => s.revealNonce)

  useEffect(() => {
    if (
      revealTarget &&
      revealTarget.connectionId === connectionId &&
      revealTarget.db === db &&
      revealTarget.coll === name
    ) {
      buttonRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [revealNonce, revealTarget, connectionId, db, name])

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })
  const conn = connectionsQuery.data?.find((c) => c.id === connectionId)
  const uuidEncoding = conn?.uuidEncoding ?? 'default'
  const timezone = conn?.timezone ?? 'UTC'

  const dropMutation = useMutation({
    mutationFn: () => api.collections.drop({ connectionId, db, coll: name }),
    onSuccess: () => {
      closeForCollection(connectionId, db, name)
      void queryClient.invalidateQueries({ queryKey: queryKeys.collections(connectionId, db) })
      toast.success(`Dropped ${db}.${name}`)
      setDialog(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Drop failed: ${message}`)
      setDialog(null)
    }
  })

  const onCopyName = async () => {
    try {
      await navigator.clipboard.writeText(`${db}.${name}`)
      toast.success('Namespace copied')
    } catch {
      toast.error('Clipboard write blocked')
    }
  }

  const Icon = type === 'view' ? Eye : Table

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => open({ connectionId, db, coll: name })}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-accent/60 data-[state=open]:bg-accent/60'
            )}
          >
            <Icon className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate font-mono">{name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => open({ connectionId, db, coll: name })}>
            <Eye className="h-4 w-4" />
            Open
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setDialog('info')}>
            <Info className="h-4 w-4" />
            Info
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void onCopyName()}>
            <ClipboardCopy className="h-4 w-4" />
            Copy namespace
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setDialog('insert')} disabled={type === 'view'}>
            <FilePlus2 className="h-4 w-4" />
            Insert document…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setDialog('indexes')} disabled={type === 'view'}>
            <KeyRound className="h-4 w-4" />
            Indexes…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setDialog('rename')} disabled={type === 'view'}>
            <Pencil className="h-4 w-4" />
            Rename…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={() => setDialog('drop')}
          >
            <Trash2 className="h-4 w-4" />
            Drop…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <CollectionInfoDialog
        open={dialog === 'info'}
        connectionId={connectionId}
        db={db}
        coll={name}
        onClose={() => setDialog(null)}
      />

      <IndexesDialog
        open={dialog === 'indexes'}
        connectionId={connectionId}
        db={db}
        coll={name}
        onClose={() => setDialog(null)}
      />

      <DocumentEditorDialog
        mode={dialog === 'insert' ? 'insert' : null}
        envelope={null}
        connectionId={connectionId}
        db={db}
        coll={name}
        uuidEncoding={uuidEncoding}
        timezone={timezone}
        onClose={() => setDialog(null)}
      />

      <RenameCollectionDialog
        open={dialog === 'rename'}
        connectionId={connectionId}
        db={db}
        coll={name}
        onClose={() => setDialog(null)}
      />

      <AlertDialog
        open={dialog === 'drop'}
        onOpenChange={(o) => !o && !dropMutation.isPending && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop collection?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">
                {db}.{name}
              </span>{' '}
              and all of its documents will be permanently removed. This cannot be undone.
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
    </>
  )
}
