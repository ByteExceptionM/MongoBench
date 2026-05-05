import { useQuery } from '@tanstack/react-query'
import { ServerCrash } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import {
  useTabsStore,
  type CollectionTab as CollectionTabType,
  type QueryPatch
} from '@/store/tabs'
import { QueryToolbar } from './QueryToolbar'
import { DocumentTable } from './DocumentTable'
import { StatusBar } from './StatusBar'
import type { UuidEncoding } from '@shared/types'

export function CollectionTab({ tab }: { tab: CollectionTabType }) {
  const setQuery = useTabsStore((s) => s.setQuery)

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })
  const uuidEncoding: UuidEncoding =
    connectionsQuery.data?.find((c) => c.id === tab.connectionId)?.uuidEncoding ?? 'default'

  const findQuery = useQuery({
    queryKey: queryKeys.find(tab.connectionId, tab.db, tab.coll, tab.filter, tab.skip, tab.limit),
    queryFn: () =>
      api.query.find({
        connectionId: tab.connectionId,
        db: tab.db,
        coll: tab.coll,
        filter: tab.filter || undefined,
        skip: tab.skip,
        ...(tab.limit > 0 ? { limit: tab.limit } : {})
      }),
    placeholderData: (previous) => previous
  })

  const countQuery = useQuery({
    queryKey: queryKeys.count(tab.connectionId, tab.db, tab.coll, tab.filter),
    queryFn: () =>
      api.query.count({
        connectionId: tab.connectionId,
        db: tab.db,
        coll: tab.coll,
        filter: tab.filter || undefined
      })
  })

  const apply = (patch: QueryPatch) => setQuery(tab.id, patch)
  const refresh = () => {
    void findQuery.refetch()
    void countQuery.refetch()
  }

  return (
    <section className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="font-mono text-xs">
          <span className="text-muted-foreground">{tab.db}.</span>
          <span className="font-medium">{tab.coll}</span>
        </div>
      </header>

      <QueryToolbar tab={tab} onApply={apply} onRefresh={refresh} loading={findQuery.isFetching} />

      <StatusBar
        loading={findQuery.isFetching || countQuery.isFetching}
        count={countQuery.data?.count}
        estimated={countQuery.data?.estimated ?? false}
        pageSize={tab.limit}
        skip={tab.skip}
        pageDocs={findQuery.data?.documents.length ?? 0}
        tookMs={findQuery.data?.tookMs}
        onJump={(skip) => setQuery(tab.id, { skip })}
      />

      <div className="relative flex-1 overflow-hidden">
        {findQuery.error instanceof ApiError ? (
          <ErrorState message={findQuery.error.message} />
        ) : (
          <DocumentTable
            documents={findQuery.data?.documents ?? []}
            connectionId={tab.connectionId}
            db={tab.db}
            coll={tab.coll}
            uuidEncoding={uuidEncoding}
          />
        )}
      </div>
    </section>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="m-6 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <ServerCrash className="mt-0.5 h-4 w-4" />
      <div>
        <div className="font-medium">Query failed</div>
        <div className="text-xs opacity-80">{message}</div>
      </div>
    </div>
  )
}
