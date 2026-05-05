import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function StatusBar({
  loading,
  count,
  estimated,
  pageSize,
  skip,
  pageDocs,
  tookMs,
  onJump
}: {
  loading: boolean
  count: number | undefined
  estimated: boolean
  /** 0 = no limit. */
  pageSize: number
  skip: number
  pageDocs: number
  tookMs: number | undefined
  onJump: (skip: number) => void
}) {
  const hasLimit = pageSize > 0
  const totalPages =
    hasLimit && count !== undefined ? Math.max(1, Math.ceil(count / pageSize)) : undefined
  const currentPage = hasLimit ? Math.floor(skip / pageSize) + 1 : 1

  const canPrev = hasLimit && skip > 0
  const canNext = hasLimit
    ? count !== undefined
      ? skip + pageSize < count
      : pageDocs === pageSize
    : false

  return (
    <div className="flex h-9 items-center justify-between border-b bg-card/40 px-4 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3 font-mono">
        {loading ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            running…
          </span>
        ) : count !== undefined ? (
          <span>
            {estimated && '~'}
            {count.toLocaleString()} docs
          </span>
        ) : null}
        {totalPages !== undefined && (
          <span>
            page {currentPage}/{totalPages}
          </span>
        )}
        {!hasLimit && pageDocs > 0 && <span>showing all</span>}
        {tookMs !== undefined && <span>{tookMs} ms</span>}
      </div>

      {hasLimit && (
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
              if (count === undefined || totalPages === undefined) return
              const last = (totalPages - 1) * pageSize
              onJump(last)
            }}
            disabled={!canNext || count === undefined}
            label="Last"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </PageBtn>
        </div>
      )}
    </div>
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
