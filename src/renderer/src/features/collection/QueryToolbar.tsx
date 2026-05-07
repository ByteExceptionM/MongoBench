import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, Eye, Play, Wand2, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { parseMongoQuery } from '@/lib/mongoQueryLang'
import { parseShellCommand, type ShellParseResult } from '@/lib/shellParser'
import type { CollectionTab, QueryMode, QueryPatch } from '@/store/tabs'
import type { DocumentEnvelope, UuidEncoding } from '@shared/types'
import { ExportButton } from './ExportButton'
import { QueryEditor, setDocumentFieldNames } from './QueryEditor'

const EMPTY_OBJECT = '{}'
const EMPTY_ARRAY = '[]'
const objOrDefault = (s: string): string => (s.trim().length === 0 ? EMPTY_OBJECT : s)
const arrOrDefault = (s: string): string => (s.trim().length === 0 ? EMPTY_ARRAY : s)

const MODES: ReadonlyArray<{ id: QueryMode; label: string }> = [
  { id: 'simple', label: 'Simple' },
  { id: 'aggregation', label: 'Aggregation' },
  { id: 'shell', label: 'Shell' }
]

export function QueryToolbar({
  tab,
  onApply,
  onCancel,
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
  onCancel: () => void
  loading: boolean
  documents: DocumentEnvelope[]
  uuidEncoding: UuidEncoding
  timezone: string
  compiledFilter: string | null
  compiledProjection: string | null
  compiledSort: string | null
}) {
  const [filter, setFilter] = useState(() => objOrDefault(tab.filter))
  const [projection, setProjection] = useState(() => objOrDefault(tab.projection))
  const [sort, setSort] = useState(() => objOrDefault(tab.sort))
  const [pipeline, setPipeline] = useState(() => arrOrDefault(tab.pipeline))
  const [shell, setShell] = useState(() => tab.shell)
  const [limit, setLimit] = useState(tab.limit > 0 ? String(tab.limit) : '')

  useEffect(() => {
    setFilter(objOrDefault(tab.filter))
    setProjection(objOrDefault(tab.projection))
    setSort(objOrDefault(tab.sort))
    setPipeline(arrOrDefault(tab.pipeline))
    setShell(tab.shell)
    setLimit(tab.limit > 0 ? String(tab.limit) : '')
  }, [tab.id, tab.filter, tab.projection, tab.sort, tab.pipeline, tab.shell, tab.limit])

  // Cache distinct top-level field names from the most recent fetch so
  // the editor can offer them as completions in any input.
  useEffect(() => {
    const names = new Set<string>()
    for (const env of documents) {
      for (const key of Object.keys(env.data)) names.add(key)
    }
    setDocumentFieldNames(names)
  }, [documents])

  const filterStatus = useMemo(() => parseObjectStatus(filter), [filter])
  const projectionStatus = useMemo(() => parseObjectStatus(projection), [projection])
  const sortStatus = useMemo(() => parseObjectStatus(sort), [sort])
  const pipelineStatus = useMemo(() => parsePipelineStatus(pipeline), [pipeline])
  const shellStatus = useMemo(() => parseShellStatus(shell, tab.coll), [shell, tab.coll])

  const simpleInvalid =
    filterStatus.kind === 'invalid' ||
    projectionStatus.kind === 'invalid' ||
    sortStatus.kind === 'invalid'
  const modeInvalid =
    tab.mode === 'simple'
      ? simpleInvalid
      : tab.mode === 'aggregation'
        ? pipelineStatus.kind !== 'ok'
        : shellStatus.kind !== 'ok'

  const apply = (e?: FormEvent) => {
    e?.preventDefault()
    if (modeInvalid || loading) return
    // Bumping runEpoch guarantees a fresh fetch even when none of the
    // mode-specific params changed (e.g. the user pressed Run twice on
    // the same filter). Tab switches don't go through here.
    const runEpoch = tab.runEpoch + 1
    if (tab.mode === 'simple') {
      const limitNum = Number.parseInt(limit, 10)
      const nextLimit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 0
      onApply({ filter, projection, sort, skip: 0, limit: nextLimit, runEpoch })
    } else if (tab.mode === 'aggregation') {
      onApply({ pipeline, skip: 0, runEpoch })
    } else {
      onApply({ shell, skip: 0, runEpoch })
    }
  }

  const setMode = (mode: QueryMode) => {
    if (mode === tab.mode) return
    onApply({ mode })
  }

  const formatObject = (status: ObjectStatus, setter: (next: string) => void): void => {
    if (status.kind !== 'ok') return
    try {
      setter(JSON.stringify(JSON.parse(status.ejson), null, 2))
    } catch {
      // ok-status guarantees parseable EJSON.
    }
  }
  const formatPipeline = () => {
    if (pipelineStatus.kind !== 'ok') return
    try {
      setPipeline(JSON.stringify(JSON.parse(pipelineStatus.ejson), null, 2))
    } catch {
      // unreachable
    }
  }

  return (
    <form onSubmit={apply} className="border-b bg-card/30">
      <div className="flex h-12 items-stretch justify-between border-b pr-4">
        <ModeTabs current={tab.mode} onChange={setMode} />
        <div className="flex items-center gap-2">
          {tab.mode === 'simple' && <LimitInput value={limit} onChange={setLimit} />}
          {loading ? (
            <Tooltip content="Cancel">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={onCancel}
                className="h-8 shrink-0 px-3"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </Tooltip>
          ) : (
            <Tooltip content="Run · ⌘/Ctrl-Enter">
              <Button type="submit" size="sm" className="h-8 shrink-0 px-3">
                <Play className="h-3.5 w-3.5" />
                Run
              </Button>
            </Tooltip>
          )}
          {tab.mode === 'simple' && (
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
              disabled={simpleInvalid}
            />
          )}
        </div>
      </div>

      <div className="grid gap-1.5 px-4 py-2">
        {tab.mode === 'simple' && (
          <SimpleBody
            filter={filter}
            setFilter={setFilter}
            filterStatus={filterStatus}
            sort={sort}
            setSort={setSort}
            sortStatus={sortStatus}
            projection={projection}
            setProjection={setProjection}
            projectionStatus={projectionStatus}
            onSubmit={() => apply()}
            formatObject={formatObject}
          />
        )}

        {tab.mode === 'aggregation' && (
          <AggregationBody
            pipeline={pipeline}
            setPipeline={setPipeline}
            status={pipelineStatus}
            onSubmit={() => apply()}
            onFormat={formatPipeline}
          />
        )}

        {tab.mode === 'shell' && (
          <ShellBody
            coll={tab.coll}
            shell={shell}
            setShell={setShell}
            status={shellStatus}
            onSubmit={() => apply()}
          />
        )}
      </div>
    </form>
  )
}

function ModeTabs({ current, onChange }: { current: QueryMode; onChange: (m: QueryMode) => void }) {
  return (
    <div role="tablist" className="flex items-stretch">
      {MODES.map((m) => {
        const active = m.id === current
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m.id)}
            className={cn(
              'relative flex items-center px-4 text-[13px] font-medium tracking-tight transition-colors',
              active ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground'
            )}
          >
            {m.label}
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-t-sm bg-primary" />
            )}
          </button>
        )
      })}
    </div>
  )
}

function SimpleBody({
  filter,
  setFilter,
  filterStatus,
  sort,
  setSort,
  sortStatus,
  projection,
  setProjection,
  projectionStatus,
  onSubmit,
  formatObject
}: {
  filter: string
  setFilter: (next: string) => void
  filterStatus: ObjectStatus
  sort: string
  setSort: (next: string) => void
  sortStatus: ObjectStatus
  projection: string
  setProjection: (next: string) => void
  projectionStatus: ObjectStatus
  onSubmit: () => void
  formatObject: (status: ObjectStatus, setter: (next: string) => void) => void
}) {
  // Sort and Projection share their height: whichever editor's content is
  // taller pushes the shorter one to match. Each reports its natural
  // (pre-clamp) height; the max is fed back as both editors' minHeight.
  const [sortContentH, setSortContentH] = useState(30)
  const [projContentH, setProjContentH] = useState(30)
  const sharedRowH = Math.max(30, sortContentH, projContentH)

  return (
    <>
      <div className="min-w-0 flex-1">
        <QueryEditor
          value={filter}
          onChange={(next) => setFilter(objOrDefault(next))}
          onSubmit={onSubmit}
          onFormat={() => formatObject(filterStatus, setFilter)}
          hasError={filterStatus.kind === 'invalid'}
          minHeight={32}
          maxHeight={180}
          placeholder='filter ·  { _id: ObjectId("…"), createdAt: { $gt: ISODate("2024-01-01") } }     ⌘/Ctrl-Enter to run'
          actions={
            <>
              {filterStatus.kind === 'invalid' && <ErrorTag title={filterStatus.error} />}
              <FormatButton
                disabled={filterStatus.kind !== 'ok'}
                onClick={() => formatObject(filterStatus, setFilter)}
              />
            </>
          }
        />
      </div>

      <div className="flex flex-wrap items-stretch gap-1.5">
        <OptionRow
          icon={<ArrowDownUp className="h-3 w-3" />}
          label="Sort"
          placeholder="{ createdAt: -1 }"
          value={sort}
          onChange={setSort}
          onSubmit={onSubmit}
          onFormat={() => formatObject(sortStatus, setSort)}
          status={sortStatus}
          minHeight={sharedRowH}
          onContentHeight={setSortContentH}
        />
        <OptionRow
          icon={<Eye className="h-3 w-3" />}
          label="Projection"
          placeholder="{ name: 1, _id: 0 }"
          value={projection}
          onChange={setProjection}
          onSubmit={onSubmit}
          onFormat={() => formatObject(projectionStatus, setProjection)}
          status={projectionStatus}
          minHeight={sharedRowH}
          onContentHeight={setProjContentH}
        />
      </div>
    </>
  )
}

function AggregationBody({
  pipeline,
  setPipeline,
  status,
  onSubmit,
  onFormat
}: {
  pipeline: string
  setPipeline: (next: string) => void
  status: PipelineStatus
  onSubmit: () => void
  onFormat: () => void
}) {
  return (
    <div className="min-w-0 flex-1">
      <QueryEditor
        value={pipeline}
        onChange={(next) => setPipeline(arrOrDefault(next))}
        onSubmit={onSubmit}
        onFormat={onFormat}
        hasError={status.kind === 'invalid'}
        minHeight={120}
        maxHeight={400}
        placeholder={'[\n  { $match: { … } },\n  { $group: { _id: "$type", n: { $sum: 1 } } }\n]'}
        actions={
          <>
            {status.kind === 'invalid' && <ErrorTag title={status.error} />}
            <FormatButton disabled={status.kind !== 'ok'} onClick={onFormat} />
          </>
        }
      />
    </div>
  )
}

function ShellBody({
  coll,
  shell,
  setShell,
  status,
  onSubmit
}: {
  coll: string
  shell: string
  setShell: (next: string) => void
  status: ShellStatus
  onSubmit: () => void
}) {
  return (
    <div className="min-w-0 flex-1">
      <QueryEditor
        value={shell}
        onChange={setShell}
        onSubmit={onSubmit}
        hasError={status.kind === 'invalid'}
        minHeight={60}
        maxHeight={240}
        placeholder={`db.${coll}.find({ … }).sort({ … }).limit(50)`}
        actions={<>{status.kind === 'invalid' && <ErrorTag title={status.error} />}</>}
      />
    </div>
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
  status,
  minHeight,
  onContentHeight
}: {
  icon: React.ReactNode
  label: string
  placeholder: string
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  onFormat: () => void
  status: ObjectStatus
  minHeight: number
  onContentHeight: (px: number) => void
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
          onChange={(next) => onChange(objOrDefault(next))}
          onSubmit={onSubmit}
          onFormat={onFormat}
          hasError={status.kind === 'invalid'}
          minHeight={minHeight}
          maxHeight={120}
          placeholder={placeholder}
          onContentHeightChange={onContentHeight}
          actions={
            <>
              {status.kind === 'invalid' && <ErrorTag title={status.error} />}
              <FormatButton disabled={status.kind !== 'ok'} onClick={onFormat} />
            </>
          }
        />
      </div>
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

type ObjectStatus =
  | { kind: 'empty' }
  | { kind: 'ok'; ejson: string }
  | { kind: 'invalid'; error: string }

function parseObjectStatus(value: string): ObjectStatus {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  const result = parseMongoQuery(trimmed)
  if (!result.ok) return { kind: 'invalid', error: result.error }
  if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return { kind: 'invalid', error: 'Must be an object' }
  }
  return { kind: 'ok', ejson: result.ejson }
}

type PipelineStatus =
  | { kind: 'empty' }
  | { kind: 'ok'; ejson: string }
  | { kind: 'invalid'; error: string }

function parsePipelineStatus(value: string): PipelineStatus {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  const result = parseMongoQuery(trimmed)
  if (!result.ok) return { kind: 'invalid', error: result.error }
  if (!Array.isArray(result.value)) {
    return { kind: 'invalid', error: 'Must be an array of stage objects' }
  }
  for (const stage of result.value) {
    if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
      return { kind: 'invalid', error: 'Each stage must be an object' }
    }
  }
  return { kind: 'ok', ejson: result.ejson }
}

type ShellStatus =
  | { kind: 'empty' }
  | { kind: 'ok'; parsed: ShellParseResult & { ok: true } }
  | { kind: 'invalid'; error: string }

function parseShellStatus(value: string, expectedColl: string): ShellStatus {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  const parsed = parseShellCommand(trimmed)
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error }
  if (parsed.coll !== expectedColl) {
    return {
      kind: 'invalid',
      error: `Collection mismatch: this tab is "${expectedColl}", command targets "${parsed.coll}"`
    }
  }
  return { kind: 'ok', parsed }
}
