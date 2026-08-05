import type { Document, Filter, Sort, UpdateFilter } from 'mongodb'
import { EJSON } from 'bson'
import type {
  AggregateRequest,
  AggregateResponse,
  DeleteByFilterRequest,
  DeleteByFilterResponse,
  DeleteManyRequest,
  DeleteManyResponse,
  DeleteOneRequest,
  DeleteOneResponse,
  DocumentEnvelope,
  FindRequest,
  FindResponse,
  InsertManyRequest,
  InsertManyResponse,
  InsertOneRequest,
  InsertOneResponse,
  ReplaceByFilterRequest,
  ReplaceByFilterResponse,
  ReplaceOneRequest,
  ReplaceOneResponse,
  UpdateByFilterRequest,
  UpdateByFilterResponse
} from '@shared/types'
import type { ConnectionService } from './ConnectionService'
import { canonicalHash, parseFilter, toCanonicalString, toRelaxed } from '../lib/ejson'

export class QueryService {
  constructor(private readonly connections: ConnectionService) {}

  async find(req: FindRequest): Promise<FindResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)

    const filter = parseFilter(req.filter)
    const projection = parseFilter(req.projection)
    const sort = parseFilter(req.sort) as Sort

    const startedAt = Date.now()
    let cursor = coll.find(filter)
    if (Object.keys(projection).length > 0) cursor = cursor.project(projection)
    if (Object.keys(sort).length > 0) cursor = cursor.sort(sort)
    if (req.skip > 0) cursor = cursor.skip(req.skip)
    if (req.limit !== undefined && req.limit > 0) cursor = cursor.limit(req.limit)

    const docs: Document[] = await cursor.toArray()
    const tookMs = Date.now() - startedAt

    const documents: DocumentEnvelope[] = docs.map(toEnvelope)

    return { documents, tookMs }
  }

  async aggregate(req: AggregateRequest): Promise<AggregateResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)

    const pipeline = parsePipeline(req.pipeline)

    const startedAt = Date.now()
    const docs = await coll.aggregate(pipeline).toArray()
    const tookMs = Date.now() - startedAt

    return { documents: docs.map(toEnvelope), tookMs }
  }

  async count(req: {
    connectionId: string
    db: string
    coll: string
    filter?: string
  }): Promise<{ count: number; estimated: boolean }> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const filter = parseFilter(req.filter)
    if (Object.keys(filter).length === 0) {
      const count = await coll.estimatedDocumentCount()
      return { count, estimated: true }
    }
    const count = await coll.countDocuments(filter)
    return { count, estimated: false }
  }

  async replaceOne(req: ReplaceOneRequest): Promise<ReplaceOneResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const idValue = parseId(req.id)
    const replacement = parseDocument(req.replacement)

    const idFilter = { _id: idValue } as Filter<Document>
    const fresh = await coll.findOne(idFilter)
    if (!fresh) {
      const e = new Error('Document not found — it may have been deleted')
      e.name = 'DocumentNotFoundError'
      throw e
    }
    if (canonicalHash(fresh) !== req.expectedHash) {
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

    const fresh = await coll.findOne(idFilter)
    if (!fresh) {
      return { deletedCount: 0 }
    }
    if (canonicalHash(fresh) !== req.expectedHash) {
      const e = new Error('Document changed since you opened it')
      e.name = 'DocumentConflictError'
      throw e
    }

    const result = await coll.deleteOne(idFilter)
    return { deletedCount: result.deletedCount }
  }

  async updateByFilter(req: UpdateByFilterRequest): Promise<UpdateByFilterResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const filter = parseFilter(req.filter) as Filter<Document>
    const update = parseUpdate(req.update)

    const result = req.many
      ? await coll.updateMany(filter, update, { upsert: req.upsert })
      : await coll.updateOne(filter, update, { upsert: req.upsert })

    return {
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upsertedId: result.upsertedId ? toCanonicalString(result.upsertedId) : null
    }
  }

  async deleteByFilter(req: DeleteByFilterRequest): Promise<DeleteByFilterResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const filter = parseFilter(req.filter) as Filter<Document>

    const result = req.many ? await coll.deleteMany(filter) : await coll.deleteOne(filter)
    return { deletedCount: result.deletedCount }
  }

  async replaceByFilter(req: ReplaceByFilterRequest): Promise<ReplaceByFilterResponse> {
    const client = this.connections.getClient(req.connectionId)
    const coll = client.db(req.db).collection(req.coll)
    const filter = parseFilter(req.filter) as Filter<Document>
    const replacement = parseDocument(req.replacement)

    const result = await coll.replaceOne(filter, replacement, { upsert: req.upsert })
    return {
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upsertedId: result.upsertedId ? toCanonicalString(result.upsertedId) : null
    }
  }
}

function toEnvelope(doc: Document): DocumentEnvelope {
  const idValue = doc['_id']
  return {
    id: toCanonicalString(idValue),
    data: toRelaxed(doc),
    canonical: toCanonicalString(doc),
    hash: canonicalHash(doc)
  }
}

function parseId(canonical: string): unknown {
  return EJSON.parse(canonical, { relaxed: false })
}

function parseDocument(canonical: string): Document {
  const parsed = EJSON.parse(canonical, { relaxed: false })
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const e = new Error('Document must be a JSON object')
    e.name = 'ValidationError'
    throw e
  }
  return parsed as Document
}

/**
 * Update documents must consist of update operators (`$set`, `$inc`, …) or
 * be an aggregation pipeline. A plain document would silently replace the
 * whole record, which is what `replaceByFilter` is for.
 */
function parseUpdate(canonical: string): UpdateFilter<Document> | Document[] {
  const parsed = EJSON.parse(canonical, { relaxed: false })
  if (Array.isArray(parsed)) return parsePipeline(canonical)
  if (typeof parsed !== 'object' || parsed === null) {
    const e = new Error('Update must be a JSON object')
    e.name = 'ValidationError'
    throw e
  }
  const keys = Object.keys(parsed)
  if (keys.length === 0 || !keys.every((key) => key.startsWith('$'))) {
    const e = new Error('Update must only contain update operators such as $set or $inc')
    e.name = 'ValidationError'
    throw e
  }
  return parsed as UpdateFilter<Document>
}

function parsePipeline(canonical: string): Document[] {
  const parsed = EJSON.parse(canonical, { relaxed: false })
  if (!Array.isArray(parsed)) {
    const e = new Error('Pipeline must be an array of stage objects')
    e.name = 'ValidationError'
    throw e
  }
  for (const stage of parsed) {
    if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
      const e = new Error('Each pipeline stage must be an object')
      e.name = 'ValidationError'
      throw e
    }
  }
  return parsed as Document[]
}
