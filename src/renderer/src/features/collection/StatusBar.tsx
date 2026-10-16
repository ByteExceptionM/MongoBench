import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { RESULT_CAP } from '@shared/types'

/** What the status bar describes: a paged Simple find, a capped result, or nothing countable. */
export type StatusSummary =
  | {
      kind: 'paged'
      count: number | undefined
      /** Why the count failed; null while it is pending, cancelled or known. */
      countError: string | null
      estimated: boolean
      /** 0 = no limit. */
      pageSize: number
      skip: number
      pageDocs: number
      /** A page is loading; paging waits for it. */
      busy: boolean
      onJump: (skip: number) => void
    }
  | {
      kind: 'rows'
      rows: number
      truncated: boolean
      /** How to reach the rows past the cap. */
      truncationHint: string
      /** Why rows can't be edited or deleted; null when they can. */
      readOnlyReason: string | null
      /** The rows' collection when it isn't the tab's. */
      foreignColl: string | null
    }
  | { kind: 'none' }

export function StatusBar({
  loading,
  tookMs,
  summary
}: {
  loading: boolean
  tookMs: number | undefined
  summary: StatusSummary
}) {
  return (
    <div className="flex h-9 items-center justify-between border-b bg-card/40 px-4 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3 font-mono">
        {summary.kind === 'paged' ? (
          <PagedInfo summary={summary} loading={loading} />
        ) : loading ? (
          <Running />
        ) : (
          summary.kind === 'rows' && <RowsInfo summary={summary} />
        )}
        {tookMs !== undefined && <span>{tookMs} ms</span>}
      </div>
      {summary.kind === 'paged' && summary.pageSize > 0 && <Pager summary={summary} />}
    </div>
  )
}

type PagedSummary = Extract<StatusSummary, { kind: 'paged' }>

const pageCount = ({ count, pageSize }: PagedSummary): number | undefined =>
  pageSize > 0 && count !== undefined ? Math.max(1, Math.ceil(count / pageSize)) : undefined

function Running() {
  return (
    <span className="flex items-center gap-1.5">
      <Loader2 className="h-3 w-3 animate-spin" />
      running…
    </span>
  )
}

function PagedInfo({ summary, loading }: { summary: PagedSummary; loading: boolean }) {
  const { count, countError, estimated, pageSize, skip, pageDocs } = summary
  const totalPages = pageCount(summary)
  return (
    <>
      {loading ? (
        <Running />
      ) : count !== undefined ? (
        <span>
          {estimated && '~'}
          {count.toLocaleString()} docs
        </span>
      ) : (
        countError && (
          <Tooltip content={countError}>
            <span className="rounded-sm bg-amber-400/15 px-1.5 py-0.5 text-amber-300">
              count unavailable
            </span>
          </Tooltip>
        )
      )}
      {totalPages !== undefined && (
        <span>
          page {Math.floor(skip / pageSize) + 1}/{totalPages}
        </span>
      )}
      {pageSize === 0 && pageDocs > 0 && <span>showing all</span>}
    </>
  )
}

function Pager({ summary }: { summary: PagedSummary }) {
  const { count, pageSize, skip, pageDocs, busy, onJump } = summary
  const totalPages = pageCount(summary)
  // Paging past a loading page would leave its server op running for nothing.
  const canPrev = !busy && skip > 0
  const canNext = !busy && (count !== undefined ? skip + pageSize < count : pageDocs === pageSize)
  return (
    <div className="flex items-center gap-0.5">
      <PageBtn onClick={() => onJump(0)} disabled={!canPrev} label="First">
        <ChevronsLeft className="h-3.5 w-3.5" />
      </PageBtn>
      <PageBtn
        onClick={() => onJump(Math.max(0, skip - pageSize))}
        disabled={!canPrev}
        label="Prev"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </PageBtn>
      <PageBtn onClick={() => onJump(skip + pageSize)} disabled={!canNext} label="Next">
        <ChevronRight className="h-3.5 w-3.5" />
      </PageBtn>
      <PageBtn
        onClick={() => {
          if (totalPages !== undefined) onJump((totalPages - 1) * pageSize)
        }}
        disabled={!canNext || totalPages === undefined}
        label="Last"
      >
        <ChevronsRight className="h-3.5 w-3.5" />
      </PageBtn>
    </div>
  )
}

function RowsInfo({ summary }: { summary: Extract<StatusSummary, { kind: 'rows' }> }) {
  const cap = RESULT_CAP.toLocaleString()
  return (
    <>
      <span>
        {summary.rows.toLocaleString()} result{summary.rows === 1 ? '' : 's'}
      </span>
      {summary.truncated && (
        <Tooltip content={`Only the first ${cap} results are shown. ${summary.truncationHint}`}>
          <span className="rounded-sm bg-amber-400/15 px-1.5 py-0.5 text-amber-300">
            first {cap}
          </span>
        </Tooltip>
      )}
      {summary.readOnlyReason !== null && (
        <Tooltip content={summary.readOnlyReason}>
          <span className="rounded-sm bg-muted/60 px-1.5 py-0.5">read-only</span>
        </Tooltip>
      )}
      {summary.foreignColl !== null && (
        <Tooltip content="Rows come from this collection; edits and deletes target it.">
          <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-primary">
            {summary.foreignColl}
          </span>
        </Tooltip>
      )}
    </>
  )
}

function PageBtn({
  onClick,
  disabled,
  label,
  children
}: {
  onClick: () => void
  disabled: boolean
  label: string
  children: React.ReactNode
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      size="icon"
      variant="ghost"
      className={cn('h-7 w-7')}
      aria-label={label}
    >
      {children}
    </Button>
  )
}
