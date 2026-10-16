import { type FormEvent, useMemo, useState } from 'react'
import { ArrowDownUp, Eye, Loader2, PenLine, Play, Wand2, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { compilePipelineSource } from '@/lib/aggregationPipeline'
import type { CompletionBinding } from '@/lib/completion/monacoAdapter'
import type { CompletionEnv } from '@/lib/completion/useCompletionEnv'
import { formatMongoSource } from '@/lib/mongoFormat'
import { parseMongoQuery } from '@/lib/mongoQueryLang'
import type { SerializeOptions } from '@/lib/mongoQuerySerialize'
import { queryModelUri } from '@/lib/queryModelUri'
import type { CompiledFind, ShellWriteCommand } from '@/lib/queryRun'
import {
  formatShellCommand,
  parseShellCommand,
  shellCollectionAccessor,
  writeTargetName
} from '@/lib/shellParser'
import { useTabsStore, type CollectionTab, type QueryDraft, type QueryMode } from '@/store/tabs'
import type { UuidEncoding } from '@shared/types'
import { ExportButton } from './ExportButton'
import { QueryEditor } from './QueryEditor'

const MODES: ReadonlyArray<{ id: QueryMode; label: string }> = [
  { id: 'simple', label: 'Simple' },
  { id: 'aggregation', label: 'Aggregation' },
  { id: 'shell', label: 'Shell' }
]

type ToolbarProps = {
  tab: CollectionTab
  onCancel: () => void
  /** Runs a shell draft that writes; reads run through the store's `run`. */
  onRunWrite: (command: ShellWriteCommand) => void
  loading: boolean
  /** The shown shell write is running; it can't be cancelled. */
  writing: boolean
  completionEnv: CompletionEnv
  uuidEncoding: UuidEncoding
  timezone: string
  /** The applied Simple query, exported as is; null when it doesn't compile. */
  exportFind: CompiledFind | null
  /** Rows of the visible Simple page; seeds the export's document count. */
  exportDocCount: number
}

export function QueryToolbar(props: ToolbarProps) {
  const draft = useTabsStore((s) => s.drafts[props.tab.id])
  // Tabs and drafts are created and removed in one store update.
  if (!draft) return null
  return <QueryForm {...props} draft={draft} />
}

function QueryForm({
  tab,
  draft,
  onCancel,
  onRunWrite,
  loading,
  writing,
  completionEnv,
  uuidEncoding,
  timezone,
  exportFind,
  exportDocCount
}: ToolbarProps & { draft: QueryDraft }) {
  const setDraft = useTabsStore((s) => s.setDraft)
  const run = useTabsStore((s) => s.run)
  const setFilter = (filter: string) => setDraft(tab.id, { filter })
  const setProjection = (projection: string) => setDraft(tab.id, { projection })
  const setSort = (sort: string) => setDraft(tab.id, { sort })
  const setPipeline = (pipeline: string) => setDraft(tab.id, { pipeline })
  const setShell = (shell: string) => setDraft(tab.id, { shell })
  const setLimit = (limit: string) => setDraft(tab.id, { limit })

  const filterStatus = useMemo(() => parseObjectStatus(draft.filter), [draft.filter])
  const projectionStatus = useMemo(() => parseObjectStatus(draft.projection), [draft.projection])
  const sortStatus = useMemo(() => parseObjectStatus(draft.sort), [draft.sort])
  const pipelineStatus = useMemo(() => parsePipelineStatus(draft.pipeline), [draft.pipeline])
  const { status: shellStatus, write: shellWrite } = useMemo(
    () => parseShellDraft(draft.shell),
    [draft.shell]
  )
  const write = draft.mode === 'shell' ? shellWrite : null

  const blockedReason =
    draft.mode === 'simple'
      ? (invalidReason('Filter', filterStatus) ??
        invalidReason('Projection', projectionStatus) ??
        invalidReason('Sort', sortStatus))
      : draft.mode === 'aggregation'
        ? pipelineStatus.kind === 'empty'
          ? 'Add a pipeline, e.g. [{ $match: { … } }]'
          : invalidReason(null, pipelineStatus)
        : shellStatus.kind === 'empty'
          ? `Type a command, e.g. ${shellCollectionAccessor(tab.coll)}.find({})`
          : invalidReason(null, shellStatus)

  const apply = (e?: FormEvent) => {
    e?.preventDefault()
    if (blockedReason !== null || loading || writing) return
    if (write) onRunWrite(write)
    else run(tab.id)
  }

  const setMode = (mode: QueryMode) => {
    if (mode !== draft.mode) setDraft(tab.id, { mode })
  }

  const formatOptions: SerializeOptions = { timezone, uuidEncoding, indent: 2, printWidth: 80 }
  const formatSource = (value: string, setter: (next: string) => void): void => {
    const formatted = formatMongoSource(value, formatOptions)
    if (formatted !== null) setter(formatted)
  }
  const formatShell = (): void => {
    const formatted = formatShellCommand(draft.shell, formatOptions)
    if (formatted !== null) setShell(formatted)
  }

  return (
    <form onSubmit={apply} className="border-b bg-card/30">
      <div className="flex h-12 items-stretch justify-between border-b pr-4">
        <ModeTabs current={draft.mode} onChange={setMode} />
        <div className="flex items-center gap-2">
          {draft.mode === 'simple' && <LimitInput value={draft.limit} onChange={setLimit} />}
          {writing ? (
            <Tooltip content="A write can't be cancelled; the server finishes it">
              <Button
                type="button"
                size="sm"
                aria-disabled
                className="h-8 shrink-0 cursor-not-allowed bg-amber-400/60 px-3 text-amber-950 hover:bg-amber-400/60"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Writing…
              </Button>
            </Tooltip>
          ) : loading ? (
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
            <Tooltip
              content={
                blockedReason ??
                (write
                  ? `Writes to ${writeTargetName(write.op.writes, tab.db)} · ⌘/Ctrl-Enter`
                  : 'Run · ⌘/Ctrl-Enter')
              }
            >
              <Button
                type="submit"
                size="sm"
                // A double-click's second click would run again once a fast run has finished.
                onClick={(e) => {
                  if (e.detail > 1) e.preventDefault()
                }}
                // Stays focusable and hoverable so the tooltip can say why Run is blocked.
                aria-disabled={blockedReason !== null}
                className={cn(
                  'h-8 shrink-0 px-3',
                  write && 'bg-amber-400 text-amber-950 hover:bg-amber-400/90',
                  blockedReason !== null && 'cursor-not-allowed opacity-50'
                )}
              >
                {write ? <PenLine className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {write ? 'Run write' : 'Run'}
              </Button>
            </Tooltip>
          )}
          {draft.mode === 'simple' && (
            <ExportButton
              connectionId={tab.connectionId}
              db={tab.db}
              coll={tab.coll}
              filter={exportFind?.filter ?? null}
              projection={exportFind?.projection ?? null}
              sort={exportFind?.sort ?? null}
              currentDocCount={exportDocCount}
              uuidEncoding={uuidEncoding}
              timezone={timezone}
              disabled={exportFind === null}
            />
          )}
        </div>
      </div>

      <div className="grid gap-1.5 px-4 py-2">
        {draft.mode === 'simple' && (
          <SimpleBody
            tabId={tab.id}
            completionEnv={completionEnv}
            filter={draft.filter}
            setFilter={setFilter}
            filterStatus={filterStatus}
            sort={draft.sort}
            setSort={setSort}
            sortStatus={sortStatus}
            projection={draft.projection}
            setProjection={setProjection}
            projectionStatus={projectionStatus}
            onSubmit={() => apply()}
            formatSource={formatSource}
          />
        )}

        {draft.mode === 'aggregation' && (
          <SourceEditor
            modelPath={queryModelUri(tab.id, 'pipeline')}
            completion={{ kind: 'pipeline', env: completionEnv }}
            value={draft.pipeline}
            onChange={setPipeline}
            status={pipelineStatus}
            onSubmit={() => apply()}
            onFormat={() => formatSource(draft.pipeline, setPipeline)}
            minHeight={120}
            maxHeight={400}
            placeholder={
              '[\n  { $match: { … } },\n  { $group: { _id: "$type", n: { $sum: 1 } } }\n]'
            }
          />
        )}

        {draft.mode === 'shell' && (
          <SourceEditor
            modelPath={queryModelUri(tab.id, 'shell')}
            completion={{ kind: 'shell', env: completionEnv }}
            value={draft.shell}
            onChange={setShell}
            status={shellStatus}
            onSubmit={() => apply()}
            onFormat={formatShell}
            minHeight={60}
            maxHeight={240}
            placeholder={`${shellCollectionAccessor(tab.coll)}.find({ … }).sort({ … }).limit(50)`}
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
  tabId,
  completionEnv,
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
  formatSource
}: {
  tabId: string
  completionEnv: CompletionEnv
  filter: string
  setFilter: (next: string) => void
  filterStatus: SourceStatus
  sort: string
  setSort: (next: string) => void
  sortStatus: SourceStatus
  projection: string
  setProjection: (next: string) => void
  projectionStatus: SourceStatus
  onSubmit: () => void
  formatSource: (value: string, setter: (next: string) => void) => void
}) {
  // Sort and Projection share their height: whichever editor's content is
  // taller pushes the shorter one to match. Each reports its natural
  // (pre-clamp) height; the max is fed back as both editors' minHeight.
  const [sortContentH, setSortContentH] = useState(30)
  const [projContentH, setProjContentH] = useState(30)
  const sharedRowH = Math.max(30, sortContentH, projContentH)

  return (
    <>
      <SourceEditor
        modelPath={queryModelUri(tabId, 'filter')}
        completion={{ kind: 'filter', env: completionEnv }}
        value={filter}
        onChange={setFilter}
        status={filterStatus}
        onSubmit={onSubmit}
        onFormat={() => formatSource(filter, setFilter)}
        minHeight={32}
        maxHeight={180}
        placeholder='filter ·  { _id: ObjectId("…"), createdAt: { $gt: ISODate("2024-01-01") } }     ⌘/Ctrl-Enter to run'
      />

      <div className="flex flex-wrap items-stretch gap-1.5">
        <OptionRow
          modelPath={queryModelUri(tabId, 'sort')}
          completion={{ kind: 'sort', env: completionEnv }}
          icon={<ArrowDownUp className="h-3 w-3" />}
          label="Sort"
          placeholder="{ createdAt: -1 }"
          value={sort}
          onChange={setSort}
          onSubmit={onSubmit}
          onFormat={() => formatSource(sort, setSort)}
          status={sortStatus}
          minHeight={sharedRowH}
          onContentHeightChange={setSortContentH}
        />
        <OptionRow
          modelPath={queryModelUri(tabId, 'projection')}
          completion={{ kind: 'projection', env: completionEnv }}
          icon={<Eye className="h-3 w-3" />}
          label="Projection"
          placeholder="{ name: 1, _id: 0 }"
          value={projection}
          onChange={setProjection}
          onSubmit={onSubmit}
          onFormat={() => formatSource(projection, setProjection)}
          status={projectionStatus}
          minHeight={sharedRowH}
          onContentHeightChange={setProjContentH}
        />
      </div>
    </>
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
  ...editor
}: Omit<SourceEditorProps, 'maxHeight'> & { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 basis-[280px] items-stretch gap-1.5">
      <div className="flex shrink-0 items-center gap-1 rounded-md border border-input bg-muted/30 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <SourceEditor {...editor} maxHeight={120} />
    </div>
  )
}

type SourceEditorProps = {
  modelPath: string
  completion: CompletionBinding
  value: string
  onChange: (next: string) => void
  status: SourceStatus
  onSubmit: () => void
  onFormat: () => void
  minHeight: number
  maxHeight: number
  placeholder: string
  onContentHeightChange?: (px: number) => void
}

function SourceEditor({ status, onFormat, ...editor }: SourceEditorProps) {
  return (
    <div className="min-w-0 flex-1">
      <QueryEditor
        {...editor}
        onFormat={onFormat}
        hasError={status.kind === 'invalid'}
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

function FormatButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content="Format · Shift+Alt+F · removes comments">
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

type SourceStatus = { kind: 'empty' } | { kind: 'ok' } | { kind: 'invalid'; error: string }

function invalidReason(label: string | null, status: SourceStatus): string | null {
  if (status.kind !== 'invalid') return null
  return label === null ? status.error : `${label}: ${status.error}`
}

function parseObjectStatus(value: string): SourceStatus {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  const result = parseMongoQuery(trimmed)
  if (!result.ok) return { kind: 'invalid', error: result.error }
  if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return { kind: 'invalid', error: 'Must be an object' }
  }
  return { kind: 'ok' }
}

function parsePipelineStatus(value: string): SourceStatus {
  if (value.trim().length === 0) return { kind: 'empty' }
  const result = compilePipelineSource(value)
  return result.ok ? { kind: 'ok' } : { kind: 'invalid', error: result.error }
}

function parseShellDraft(value: string): { status: SourceStatus; write: ShellWriteCommand | null } {
  if (value.trim().length === 0) return { status: { kind: 'empty' }, write: null }
  const result = parseShellCommand(value)
  if (!result.ok) return { status: { kind: 'invalid', error: result.error }, write: null }
  const { coll, op } = result.command
  return { status: { kind: 'ok' }, write: op.kind === 'write' ? { coll, op } : null }
}
