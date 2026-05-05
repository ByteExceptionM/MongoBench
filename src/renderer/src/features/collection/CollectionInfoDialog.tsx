import { useQuery } from '@tanstack/react-query'
import { Loader2, ServerCrash } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'

type Props = {
  open: boolean
  connectionId: string
  db: string
  coll: string
  onClose: () => void
}

export function CollectionInfoDialog({ open, connectionId, db, coll, onClose }: Props) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.collectionStats(connectionId, db, coll),
    queryFn: () => api.collections.stats({ connectionId, db, coll }),
    enabled: open
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Collection info</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {db}.{coll}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading collection stats…
          </div>
        )}

        {error instanceof ApiError && (
          <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <ServerCrash className="mt-0.5 h-4 w-4" />
            <div>
              <div className="font-medium">Could not read stats</div>
              <div className="text-xs opacity-80">{error.message}</div>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-2 text-xs underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {data && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 font-mono text-xs">
            <Row label="Documents" value={data.count.toLocaleString()} />
            <Row label="Avg. doc size" value={formatBytes(data.avgObjSize)} />
            <Row label="Logical size" value={formatBytes(data.size)} />
            <Row
              label="Storage size"
              value={formatBytes(data.storageSize)}
              hint="on disk, after compression"
            />
            {data.freeStorageSize > 0 && (
              <Row label="Free storage" value={formatBytes(data.freeStorageSize)} />
            )}
            <Row label="Indexes" value={data.nindexes.toString()} />
            <Row label="Total index size" value={formatBytes(data.totalIndexSize)} />
            <Row label="Total size" value={formatBytes(data.totalSize)} />
            {data.numOrphanDocs !== undefined && data.numOrphanDocs > 0 && (
              <Row label="Orphan docs" value={data.numOrphanDocs.toLocaleString()} />
            )}
            {data.capped && <Row label="Capped" value="yes" />}

            {Object.keys(data.indexSizes).length > 0 && (
              <>
                <div className="col-span-2 mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Per-index size
                </div>
                {Object.entries(data.indexSizes).map(([name, size]) => (
                  <Row key={name} label={name} value={formatBytes(size)} mono />
                ))}
              </>
            )}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({
  label,
  value,
  hint,
  mono
}: {
  label: string
  value: string
  hint?: string
  mono?: boolean
}) {
  return (
    <>
      <dt className={mono ? 'font-mono text-muted-foreground' : 'text-muted-foreground'}>
        {label}
      </dt>
      <dd className="text-foreground">
        {value}
        {hint && <span className="ml-2 text-[10px] text-muted-foreground">{hint}</span>}
      </dd>
    </>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
