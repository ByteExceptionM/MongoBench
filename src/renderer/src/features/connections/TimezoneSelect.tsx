import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Globe } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

type Props = {
  value: string
  onChange: (zone: string) => void
  id?: string
}

/**
 * Searchable picker for IANA timezones.
 *
 * Lists every zone the runtime knows about (`Intl.supportedValuesOf`) and
 * computes each one's *current* UTC offset on the fly so the user can see
 * the actual time delta — `Europe/Berlin (UTC+02:00)`. Zones get grouped
 * by their region prefix (Europe, America, Asia, …) for fast scanning.
 */
export function TimezoneSelect({ value, onChange, id }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const zones = useMemo(() => loadZones(), [])
  const grouped = useMemo(() => groupZones(zones), [zones])
  const offsetForCurrent = useMemo(() => zoneOffsetLabel(value), [value])

  useEffect(() => {
    if (!open) return
    const onMouse = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring',
          open && 'ring-1 ring-ring'
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{value || 'UTC'}</span>
          <span className="shrink-0 rounded-sm bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {offsetForCurrent}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-md border bg-popover shadow-lg">
          <Command shouldFilter={true}>
            <CommandInput placeholder="Search timezone…" autoFocus />
            <CommandList className="max-h-[320px]">
              <CommandEmpty>No timezone matches.</CommandEmpty>
              <CommandGroup heading="Quick">
                <ZoneItem
                  zone="UTC"
                  selected={value === 'UTC'}
                  onSelect={() => {
                    onChange('UTC')
                    setOpen(false)
                  }}
                />
                <ZoneItem
                  zone={detectBrowserTimezone()}
                  label={`Local — ${detectBrowserTimezone()}`}
                  selected={value === detectBrowserTimezone()}
                  onSelect={() => {
                    onChange(detectBrowserTimezone())
                    setOpen(false)
                  }}
                />
              </CommandGroup>
              {Object.entries(grouped).map(([region, list]) => (
                <CommandGroup key={region} heading={region}>
                  {list.map((zone) => (
                    <ZoneItem
                      key={zone}
                      zone={zone}
                      selected={zone === value}
                      onSelect={() => {
                        onChange(zone)
                        setOpen(false)
                      }}
                    />
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )
}

function ZoneItem({
  zone,
  label,
  selected,
  onSelect
}: {
  zone: string
  label?: string
  selected: boolean
  onSelect: () => void
}) {
  const offset = zoneOffsetLabel(zone)
  return (
    <CommandItem value={`${zone} ${offset}`} onSelect={onSelect} className="text-xs">
      <Check className={cn('h-3.5 w-3.5', selected ? 'opacity-100' : 'opacity-0')} />
      <span className="flex-1 truncate font-mono">{label ?? zone}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{offset}</span>
    </CommandItem>
  )
}

/**
 * Format the current UTC offset of a zone as `UTC+02:00` / `UTC-05:30` / `UTC`.
 * Uses `longOffset` so half-hour zones (India, Newfoundland) render correctly.
 */
function zoneOffsetLabel(zone: string): string {
  if (!zone) return 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      timeZoneName: 'longOffset'
    }).formatToParts(new Date())
    const tzn = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    if (tzn === 'GMT' || tzn === '') return 'UTC'
    return tzn.replace('GMT', 'UTC').replace('−', '-')
  } catch {
    return ''
  }
}

function loadZones(): string[] {
  // `Intl.supportedValuesOf` lists every IANA zone the platform knows
  // (Chromium 99+). Falls back to a hand-curated set on older runtimes
  // so this picker still works.
  const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  if (typeof fn === 'function') {
    try {
      const all = fn('timeZone')
      if (Array.isArray(all) && all.length > 0) return all
    } catch {
      // fall through
    }
  }
  return [
    'UTC',
    'Europe/Berlin',
    'Europe/London',
    'Europe/Paris',
    'Europe/Moscow',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Auckland'
  ]
}

function groupZones(zones: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const z of zones) {
    if (z === 'UTC') continue
    const slash = z.indexOf('/')
    const region = slash === -1 ? 'Other' : z.slice(0, slash)
    if (!out[region]) out[region] = []
    out[region].push(z)
  }
  // Sort each group's zones alphabetically; keep regions in a stable order.
  const sortedRegions = Object.keys(out).sort()
  const sorted: Record<string, string[]> = {}
  for (const region of sortedRegions) {
    sorted[region] = out[region]!.sort((a, b) => a.localeCompare(b))
  }
  return sorted
}

function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
