import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, Eye, Loader2, Play, Plus, Wand2, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { parseMongoQuery } from '@/lib/mongoQueryLang'
import type { CollectionTab, QueryPatch } from '@/store/tabs'
import type { DocumentEnvelope, UuidEncoding } from '@shared/types'
import { ExportButton } from './ExportButton'
import { QueryEditor } from './QueryEditor'

export function QueryToolbar({
  tab,
  onApply,
  loading,
  documents,
  uuidEncoding,
  timezone,
  compiledFilter,
  compiledProjection,
  compiledSort
}: {
  tab: CollectionTab
  onApply: (patch: QueryPatch) => void
  loading: boolean
  documents: DocumentEnvelope[]
  uuidEncoding: UuidEncoding
  timezone: string
  compiledFilter: string | null
  compiledProjection: string | null
  compiledSort: string | null
}) {
  const [filter, setFilter] = useState(tab.filter)
  const [projection, setProjection] = useState(tab.projection)
  const [sort, setSort] = useState(tab.sort)
  const [limit, setLimit] = useState(tab.limit > 0 ? String(tab.limit) : '')

  // Force-expand state for empty Sort / Projection so the editor stays
  // visible after the user opens it but before they type anything.
  const [sortOpen, setSortOpen] = useState(false)
  const [projectionOpen, setProjectionOpen] = useState(false)

  useEffect(() => {
    setFilter(tab.filter)
    setProjection(tab.projection)
    setSort(tab.sort)
    setLimit(tab.limit > 0 ? String(tab.limit) : '')
    setSortOpen(false)
    setProjectionOpen(false)
  }, [tab.id, tab.filter, tab.projection, tab.sort, tab.limit])

  const filterStatus = useMemo(() => parseStatus(filter), [filter])
  const projectionStatus = useMemo(() => parseStatus(projection), [projection])
  const sortStatus = useMemo(() => parseStatus(sort), [sort])

  const anyInvalid =
    filterStatus.kind === 'invalid' ||
    projectionStatus.kind === 'invalid' ||
    sortStatus.kind === 'invalid'

  const sortShown = sortOpen || sort.trim().length > 0
  const projectionShown = projectionOpen || projection.trim().length > 0

  const apply = (e?: FormEvent) => {
    e?.preventDefault()
    if (anyInvalid) return
    const limitNum = Number.parseInt(limit, 10)
    const nextLimit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 0
    onApply({ filter, projection, sort, skip: 0, limit: nextLimit })
  }

  const removeSort = () => {
    setSort('')
    setSortOpen(false)
  }
  const removeProjection = () => {
    setProjection('')
    setProjectionOpen(false)
  }

  const formatField = (status: ParseStatus, setter: (next: string) => void): void => {
    if (status.kind !== 'ok') return
    try {
      const parsed = JSON.parse(status.ejson)
      setter(JSON.stringify(parsed, null, 2))
    } catch {
      // ok-status guarantees parseable EJSON; nothing actionable here.
    }
  }

  return (
    <form onSubmit={apply} className="grid gap-1.5 border-b bg-card/30 px-4 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <QueryEditor
            value={filter}
            onChange={setFilter}
            onSubmit={() => apply()}
            onFormat={() => formatField(filterStatus, setFilter)}
            hasError={filterStatus.kind === 'invalid'}
            minHeight={32}
            maxHeight={180}
            placeholder='filter ·  { _id: ObjectId("…"), createdAt: { $gt: ISODate("2024-01-01") } }     ⌘/Ctrl-Enter to run'
            actions={
              <>
                {filterStatus.kind === 'invalid' && <ErrorTag title={filterStatus.error} />}
                <FormatButton
                  disabled={filterStatus.kind !== 'ok'}
                  onClick={() => formatField(filterStatus, setFilter)}
                />
              </>
            }
          />
        </div>
        <LimitInput value={limit} onChange={setLimit} />
        <Tooltip content="Run · ⌘/Ctrl-Enter">
          <Button
            type="submit"
            size="sm"
            disabled={loading || anyInvalid}
            className="h-8 shrink-0 px-3"
          >
            {loading ? <Loader2 className="animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </Tooltip>
        <ExportButton
          connectionId={tab.connectionId}
          db={tab.db}
          coll={tab.coll}
          filter={compiledFilter}
          projection={compiledProjection}
          sort={compiledSort}
          currentDocCount={documents.length}
          uuidEncoding={uuidEncoding}
          timezone={timezone}
          disabled={anyInvalid}
        />
      </div>

      <div className="flex flex-wrap items-stretch gap-1.5">
        {sortShown ? (
          <OptionRow
            icon={<ArrowDownUp className="h-3 w-3" />}
            label="Sort"
            placeholder="{ createdAt: -1 }"
            value={sort}
            onChange={setSort}
            onSubmit={() => apply()}
            onFormat={() => formatField(sortStatus, setSort)}
            onRemove={removeSort}
            status={sortStatus}
            autoFocus={sortOpen && sort.length === 0}
          />
        ) : (
          <AddPill
            icon={<ArrowDownUp className="h-3 w-3" />}
            label="Sort"
            onClick={() => setSortOpen(true)}
          />
        )}
        {projectionShown ? (
          <OptionRow
            icon={<Eye className="h-3 w-3" />}
            label="Projection"
            placeholder="{ name: 1, _id: 0 }"
            value={projection}
            onChange={setProjection}
            onSubmit={() => apply()}
            onFormat={() => formatField(projectionStatus, setProjection)}
            onRemove={removeProjection}
            status={projectionStatus}
            autoFocus={projectionOpen && projection.length === 0}
          />
        ) : (
          <AddPill
            icon={<Eye className="h-3 w-3" />}
            label="Projection"
            onClick={() => setProjectionOpen(true)}
          />
        )}
      </div>
    </form>
  )
}

function LimitInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <Tooltip content="Empty or 0 = fetch all matching documents">
      <label className="flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-input bg-background">
        <span className="flex items-center bg-muted/40 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          limit
        </span>
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="all"
          className="w-16 bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/50"
        />
      </label>
    </Tooltip>
  )
}

function OptionRow({
  icon,
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  onFormat,
  onRemove,
  status,
  autoFocus
}: {
  icon: React.ReactNode
  label: string
  placeholder: string
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  onFormat: () => void
  onRemove: () => void
  status: ParseStatus
  autoFocus?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 basis-[280px] items-stretch gap-1.5">
      <div className="flex shrink-0 items-center gap-1 rounded-md border border-input bg-muted/30 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="min-w-0 flex-1">
        <QueryEditor
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onFormat={onFormat}
          hasError={status.kind === 'invalid'}
          minHeight={30}
          maxHeight={120}
          placeholder={placeholder}
          autoFocus={autoFocus}
          actions={
            <>
              {status.kind === 'invalid' && <ErrorTag title={status.error} />}
              <FormatButton disabled={status.kind !== 'ok'} onClick={onFormat} />
            </>
          }
        />
      </div>
      <Tooltip content={`Remove ${label.toLowerCase()}`}>
        <button
          type="button"
          onClick={onRemove}
          className="flex h-[30px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          aria-label={`Remove ${label.toLowerCase()}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  )
}

function FormatButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content="Format · Shift+Alt+F">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-sm transition-colors',
          disabled
            ? 'cursor-not-allowed text-muted-foreground/30'
            : 'text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground'
        )}
        aria-label="Format"
      >
        <Wand2 className="h-3 w-3" />
      </button>
    </Tooltip>
  )
}

function AddPill({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md border border-dashed border-input bg-transparent px-2.5 text-[11px] text-muted-foreground transition-colors',
        'hover:border-input/80 hover:bg-accent/40 hover:text-foreground'
      )}
    >
      <Plus className="h-3 w-3" />
      {icon}
      <span className="uppercase tracking-wider">{label}</span>
    </button>
  )
}

function ErrorTag({ title }: { title: string }) {
  return (
    <Tooltip content={title}>
      <span className="flex items-center gap-1 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-destructive">
        <XCircle className="h-3 w-3" />
        invalid
      </span>
    </Tooltip>
  )
}

type ParseStatus =
  | { kind: 'empty' }
  | { kind: 'ok'; ejson: string }
  | { kind: 'invalid'; error: string }

function parseStatus(value: string): ParseStatus {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  const result = parseMongoQuery(trimmed)
  if (!result.ok) return { kind: 'invalid', error: result.error }
  if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return { kind: 'invalid', error: 'Must be an object' }
  }
  return { kind: 'ok', ejson: result.ejson }
}
