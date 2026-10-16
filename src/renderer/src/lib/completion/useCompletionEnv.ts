import { useEffect, useMemo, useRef } from 'react'
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createSchemaBuilder } from '@shared/collectionSchema'
import type { CollectionRef, CollectionSchema, DocumentEnvelope, UuidEncoding } from '@shared/types'
import { api } from '../api'
import { queryKeys } from '../queryClient'

export const SCHEMA_STALE_MS = 10 * 60_000
// Folding is synchronous on the editor's thread; an unlimited result page would stall typing.
const MAX_MERGED_DOCUMENTS = 1000

/** Query options for a collection's sampled schema (shared by completion and the index form). */
export function collectionSchemaQuery(connectionId: string, db: string, coll: string) {
  return queryOptions({
    queryKey: queryKeys.collectionSchema(connectionId, db, coll),
    queryFn: () => api.collections.schema({ connectionId, db, coll }),
    staleTime: SCHEMA_STALE_MS,
    // Completion fetches without an observer; the default gcTime would drop samples and failures early.
    gcTime: SCHEMA_STALE_MS,
    retry: false
  })
}

export type CompletionEnv = {
  coll: string
  /** Collection names of the database; schemas are only ever loaded for these and `coll`. */
  collections: readonly string[]
  uuidEncoding: UuidEncoding
  timezone: string
  /** Effective schema of `name` (own collection includes loaded documents); null if sampling failed or the name is unknown. */
  loadSchema: (name: string) => Promise<CollectionSchema | null>
  /** Starts sampling `coll` and folding the documents into it before the first completion request needs them. */
  prefetchSchema: () => void
  /** Samples `coll` again. */
  refreshSchema: () => void
}

/**
 * Per-tab completion environment; nothing is sampled until an editor asks for a schema.
 * @param p.documents whole, unprojected documents of `coll`, folded into its schema
 * @param p.enabled false leaves the collection list unloaded (closed dialogs)
 */
export function useCompletionEnv(p: {
  connectionId: string
  db: string
  coll: string
  uuidEncoding: UuidEncoding
  timezone: string
  documents?: readonly DocumentEnvelope[]
  enabled?: boolean
}): CompletionEnv {
  const { connectionId, db, coll, uuidEncoding, timezone, documents, enabled = true } = p
  const queryClient = useQueryClient()
  const collectionsQuery = useQuery({
    queryKey: queryKeys.collections(connectionId, db),
    queryFn: () => api.collections.list({ connectionId, db }),
    enabled
  })
  const listed = collectionsQuery.data
  const collections = useMemo(() => listed?.map((c) => c.name) ?? [], [listed])
  // Read on every request, so a new result page does not rebuild the environment.
  const documentsRef = useRef(documents)
  const access = useMemo(
    () =>
      schemaAccess(
        queryClient,
        { connectionId, db, coll },
        collections,
        () => documentsRef.current
      ),
    [queryClient, connectionId, db, coll, collections]
  )
  useEffect(() => {
    documentsRef.current = documents
    // Folding a result page takes long enough to stall the next keystroke.
    const idle = requestIdleCallback(access.foldDocuments)
    return () => cancelIdleCallback(idle)
  }, [documents, access])

  return useMemo(
    () => ({
      coll,
      collections,
      uuidEncoding,
      timezone,
      loadSchema: access.loadSchema,
      prefetchSchema: access.prefetchSchema,
      refreshSchema: access.refreshSchema
    }),
    [access, coll, collections, uuidEncoding, timezone]
  )
}

/**
 * Schema loading of one collection's editors through the query cache.
 * @param collections names whose schemas may be sampled besides `ref.coll`
 * @param documents current whole documents of `ref.coll`; folded in when non-empty
 * @returns the schema functions of the env, plus `foldDocuments`: folds the documents into an existing sample now, never samples
 */
export function schemaAccess(
  queryClient: QueryClient,
  ref: CollectionRef,
  collections: readonly string[],
  documents: () => readonly DocumentEnvelope[] | undefined
): Pick<CompletionEnv, 'loadSchema' | 'prefetchSchema' | 'refreshSchema'> & {
  foldDocuments: () => void
} {
  const { connectionId, db, coll } = ref
  // Keyed by the result page, so a replaced page is collected together with its folded schema.
  const merged = new WeakMap<
    readonly DocumentEnvelope[],
    { base: CollectionSchema | null; schema: CollectionSchema }
  >()

  const sampled = (name: string): Promise<CollectionSchema | null> => {
    const options = collectionSchemaQuery(connectionId, db, name)
    const state = queryClient.getQueryState(options.queryKey)
    // A failed sample would otherwise be retried on every keystroke; refreshSchema retries it.
    if (state?.status === 'error' && Date.now() - state.errorUpdatedAt < SCHEMA_STALE_MS) {
      return Promise.resolve(state.data ?? null)
    }
    return queryClient.fetchQuery(options).catch(() => null)
  }

  const withDocuments = (base: CollectionSchema | null): CollectionSchema | null => {
    const docs = documents()
    if (!docs || docs.length === 0) return base
    let entry = merged.get(docs)
    if (!entry || entry.base !== base) {
      const builder = createSchemaBuilder(base ?? undefined)
      for (const envelope of docs.slice(0, MAX_MERGED_DOCUMENTS)) {
        if (envelope.canonical) builder.add(JSON.parse(envelope.canonical))
      }
      entry = { base, schema: builder.build() }
      merged.set(docs, entry)
    }
    return entry.schema
  }

  return {
    loadSchema: async (name) => {
      if (name !== coll && !collections.includes(name)) return null
      const base = await sampled(name)
      return name === coll ? withDocuments(base) : base
    },
    prefetchSchema: () => void sampled(coll).then(withDocuments),
    refreshSchema: () =>
      void queryClient.refetchQueries({
        queryKey: queryKeys.collectionSchema(connectionId, db, coll)
      }),
    foldDocuments: () => {
      const state = queryClient.getQueryState(
        collectionSchemaQuery(connectionId, db, coll).queryKey
      )
      // Sampling waits for an editor to ask; only a sample it already got is folded into.
      if (state && state.status !== 'pending') withDocuments(state.data ?? null)
    }
  }
}
