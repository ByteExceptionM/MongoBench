import { CircleCheck, CircleSlash, Loader2, ServerCrash } from 'lucide-react'
import { serializeMongoValue } from '@/lib/mongoQuerySerialize'
import type { ShellWriteResult } from '@/lib/queryRun'
import {
  SHELL_READ_METHODS,
  shellCollectionAccessor,
  writeTargetName,
  type ShellCountMethod
} from '@/lib/shellParser'
import { RESULT_CAP, WRITE_METHODS, type UuidEncoding } from '@shared/types'

const CAP_TEXT = RESULT_CAP.toLocaleString()

/** Shown before the visible mode was ever run in this tab. */
export function IdleState({
  mode,
  coll,
  db
}: {
  mode: 'aggregation' | 'shell'
  coll: string
  db: string
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="grid max-w-xl gap-2 text-sm text-muted-foreground">
        {mode === 'aggregation' ? (
          <>
            <p className="text-foreground">Write a pipeline above and press Run (⌘/Ctrl-Enter).</p>
            <Example>{'[{ $match: { status: "active" } }, { $sortByCount: "$type" }]'}</Example>
            <p className="text-xs">
              Returns at most {CAP_TEXT} rows. Only read pipelines run here; run $out and $merge in
              Shell mode.
            </p>
          </>
        ) : (
          <>
            <p className="text-foreground">Type a command above and press Run (⌘/Ctrl-Enter).</p>
            <Example>{`${shellCollectionAccessor(coll)}.find({ … }).sort({ … }).limit(50)`}</Example>
            <p className="text-xs">
              Reads: <span className="font-mono">{SHELL_READ_METHODS.join(', ')}</span>. They return
              at most {CAP_TEXT} rows.
            </p>
            <p className="text-xs">
              Writes: <span className="font-mono">{WRITE_METHODS.join(', ')}</span>, and aggregate
              ending in <span className="font-mono">$out</span> /{' '}
              <span className="font-mono">$merge</span>. A write runs once per Run and can&apos;t be
              cancelled; one that changes every document or replaces a collection asks first.
            </p>
            <p className="text-xs">
              Any collection of <span className="font-mono text-foreground">{db}</span>:{' '}
              <span className="font-mono">db.&lt;name&gt;, db.getCollection(&quot;name&quot;)</span>
              .
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Example({ children }: { children: string }) {
  return (
    <code className="block rounded-md border bg-card/40 px-3 py-2 font-mono text-xs text-foreground/90">
      {children}
    </code>
  )
}

/** A one-line note centred in the result area. */
export function Notice({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        {icon}
        {children}
      </span>
    </div>
  )
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <Notice icon={<Loader2 className="h-4 w-4 animate-spin" />}>{label}</Notice>
}

export function CancelledState() {
  return (
    <Notice icon={<CircleSlash className="h-4 w-4" />}>
      Run cancelled. Press Run to start it again.
    </Notice>
  )
}

export function ErrorState({
  message,
  title = 'Query failed'
}: {
  message: string
  title?: string
}) {
  return (
    <div className="m-6 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <ServerCrash className="mt-0.5 h-4 w-4" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-xs opacity-80">{message}</div>
      </div>
    </div>
  )
}

/** Result of a shell count method; `estimated` comes from collection metadata. */
export function CountResult({
  count,
  estimated,
  method,
  coll
}: {
  count: number
  estimated: boolean
  method: ShellCountMethod
  coll: string
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="grid justify-items-center gap-1 text-center">
        <div className="font-mono text-4xl font-semibold tabular-nums tracking-tight text-foreground">
          {estimated && '~'}
          {count.toLocaleString()}
        </div>
        <div className="text-sm text-muted-foreground">
          {estimated ? (
            <>
              documents in <span className="font-mono text-foreground">{coll}</span> · estimated
              from collection metadata
            </>
          ) : (
            <>
              documents match in <span className="font-mono text-foreground">{coll}</span>
            </>
          )}
        </div>
        <div className="font-mono text-[11px] text-muted-foreground/70">{method}()</div>
      </div>
    </div>
  )
}

const COUNT_ORDER = ['inserted', 'matched', 'modified', 'upserted', 'deleted'] as const

/** Outcome of a shell write: the counters that apply and the written ids. */
export function WriteResult({
  result,
  db,
  uuidEncoding,
  timezone,
  children
}: {
  result: ShellWriteResult
  /** The tab's database; a target elsewhere is named with its database. */
  db: string
  uuidEncoding: UuidEncoding
  timezone: string
  /** The document a findOneAnd* method returned, shown below the outcome. */
  children?: React.ReactNode
}) {
  const target = writeTargetName(result.writes, db)
  const counts = COUNT_ORDER.flatMap((name) => {
    const value = result.counts[name]
    return value === undefined ? [] : [{ name, value }]
  })
  const outcome =
    result.method === 'aggregate' ? (
      <>
        Output written to <span className="font-mono text-foreground">{target}</span>
      </>
    ) : (
      <>
        <span className="font-mono">{result.method}()</span> on{' '}
        <span className="font-mono text-foreground">{target}</span>
      </>
    )
  const ids = <WrittenIds result={result} uuidEncoding={uuidEncoding} timezone={timezone} />

  if (result.returned !== null) {
    return (
      <div className="flex h-full flex-col">
        <div className="grid shrink-0 gap-2 border-b bg-card/30 px-4 py-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <CircleCheck className="h-3.5 w-3.5 text-success" />
              {outcome}
            </span>
            {counts.map(({ name, value }) => (
              <span key={name}>
                <span className="font-mono tabular-nums text-foreground">
                  {value.toLocaleString()}
                </span>{' '}
                {name}
              </span>
            ))}
          </div>
          {ids}
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="grid w-full max-w-xl justify-items-center gap-3 text-center">
        {counts.length > 0 && (
          <dl className="flex flex-wrap justify-center gap-x-10 gap-y-3">
            {counts.map(({ name, value }) => (
              <div key={name} className="grid justify-items-center">
                <dt className="order-last text-[11px] uppercase tracking-wider text-muted-foreground">
                  {name}
                </dt>
                <dd className="font-mono text-4xl font-semibold tabular-nums tracking-tight text-foreground">
                  {value.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleCheck className="h-4 w-4 text-success" />
          {outcome}
        </div>
        {ids}
      </div>
    </div>
  )
}

function WrittenIds({
  result,
  uuidEncoding,
  timezone
}: {
  result: ShellWriteResult
  uuidEncoding: UuidEncoding
  timezone: string
}) {
  const { ids, counts } = result
  if (ids.length === 0) return null
  const inserted = counts.inserted ?? 0
  const upserted = counts.upserted ?? 0
  const kind =
    inserted > 0 && upserted > 0 ? 'Inserted and upserted' : upserted > 0 ? 'Upserted' : 'Inserted'
  const more = inserted + upserted - ids.length
  return (
    <div className="grid w-full gap-1 text-left">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {kind} _id{ids.length === 1 ? '' : 's'}
      </div>
      <ul className="max-h-40 overflow-auto rounded-md border bg-card/40 px-3 py-2 font-mono text-xs text-foreground/90">
        {ids.map((id, index) => (
          <li key={index} className="truncate">
            {serializeMongoValue(JSON.parse(id), { indent: 0, uuidEncoding, timezone })}
          </li>
        ))}
        {result.idsTruncated && more > 0 && (
          <li className="text-muted-foreground">+{more.toLocaleString()} more</li>
        )}
      </ul>
    </div>
  )
}
