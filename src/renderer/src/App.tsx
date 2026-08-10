import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ConnectionsExplorer } from '@/features/explorer/ConnectionsExplorer'
import { TabBar } from '@/features/tabs/TabBar'
import { CollectionTab } from '@/features/collection/CollectionTab'
import { ConnectionDashboard } from '@/features/dashboard/ConnectionDashboard'
import { ServerStatsCollector } from '@/features/dashboard/ServerStatsCollector'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { UpdateNotifier } from '@/features/updater/UpdateNotifier'
import { Welcome } from '@/features/welcome/Welcome'
import { useTabsStore } from '@/store/tabs'
import { useAppStore } from '@/store'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'

export default function App() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeIds = useAppStore((s) => s.activeConnectionIds)
  const markDisconnected = useAppStore((s) => s.markDisconnected)
  const { data: connections } = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })
  const dashboardConnection = !activeTab ? connections?.find((c) => activeIds.has(c.id)) : undefined
  const onWelcome = !activeTab && !dashboardConnection

  // Main took a connection down without being asked — today that means a dead
  // SSH tunnel. Subscribed here because the sidebar is not always mounted.
  // Open tabs are left alone: a drop is usually followed by a reconnect, and
  // discarding the user's queries over a network hiccup would be worse.
  useEffect(() => {
    return api.connections.onDropped(({ connectionId, reason }) => {
      markDisconnected(connectionId)
      toast.error('Connection lost', { description: reason })
    })
  }, [markDisconnected])

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <ServerStatsCollector />
      <UpdateNotifier />
      {!onWelcome && <ConnectionsExplorer />}
      <main className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <div className="min-h-0 flex-1">
          {activeTab ? (
            <CollectionTab tab={activeTab} />
          ) : dashboardConnection ? (
            <ConnectionDashboard connection={dashboardConnection} />
          ) : (
            <Welcome />
          )}
        </div>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
