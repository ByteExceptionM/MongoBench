import type {
  AnyBulkWriteOperation,
  Collection,
  Document,
  Filter,
  ModifyResult,
  Sort,
  UpdateResult
} from 'mongodb'
import { EJSON } from 'bson'
import {
  finalWriteStage,
  findRejectedStage,
  rejectedStageMessage,
  writePipelineError
} from '@shared/pipeline'
import {
  bulkWriteError,
  filterError,
  insertDocumentError,
  isDocument,
  replacementError,
  updateError,
  writeOptionsError
} from '@shared/writeOps'
import {
  RESULT_CAP,
  type AggregateRequest,
  type AggregateResponse,
  type CountRequest,
  type CountResponse,
  type DeleteManyRequest,
  type DeleteManyResponse,
  type DeleteOneRequest,
  type DeleteOneResponse,
  type DistinctRequest,
  type DistinctResponse,
  type DocumentEnvelope,
  type FindRequest,
  type FindResponse,
  type InsertManyRequest,
  type InsertManyResponse,
  type InsertOneRequest,
  type InsertOneResponse,
  type ReplaceOneRequest,
  type ReplaceOneResponse,
  type WriteMethod,
  type WriteOp,
  type WriteRequest,
  type WriteResponse
} from '@shared/types'
import type { ConnectionService } from './ConnectionService'
import {
  REPLY_DECODE_OPTIONS,
  canonicalHash,
  decodeDocument,
  hashCanonicalString,
  parseFilter,
  toCanonicalString,
  toRelaxed
} from '../lib/ejson'
import { cancelledError, validationError } from '../lib/errorMap'

export class QueryService {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly connections: ConnectionService) {}

  async find(req: FindRequest): Promise<FindResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)

    const filter = parseFilter(req.filter)
    const projection = parseFilter(req.projection)
    const sort = parseFilter(req.sort) as Sort

    const startedAt = Date.now()
    const docs = await this.track(req.requestId, (signal) => {
      let cursor = coll.find<Uint8Array>(filter, { raw: true, signal })
      if (Object.keys(projection).length > 0) cursor = cursor.project<Uint8Array>(projection)
      if (Object.keys(sort).length > 0) cursor = cursor.sort(sort)
      if (req.skip > 0) cursor = cursor.skip(req.skip)
      if (req.limit !== undefined && req.limit > 0) cursor = cursor.limit(req.limit)
      return cursor.toArray()
    })
    const tookMs = Date.now() - startedAt

    const documents: DocumentEnvelope[] = docs.map((bytes) => toEnvelope(decodeDocument(bytes)))

    return { documents, tookMs }
  }

  async aggregate(req: AggregateRequest): Promise<AggregateResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)

    const pipeline = parsePipeline(req.pipeline)

    const startedAt = Date.now()
    // The server applies the cap, so a $sort before it becomes a top-k sort.
    const docs = await this.track(req.requestId, (signal) =>
      coll
        .aggregate<Uint8Array>([...pipeline, { $limit: RESULT_CAP + 1 }], { raw: true, signal })
        .toArray()
    )
    const tookMs = Date.now() - startedAt

    return {
      documents: docs.slice(0, RESULT_CAP).map((bytes) => toEnvelope(decodeDocument(bytes))),
      tookMs,
      truncated: docs.length > RESULT_CAP
    }
  }

  async count(req: CountRequest): Promise<CountResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const filter = parseFilter(req.filter)
    const startedAt = Date.now()
    if (!req.exact && Object.keys(filter).length === 0) {
      const count = await coll.estimatedDocumentCount()
      return { count, estimated: true, tookMs: Date.now() - startedAt }
    }
    const count = await this.track(req.requestId, (signal) =>
      coll.countDocuments(filter, { signal })
    )
    return { count, estimated: false, tookMs: Date.now() - startedAt }
  }

  async distinct(req: DistinctRequest): Promise<DistinctResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const filter = parseFilter(req.filter)

    const startedAt = Date.now()
    // distinct cannot read raw, so Int32 and Double values both arrive as numbers.
    const values = await coll.distinct(req.field, filter, REPLY_DECODE_OPTIONS)
    const tookMs = Date.now() - startedAt

    return {
      documents: values.slice(0, RESULT_CAP).map((value: unknown) => toEnvelope({ value })),
      tookMs,
      truncated: values.length > RESULT_CAP
    }
  }

  /** Aborts the run registered under `requestId`; ids of settled or unknown runs are ignored. */
  cancel(requestId: string): void {
    this.running.get(requestId)?.abort(cancelledError('Query cancelled'))
  }

  async replaceOne(req: ReplaceOneRequest): Promise<ReplaceOneResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const idValue = parseId(req.id)
    const replacement = parseDocument(req.replacement)

    const idFilter = { _id: idValue } as Filter<Document>
    const fresh = await coll.findOne<Uint8Array>(idFilter, { raw: true })
    if (!fresh) {
      const e = new Error('Document not found — it may have been deleted')
      e.name = 'DocumentNotFoundError'
      throw e
    }
    if (canonicalHash(decodeDocument(fresh)) !== req.expectedHash) {
      const e = new Error('Document changed since you opened it')
      e.name = 'DocumentConflictError'
      throw e
    }

    if (toCanonicalString(replacement['_id']) !== req.id) {
      const e = new Error('Replacement document changed _id; that is not allowed')
      e.name = 'DocumentImmutableIdError'
      throw e
    }

    const result = await coll.replaceOne(idFilter, replacement)
    return { matched: result.matchedCount, modified: result.modifiedCount }
  }

  async insertOne(req: InsertOneRequest): Promise<InsertOneResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const document = parseDocument(req.document)
    const result = await coll.insertOne(document)
    return { insertedId: toCanonicalString(result.insertedId) }
  }

  async insertMany(req: InsertManyRequest): Promise<InsertManyResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const documents = req.documents.map(parseDocument)
    const result = await coll.insertMany(documents)
    return { insertedIds: Object.values(result.insertedIds).map((id) => toCanonicalString(id)) }
  }

  /**
   * Bulk delete by `_id`. No per-document hash check — the renderer
   * collects an explicit confirmation before calling this, so a stale
   * view between selection and submission is acceptable. Documents that
   * have already been deleted are silently skipped (driver semantics).
   */
  async deleteMany(req: DeleteManyRequest): Promise<DeleteManyResponse> {
    if (req.ids.length === 0) return { deletedCount: 0 }
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const idValues = req.ids.map(parseId)
    const result = await coll.deleteMany({ _id: { $in: idValues } } as Filter<Document>)
    return { deletedCount: result.deletedCount }
  }

  async deleteOne(req: DeleteOneRequest): Promise<DeleteOneResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const idValue = parseId(req.id)
    const idFilter = { _id: idValue } as Filter<Document>

    const fresh = await coll.findOne<Uint8Array>(idFilter, { raw: true })
    if (!fresh) {
      return { deletedCount: 0 }
    }
    if (canonicalHash(decodeDocument(fresh)) !== req.expectedHash) {
      const e = new Error('Document changed since you opened it')
      e.name = 'DocumentConflictError'
      throw e
    }

    const result = await coll.deleteOne(idFilter)
    return { deletedCount: result.deletedCount }
  }

  /** Validates a shell write by the parser's rules, then runs it; writes take no abort signal. */
  async write(req: WriteRequest): Promise<WriteResponse> {
    const execute = prepareWrite(req.op)
    const coll = this.connections.getClient(req.connectionId).db(req.db).collection(req.coll)
    const startedAt = Date.now()
    const outcome = await execute(coll)
    return { ...outcome, tookMs: Date.now() - startedAt }
  }

  // Registers before the first await, so a cancel that arrives right after the request finds it.
  private async track<T>(
    requestId: string | undefined,
    run: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    if (requestId === undefined) return run(undefined)
    const controller = new AbortController()
    this.running.set(requestId, controller)
    try {
      return await run(controller.signal)
    } catch (error) {
      // A cancel during getMore surfaces as the server's interrupt error, not as the abort reason.
      throw controller.signal.aborted ? controller.signal.reason : error
    } finally {
      if (this.running.get(requestId) === controller) this.running.delete(requestId)
    }
  }
}

function toEnvelope(doc: Document): DocumentEnvelope {
  const canonical = toCanonicalString(doc)
  return {
    id: '_id' in doc ? toCanonicalString(doc['_id']) : null,
    data: toRelaxed(doc),
    canonical,
    hash: hashCanonicalString(canonical)
  }
}

function parseId(canonical: string): unknown {
  return EJSON.parse(canonical, { relaxed: false })
}

function parseDocument(canonical: string): Document {
  const parsed = EJSON.parse(canonical, { relaxed: false })
  if (!isDocument(parsed)) throw validationError('Document must be a JSON object')
  return parsed as Document
}

function parsePipeline(canonical: string): Document[] {
  const stages = parseStages(canonical)
  const rejected = findRejectedStage(stages)
  if (rejected !== null) throw validationError(rejectedStageMessage(rejected))
  return stages
}

function parseStages(canonical: string): Document[] {
  const parsed = EJSON.parse(canonical, { relaxed: false })
  if (!Array.isArray(parsed)) throw validationError('Pipeline must be an array of stage objects')
  for (const stage of parsed) {
    if (!isDocument(stage)) throw validationError('Each pipeline stage must be an object')
  }
  return parsed as Document[]
}

type WriteOutcome = Omit<WriteResponse, 'tookMs'>

// Not raw: an error reply's topologyVersion would arrive as bytes and break failover detection.
const MODIFY_OPTIONS = { ...REPLY_DECODE_OPTIONS, includeResultMetadata: true } as const

// Parses and validates up front, so an invalid write throws before anything reaches the server.
function prepareWrite(op: WriteOp): (coll: Collection) => Promise<WriteOutcome> {
  switch (op.method) {
    case 'insertOne': {
      const document = parseChecked(op.document, insertDocumentError)
      const options = parseOptions(op.method, op.options)
      return async (coll) => {
        const result = await coll.insertOne(document, options)
        return { counts: { inserted: 1 }, ...idList([result.insertedId]) }
      }
    }
    case 'insertMany': {
      const documents = op.documents.map((text) => parseChecked(text, insertDocumentError))
      const options = parseOptions(op.method, op.options)
      return async (coll) => {
        const result = await coll.insertMany(documents, options)
        return {
          counts: { inserted: result.insertedCount },
          ...idList(Object.values(result.insertedIds))
        }
      }
    }
    case 'updateOne':
    case 'updateMany': {
      const { method } = op
      const filter = parseWriteFilter(method, op.filter)
      const update = parseChecked(op.update, updateError)
      const options = { ...parseOptions(method, op.options), ...REPLY_DECODE_OPTIONS }
      return async (coll) =>
        updateOutcome(
          method === 'updateOne'
            ? await coll.updateOne(filter, update, options)
            : await coll.updateMany(filter, update, options)
        )
    }
    case 'replaceOne': {
      const filter = parseWriteFilter(op.method, op.filter)
      const replacement = parseChecked(op.replacement, replacementError)
      const options = { ...parseOptions(op.method, op.options), ...REPLY_DECODE_OPTIONS }
      return async (coll) => updateOutcome(await coll.replaceOne(filter, replacement, options))
    }
    case 'deleteOne':
    case 'deleteMany': {
      const { method } = op
      const filter = parseWriteFilter(method, op.filter)
      const options = parseOptions(method, op.options)
      return async (coll) => {
        const result =
          method === 'deleteOne'
            ? await coll.deleteOne(filter, options)
            : await coll.deleteMany(filter, options)
        return { counts: { deleted: result.deletedCount }, ...idList([]) }
      }
    }
    case 'findOneAndUpdate': {
      const filter = parseWriteFilter(op.method, op.filter)
      const update = parseChecked(op.update, updateError)
      const options = returnDocumentOptions(parseOptions(op.method, op.options))
      return async (coll) =>
        modifyOutcome(
          await coll.findOneAndUpdate(filter, update, { ...options, ...MODIFY_OPTIONS }),
          'update'
        )
    }
    case 'findOneAndReplace': {
      const filter = parseWriteFilter(op.method, op.filter)
      const replacement = parseChecked(op.replacement, replacementError)
      const options = returnDocumentOptions(parseOptions(op.method, op.options))
      return async (coll) =>
        modifyOutcome(
          await coll.findOneAndReplace(filter, replacement, { ...options, ...MODIFY_OPTIONS }),
          'update'
        )
    }
    case 'findOneAndDelete': {
      const filter = parseWriteFilter(op.method, op.filter)
      const options = parseOptions(op.method, op.options)
      return async (coll) =>
        modifyOutcome(
          await coll.findOneAndDelete(filter, { ...options, ...MODIFY_OPTIONS }),
          'delete'
        )
    }
    case 'bulkWrite': {
      const operations = parseChecked(op.operations, bulkWriteError) as AnyBulkWriteOperation[]
      const options = { ...parseOptions(op.method, op.options), ...REPLY_DECODE_OPTIONS }
      return async (coll) => {
        const result = await coll.bulkWrite(operations, options)
        return {
          counts: {
            inserted: result.insertedCount,
            matched: result.matchedCount,
            modified: result.modifiedCount,
            deleted: result.deletedCount,
            upserted: result.upsertedCount
          },
          // Not merged by key: unordered writes key each map by position among operations of its kind.
          ...idList([...Object.values(result.insertedIds), ...Object.values(result.upsertedIds)])
        }
      }
    }
    case 'aggregate': {
      const stages = parseStages(op.pipeline)
      rejectInvalid(
        finalWriteStage(stages) === null
          ? 'A write pipeline must end with $out or $merge'
          : writePipelineError(stages)
      )
      return async (coll) => {
        // The server writes while the cursor is drained; $out / $merge return no documents.
        await coll.aggregate(stages).toArray()
        return { counts: {}, ...idList([]) }
      }
    }
  }
}

function updateOutcome(result: UpdateResult): WriteOutcome {
  return {
    counts: {
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: result.upsertedCount
    },
    ...idList(result.upsertedCount > 0 ? [result.upsertedId] : [])
  }
}

function modifyOutcome(result: ModifyResult, kind: 'update' | 'delete'): WriteOutcome {
  const meta = result.lastErrorObject ?? {}
  const n = Number(meta['n'] ?? 0)
  const upserted = 'upserted' in meta ? [meta['upserted']] : []
  return {
    counts:
      kind === 'delete'
        ? { deleted: n }
        : { matched: meta['updatedExisting'] === true ? n : 0, upserted: upserted.length },
    ...idList(upserted),
    document: result.value === null ? null : toEnvelope(result.value)
  }
}

function idList(ids: readonly unknown[]): Pick<WriteResponse, 'ids' | 'idsTruncated'> {
  return {
    ids: ids.slice(0, RESULT_CAP).map((id) => toCanonicalString(id)),
    idsTruncated: ids.length > RESULT_CAP
  }
}

function parseChecked(canonical: string, problem: (value: unknown) => string | null): Document {
  const value: unknown = EJSON.parse(canonical, { relaxed: false })
  rejectInvalid(problem(value))
  return value as Document
}

function parseWriteFilter(method: WriteMethod, canonical: string): Document {
  return parseChecked(canonical, (filter) => filterError(method, filter))
}

function parseOptions(method: WriteMethod, canonical: string | undefined): Document {
  return canonical === undefined
    ? {}
    : parseChecked(canonical, (options) => writeOptionsError(method, options))
}

// mongosh's returnNewDocument; the driver only knows returnDocument.
function returnDocumentOptions({ returnNewDocument, ...options }: Document): Document {
  return returnNewDocument === undefined
    ? options
    : { ...options, returnDocument: returnNewDocument === true ? 'after' : 'before' }
}

function rejectInvalid(message: string | null): void {
  if (message !== null) throw validationError(message)
}
