import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Command, Database, Github, Keyboard, Loader2, Plug, Plus, ServerCrash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConnectionFormDialog } from '@/features/connections/ConnectionFormDialog'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { formatHostShort } from '@/lib/displayUri'
import { useAppStore } from '@/store'
import type { ConnectionConfig } from '@shared/types'

/**
 * Main-menu landing screen — shown when no collection tab is open and
 * no connection is active.
 *
 * The sidebar is always visible too, so this view is intentionally NOT
 * a duplicate of it: it focuses on getting the user into a connection
 * fast (one-click Connect on a saved connection, or "+ New connection")
 * and surfaces a few app-level hints / shortcuts that don't fit anywhere
 * else.
 */
export function Welcome() {
  const [formOpen, setFormOpen] = useState(false)
  const queryClient = useQueryClient()

  const connections = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })

  const items = connections.data ?? []

  return (
    <section className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-12">
        <Brand />

        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">
              {items.length === 0 ? 'Get started' : 'Saved connections'}
            </h2>
            <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New connection
            </Button>
          </div>

          {connections.isLoading ? (
            <div className="flex items-center gap-2 rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading saved connections…
            </div>
          ) : connections.error instanceof ApiError ? (
            <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              <ServerCrash className="mt-0.5 h-4 w-4" />
              <div>
                <div className="font-medium">Could not read connections</div>
                <div className="text-xs opacity-80">{connections.error.message}</div>
              </div>
            </div>
          ) : items.length === 0 ? (
            <EmptyState onNew={() => setFormOpen(true)} />
          ) : (
            <ul className="overflow-hidden rounded-lg border bg-card">
              {items.map((c, i) => (
                <ConnectionRow
                  key={c.id}
                  connection={c}
                  isLast={i === items.length - 1}
                  onAfterConnect={() => {
                    void queryClient.invalidateQueries({ queryKey: queryKeys.databases(c.id) })
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        <Tips />
      </div>

      <ConnectionFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </section>
  )
}

function Brand() {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/30">
          <Database className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">MongoBench</h1>
          <p className="text-xs text-muted-foreground">A native MongoDB client.</p>
        </div>
      </div>
    </div>
  )
}

function ConnectionRow({
  connection,
  isLast,
  onAfterConnect
}: {
  connection: ConnectionConfig
  isLast: boolean
  onAfterConnect: () => void
}) {
  const markConnected = useAppStore((s) => s.markConnected)

  const connectMutation = useMutation({
    mutationFn: () => api.connections.connect(connection.id),
    onSuccess: () => {
      markConnected(connection.id)
      onAfterConnect()
      toast.success(`Connected to ${connection.name}`)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Connect failed: ${message}`)
    }
  })

  return (
    <li
      className={
        'group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 ' +
        (!isLast ? 'border-b' : '')
      }
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Plug className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{connection.name}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {formatHostShort(connection)}
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => connectMutation.mutate()}
        disabled={connectMutation.isPending}
      >
        {connectMutation.isPending ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Plug className="h-3.5 w-3.5" />
        )}
        Connect
      </Button>
    </li>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-lg border border-dashed bg-card/40 p-8 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Plug className="h-4 w-4" />
      </div>
      <div className="mt-3 text-sm font-medium">No saved connections yet</div>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
        Add a MongoDB URI to start browsing databases, running queries, and managing indexes.
      </p>
      <Button size="sm" className="mt-4" onClick={onNew}>
        <Plus className="h-3.5 w-3.5" /> Add your first connection
      </Button>
    </div>
  )
}

function Tips() {
  return (
    <div className="grid gap-3">
      <h2 className="text-sm font-semibold tracking-tight">Tips</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <TipCard
          icon={<Command className="h-3.5 w-3.5" />}
          title="Command palette"
          body={
            <>
              Press <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd> to jump to any saved connection or run common
              actions.
            </>
          }
        />
        <TipCard
          icon={<Keyboard className="h-3.5 w-3.5" />}
          title="Shell-flavored queries"
          body={
            <>
              The query editor accepts{' '}
              <code className="font-mono text-foreground">ObjectId(…)</code>,{' '}
              <code className="font-mono text-foreground">ISODate(…)</code>, regex literals, and
              unquoted keys.
            </>
          }
        />
        <TipCard
          icon={<Github className="h-3.5 w-3.5" />}
          title="Open source"
          body={<>Found a bug or want a feature? Issues and PRs welcome on GitHub.</>}
        />
        <TipCard
          icon={<Database className="h-3.5 w-3.5" />}
          title="Per-collection indexes"
          body={
            <>
              Right-click any collection in the sidebar to manage indexes — TTL, partial filters,
              text, 2dsphere, wildcard, and more.
            </>
          }
        />
      </div>
    </div>
  )
}

function TipCard({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-card p-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <div>
        <div className="text-xs font-medium">{title}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded border bg-muted/40 px-1 font-mono text-[10px] text-foreground">
      {children}
    </kbd>
  )
}
