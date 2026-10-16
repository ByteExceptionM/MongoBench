import { CopyPlus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { isDraftDirty, ordinalLabel, useTabsStore, type CollectionTab } from '@/store/tabs'

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const activate = useTabsStore((s) => s.activate)
  const close = useTabsStore((s) => s.close)
  const duplicate = useTabsStore((s) => s.duplicate)

  if (tabs.length === 0) return null

  return (
    <div className="flex h-10 items-stretch border-b bg-card/40">
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <TabPill
            key={tab.id}
            tab={tab}
            ordinal={ordinalLabel(tabs, tab)}
            active={tab.id === activeTabId}
            onSelect={() => activate(tab.id)}
            onClose={() => close(tab.id)}
            onDuplicate={() => duplicate(tab.id)}
          />
        ))}
      </div>
    </div>
  )
}

function TabPill({
  tab,
  ordinal,
  active,
  onSelect,
  onClose,
  onDuplicate
}: {
  tab: CollectionTab
  ordinal: number | null
  active: boolean
  onSelect: () => void
  onClose: () => void
  onDuplicate: () => void
}) {
  // Drafts change on every keystroke; this selector re-renders only the pill whose dot flips.
  const dirty = useTabsStore((s) => {
    const draft = s.drafts[tab.id]
    return draft !== undefined && isDraftDirty(draft, tab.applied)
  })
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={active}
          title={dirty ? 'Query edited, not run yet' : undefined}
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
            'group relative flex shrink-0 cursor-pointer items-center gap-2 border-r px-3 text-xs',
            active
              ? 'border-b-0 bg-background font-medium text-foreground'
              : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground data-[state=open]:bg-accent/40'
          )}
        >
          {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-primary" />}
          <span className="font-mono">
            <span className={active ? 'text-primary/70' : 'text-muted-foreground'}>{tab.db}.</span>
            <span>{tab.coll}</span>
            {ordinal !== null && <span className="ml-1 text-muted-foreground">#{ordinal}</span>}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={cn(
              'relative rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground',
              !dirty && 'opacity-0 group-hover:opacity-100'
            )}
            aria-label="Close tab"
          >
            {dirty && (
              <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-primary group-hover:hidden" />
            )}
            <X className={cn('h-3 w-3', dirty && 'invisible group-hover:visible')} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onDuplicate}>
          <CopyPlus className="h-4 w-4" />
          Duplicate tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}>
          <X className="h-4 w-4" />
          Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
