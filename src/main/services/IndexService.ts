import type { CreateIndexesOptions, IndexDirection, IndexSpecification } from 'mongodb'
import { EJSON } from 'bson'
import type { IndexCreateOptions, IndexInfo } from '@shared/types'
import type { ConnectionService } from './ConnectionService'

/** Index management on a single collection. */
export class IndexService {
  constructor(private readonly connections: ConnectionService) {}

  async listIndexes(connectionId: string, db: string, coll: string): Promise<IndexInfo[]> {
    const client = this.connections.getClient(connectionId)
    const collection = client.db(db).collection(coll)

    const [raw, statsCursor] = await Promise.all([
      collection.listIndexes().toArray(),
      collection
        .aggregate([{ $collStats: { storageStats: {} } }, { $limit: 1 }])
        .toArray()
        .catch(() => [] as Array<Record<string, unknown>>)
    ])

    const sizes =
      ((statsCursor[0]?.['storageStats'] as Record<string, unknown> | undefined)?.['indexSizes'] as
        | Record<string, number>
        | undefined) ?? {}

    return raw.map((info) =>
      mapIndex(info as Record<string, unknown>, sizes[info['name'] as string])
    )
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
      throwValidation('At least one key field is required')
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
        driverOptions.partialFilterExpression = parseObject(
          options.partialFilterExpression,
          'partialFilterExpression'
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
      throwValidation('The default _id_ index cannot be dropped')
    }
    const client = this.connections.getClient(connectionId)
    await client.db(db).collection(coll).dropIndex(name)
  }
}

function parseObject(input: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = EJSON.parse(input, { relaxed: true })
  } catch (e) {
    throwValidation(`${label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throwValidation(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function assertKeySpec(keys: Record<string, unknown>): void {
  for (const [field, direction] of Object.entries(keys)) {
    if (field.length === 0) throwValidation('Key field name cannot be empty')
    if (typeof direction === 'number' ? direction !== 1 && direction !== -1 : false) {
      throwValidation(`Numeric direction for "${field}" must be 1 or -1`)
    }
    if (typeof direction === 'string') {
      if (!['text', '2dsphere', '2d', 'hashed'].includes(direction)) {
        throwValidation(`Unknown index type "${direction}" for field "${field}"`)
      }
    } else if (typeof direction !== 'number') {
      throwValidation(`Direction for "${field}" must be 1, -1, or a string type`)
    }
  }
}

function mapIndex(raw: Record<string, unknown>, size: number | undefined): IndexInfo {
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
    out.partialFilterExpression = raw['partialFilterExpression'] as Record<string, unknown>
  }
  if (raw['collation'] !== undefined) {
    out.collation = raw['collation'] as Record<string, unknown>
  }
  if (raw['hidden'] !== undefined) out.hidden = Boolean(raw['hidden'])
  if (raw['background'] !== undefined) out.background = Boolean(raw['background'])
  if (raw['weights'] !== undefined) out.weights = raw['weights'] as Record<string, number>
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
    out.wildcardProjection = raw['wildcardProjection'] as Record<string, unknown>
  }
  if (size !== undefined) out.size = size
  return out
}

function throwValidation(message: string): never {
  const e = new Error(message)
  e.name = 'ValidationError'
  throw e
}
