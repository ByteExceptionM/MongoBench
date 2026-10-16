import { useMemo, useState } from 'react'
import {
  hashKey,
  isCancelledError,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationState,
  type QueryKey,
  type UseQueryResult
} from '@tanstack/react-query'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { compilePipelineSource } from '@/lib/aggregationPipeline'
import { api, ApiError } from '@/lib/api'
import { useCompletionEnv } from '@/lib/completion/useCompletionEnv'
import { cancelRequests } from '@/lib/queryCancellation'
import {
  explicitRunOptions,
  mutationKeys,
  queryKeys,
  runQueryOptions,
  shellWriteOptions,
  simpleRunOptions,
  type RunnableQuery,
  type ShellWriteVariables
} from '@/lib/queryClient'
import {
  compileFind,
  runAggregation,
  runFind,
  runShellCommand,
  type QueryResult,
  type ShellWriteCommand,
  type ShellWriteResult
} from '@/lib/queryRun'
import { parseShellCommand, writeConfirmation } from '@/lib/shellParser'
import {
  useTabsStore,
  type AppliedSimple,
  type AppliedSource,
  type CollectionTab as CollectionTabType
} from '@/store/tabs'
import type { CollectionRef, UuidEncoding } from '@shared/types'
import { QueryToolbar } from './QueryToolbar'
import { DocumentTable } from './DocumentTable'
import {
  CancelledState,
  CountResult,
  ErrorState,
  IdleState,
  LoadingState,
  WriteResult
} from './ResultStates'
import { StatusBar, type StatusSummary } from './StatusBar'

type DocumentsResult = Extract<QueryResult, { kind: 'documents' }>

type ShellWriteState = MutationState<ShellWriteResult, Error, ShellWriteVariables>

/** What the view reads of a shell write: the run it belongs to and its outcome. */
type ShownWrite = Pick<ShellWriteState, 'status' | 'data' | 'error'> &
  Partial<Pick<ShellWriteVariables, 'tabId' | 'epoch'>>

/** A write waiting for the user to confirm it. */
type PendingWrite = { tabId: string; reason: string }

/** The visible mode's applied query: never run, not compilable, ready with its result key, or a write. */
type ResultRun =
  | { kind: 'idle'; mode: 'aggregation' | 'shell' }
  | { kind: 'invalid'; error: string }
  | ({ kind: 'ready' } & RunnableQuery<QueryResult>)
  // Run executes it once as a mutation; it has no query, so no refetch or invalidation repeats it.
  | { kind: 'write'; epoch: number }

const runnable = (run: ResultRun | null): RunnableQuery<QueryResult> | null =>
  run?.kind === 'ready' ? run : null

const isCancelled = (error: unknown): boolean =>
  isCancelledError(error) || (error instanceof ApiError && error.code === 'cancelled')

const EMPTY_MESSAGES: Record<DocumentsResult['origin'], string> = {
  find: 'No documents match the current filter.',
  aggregate: 'The pipeline returned no documents.',
  distinct: 'No values found.'
}

const TRUNCATION_HINTS: Record<DocumentsResult['origin'], string> = {
  find: 'Use .skip() / .limit() to page through the rest.',
  aggregate: 'Add $skip / $limit stages to page through the rest.',
  distinct: 'Narrow the filter to see the remaining values.'
}

export function CollectionTab({ tab }: { tab: CollectionTabType }) {
  // Only the mode: the rest of the draft changes on every keystroke and never affects results.
  const mode = useTabsStore((s) => s.drafts[tab.id]?.mode ?? 'simple')
  const setSkip = useTabsStore((s) => s.setSkip)
  const commitRun = useTabsStore((s) => s.run)
  const queryClient = useQueryClient()

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections.list()
  })
  const connectionConfig = connectionsQuery.data?.find((c) => c.id === tab.connectionId)
  const uuidEncoding: UuidEncoding = connectionConfig?.uuidEncoding ?? 'default'
  const timezone = connectionConfig?.timezone ?? 'UTC'

  const { id, connectionId, db, coll, applied } = tab
  const simple = applied.simple
  const appliedSource =
    mode === 'aggregation' ? applied.aggregation : mode === 'shell' ? applied.shell : null
  const compiledFind = useMemo(() => compileFind(simple), [simple])
  const findRun = useMemo(
    () => simpleRun({ connectionId, db, coll }, simple, compiledFind),
    [connectionId, db, coll, simple, compiledFind]
  )
  const sourceRun = useMemo(
    () =>
      mode === 'simple' ? null : explicitRun(id, { connectionId, db, coll }, mode, appliedSource),
    [id, connectionId, db, coll, mode, appliedSource]
  )

  // Observed in every mode so a mode switch shows the kept result without re-running it.
  const findQuery = useQuery(
    runQueryOptions(id, runnable(findRun), simpleRunOptions, mode === 'simple')
  )
  const sourceQuery = useQuery(runQueryOptions(id, runnable(sourceRun), explicitRunOptions))
  const run = sourceRun ?? findRun
  const resultQuery = sourceRun ? sourceQuery : findQuery

  const writeMutation = useMutation(shellWriteOptions(queryClient))
  // Filtered while rendering: useMutationState applies changed filters only on its next cache event.
  const writeStates = useMutationState({
    filters: { mutationKey: mutationKeys.shellWrite },
    select: (mutation): ShownWrite => {
      const { variables, status, data, error } = mutation.state as ShellWriteState
      return { tabId: variables?.tabId, epoch: variables?.epoch, status, data, error }
    }
  })
  const writeState =
    run.kind === 'write'
      ? writeStates.find((write) => write.tabId === id && write.epoch === run.epoch)
      : undefined
  const writing = writeState?.status === 'pending'

  const [confirming, setConfirming] = useState<PendingWrite | null>(null)
  // One view serves every tab; a confirmation belongs to the tab that asked for it.
  if (confirming !== null && confirming.tabId !== id) setConfirming(null)

  const runWrite = () => {
    // Committing first gives the write its run's epoch, which releases the tab's previous write.
    const committed = commitRun(id)
    if (committed === null || !('source' in committed)) return
    // Parsed from the committed source, so the write is exactly the run the tab records and shows.
    const parsed = parseShellCommand(committed.source)
    if (!parsed.ok) return
    const { command } = parsed
    if (command.op.kind !== 'write') return
    writeMutation.mutate({
      tabId: id,
      epoch: committed.epoch,
      target: { connectionId, db },
      command: { coll: command.coll, op: command.op }
    })
  }

  const requestWrite = (command: ShellWriteCommand) => {
    const reason = writeConfirmation(command, db)
    if (reason === null) runWrite()
    else setConfirming({ tabId: id, reason })
  }

  const countKey = queryKeys.count(connectionId, db, coll, simple.filter, simple.epoch)
  const countQuery = useQuery(
    runQueryOptions(
      id,
      compiledFind.ok
        ? {
            key: countKey,
            execute: (requestId) =>
              api.query.count({
                connectionId,
                db,
                coll,
                ...(compiledFind.find.filter ? { filter: compiledFind.find.filter } : {}),
                requestId
              })
          }
        : null,
      simpleRunOptions,
      // Only Simple mode pages, so only it needs the total.
      mode === 'simple'
    )
  )

  const cancel = () => {
    const keys: QueryKey[] = run.kind === 'ready' ? [run.key] : []
    if (mode === 'simple') keys.push(countKey)
    for (const key of keys) {
      const hash = hashKey(key)
      cancelRequests((k) => hashKey(k) === hash)
      // Kept as a failure instead of reverting, so the cancelled run is never re-executed implicitly.
      void queryClient.cancelQueries({ queryKey: key, exact: true }, { revert: false })
    }
  }

  const result = resultQuery.data
  const completionEnv = useCompletionEnv({
    connectionId,
    db,
    coll,
    uuidEncoding,
    timezone,
    // Projected, derived or other collections' rows would teach the schema fields `coll` does not store.
    documents:
      result?.kind === 'documents' && result.rowAccess === 'full' && result.coll === coll
        ? result.documents
        : undefined
  })
  const loading = resultQuery.isFetching
  // A slow count shows as running but never blocks Run.
  const countLoading = mode === 'simple' && countQuery.isFetching
  const summary: StatusSummary =
    mode === 'simple'
      ? {
          kind: 'paged',
          count: countQuery.data?.count,
          countError:
            countQuery.error && !isCancelled(countQuery.error) ? countQuery.error.message : null,
          estimated: countQuery.data?.estimated ?? false,
          pageSize: simple.limit,
          skip: simple.skip,
          pageDocs: result?.kind === 'documents' ? result.documents.length : 0,
          busy: findQuery.isFetching,
          onJump: (skip) => setSkip(id, skip)
        }
      : result?.kind === 'documents'
        ? rowsSummary(result, coll)
        : { kind: 'none' }

  return (
    <section className="flex h-full flex-col">
      <QueryToolbar
        tab={tab}
        onCancel={cancel}
        onRunWrite={requestWrite}
        loading={loading}
        writing={writing}
        completionEnv={completionEnv}
        uuidEncoding={uuidEncoding}
        timezone={timezone}
        exportFind={compiledFind.ok ? compiledFind.find : null}
        exportDocCount={
          mode === 'simple' && result?.kind === 'documents' ? result.documents.length : 0
        }
      />

      <StatusBar
        loading={loading || countLoading || writing}
        tookMs={run.kind === 'write' ? writeState?.data?.tookMs : result?.tookMs}
        summary={summary}
      />

      <div className="relative flex-1 overflow-hidden">
        <ResultView
          run={run}
          query={resultQuery}
          write={writeState}
          tab={tab}
          uuidEncoding={uuidEncoding}
          timezone={timezone}
        />
      </div>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run this write?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.reason} A write can&apos;t be cancelled once it runs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              // The closing dialog still takes a second click or Enter; only the first one confirms.
              onClick={() => {
                if (confirming !== null) runWrite()
              }}
            >
              Run write
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function ResultView({
  run,
  query,
  write,
  tab,
  uuidEncoding,
  timezone
}: {
  run: ResultRun
  query: Pick<UseQueryResult<QueryResult>, 'data' | 'error' | 'fetchStatus'>
  write: ShownWrite | undefined
  tab: CollectionTabType
  uuidEncoding: UuidEncoding
  timezone: string
}) {
  const { id, connectionId, db, coll } = tab
  if (run.kind === 'idle') return <IdleState mode={run.mode} coll={coll} db={db} />
  if (run.kind === 'invalid') return <ErrorState message={run.error} />
  if (run.kind === 'write') {
    return (
      <ShellWriteView
        state={write}
        tabId={id}
        connectionId={connectionId}
        db={db}
        coll={coll}
        uuidEncoding={uuidEncoding}
        timezone={timezone}
      />
    )
  }
  const { data: result, error } = query
  if (isCancelled(error)) return <CancelledState />
  if (error) return <ErrorState message={error.message} />
  if (!result) return query.fetchStatus === 'idle' ? <CancelledState /> : <LoadingState />
  if (result.kind === 'count') {
    return (
      <CountResult
        count={result.count}
        estimated={result.estimated}
        method={result.method}
        coll={result.coll}
      />
    )
  }
  return (
    <DocumentTable
      // Selection, lookup target and column widths belong to one tab's view of one collection.
      key={`${id}:${result.coll}`}
      documents={result.documents}
      connectionId={connectionId}
      db={db}
      coll={result.coll}
      rowAccess={result.rowAccess}
      emptyMessage={EMPTY_MESSAGES[result.origin]}
      uuidEncoding={uuidEncoding}
      timezone={timezone}
    />
  )
}

function ShellWriteView({
  state,
  tabId,
  connectionId,
  db,
  coll,
  uuidEncoding,
  timezone
}: {
  state: ShownWrite | undefined
  tabId: string
  connectionId: string
  db: string
  coll: string
  uuidEncoding: UuidEncoding
  timezone: string
}) {
  const returned = state?.data?.returned
  const documents = useMemo(() => (returned?.document ? [returned.document] : []), [returned])
  if (!state) return <IdleState mode="shell" coll={coll} db={db} />
  if (state.error) return <ErrorState title="Write failed" message={state.error.message} />
  if (!state.data) return <LoadingState label="Writing…" />
  const { writes } = state.data
  return (
    <WriteResult result={state.data} db={db} uuidEncoding={uuidEncoding} timezone={timezone}>
      {returned && (
        <DocumentTable
          key={`${tabId}:${writes.coll}`}
          documents={documents}
          connectionId={connectionId}
          db={writes.db}
          coll={writes.coll}
          rowAccess={returned.rowAccess}
          emptyMessage="No document matched."
          uuidEncoding={uuidEncoding}
          timezone={timezone}
        />
      )}
    </WriteResult>
  )
}

function simpleRun(
  ref: CollectionRef,
  simple: AppliedSimple,
  compiled: ReturnType<typeof compileFind>
): ResultRun {
  if (!compiled.ok) return { kind: 'invalid', error: compiled.error }
  const { find } = compiled
  return {
    kind: 'ready',
    key: queryKeys.find(
      ref.connectionId,
      ref.db,
      ref.coll,
      simple.filter,
      simple.projection,
      simple.sort,
      simple.skip,
      simple.limit,
      simple.epoch
    ),
    execute: (requestId) => runFind(ref, find, requestId)
  }
}

function explicitRun(
  tabId: string,
  ref: CollectionRef,
  mode: 'aggregation' | 'shell',
  applied: AppliedSource | null
): ResultRun {
  if (applied === null || applied.source.trim() === '') return { kind: 'idle', mode }
  if (mode === 'aggregation') {
    const compiled = compilePipelineSource(applied.source)
    if (!compiled.ok) return { kind: 'invalid', error: compiled.error }
    return {
      kind: 'ready',
      key: queryKeys.aggregate(
        tabId,
        ref.connectionId,
        ref.db,
        ref.coll,
        applied.source,
        applied.epoch
      ),
      execute: (requestId) => runAggregation(ref, compiled, requestId)
    }
  }
  const parsed = parseShellCommand(applied.source)
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error }
  const { coll, op } = parsed.command
  if (op.kind === 'write') return { kind: 'write', epoch: applied.epoch }
  return {
    kind: 'ready',
    key: queryKeys.shell(tabId, ref.connectionId, ref.db, applied.source, applied.epoch),
    execute: (requestId) => runShellCommand(ref, { coll, op }, requestId)
  }
}

function rowsSummary(result: DocumentsResult, tabColl: string): StatusSummary {
  return {
    kind: 'rows',
    rows: result.documents.length,
    truncated: result.truncated,
    truncationHint: TRUNCATION_HINTS[result.origin],
    readOnlyReason:
      result.rowAccess !== 'none'
        ? null
        : result.origin === 'distinct'
          ? "Distinct values aren't documents."
          : `Pipeline output isn't 1:1 documents of ${result.coll}, so rows can't be edited or deleted.`,
    foreignColl: result.coll === tabColl ? null : result.coll
  }
}
