import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ServerCrash } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { parseMongoQuery } from '@/lib/mongoQueryLang'
import { parseShellCommand } from '@/lib/shellParser'
import {
  useTabsStore,
  type CollectionTab as CollectionTabType,
  type QueryPatch
} from '@/store/tabs'
import { QueryToolbar } from './QueryToolbar'
import { DocumentTable } from './DocumentTable'
import { StatusBar } from './StatusBar'
import type { FindResponse, UuidEncoding } from '@shared/types'

export function CollectionTab({ tab }: { tab: CollectionTabType }) {
  const setQuery = useTabsStore((s) => s.setQuery)
  const queryClient = useQueryClient()

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })
  const connectionConfig = connectionsQuery.data?.find((c) => c.id === tab.connectionId)
  const uuidEncoding: UuidEncoding = connectionConfig?.uuidEncoding ?? 'default'
  const timezone = connectionConfig?.timezone ?? 'UTC'

  // Compile all three modes' inputs up-front; the active query just picks
  // its slice. parseMongoQuery rejects anything that isn't valid mongo
  // shell syntax (with our $-operator extensions).
  const compiled = useMemo(() => {
    if (tab.mode === 'simple') {
      const f = parseMongoQuery(tab.filter)
      const p = parseMongoQuery(tab.projection)
      const s = parseMongoQuery(tab.sort)
      const ok = f.ok && p.ok && s.ok
      return {
        mode: 'simple' as const,
        ok,
        filter: f.ok ? f.ejson : null,
        projection: p.ok ? p.ejson : null,
        sort: s.ok ? s.ejson : null,
        error:
          (!f.ok && `Filter: ${f.error}`) ||
          (!p.ok && `Projection: ${p.error}`) ||
          (!s.ok && `Sort: ${s.error}`) ||
          null
      }
    }
    if (tab.mode === 'aggregation') {
      const r = parseMongoQuery(tab.pipeline)
      if (!r.ok) {
        return { mode: 'aggregation' as const, ok: false, pipeline: null, error: r.error }
      }
      if (!Array.isArray(r.value)) {
        return {
          mode: 'aggregation' as const,
          ok: false,
          pipeline: null,
          error: 'Pipeline must be an array'
        }
      }
      return { mode: 'aggregation' as const, ok: true, pipeline: r.ejson, error: null }
    }
    // shell
    const r = parseShellCommand(tab.shell)
    if (!r.ok) {
      return { mode: 'shell' as const, ok: false, parsed: null, error: r.error }
    }
    if (r.coll !== tab.coll) {
      return {
        mode: 'shell' as const,
        ok: false,
        parsed: null,
        error: `Command targets "${r.coll}" but this tab is "${tab.coll}"`
      }
    }
    return { mode: 'shell' as const, ok: true, parsed: r, error: null }
  }, [tab.mode, tab.filter, tab.projection, tab.sort, tab.pipeline, tab.shell, tab.coll])

  const findQuery = useQuery({
    queryKey:
      compiled.mode === 'simple'
        ? queryKeys.find(
            tab.connectionId,
            tab.db,
            tab.coll,
            tab.filter,
            tab.projection,
            tab.sort,
            tab.skip,
            tab.limit,
            tab.runEpoch
          )
        : compiled.mode === 'aggregation'
          ? queryKeys.aggregate(tab.connectionId, tab.db, tab.coll, tab.pipeline, tab.runEpoch)
          : queryKeys.shell(tab.connectionId, tab.db, tab.coll, tab.shell, tab.runEpoch),
    queryFn: () => runForMode(tab, compiled),
    enabled: compiled.ok,
    // Don't auto-refetch when the user just switches between tabs; the
    // query only re-runs when its key changes (filter / mode / runEpoch).
    refetchOnMount: false,
    staleTime: Infinity
  })

  // Count is only meaningful for the simple mode — aggregation/shell show
  // the result size in the StatusBar instead.
  const countQuery = useQuery({
    queryKey: queryKeys.count(tab.connectionId, tab.db, tab.coll, tab.filter),
    queryFn: () =>
      api.query.count({
        connectionId: tab.connectionId,
        db: tab.db,
        coll: tab.coll,
        ...(compiled.mode === 'simple' && compiled.filter ? { filter: compiled.filter } : {})
      }),
    enabled: compiled.mode === 'simple' && compiled.ok
  })

  const apply = (patch: QueryPatch) => setQuery(tab.id, patch)

  const cancel = () => {
    // Soft cancel via react-query: the IPC promise still settles in main
    // but its result is discarded, so the UI returns to its previous state
    // immediately. No queryFn signal plumbing needed.
    const key =
      tab.mode === 'simple'
        ? queryKeys.find(
            tab.connectionId,
            tab.db,
            tab.coll,
            tab.filter,
            tab.projection,
            tab.sort,
            tab.skip,
            tab.limit,
            tab.runEpoch
          )
        : tab.mode === 'aggregation'
          ? queryKeys.aggregate(tab.connectionId, tab.db, tab.coll, tab.pipeline, tab.runEpoch)
          : queryKeys.shell(tab.connectionId, tab.db, tab.coll, tab.shell, tab.runEpoch)
    void queryClient.cancelQueries({ queryKey: key })
  }

  const documents = findQuery.data?.documents ?? []
  const tookMs = findQuery.data?.tookMs

  return (
    <section className="flex h-full flex-col">
      <QueryToolbar
        tab={tab}
        onApply={apply}
        onCancel={cancel}
        loading={findQuery.isFetching}
        documents={documents}
        uuidEncoding={uuidEncoding}
        timezone={timezone}
        compiledFilter={compiled.mode === 'simple' ? compiled.filter : null}
        compiledProjection={compiled.mode === 'simple' ? compiled.projection : null}
        compiledSort={compiled.mode === 'simple' ? compiled.sort : null}
      />

      <StatusBar
        loading={findQuery.isFetching || countQuery.isFetching}
        count={
          compiled.mode === 'simple' ? countQuery.data?.count : findQuery.data?.documents.length
        }
        estimated={compiled.mode === 'simple' ? (countQuery.data?.estimated ?? false) : false}
        pageSize={compiled.mode === 'simple' ? tab.limit : 0}
        skip={tab.skip}
        pageDocs={documents.length}
        tookMs={tookMs}
        onJump={(skip) => setQuery(tab.id, { skip })}
      />

      <div className="relative flex-1 overflow-hidden">
        {compiled.error ? (
          <ErrorState message={compiled.error} />
        ) : findQuery.error instanceof ApiError ? (
          <ErrorState message={findQuery.error.message} />
        ) : (
          <DocumentTable
            documents={documents}
            loading={findQuery.isFetching}
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

type Compiled =
  | {
      mode: 'simple'
      ok: boolean
      filter: string | null
      projection: string | null
      sort: string | null
      error: string | null
    }
  | { mode: 'aggregation'; ok: boolean; pipeline: string | null; error: string | null }
  | {
      mode: 'shell'
      ok: boolean
      parsed: (ReturnType<typeof parseShellCommand> & { ok: true }) | null
      error: string | null
    }

async function runForMode(tab: CollectionTabType, compiled: Compiled): Promise<FindResponse> {
  if (compiled.mode === 'simple') {
    return api.query.find({
      connectionId: tab.connectionId,
      db: tab.db,
      coll: tab.coll,
      ...(compiled.filter ? { filter: compiled.filter } : {}),
      ...(compiled.projection ? { projection: compiled.projection } : {}),
      ...(compiled.sort ? { sort: compiled.sort } : {}),
      skip: tab.skip,
      ...(tab.limit > 0 ? { limit: tab.limit } : {})
    })
  }
  if (compiled.mode === 'aggregation') {
    if (!compiled.pipeline) throw new Error('unreachable: aggregation enabled without pipeline')
    return api.query.aggregate({
      connectionId: tab.connectionId,
      db: tab.db,
      coll: tab.coll,
      pipeline: compiled.pipeline
    })
  }
  // shell
  if (!compiled.parsed || !compiled.parsed.ok)
    throw new Error('unreachable: shell enabled without parsed command')
  const op = compiled.parsed.op
  if (op.kind === 'aggregate') {
    return api.query.aggregate({
      connectionId: tab.connectionId,
      db: tab.db,
      coll: tab.coll,
      pipeline: op.pipeline
    })
  }
  if (op.kind === 'find') {
    return api.query.find({
      connectionId: tab.connectionId,
      db: tab.db,
      coll: tab.coll,
      filter: op.filter,
      ...(op.projection ? { projection: op.projection } : {}),
      ...(op.sort ? { sort: op.sort } : {}),
      skip: op.skip ?? 0,
      ...(op.limit !== null ? { limit: op.limit } : {})
    })
  }
  if (op.kind === 'findOne') {
    return api.query.find({
      connectionId: tab.connectionId,
      db: tab.db,
      coll: tab.coll,
      filter: op.filter,
      skip: 0,
      limit: 1
    })
  }
  // countDocuments — return an empty docs response; the count shows in the
  // StatusBar via a one-off api.query.count call below.
  const countResp = await api.query.count({
    connectionId: tab.connectionId,
    db: tab.db,
    coll: tab.coll,
    filter: op.filter
  })
  return {
    documents: [
      {
        id: '"_count"',
        data: { _count: countResp.count },
        canonical: `{"_count":${countResp.count}}`,
        hash: 'a'.repeat(64)
      }
    ],
    tookMs: 0
  }
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
