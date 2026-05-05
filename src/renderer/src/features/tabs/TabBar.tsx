import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTabsStore, type CollectionTab } from '@/store/tabs'

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const activate = useTabsStore((s) => s.activate)
  const close = useTabsStore((s) => s.close)

  if (tabs.length === 0) return null

  return (
    <div className="flex h-10 items-stretch border-b bg-card/40">
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <TabPill
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => activate(tab.id)}
            onClose={() => close(tab.id)}
          />
        ))}
      </div>
    </div>
  )
}

function TabPill({
  tab,
  active,
  onSelect,
  onClose
}: {
  tab: CollectionTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onMouseDown={(e) => {
        // Middle-click closes the tab. Prevent the default to suppress
        // Windows' autoscroll cursor.
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      className={cn(
        'group flex shrink-0 cursor-pointer items-center gap-2 border-r px-3 text-xs',
        active
          ? 'border-b-0 bg-background text-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
      )}
    >
      <span className="font-mono">
        <span className="text-muted-foreground">{tab.db}.</span>
        <span>{tab.coll}</span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
        aria-label="Close tab"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
