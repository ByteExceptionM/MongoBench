import {
  RESULT_CAP,
  type CollectionRef,
  type DatabaseRef,
  type DocumentEnvelope,
  type FindRequest,
  type WriteOp,
  type WriteResponse
} from '@shared/types'
import type { AppliedSimple } from '@/store/tabs'
import type { CompiledPipeline } from './aggregationPipeline'
import { api } from './api'
import { parseMongoQuery } from './mongoQueryLang'
import type { ShellCountMethod, ShellOp } from './shellParser'

/** How rows relate to stored documents of the result's collection. */
export type RowAccess = 'full' | 'byId' | 'none'

/** A shell command that reads; it runs as a cancellable query. */
export type ShellReadCommand = { coll: string; op: Exclude<ShellOp, { kind: 'write' }> }

/** A shell command that writes; it runs once per Run, as a mutation. */
export type ShellWriteCommand = { coll: string; op: Extract<ShellOp, { kind: 'write' }> }

/** What a shell write did; `writes` is the collection it changed. */
export type ShellWriteResult = {
  method: WriteOp['method']
  /** Counters that apply to the method. */
  counts: WriteResponse['counts']
  /** Canonical EJSON of the inserted or upserted `_id`s. */
  ids: string[]
  /** More ids were written than `ids` holds. */
  idsTruncated: boolean
  /** findOneAnd*: the returned document (null when none matched) and its row access; else null. */
  returned: { document: DocumentEnvelope | null; rowAccess: RowAccess } | null
  writes: CollectionRef
  tookMs: number
}

/** What a run displays; `coll` is the collection the rows belong to. */
export type QueryResult =
  | {
      kind: 'documents'
      origin: 'find' | 'aggregate' | 'distinct'
      documents: DocumentEnvelope[]
      tookMs: number
      /** More rows existed than RESULT_CAP; only the first RESULT_CAP are included. */
      truncated: boolean
      rowAccess: RowAccess
      coll: string
    }
  | {
      kind: 'count'
      method: ShellCountMethod
      count: number
      estimated: boolean
      tookMs: number
      coll: string
    }

/** A Simple-mode query as EJSON; empty strings mean "not given". */
export type CompiledFind = {
  filter: string
  projection: string
  sort: string
  skip: number
  /** 0 = no limit. */
  limit: number
}

/** Compiles an applied Simple query; the error names the editor that failed to parse. */
export function compileFind(
  applied: AppliedSimple
): { ok: true; find: CompiledFind } | { ok: false; error: string } {
  const filter = parseMongoQuery(applied.filter)
  if (!filter.ok) return { ok: false, error: `Filter: ${filter.error}` }
  const projection = parseMongoQuery(applied.projection)
  if (!projection.ok) return { ok: false, error: `Projection: ${projection.error}` }
  const sort = parseMongoQuery(applied.sort)
  if (!sort.ok) return { ok: false, error: `Sort: ${sort.error}` }
  return {
    ok: true,
    find: {
      filter: filter.ejson,
      projection: projection.ejson,
      sort: sort.ejson,
      skip: applied.skip,
      limit: applied.limit
    }
  }
}

/** Limit sent for a shell find: at most RESULT_CAP rows shown, one extra detects truncation. */
export function boundedFindLimit(limit: number | null): number {
  return limit !== null && limit <= RESULT_CAP ? limit : RESULT_CAP + 1
}

const isWholeDocument = (projection: string | null): boolean =>
  projection === null || projection === '' || projection === '{}'

/**
 * Runs a Simple-mode find; uncapped, it pages with its own skip and limit.
 * @param requestId Lets `query.cancel` abort the server op.
 */
export async function runFind(
  ref: CollectionRef,
  find: CompiledFind,
  requestId: string
): Promise<QueryResult> {
  const response = await api.query.find({
    connectionId: ref.connectionId,
    db: ref.db,
    coll: ref.coll,
    ...(find.filter ? { filter: find.filter } : {}),
    ...(find.projection ? { projection: find.projection } : {}),
    ...(find.sort ? { sort: find.sort } : {}),
    skip: find.skip,
    ...(find.limit > 0 ? { limit: find.limit } : {}),
    requestId
  })
  return {
    kind: 'documents',
    origin: 'find',
    documents: response.documents,
    tookMs: response.tookMs,
    truncated: false,
    rowAccess: isWholeDocument(find.projection) ? 'full' : 'byId',
    coll: ref.coll
  }
}

/**
 * Runs an aggregation-mode pipeline on the tab's collection; main caps it at RESULT_CAP.
 * @param requestId Lets `query.cancel` abort the server op.
 */
export async function runAggregation(
  ref: CollectionRef,
  compiled: CompiledPipeline,
  requestId: string
): Promise<QueryResult> {
  const response = await api.query.aggregate({
    connectionId: ref.connectionId,
    db: ref.db,
    coll: ref.coll,
    pipeline: compiled.ejson,
    requestId
  })
  return {
    kind: 'documents',
    origin: 'aggregate',
    documents: response.documents,
    tookMs: response.tookMs,
    truncated: response.truncated,
    rowAccess: compiled.documentPreserving ? 'full' : 'none',
    coll: ref.coll
  }
}

/**
 * Runs a parsed shell read against any collection of the database.
 * @param requestId Lets `query.cancel` abort the server op; distinct ignores it.
 */
export async function runShellCommand(
  target: DatabaseRef,
  command: ShellReadCommand,
  requestId: string
): Promise<QueryResult> {
  const ref: CollectionRef = {
    connectionId: target.connectionId,
    db: target.db,
    coll: command.coll
  }
  const { op } = command
  switch (op.kind) {
    case 'find':
      return runShellFind(ref, op, boundedFindLimit(op.limit), requestId)
    case 'findOne':
      return runShellFind(ref, { ...op, sort: null, skip: 0 }, 1, requestId)
    case 'aggregate':
      return runAggregation(
        ref,
        { ejson: op.pipeline, documentPreserving: op.documentPreserving },
        requestId
      )
    case 'count': {
      const response = await api.query.count({
        ...ref,
        ...(op.filter !== null ? { filter: op.filter } : {}),
        // countDocuments is always exact; legacy count() estimates an empty filter, like mongosh.
        exact: op.method === 'countDocuments',
        requestId
      })
      return {
        kind: 'count',
        method: op.method,
        count: response.count,
        estimated: response.estimated,
        tookMs: response.tookMs,
        coll: ref.coll
      }
    }
    case 'distinct': {
      const response = await api.query.distinct({
        ...ref,
        field: op.field,
        ...(op.filter !== null ? { filter: op.filter } : {})
      })
      return {
        kind: 'documents',
        origin: 'distinct',
        documents: response.documents,
        tookMs: response.tookMs,
        truncated: response.truncated,
        rowAccess: 'none',
        coll: ref.coll
      }
    }
  }
}

/** The collection a shell write changes: the command's own, or the $out / $merge target. */
export function writtenCollection(target: DatabaseRef, command: ShellWriteCommand): CollectionRef {
  const { writes } = command.op
  return { connectionId: target.connectionId, db: writes.db ?? target.db, coll: writes.coll }
}

/** Runs a shell write against any collection of the database; the driver cannot abort writes. */
export async function runShellWrite(
  target: DatabaseRef,
  command: ShellWriteCommand
): Promise<ShellWriteResult> {
  const { write } = command.op
  const response = await api.query.write({
    connectionId: target.connectionId,
    db: target.db,
    coll: command.coll,
    op: write
  })
  return {
    method: write.method,
    counts: response.counts,
    ids: response.ids,
    idsTruncated: response.idsTruncated,
    returned: returnedDocument(write, response.document ?? null),
    writes: writtenCollection(target, command),
    tookMs: response.tookMs
  }
}

function returnedDocument(
  write: WriteOp,
  document: DocumentEnvelope | null
): ShellWriteResult['returned'] {
  switch (write.method) {
    case 'findOneAndDelete':
      return { document, rowAccess: 'none' }
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
      // An integral Double may arrive as Int32 (main promotes values), so edits load the stored one.
      return { document, rowAccess: 'byId' }
    default:
      return null
  }
}

async function runShellFind(
  ref: CollectionRef,
  op: { filter: string; projection: string | null; sort: string | null; skip: number },
  limit: number,
  requestId: string
): Promise<QueryResult> {
  const request: FindRequest = {
    ...ref,
    filter: op.filter,
    ...(op.projection !== null ? { projection: op.projection } : {}),
    ...(op.sort !== null ? { sort: op.sort } : {}),
    skip: op.skip,
    limit,
    requestId
  }
  const response = await api.query.find(request)
  return {
    kind: 'documents',
    origin: 'find',
    documents: response.documents.slice(0, RESULT_CAP),
    tookMs: response.tookMs,
    truncated: response.documents.length > RESULT_CAP,
    rowAccess: isWholeDocument(op.projection) ? 'full' : 'byId',
    coll: ref.coll
  }
}
