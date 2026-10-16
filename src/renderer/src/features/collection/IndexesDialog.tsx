import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  CircleOff,
  EyeOff,
  Hash,
  Info,
  Key,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ServerCrash,
  Sparkles,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AutocompleteInput } from '@/components/ui/autocomplete-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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
import { Tooltip } from '@/components/ui/tooltip'
import { api, ApiError } from '@/lib/api'
import { collectionSchemaQuery } from '@/lib/completion/useCompletionEnv'
import { formatDateInZone } from '@/lib/dateZone'
import {
  buildIndexRows,
  formatAge,
  formatCount,
  formatRate,
  nextSort,
  sortIndexRows,
  unavailableText,
  usageAvailable,
  usageNotes,
  usageSources,
  type IndexRow,
  type IndexSort,
  type IndexSortKey
} from '@/lib/indexUsage'
import { queryKeys } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import { schemaFieldPaths } from '@shared/collectionSchema'
import type { IndexCreateOptions, IndexInfo, IndexStatsReport } from '@shared/types'

type Props = {
  open: boolean
  connectionId: string
  db: string
  coll: string
  timezone: string
  onClose: () => void
}

type View = { kind: 'list' } | { kind: 'create' }

const KEY_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1', label: 'Ascending (1)' },
  { value: '-1', label: 'Descending (-1)' },
  { value: 'text', label: 'Text' },
  { value: '2dsphere', label: '2dsphere (geo)' },
  { value: '2d', label: '2d (legacy geo)' },
  { value: 'hashed', label: 'Hashed' }
]

export function IndexesDialog({ open, connectionId, db, coll, timezone, onClose }: Props) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const [pendingDrop, setPendingDrop] = useState<IndexInfo | null>(null)
  const [sort, setSort] = useState<IndexSort>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (open) {
      setView({ kind: 'list' })
      setSort(null)
    }
  }, [open])

  const indexesQuery = useQuery({
    queryKey: queryKeys.indexes(connectionId, db, coll),
    queryFn: () => api.indexes.list({ connectionId, db, coll }),
    enabled: open
  })

  // No polling: on mongos $indexStats fans out to every shard, so refresh stays manual.
  const statsQuery = useQuery({
    queryKey: queryKeys.indexStats(connectionId, db, coll),
    queryFn: () => api.indexes.stats({ connectionId, db, coll }),
    enabled: open
  })

  const dropMutation = useMutation({
    mutationFn: (name: string) => api.indexes.drop({ connectionId, db, coll, name }),
    onSuccess: (_, name) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.indexes(connectionId, db, coll) })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.collectionStats(connectionId, db, coll)
      })
      toast.success(`Dropped index ${name}`)
      setPendingDrop(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Drop failed: ${message}`)
      setPendingDrop(null)
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {view.kind !== 'list' && (
              <Button
                size="icon"
                variant="ghost"
                className="-ml-2 h-7 w-7"
                onClick={() => setView({ kind: 'list' })}
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {view.kind === 'list' && <>Indexes</>}
            {view.kind === 'create' && <>New index</>}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {db}.{coll}
          </DialogDescription>
        </DialogHeader>

        {view.kind === 'list' && (
          <IndexesList
            isLoading={indexesQuery.isLoading}
            error={indexesQuery.error}
            indexes={indexesQuery.data ?? []}
            // A failed refresh keeps the previous data; showing it beside the error would mislead.
            report={statsQuery.isError ? undefined : statsQuery.data}
            statsLoading={statsQuery.isLoading}
            statsError={statsQuery.error}
            now={statsQuery.dataUpdatedAt}
            timezone={timezone}
            sort={sort}
            onSort={(key) => setSort((s) => nextSort(s, key))}
            refreshing={indexesQuery.isFetching || statsQuery.isFetching}
            onRefresh={() =>
              void queryClient.invalidateQueries({
                queryKey: queryKeys.indexes(connectionId, db, coll)
              })
            }
            onCreate={() => setView({ kind: 'create' })}
            onDrop={(idx) => setPendingDrop(idx)}
          />
        )}

        {view.kind === 'create' && (
          <CreateIndexForm
            connectionId={connectionId}
            db={db}
            coll={coll}
            onDone={() => setView({ kind: 'list' })}
          />
        )}
      </DialogContent>

      <AlertDialog
        open={pendingDrop !== null}
        onOpenChange={(o) => !o && !dropMutation.isPending && setPendingDrop(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop index?</AlertDialogTitle>
            <AlertDialogDescription>
              Index <span className="font-mono text-foreground">{pendingDrop?.name}</span> on{' '}
              <span className="font-mono text-foreground">
                {db}.{coll}
              </span>{' '}
              will be removed. This cannot be undone — queries that relied on it may slow down.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={dropMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (pendingDrop) dropMutation.mutate(pendingDrop.name)
              }}
            >
              {dropMutation.isPending && <Loader2 className="animate-spin" />}
              Drop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

function IndexesList({
  isLoading,
  error,
  indexes,
  report,
  statsLoading,
  statsError,
  now,
  timezone,
  sort,
  onSort,
  refreshing,
  onRefresh,
  onCreate,
  onDrop
}: {
  isLoading: boolean
  error: unknown
  indexes: IndexInfo[]
  report: IndexStatsReport | undefined
  statsLoading: boolean
  statsError: Error | null
  now: number
  timezone: string
  sort: IndexSort
  onSort: (key: IndexSortKey) => void
  refreshing: boolean
  onRefresh: () => void
  onCreate: () => void
  onDrop: (idx: IndexInfo) => void
}) {
  const rows = useMemo(
    () => sortIndexRows(buildIndexRows(indexes, report, now), sort),
    [indexes, report, now, sort]
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading indexes…
      </div>
    )
  }
  if (error instanceof ApiError) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <ServerCrash className="mt-0.5 h-4 w-4" />
        <div>
          <div className="font-medium">Could not list indexes</div>
          <div className="text-xs opacity-80">{error.message}</div>
        </div>
      </div>
    )
  }

  const usageUnavailable = report?.usageUnavailable ?? null
  const storageUnavailable = report?.storageUnavailable ?? null
  const hasUsage = usageAvailable(report)
  const sizes = rows.flatMap((r) => (r.size === undefined ? [] : [r.size]))
  const sources = report && hasUsage ? usageSources(report) : null

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {indexes.length} index{indexes.length === 1 ? '' : 'es'}
          {sizes.length > 0 && ` · ${formatBytes(sizes.reduce((sum, size) => sum + size, 0))}`}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" /> New index
          </Button>
        </div>
      </div>
      {(statsError !== null || usageUnavailable !== null || storageUnavailable !== null) && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" />
          <div className="grid gap-0.5">
            {statsError !== null && (
              <div>
                Could not read index statistics: {statsError.message}{' '}
                <button type="button" onClick={onRefresh} className="underline hover:no-underline">
                  Retry
                </button>
              </div>
            )}
            {usageUnavailable !== null && (
              <Tooltip content={usageUnavailable.message}>
                <div className="w-fit">{unavailableText('usage', usageUnavailable)}</div>
              </Tooltip>
            )}
            {storageUnavailable !== null && (
              <Tooltip content={storageUnavailable.message}>
                <div className="w-fit">{unavailableText('storage', storageUnavailable)}</div>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      <div className="max-h-[60vh] overflow-auto rounded-md border">
        <table className="w-full text-xs">
          {/* z-10: spinning badges are transformed and would otherwise paint over the sticky header. */}
          <thead className="sticky top-0 z-10 bg-background text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr className="bg-muted/40">
              <SortableHeader label="Name" sortKey="name" sort={sort} onSort={onSort} />
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Properties</th>
              <SortableHeader
                label="Size"
                sortKey="size"
                sort={sort}
                onSort={onSort}
                disabled={report === undefined || storageUnavailable !== null}
                alignRight
              />
              <SortableHeader
                label="Usage"
                sortKey="ops"
                sort={sort}
                onSort={onSort}
                disabled={!hasUsage}
                alignRight
              />
              <th className="w-px px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index.name} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2 align-top font-mono">{row.index.name}</td>
                <td className="px-3 py-2 align-top">
                  <div className="flex flex-wrap gap-1 font-mono">
                    {Object.entries(row.index.key).map(([field, dir]) => (
                      <span
                        key={field}
                        className="rounded-sm border bg-background px-1.5 py-0.5 text-[10px]"
                      >
                        {field}: {String(dir)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="flex flex-wrap gap-1">
                    {indexBadges(row.index, row.building).map((b) => (
                      <span
                        key={b.label}
                        className="flex items-center gap-1 rounded-sm border bg-background px-1.5 py-0.5 text-[10px]"
                        title={b.title}
                      >
                        {b.icon}
                        {b.label}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-top font-mono text-[10px] tabular-nums text-muted-foreground">
                  {statsLoading ? '…' : row.size !== undefined ? formatBytes(row.size) : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">
                  <UsageCell
                    row={row}
                    statsLoading={statsLoading}
                    hasUsage={hasUsage}
                    now={now}
                    timezone={timezone}
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground"
                    disabled={row.index.name === '_id_'}
                    onClick={() => onDrop(row.index)}
                    aria-label="Drop"
                    title={
                      row.index.name === '_id_'
                        ? 'The default _id_ index cannot be dropped'
                        : 'Drop'
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sources !== null && sources.hosts.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {sources.hosts.length === 1
            ? `Usage counted on ${sources.hosts[0]} only; counters reset when it restarts or the index changes.`
            : `Usage summed over ${sources.hosts.length} mongods${
                sources.shards.length > 0
                  ? ` across ${sources.shards.length} shard${sources.shards.length === 1 ? '' : 's'}`
                  : ''
              }; counters reset when a mongod restarts.`}
        </p>
      )}
    </div>
  )
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  disabled,
  alignRight
}: {
  label: string
  sortKey: IndexSortKey
  sort: IndexSort
  onSort: (key: IndexSortKey) => void
  disabled?: boolean
  alignRight?: boolean
}) {
  const dir = sort?.key === sortKey ? sort.dir : null
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown
  return (
    <th
      className={cn('px-3 py-2 font-medium', alignRight && 'text-right')}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 uppercase hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          // The icon leads in right-aligned columns so the label lines up with the values.
          alignRight && 'flex-row-reverse'
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', dir === null && 'opacity-40')} />
      </button>
    </th>
  )
}

function UsageCell({
  row,
  statsLoading,
  hasUsage,
  now,
  timezone
}: {
  row: IndexRow
  statsLoading: boolean
  hasUsage: boolean
  now: number
  timezone: string
}) {
  if (statsLoading) return <span className="text-muted-foreground">…</span>
  if (row.building) return <span className="text-[10px] text-muted-foreground">building</span>
  if (!hasUsage) return <span className="text-muted-foreground">—</span>
  const { usage } = row
  if (usage === null) {
    return (
      <Tooltip content="No usage reported for this index.">
        <span className="text-muted-foreground">—</span>
      </Tooltip>
    )
  }

  const notes = usageNotes(row, now)
  return (
    <Tooltip
      content={
        <div className="grid gap-0.5">
          <div>
            {usage.ops.toLocaleString('en-US')} ops since {formatDateInZone(usage.since, timezone)}
          </div>
          {usage.hosts.length > 1 &&
            usage.hosts.map((h, i) => (
              <div key={i} className="font-mono text-[10px]">
                {h.shard !== undefined && `${h.shard} · `}
                {h.host} — {h.ops.toLocaleString('en-US')} since{' '}
                {formatDateInZone(h.since, timezone)}
              </div>
            ))}
          {notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      }
    >
      <div>
        <div
          className={cn(
            'font-mono',
            row.unused ? 'text-amber-400' : usage.ops === 0 && 'text-muted-foreground'
          )}
        >
          {formatCount(usage.ops)}
        </div>
        {row.unused ? (
          <div className="flex items-center justify-end gap-1 text-[10px] text-amber-400">
            <CircleOff className="h-3 w-3" />
            unused for {formatAge(now - usage.coveredSince)}
          </div>
        ) : (
          <div className="text-[10px] text-muted-foreground">
            {usage.ops > 0 && usage.opsPerDay !== null
              ? `${formatRate(usage.opsPerDay)} over ${formatAge(now - usage.since)}`
              : `over ${formatAge(now - usage.since)}`}
          </div>
        )}
      </div>
    </Tooltip>
  )
}

function indexBadges(
  idx: IndexInfo,
  building: boolean
): Array<{ label: string; icon: JSX.Element; title?: string }> {
  const badges: Array<{ label: string; icon: JSX.Element; title?: string }> = []
  if (building) {
    badges.push({
      label: 'building',
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      title: 'Index build in progress'
    })
  }
  if (idx.unique) badges.push({ label: 'unique', icon: <Lock className="h-3 w-3" /> })
  if (idx.sparse) badges.push({ label: 'sparse', icon: <Sparkles className="h-3 w-3" /> })
  if (idx.hidden) {
    badges.push({
      label: 'hidden',
      icon: <EyeOff className="h-3 w-3" />,
      title: 'Hidden from the query planner'
    })
  }
  if (idx.expireAfterSeconds !== undefined) {
    badges.push({
      label: `TTL ${idx.expireAfterSeconds}s`,
      icon: <Timer className="h-3 w-3" />,
      title: 'expireAfterSeconds'
    })
  }
  if (idx.partialFilterExpression !== undefined) {
    badges.push({
      label: 'partial',
      icon: <Key className="h-3 w-3" />,
      title: JSON.stringify(idx.partialFilterExpression)
    })
  }
  if (idx.collation !== undefined) {
    badges.push({
      label: 'collation',
      icon: <Hash className="h-3 w-3" />,
      title: JSON.stringify(idx.collation)
    })
  }
  if (idx.weights !== undefined) {
    badges.push({
      label: 'weights',
      icon: <Hash className="h-3 w-3" />,
      title: JSON.stringify(idx.weights)
    })
  }
  if (idx.wildcardProjection !== undefined) {
    badges.push({
      label: 'wildcardProjection',
      icon: <Key className="h-3 w-3" />,
      title: JSON.stringify(idx.wildcardProjection)
    })
  }
  return badges
}

type KeyRow = { field: string; type: string }

type FormState = {
  rows: KeyRow[]
  name: string
  unique: boolean
  sparse: boolean
  hidden: boolean
  ttlEnabled: boolean
  ttlSeconds: string
  partialFilter: string
  collation: string
  weights: string
  default_language: string
  language_override: string
  textIndexVersion: string
  spheroidVersion: string
  bits: string
  min: string
  max: string
  wildcardProjection: string
}

const initialFormState = (): FormState => ({
  rows: [{ field: '', type: '1' }],
  name: '',
  unique: false,
  sparse: false,
  hidden: false,
  ttlEnabled: false,
  ttlSeconds: '',
  partialFilter: '',
  collation: '',
  weights: '',
  default_language: '',
  language_override: '',
  textIndexVersion: '',
  spheroidVersion: '',
  bits: '',
  min: '',
  max: '',
  wildcardProjection: ''
})

function CreateIndexForm({
  connectionId,
  db,
  coll,
  onDone
}: {
  connectionId: string
  db: string
  coll: string
  onDone: () => void
}) {
  const [state, setState] = useState<FormState>(() => initialFormState())
  const [serverError, setServerError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const queryClient = useQueryClient()

  // Best-effort: an empty or failed sample just means no suggestions.
  const fieldPathsQuery = useQuery({
    ...collectionSchemaQuery(connectionId, db, coll),
    select: schemaFieldPaths
  })
  const fieldSuggestions = fieldPathsQuery.data ?? []

  const hasText = state.rows.some((r) => r.type === 'text')
  const hasGeoSphere = state.rows.some((r) => r.type === '2dsphere')
  const hasGeo2d = state.rows.some((r) => r.type === '2d')
  const hasWildcard = state.rows.some((r) => r.field.endsWith('$**') || r.field === '$**')
  const ttlEligible =
    state.rows.length === 1 && (state.rows[0]?.type === '1' || state.rows[0]?.type === '-1')

  const validation = useMemo(() => validateForm(state, ttlEligible), [state, ttlEligible])

  const buildPayload = (): {
    keys: string
    options?: IndexCreateOptions
  } | null => {
    const keys: Record<string, unknown> = {}
    for (const row of state.rows) {
      const f = row.field.trim()
      if (!f) continue
      if (row.type === '1') keys[f] = 1
      else if (row.type === '-1') keys[f] = -1
      else keys[f] = row.type
    }
    if (Object.keys(keys).length === 0) return null

    const options: IndexCreateOptions = {}
    if (state.name.trim()) options.name = state.name.trim()
    if (state.unique) options.unique = true
    if (state.sparse) options.sparse = true
    if (state.hidden) options.hidden = true
    if (state.ttlEnabled && state.ttlSeconds.trim()) {
      const n = Number(state.ttlSeconds.trim())
      if (Number.isFinite(n) && n >= 0) options.expireAfterSeconds = Math.floor(n)
    }
    if (state.partialFilter.trim()) options.partialFilterExpression = state.partialFilter.trim()
    if (state.collation.trim()) options.collation = state.collation.trim()
    if (hasText) {
      if (state.weights.trim()) options.weights = state.weights.trim()
      if (state.default_language.trim()) options.default_language = state.default_language.trim()
      if (state.language_override.trim()) options.language_override = state.language_override.trim()
      if (state.textIndexVersion.trim())
        options.textIndexVersion = Number(state.textIndexVersion.trim())
    }
    if (hasGeoSphere && state.spheroidVersion.trim()) {
      options['2dsphereIndexVersion'] = Number(state.spheroidVersion.trim())
    }
    if (hasGeo2d) {
      if (state.bits.trim()) options.bits = Number(state.bits.trim())
      if (state.min.trim()) options.min = Number(state.min.trim())
      if (state.max.trim()) options.max = Number(state.max.trim())
    }
    if (hasWildcard && state.wildcardProjection.trim()) {
      options.wildcardProjection = state.wildcardProjection.trim()
    }

    return {
      keys: JSON.stringify(keys),
      ...(Object.keys(options).length > 0 ? { options } : {})
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const payload = buildPayload()
      if (!payload) throw new Error('At least one key field is required')
      return api.indexes.create({ connectionId, db, coll, ...payload })
    },
    onSuccess: ({ name }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.indexes(connectionId, db, coll) })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.collectionStats(connectionId, db, coll)
      })
      toast.success(`Created index ${name}`)
      onDone()
    },
    onError: (e: unknown) => {
      setServerError(e instanceof ApiError ? e.message : String(e))
    }
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (validation) return
    setServerError(null)
    mutation.mutate()
  }

  const updateRow = (i: number, patch: Partial<KeyRow>) =>
    setState((s) => ({
      ...s,
      rows: s.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))
    }))
  const addRow = () => setState((s) => ({ ...s, rows: [...s.rows, { field: '', type: '1' }] }))
  const removeRow = (i: number) =>
    setState((s) => ({
      ...s,
      rows: s.rows.length === 1 ? s.rows : s.rows.filter((_, idx) => idx !== i)
    }))

  return (
    <form onSubmit={onSubmit} className="grid max-h-[70vh] gap-4 overflow-auto pr-1">
      <div className="grid gap-2">
        <Label className="text-[10px] uppercase tracking-wider">Key fields</Label>
        <div className="grid gap-2">
          {state.rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <AutocompleteInput
                wrapperClassName="flex-1"
                value={row.field}
                onValueChange={(field) => updateRow(i, { field })}
                suggestions={fieldSuggestions}
                autoFocus={i === 0}
                placeholder="field.path  (use foo.$**  for wildcard)"
                spellCheck={false}
              />
              <div className="w-44">
                <Select value={row.type} onValueChange={(v) => updateRow(i, { type: v })}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KEY_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => removeRow(i)}
                disabled={state.rows.length === 1}
                aria-label="Remove field"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <div>
          <Button type="button" size="sm" variant="outline" onClick={addRow}>
            <Plus className="h-3.5 w-3.5" /> Add field
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Order matters for compound indexes. For a wildcard index, set the field to{' '}
          <span className="font-mono">$**</span> or <span className="font-mono">path.$**</span>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="idx-name">Name (optional)</Label>
          <Input
            id="idx-name"
            value={state.name}
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
            spellCheck={false}
            className="font-mono"
            placeholder="auto: field_1_field2_-1"
          />
        </div>
        <div className="grid grid-cols-3 items-end gap-2">
          <Toggle
            label="Unique"
            checked={state.unique}
            onChange={(v) => setState((s) => ({ ...s, unique: v }))}
          />
          <Toggle
            label="Sparse"
            checked={state.sparse}
            onChange={(v) => setState((s) => ({ ...s, sparse: v }))}
          />
          <Toggle
            label="Hidden"
            checked={state.hidden}
            onChange={(v) => setState((s) => ({ ...s, hidden: v }))}
          />
        </div>
      </div>

      <div className="grid gap-2 rounded-md border bg-card p-3">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <Timer className="h-3.5 w-3.5" />
            TTL (expireAfterSeconds)
          </Label>
          <Switch
            checked={state.ttlEnabled}
            onCheckedChange={(v) => setState((s) => ({ ...s, ttlEnabled: v }))}
            disabled={!ttlEligible}
          />
        </div>
        {state.ttlEnabled && (
          <Input
            type="number"
            min={0}
            value={state.ttlSeconds}
            onChange={(e) => setState((s) => ({ ...s, ttlSeconds: e.target.value }))}
            placeholder="seconds"
            className="font-mono"
          />
        )}
        <p className="text-[10px] text-muted-foreground">
          {ttlEligible
            ? 'Documents are removed once the indexed date is older than this many seconds. Single-field ascending/descending only.'
            : 'TTL is only valid on a single ascending/descending index over a Date field.'}
        </p>
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {showAdvanced ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Advanced options
      </button>

      {showAdvanced && (
        <div className="grid gap-4 rounded-md border bg-card p-3">
          <EjsonField
            label="Partial filter expression"
            hint="Only documents matching this filter are indexed. EJSON object."
            value={state.partialFilter}
            onChange={(v) => setState((s) => ({ ...s, partialFilter: v }))}
            placeholder='{ "status": "active" }'
          />

          <EjsonField
            label="Collation"
            hint='Locale-aware comparison rules. e.g. { "locale": "en", "strength": 2 }.'
            value={state.collation}
            onChange={(v) => setState((s) => ({ ...s, collation: v }))}
            placeholder='{ "locale": "en", "strength": 2 }'
          />

          {hasText && (
            <div className="grid gap-3 rounded-md border-l-2 border-l-primary/40 bg-background p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Text index
              </div>
              <EjsonField
                label="Weights"
                hint="Per-field relevance weight. Higher = more important."
                value={state.weights}
                onChange={(v) => setState((s) => ({ ...s, weights: v }))}
                placeholder='{ "title": 10, "body": 1 }'
                rows={2}
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Default language</Label>
                  <Input
                    value={state.default_language}
                    onChange={(e) => setState((s) => ({ ...s, default_language: e.target.value }))}
                    placeholder="english"
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Language override field</Label>
                  <Input
                    value={state.language_override}
                    onChange={(e) => setState((s) => ({ ...s, language_override: e.target.value }))}
                    placeholder="language"
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Text index version</Label>
                  <Input
                    type="number"
                    min={1}
                    max={3}
                    value={state.textIndexVersion}
                    onChange={(e) => setState((s) => ({ ...s, textIndexVersion: e.target.value }))}
                    placeholder="3"
                    className="font-mono"
                  />
                </div>
              </div>
            </div>
          )}

          {hasGeoSphere && (
            <div className="grid gap-3 rounded-md border-l-2 border-l-primary/40 bg-background p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                2dsphere
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">2dsphereIndexVersion</Label>
                  <Input
                    type="number"
                    min={1}
                    max={3}
                    value={state.spheroidVersion}
                    onChange={(e) => setState((s) => ({ ...s, spheroidVersion: e.target.value }))}
                    placeholder="3"
                    className="font-mono"
                  />
                </div>
              </div>
            </div>
          )}

          {hasGeo2d && (
            <div className="grid gap-3 rounded-md border-l-2 border-l-primary/40 bg-background p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                2d (legacy geo)
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Bits</Label>
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={state.bits}
                    onChange={(e) => setState((s) => ({ ...s, bits: e.target.value }))}
                    placeholder="26"
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Min</Label>
                  <Input
                    type="number"
                    value={state.min}
                    onChange={(e) => setState((s) => ({ ...s, min: e.target.value }))}
                    placeholder="-180"
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Max</Label>
                  <Input
                    type="number"
                    value={state.max}
                    onChange={(e) => setState((s) => ({ ...s, max: e.target.value }))}
                    placeholder="180"
                    className="font-mono"
                  />
                </div>
              </div>
            </div>
          )}

          {hasWildcard && (
            <div className="grid gap-3 rounded-md border-l-2 border-l-primary/40 bg-background p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Wildcard
              </div>
              <EjsonField
                label="wildcardProjection"
                hint="Paths to include or exclude from a $** index. Cannot mix include/exclude (except for _id)."
                value={state.wildcardProjection}
                onChange={(v) => setState((s) => ({ ...s, wildcardProjection: v }))}
                placeholder='{ "fieldA": 1, "fieldB.subfield": 1 }'
                rows={2}
              />
            </div>
          )}
        </div>
      )}

      {validation && <p className="text-xs text-destructive">{validation}</p>}
      {serverError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {serverError}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={validation !== null || mutation.isPending}>
          {mutation.isPending && <Loader2 className="animate-spin" />}
          Create index
        </Button>
      </DialogFooter>
    </form>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-xs',
        checked ? 'border-primary/40 text-foreground' : 'text-muted-foreground'
      )}
    >
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function EjsonField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows = 3
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  const parseError = useMemo(() => {
    if (!value.trim()) return null
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'Must be a JSON object'
      }
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid JSON'
    }
  }, [value])

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={rows}
        placeholder={placeholder}
        className="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      {parseError && <p className="text-xs text-destructive">{parseError}</p>}
    </div>
  )
}

function validateForm(state: FormState, ttlEligible: boolean): string | null {
  const filledRows = state.rows.filter((r) => r.field.trim())
  if (filledRows.length === 0) return 'At least one key field is required'

  const seen = new Set<string>()
  for (const r of filledRows) {
    const f = r.field.trim()
    if (seen.has(f)) return `Duplicate key field "${f}"`
    seen.add(f)
  }

  if (state.ttlEnabled) {
    if (!ttlEligible) {
      return 'TTL requires exactly one ascending/descending field'
    }
    const n = Number(state.ttlSeconds)
    if (!state.ttlSeconds.trim() || !Number.isFinite(n) || n < 0) {
      return 'TTL seconds must be a non-negative number'
    }
  }

  for (const [label, raw] of [
    ['Partial filter', state.partialFilter],
    ['Collation', state.collation],
    ['Weights', state.weights],
    ['wildcardProjection', state.wildcardProjection]
  ] as const) {
    if (!raw.trim()) continue
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `${label} must be a JSON object`
      }
    } catch (e) {
      return `${label}: ${e instanceof Error ? e.message : 'invalid JSON'}`
    }
  }

  return null
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
