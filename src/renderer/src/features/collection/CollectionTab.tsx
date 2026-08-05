import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Layers, Loader2, Pencil, ServerCrash, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
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
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { parseMongoQuery } from '@/lib/mongoQueryLang'
import {
  affectsWholeCollection,
  isWriteOp,
  parseShellCommand,
  type ShellWriteOp,
  type ShellWriteRequest
} from '@/lib/shellParser'
import {
  useTabsStore,
  type CollectionTab as CollectionTabType,
  type QueryMode,
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
        idle: false,
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
      if (tab.pipeline.trim().length === 0) {
        return { mode: 'aggregation' as const, ok: false, idle: true, pipeline: null, error: null }
      }
      const r = parseMongoQuery(tab.pipeline)
      if (!r.ok) {
        return {
          mode: 'aggregation' as const,
          ok: false,
          idle: false,
          pipeline: null,
          error: r.error
        }
      }
      if (!Array.isArray(r.value)) {
        return {
          mode: 'aggregation' as const,
          ok: false,
          idle: false,
          pipeline: null,
          error: 'Pipeline must be an array'
        }
      }
      return { mode: 'aggregation' as const, ok: true, idle: false, pipeline: r.ejson, error: null }
    }
    if (tab.shell.trim().length === 0) {
      return { mode: 'shell' as const, ok: false, idle: true, parsed: null, error: null }
    }
    const r = parseShellCommand(tab.shell)
    if (!r.ok) {
      return { mode: 'shell' as const, ok: false, idle: false, parsed: null, error: r.error }
    }
    return { mode: 'shell' as const, ok: true, idle: false, parsed: r, error: null }
  }, [tab.mode, tab.filter, tab.projection, tab.sort, tab.pipeline, tab.shell])

  // A shell command may target another collection than the tab it was
  // typed in; every read and every row action has to follow it.
  const effectiveColl =
    compiled.mode === 'shell' && compiled.parsed ? compiled.parsed.coll : tab.coll
  const shellOp = compiled.mode === 'shell' ? (compiled.parsed?.op ?? null) : null
  const writeOp: ShellWriteOp | null = shellOp && isWriteOp(shellOp) ? shellOp : null

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
    queryFn: () => runForMode(tab, compiled, effectiveColl),
    // Writes never run as a query — a query may refetch, a write may not.
    enabled: compiled.ok && writeOp === null,
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

  const [writeResult, setWriteResult] = useState<{
    command: string
    outcome: ShellWriteOutcome
  } | null>(null)
  const [pendingWrite, setPendingWrite] = useState<ShellWriteRequest | null>(null)

  const writeMutation = useMutation({
    mutationFn: (request: ShellWriteRequest) =>
      runWrite(tab.connectionId, tab.db, request.coll, request.op),
    onSuccess: (outcome, request) => {
      setWriteResult({ command: request.command, outcome })
      setPendingWrite(null)
      void queryClient.invalidateQueries({ queryKey: ['find'] })
      void queryClient.invalidateQueries({ queryKey: ['count'] })
      void queryClient.invalidateQueries({ queryKey: ['aggregate'] })
      void queryClient.invalidateQueries({ queryKey: ['shell'] })
      void queryClient.invalidateQueries({ queryKey: ['collection-stats'] })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.collections(tab.connectionId, tab.db)
      })
      toast.success(outcome.title)
    },
    onError: (error) => {
      setPendingWrite(null)
      toast.error(error instanceof ApiError ? error.message : 'Command failed')
    }
  })

  const runWriteCommand = (request: ShellWriteRequest) => {
    if (writeMutation.isPending) return
    if (affectsWholeCollection(request.op)) {
      setPendingWrite(request)
      return
    }
    writeMutation.mutate(request)
  }

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
  const currentWriteResult = writeResult?.command === tab.shell ? writeResult.outcome : null

  return (
    <section className="flex h-full flex-col">
      <QueryToolbar
        tab={tab}
        onApply={apply}
        onRunWrite={runWriteCommand}
        onCancel={cancel}
        loading={findQuery.isFetching || writeMutation.isPending}
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
        coll={effectiveColl === tab.coll ? null : effectiveColl}
        onJump={(skip) => setQuery(tab.id, { skip })}
      />

      <div className="relative flex-1 overflow-hidden">
        {compiled.idle ? (
          <IdleState mode={tab.mode} coll={tab.coll} />
        ) : compiled.error ? (
          <ErrorState message={compiled.error} />
        ) : writeOp ? (
          <WriteState
            op={writeOp}
            coll={effectiveColl}
            pending={writeMutation.isPending}
            outcome={currentWriteResult}
          />
        ) : findQuery.error instanceof ApiError ? (
          <ErrorState message={findQuery.error.message} />
        ) : (
          <DocumentTable
            documents={documents}
            loading={findQuery.isFetching}
            connectionId={tab.connectionId}
            db={tab.db}
            coll={effectiveColl}
            uuidEncoding={uuidEncoding}
            timezone={timezone}
          />
        )}
      </div>

      <AlertDialog
        open={pendingWrite !== null}
        onOpenChange={(open) => {
          if (open || writeMutation.isPending) return
          setPendingWrite(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingWrite?.op.kind === 'deleteMany'
                ? 'Delete every document?'
                : 'Update every document?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The command has an empty filter and therefore hits every document in{' '}
              <span className="font-mono text-foreground">
                {tab.db}.{pendingWrite?.coll}
              </span>
              . This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={writeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={writeMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (pendingWrite) writeMutation.mutate(pendingWrite)
              }}
            >
              {writeMutation.isPending && <Loader2 className="animate-spin" />}
              Run anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

type Compiled =
  | {
      mode: 'simple'
      ok: boolean
      idle: boolean
      filter: string | null
      projection: string | null
      sort: string | null
      error: string | null
    }
  | {
      mode: 'aggregation'
      ok: boolean
      idle: boolean
      pipeline: string | null
      error: string | null
    }
  | {
      mode: 'shell'
      ok: boolean
      idle: boolean
      parsed: (ReturnType<typeof parseShellCommand> & { ok: true }) | null
      error: string | null
    }

async function runForMode(
  tab: CollectionTabType,
  compiled: Compiled,
  coll: string
): Promise<FindResponse> {
  if (compiled.mode === 'simple') {
    return api.query.find({
      connectionId: tab.connectionId,
      db: tab.db,
      coll,
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
      coll,
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
      coll,
      pipeline: op.pipeline
    })
  }
  if (op.kind === 'find') {
    return api.query.find({
      connectionId: tab.connectionId,
      db: tab.db,
      coll,
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
      coll,
      filter: op.filter,
      skip: 0,
      limit: 1
    })
  }
  if (op.kind === 'countDocuments') {
    // countDocuments — return an empty docs response; the count shows in the
    // StatusBar via a one-off api.query.count call below.
    const countResp = await api.query.count({
      connectionId: tab.connectionId,
      db: tab.db,
      coll,
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
  throw new Error('unreachable: write command dispatched as a read')
}

type ShellWriteOutcome = {
  title: string
  details: string[]
}

async function runWrite(
  connectionId: string,
  db: string,
  coll: string,
  op: ShellWriteOp
): Promise<ShellWriteOutcome> {
  const target = { connectionId, db, coll }
  switch (op.kind) {
    case 'insertOne': {
      const result = await api.query.insertOne({ ...target, document: op.document })
      return { title: '1 document inserted', details: [`insertedId: ${result.insertedId}`] }
    }
    case 'insertMany': {
      const result = await api.query.insertMany({ ...target, documents: op.documents })
      return {
        title: `${plural(result.insertedIds.length, 'document')} inserted`,
        details: result.insertedIds.slice(0, 20).map((id) => `insertedId: ${id}`)
      }
    }
    case 'updateOne':
    case 'updateMany': {
      const result = await api.query.updateByFilter({
        ...target,
        filter: op.filter,
        update: op.update,
        many: op.kind === 'updateMany',
        upsert: op.upsert
      })
      return {
        title: `${plural(result.modified, 'document')} modified`,
        details: [
          `matched: ${result.matched}`,
          ...(result.upsertedId ? [`upsertedId: ${result.upsertedId}`] : [])
        ]
      }
    }
    case 'replaceOne': {
      const result = await api.query.replaceByFilter({
        ...target,
        filter: op.filter,
        replacement: op.replacement,
        upsert: op.upsert
      })
      return {
        title: `${plural(result.modified, 'document')} replaced`,
        details: [
          `matched: ${result.matched}`,
          ...(result.upsertedId ? [`upsertedId: ${result.upsertedId}`] : [])
        ]
      }
    }
    case 'deleteOne':
    case 'deleteMany': {
      const result = await api.query.deleteByFilter({
        ...target,
        filter: op.filter,
        many: op.kind === 'deleteMany'
      })
      return { title: `${plural(result.deletedCount, 'document')} deleted`, details: [] }
    }
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function WriteState({
  op,
  coll,
  pending,
  outcome
}: {
  op: ShellWriteOp
  coll: string
  pending: boolean
  outcome: ShellWriteOutcome | null
}) {
  if (pending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Running {op.kind}…
      </div>
    )
  }
  if (outcome) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <CheckCircle2 className="h-6 w-6 text-primary" />
        <div className="text-sm text-foreground">{outcome.title}</div>
        {outcome.details.length > 0 && (
          <div className="max-h-40 overflow-auto rounded-md border bg-card/40 px-3 py-2 text-left font-mono text-xs text-muted-foreground">
            {outcome.details.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Pencil className="h-6 w-6 text-muted-foreground/50" />
      <div className="text-sm text-muted-foreground">
        <span className="font-mono text-foreground">{op.kind}</span> on{' '}
        <span className="font-mono text-foreground">{coll}</span> is ready. Press Run to execute it.
      </div>
    </div>
  )
}

function IdleState({ mode, coll }: { mode: QueryMode; coll: string }) {
  const isShell = mode === 'shell'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {isShell ? (
        <TerminalSquare className="h-6 w-6 text-muted-foreground/50" />
      ) : (
        <Layers className="h-6 w-6 text-muted-foreground/50" />
      )}
      <div className="text-sm text-muted-foreground">
        {isShell
          ? 'Write a shell command above and press Run.'
          : 'Build an aggregation pipeline above and press Run.'}
      </div>
      <code className="rounded-md border bg-card/40 px-2 py-1 font-mono text-xs text-muted-foreground/70">
        {isShell ? `db.${coll}.find({}).limit(50)` : '[{ $match: { … } }]'}
      </code>
    </div>
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
