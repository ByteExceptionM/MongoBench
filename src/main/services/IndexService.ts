import type { CreateIndexesOptions, IndexDirection, IndexSpecification } from 'mongodb'
import { EJSON } from 'bson'
import type { IndexCreateOptions, IndexInfo, IndexStatsReport } from '@shared/types'
import { isDocument } from '@shared/writeOps'
import { buildIndexStatsReport } from '../lib/indexStats'
import { parseRelaxed, toRelaxed } from '../lib/ejson'
import { validationError } from '../lib/errorMap'
import type { ConnectionService } from './ConnectionService'

/** Index management on a single collection. */
export class IndexService {
  constructor(private readonly connections: ConnectionService) {}

  async listIndexes(connectionId: string, db: string, coll: string): Promise<IndexInfo[]> {
    const client = this.connections.getClient(connectionId)
    const collection = client.db(db).collection(coll)
    const raw = await collection.listIndexes().toArray()
    return raw.map((info) => mapIndex(info as Record<string, unknown>))
  }

  /** Per-index size, build state and usage; each source degrades on its own instead of failing. */
  async indexStats(connectionId: string, db: string, coll: string): Promise<IndexStatsReport> {
    const collection = this.connections.getClient(connectionId).db(db).collection(coll)
    const [usage, storage] = await Promise.allSettled([
      collection.aggregate([{ $indexStats: {} }]).toArray(),
      collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray()
    ])
    return buildIndexStatsReport(usage, storage)
  }

  async createIndex(
    connectionId: string,
    db: string,
    coll: string,
    keysJson: string,
    options: IndexCreateOptions | undefined
  ): Promise<{ name: string }> {
    const client = this.connections.getClient(connectionId)
    const keys = parseObject(keysJson, 'keys')
    if (Object.keys(keys).length === 0) {
      throw validationError('At least one key field is required')
    }
    assertKeySpec(keys)

    const driverOptions: CreateIndexesOptions = {}
    if (options) {
      if (options.name !== undefined) driverOptions.name = options.name
      if (options.unique !== undefined) driverOptions.unique = options.unique
      if (options.sparse !== undefined) driverOptions.sparse = options.sparse
      if (options.hidden !== undefined) driverOptions.hidden = options.hidden
      if (options.expireAfterSeconds !== undefined) {
        driverOptions.expireAfterSeconds = options.expireAfterSeconds
      }
      if (options.partialFilterExpression !== undefined) {
        // Filter bounds may be Int64 values beyond 2^53, which only a bigint keeps exact.
        driverOptions.partialFilterExpression = parseObject(
          options.partialFilterExpression,
          'partialFilterExpression',
          parseRelaxed
        )
      }
      if (options.collation !== undefined) {
        driverOptions.collation = parseObject(options.collation, 'collation') as never
      }
      if (options.weights !== undefined) {
        driverOptions.weights = parseObject(options.weights, 'weights') as never
      }
      if (options.default_language !== undefined) {
        driverOptions.default_language = options.default_language
      }
      if (options.language_override !== undefined) {
        driverOptions.language_override = options.language_override
      }
      if (options.textIndexVersion !== undefined) {
        driverOptions.textIndexVersion = options.textIndexVersion
      }
      if (options['2dsphereIndexVersion'] !== undefined) {
        driverOptions['2dsphereIndexVersion'] = options['2dsphereIndexVersion']
      }
      if (options.bits !== undefined) driverOptions.bits = options.bits
      if (options.min !== undefined) driverOptions.min = options.min
      if (options.max !== undefined) driverOptions.max = options.max
      if (options.wildcardProjection !== undefined) {
        driverOptions.wildcardProjection = parseObject(
          options.wildcardProjection,
          'wildcardProjection'
        ) as never
      }
    }

    const name = await client
      .db(db)
      .collection(coll)
      .createIndex(keys as IndexSpecification, driverOptions)
    return { name }
  }

  async dropIndex(connectionId: string, db: string, coll: string, name: string): Promise<void> {
    if (name === '_id_') {
      throw validationError('The default _id_ index cannot be dropped')
    }
    const client = this.connections.getClient(connectionId)
    await client.db(db).collection(coll).dropIndex(name)
  }
}

function parseObject(
  input: string,
  label: string,
  parse: (text: string) => unknown = (text) => EJSON.parse(text, { relaxed: true })
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = parse(input)
  } catch (e) {
    throw validationError(
      `${label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!isDocument(parsed)) {
    throw validationError(`${label} must be a JSON object`)
  }
  return parsed
}

function assertKeySpec(keys: Record<string, unknown>): void {
  for (const [field, direction] of Object.entries(keys)) {
    if (field.length === 0) throw validationError('Key field name cannot be empty')
    if (typeof direction === 'number' ? direction !== 1 && direction !== -1 : false) {
      throw validationError(`Numeric direction for "${field}" must be 1 or -1`)
    }
    if (typeof direction === 'string') {
      if (!['text', '2dsphere', '2d', 'hashed'].includes(direction)) {
        throw validationError(`Unknown index type "${direction}" for field "${field}"`)
      }
    } else if (typeof direction !== 'number') {
      throw validationError(`Direction for "${field}" must be 1, -1, or a string type`)
    }
  }
}

function mapIndex(raw: Record<string, unknown>): IndexInfo {
  const out: IndexInfo = {
    name: String(raw['name']),
    key: (raw['key'] as Record<string, IndexDirection>) ?? {}
  }
  if (raw['v'] !== undefined) out.v = Number(raw['v'])
  if (raw['unique'] !== undefined) out.unique = Boolean(raw['unique'])
  if (raw['sparse'] !== undefined) out.sparse = Boolean(raw['sparse'])
  if (raw['expireAfterSeconds'] !== undefined) {
    out.expireAfterSeconds = Number(raw['expireAfterSeconds'])
  }
  if (raw['partialFilterExpression'] !== undefined) {
    out.partialFilterExpression = toRelaxed(raw['partialFilterExpression'])
  }
  if (raw['collation'] !== undefined) {
    out.collation = toRelaxed(raw['collation'])
  }
  if (raw['hidden'] !== undefined) out.hidden = Boolean(raw['hidden'])
  if (raw['background'] !== undefined) out.background = Boolean(raw['background'])
  if (raw['weights'] !== undefined) {
    out.weights = toRelaxed(raw['weights']) as Record<string, number>
  }
  if (raw['default_language'] !== undefined) out.default_language = String(raw['default_language'])
  if (raw['language_override'] !== undefined) {
    out.language_override = String(raw['language_override'])
  }
  if (raw['textIndexVersion'] !== undefined) out.textIndexVersion = Number(raw['textIndexVersion'])
  if (raw['2dsphereIndexVersion'] !== undefined) {
    out['2dsphereIndexVersion'] = Number(raw['2dsphereIndexVersion'])
  }
  if (raw['bits'] !== undefined) out.bits = Number(raw['bits'])
  if (raw['min'] !== undefined) out.min = Number(raw['min'])
  if (raw['max'] !== undefined) out.max = Number(raw['max'])
  if (raw['wildcardProjection'] !== undefined) {
    out.wildcardProjection = toRelaxed(raw['wildcardProjection'])
  }
  return out
}
