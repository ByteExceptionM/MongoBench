import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ServerCrash } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { parseMongoQuery } from '@/lib/mongoQueryLang'
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
  const connectionConfig = connectionsQuery.data?.find((c) => c.id === tab.connectionId)
  const uuidEncoding: UuidEncoding = connectionConfig?.uuidEncoding ?? 'default'
  const timezone = connectionConfig?.timezone ?? 'UTC'

  const compiled = useMemo(() => {
    const f = parseMongoQuery(tab.filter)
    const p = parseMongoQuery(tab.projection)
    const s = parseMongoQuery(tab.sort)
    return {
      ok: f.ok && p.ok && s.ok,
      filter: f.ok ? f.ejson : null,
      projection: p.ok ? p.ejson : null,
      sort: s.ok ? s.ejson : null,
      error:
        (!f.ok && `Filter: ${f.error}`) ||
        (!p.ok && `Projection: ${p.error}`) ||
        (!s.ok && `Sort: ${s.error}`) ||
        null
    }
  }, [tab.filter, tab.projection, tab.sort])

  const findQuery = useQuery({
    queryKey: queryKeys.find(
      tab.connectionId,
      tab.db,
      tab.coll,
      tab.filter,
      tab.projection,
      tab.sort,
      tab.skip,
      tab.limit
    ),
    queryFn: () =>
      api.query.find({
        connectionId: tab.connectionId,
        db: tab.db,
        coll: tab.coll,
        ...(compiled.filter ? { filter: compiled.filter } : {}),
        ...(compiled.projection ? { projection: compiled.projection } : {}),
        ...(compiled.sort ? { sort: compiled.sort } : {}),
        skip: tab.skip,
        ...(tab.limit > 0 ? { limit: tab.limit } : {})
      }),
    enabled: compiled.ok,
    placeholderData: (previous) => previous
  })

  const countQuery = useQuery({
    queryKey: queryKeys.count(tab.connectionId, tab.db, tab.coll, tab.filter),
    queryFn: () =>
      api.query.count({
        connectionId: tab.connectionId,
        db: tab.db,
        coll: tab.coll,
        ...(compiled.filter ? { filter: compiled.filter } : {})
      }),
    enabled: compiled.ok
  })

  const apply = (patch: QueryPatch) => setQuery(tab.id, patch)

  return (
    <section className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="font-mono text-xs">
          <span className="text-muted-foreground">{tab.db}.</span>
          <span className="font-medium">{tab.coll}</span>
        </div>
      </header>

      <QueryToolbar
        tab={tab}
        onApply={apply}
        loading={findQuery.isFetching}
        documents={findQuery.data?.documents ?? []}
        uuidEncoding={uuidEncoding}
        timezone={timezone}
        compiledFilter={compiled.filter}
        compiledProjection={compiled.projection}
        compiledSort={compiled.sort}
      />

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
        {compiled.error ? (
          <ErrorState message={compiled.error} />
        ) : findQuery.error instanceof ApiError ? (
          <ErrorState message={findQuery.error.message} />
        ) : (
          <DocumentTable
            documents={findQuery.data?.documents ?? []}
            connectionId={tab.connectionId}
            db={tab.db}
            coll={tab.coll}
            uuidEncoding={uuidEncoding}
            timezone={timezone}
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
