import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, Eye, Plug, Power, Server, Table } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { useAppStore } from '@/store'
import { useTabsStore } from '@/store/tabs'
import type { CollectionInfo, ConnectionConfig, DatabaseInfo } from '@shared/types'

const MAX_RESULTS = 50

type CollectionItem = {
  connectionId: string
  connName: string
  db: string
  coll: string
  type: 'collection' | 'view'
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const [query, setQuery] = useState('')
  const queryClient = useQueryClient()
  const activeIds = useAppStore((s) => s.activeConnectionIds)
  const markConnected = useAppStore((s) => s.markConnected)
  const markDisconnected = useAppStore((s) => s.markDisconnected)
  const closeForConnection = useTabsStore((s) => s.closeForConnection)
  const openTab = useTabsStore((s) => s.open)

  const { data: connections } = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list(),
    enabled: open
  })

  const activeConnections = useMemo(
    () => (connections ?? []).filter((c) => activeIds.has(c.id)),
    [connections, activeIds]
  )

  // Reset query each time the palette opens.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // Pre-fetch databases + collections for every active connection so that
  // the palette can search across them without per-keystroke loading.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const run = async (): Promise<void> => {
      for (const conn of activeConnections) {
        const dbs = await queryClient.ensureQueryData({
          queryKey: queryKeys.databases(conn.id),
          queryFn: () => api.databases.list(conn.id)
        })
        if (cancelled) return
        await Promise.all(
          dbs.map((db) =>
            queryClient.ensureQueryData({
              queryKey: queryKeys.collections(conn.id, db.name),
              queryFn: () => api.collections.list({ connectionId: conn.id, db: db.name })
            })
          )
        )
        if (cancelled) return
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [open, activeConnections, queryClient])

  // Flatten everything from the cache for instant local filtering.
  const allItems = useMemo<CollectionItem[]>(() => {
    if (!open) return []
    const out: CollectionItem[] = []
    for (const conn of activeConnections) {
      const dbs = queryClient.getQueryData<DatabaseInfo[]>(queryKeys.databases(conn.id))
      if (!dbs) continue
      for (const db of dbs) {
        const colls = queryClient.getQueryData<CollectionInfo[]>(
          queryKeys.collections(conn.id, db.name)
        )
        if (!colls) continue
        for (const c of colls) {
          out.push({
            connectionId: conn.id,
            connName: conn.name,
            db: db.name,
            coll: c.name,
            type: c.type
          })
        }
      }
    }
    return out
    // queryClient is stable; we re-derive when active connections change or
    // when prefetch completion bumps the cache (we listen via the `query` state below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeConnections, query])

  const filteredCollections = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allItems.slice(0, MAX_RESULTS)
    const scored: Array<{ item: CollectionItem; score: number }> = []
    for (const item of allItems) {
      const ns = `${item.db}.${item.coll}`.toLowerCase()
      if (ns.startsWith(q)) scored.push({ item, score: 0 })
      else if (item.coll.toLowerCase().startsWith(q)) scored.push({ item, score: 1 })
      else if (ns.includes(q)) scored.push({ item, score: 2 })
      if (scored.length >= MAX_RESULTS * 4) break
    }
    return scored
      .sort((a, b) => a.score - b.score || a.item.coll.localeCompare(b.item.coll))
      .slice(0, MAX_RESULTS)
      .map((s) => s.item)
  }, [allItems, query])

  const filteredConnections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = connections ?? []
    if (!q) return list
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.username ?? '').toLowerCase().includes(q) ||
        c.uri.toLowerCase().includes(q)
    )
  }, [connections, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <Command shouldFilter={false} loop>
          <CommandInput
            placeholder="Search connections, databases, collections…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filteredConnections.length === 0 && filteredCollections.length === 0 && (
              <CommandEmpty>Nothing matches.</CommandEmpty>
            )}

            {filteredConnections.length > 0 && (
              <CommandGroup heading="Connections">
                {filteredConnections.map((c) => (
                  <ConnectionRow
                    key={c.id}
                    conn={c}
                    isActive={activeIds.has(c.id)}
                    onSelect={async () => {
                      onOpenChange(false)
                      if (activeIds.has(c.id)) {
                        await api.connections.disconnect(c.id).catch(() => undefined)
                        markDisconnected(c.id)
                        closeForConnection(c.id)
                      } else {
                        try {
                          await api.connections.connect(c.id)
                          markConnected(c.id)
                        } catch {
                          // toast handled at row level on the sidebar
                        }
                      }
                    }}
                  />
                ))}
              </CommandGroup>
            )}

            {filteredCollections.length > 0 && (
              <CommandGroup
                heading={
                  query.trim().length > 0
                    ? `Collections (top ${filteredCollections.length})`
                    : `Collections (${filteredCollections.length} of ${allItems.length})`
                }
              >
                {filteredCollections.map((item) => (
                  <CollectionItemRow
                    key={`${item.connectionId}::${item.db}::${item.coll}`}
                    item={item}
                    showConnection={activeConnections.length > 1}
                    onSelect={() => {
                      openTab({
                        connectionId: item.connectionId,
                        db: item.db,
                        coll: item.coll
                      })
                      onOpenChange(false)
                    }}
                  />
                ))}
              </CommandGroup>
            )}

            {query.trim().length === 0 && allItems.length > MAX_RESULTS && (
              <div className="px-3 py-2 text-[10px] text-muted-foreground">
                Showing first {MAX_RESULTS} of {allItems.length} collections — type to narrow.
              </div>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionRow({
  conn,
  isActive,
  onSelect
}: {
  conn: ConnectionConfig
  isActive: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem value={`conn-${conn.id}`} onSelect={() => onSelect()}>
      <Server className="h-4 w-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{conn.name}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">{conn.uri}</div>
      </div>
      <span
        className={
          isActive
            ? 'flex items-center gap-1 text-[10px] font-medium text-success'
            : 'flex items-center gap-1 text-[10px] font-medium text-muted-foreground'
        }
      >
        {isActive ? <Power className="h-3 w-3" /> : <Plug className="h-3 w-3" />}
        {isActive ? 'disconnect' : 'connect'}
      </span>
    </CommandItem>
  )
}

function CollectionItemRow({
  item,
  showConnection,
  onSelect
}: {
  item: CollectionItem
  showConnection: boolean
  onSelect: () => void
}) {
  const Icon = item.type === 'view' ? Eye : Table
  return (
    <CommandItem
      value={`coll-${item.connectionId}-${item.db}-${item.coll}`}
      onSelect={() => onSelect()}
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline">
        <span className="font-mono text-xs text-muted-foreground">{item.db}.</span>
        <span className="truncate font-mono text-xs">{item.coll}</span>
      </div>
      {showConnection && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Database className="h-3 w-3" />
          {item.connName}
        </span>
      )}
    </CommandItem>
  )
}
