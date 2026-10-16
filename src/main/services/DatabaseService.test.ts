import { describe, expect, it } from 'vitest'
import { BSON, BSONRegExp, Double, Int32, Long, ObjectId, type Document } from 'bson'
import { MongoServerError } from 'mongodb'
import { mapError } from '../lib/errorMap'
import { DatabaseService, databasesFromPrivileges } from './DatabaseService'
import type { ConnectionService } from './ConnectionService'

type Doc = Record<string, unknown>
type Stage = Record<string, unknown>

// Privileges as `connectionStatus` with `showPrivileges` reports them for readAnyDatabase.
const READ_ANY_DATABASE = [
  { resource: { db: '', collection: '' }, actions: ['find', 'listCollections'] },
  { resource: { cluster: true }, actions: ['listDatabases'] },
  { resource: { db: '', collection: 'system.js' }, actions: ['find'] }
]

const READ_WRITE_APP = [
  { resource: { db: 'app', collection: '' }, actions: ['find', 'insert', 'update', 'remove'] },
  { resource: { db: 'app', collection: 'system.js' }, actions: ['find', 'insert'] }
]

const ALL_DATABASES = [
  { name: 'admin', sizeOnDisk: 40960, empty: false },
  { name: 'app', sizeOnDisk: 81920, empty: false },
  { name: 'reports', sizeOnDisk: 8192, empty: false }
]

/** Client double for the commands `listDatabases` and `collectionStats` send. */
function serviceFor(opts: {
  authorizedOnly?: boolean
  privileges?: Doc[]
  collStats?: Doc[]
  estimatedCount?: number
}): DatabaseService {
  const client = {
    db: () => ({
      admin: () => ({ listDatabases: async () => ({ databases: ALL_DATABASES }) }),
      command: async () => ({
        authInfo: {
          authenticatedUsers: [{ user: 'reporter', db: 'admin' }],
          authenticatedUserPrivileges: opts.privileges ?? []
        }
      }),
      collection: () => ({
        aggregate: (pipeline: Stage[]) => ({
          toArray: async () => {
            const docs = opts.collStats ?? []
            const limit = pipeline.find((s) => '$limit' in s)?.['$limit']
            return typeof limit === 'number' ? docs.slice(0, limit) : docs
          }
        }),
        estimatedDocumentCount: async () => opts.estimatedCount ?? 0
      })
    })
  }
  const connections = {
    getClient: () => client,
    isAuthorizedOnly: async () => opts.authorizedOnly ?? false
  }
  return new DatabaseService(connections as unknown as ConnectionService)
}

describe('databasesFromPrivileges', () => {
  it('treats the any-database resource of readAnyDatabase as every database', () => {
    expect(databasesFromPrivileges(READ_ANY_DATABASE)).toBe('all')
  })

  it('collects the databases of db-scoped privileges', () => {
    expect(databasesFromPrivileges(READ_WRITE_APP)).toEqual(new Set(['app']))
  })

  it('treats anyResource as every database', () => {
    expect(databasesFromPrivileges([{ resource: { anyResource: true } }])).toBe('all')
  })

  it('returns an empty set for no privileges', () => {
    expect(databasesFromPrivileges([])).toEqual(new Set())
  })
})

describe('DatabaseService.listDatabases', () => {
  it('lists every database for a readAnyDatabase user with authorized-only on', async () => {
    const service = serviceFor({ authorizedOnly: true, privileges: READ_ANY_DATABASE })

    const databases = await service.listDatabases('c1')

    expect(databases.map((d) => d.name)).toEqual(['admin', 'app', 'reports'])
  })

  it('keeps only the granted databases for a db-scoped user', async () => {
    const service = serviceFor({ authorizedOnly: true, privileges: READ_WRITE_APP })

    const databases = await service.listDatabases('c1')

    expect(databases.map((d) => d.name)).toEqual(['app'])
  })
})

describe('DatabaseService.collectionStats', () => {
  it('sums the storage stats of every shard', async () => {
    const service = serviceFor({
      collStats: [
        {
          ns: 'app.players',
          shard: 'shard-a',
          storageStats: {
            count: 1_000_000,
            size: 100_000_000,
            avgObjSize: 100,
            storageSize: 40_000_000,
            freeStorageSize: 1000,
            totalIndexSize: 20_000_000,
            totalSize: 60_000_000,
            indexSizes: { _id_: 20_000_000 },
            nindexes: 1,
            capped: false
          }
        },
        {
          ns: 'app.players',
          shard: 'shard-b',
          storageStats: {
            count: 1_000_000,
            size: 300_000_000,
            avgObjSize: 300,
            storageSize: 80_000_000,
            freeStorageSize: 0,
            totalIndexSize: 25_000_000,
            totalSize: 105_000_000,
            indexSizes: { _id_: 25_000_000 },
            nindexes: 1,
            capped: false
          }
        }
      ]
    })

    const stats = await service.collectionStats('c1', 'app', 'players')

    expect(stats).toEqual({
      ns: 'app.players',
      count: 2_000_000,
      size: 400_000_000,
      storageSize: 120_000_000,
      freeStorageSize: 1000,
      avgObjSize: 200,
      totalIndexSize: 45_000_000,
      indexSizes: { _id_: 45_000_000 },
      nindexes: 1,
      capped: false,
      totalSize: 165_000_000
    })
  })

  it('counts a time-series collection, whose storage stats carry no count, from metadata', async () => {
    const service = serviceFor({
      estimatedCount: 50,
      collStats: [
        {
          ns: 'app.system.buckets.readings',
          storageStats: {
            size: 959,
            storageSize: 20480,
            freeStorageSize: 0,
            totalIndexSize: 4096,
            totalSize: 24576,
            indexSizes: { meta_1_ts_1: 4096 },
            nindexes: 1,
            capped: false,
            timeseries: { bucketsNs: 'app.system.buckets.readings', bucketCount: 3 }
          }
        }
      ]
    })

    const stats = await service.collectionStats('c1', 'app', 'readings')

    expect(stats).toMatchObject({ count: 50, size: 959, avgObjSize: 959 / 50 })
  })

  it('reports avgObjSize 0 for an empty collection', async () => {
    const service = serviceFor({
      collStats: [{ ns: 'app.empty', storageStats: { count: 0, size: 0 } }]
    })

    const stats = await service.collectionStats('c1', 'app', 'empty')

    expect(stats).toMatchObject({ count: 0, avgObjSize: 0 })
  })

  it('fails with DocumentNotFoundError when collStats returns nothing', async () => {
    const service = serviceFor({ collStats: [] })

    await expect(service.collectionStats('c1', 'app', 'players')).rejects.toMatchObject({
      name: 'DocumentNotFoundError'
    })
  })
})

type ReadOptions = {
  raw?: boolean
  promoteValues?: boolean
  bsonRegExp?: boolean
  maxTimeMS?: number
  limit?: number
}

/**
 * Client double that stores BSON bytes and answers reads like the driver: raw bytes with `raw`,
 * else decoded with the read's options; a `failure` reply is decoded with the same options.
 */
function schemaServiceFor(opts: {
  type: 'collection' | 'view'
  docs: Document[]
  failure?: { code: number; errmsg: string }
}) {
  const bytes = opts.docs.map((d) => BSON.serialize(d))
  const reads: Array<{ op: 'find' | 'aggregate'; arg: unknown; options: ReadOptions }> = []
  const cursor = (options: ReadOptions) =>
    (async function* () {
      const bsonOptions = {
        promoteValues: options.promoteValues,
        bsonRegExp: options.bsonRegExp,
        raw: options.raw
      }
      if (opts.failure) {
        const reply = BSON.serialize({ ok: 0, ...opts.failure })
        throw new MongoServerError(BSON.deserialize(reply, bsonOptions))
      }
      for (const b of bytes) yield options.raw ? b : BSON.deserialize(b, bsonOptions)
    })()
  const client = {
    db: () => ({
      listCollections: (filter: { name: string }) => ({
        toArray: async () => [{ name: filter.name, type: opts.type }]
      }),
      collection: () => ({
        find: (filter: unknown, options: ReadOptions) => {
          reads.push({ op: 'find', arg: filter, options })
          return cursor(options)
        },
        aggregate: (pipeline: unknown, options: ReadOptions) => {
          reads.push({ op: 'aggregate', arg: pipeline, options })
          return cursor(options)
        }
      })
    })
  }
  const connections = { getClient: () => client }
  return { service: new DatabaseService(connections as unknown as ConnectionService), reads }
}

describe('DatabaseService.collectionSchema', () => {
  const docs = [
    {
      _id: new ObjectId(),
      qty: new Int32(5),
      price: new Double(5),
      big: Long.fromNumber(7),
      re: new BSONRegExp('dot.all', 's')
    },
    {
      _id: new ObjectId(),
      qty: new Int32(6),
      price: new Double(2.5),
      big: Long.fromNumber(8),
      re: new BSONRegExp('(?i)abc', '')
    }
  ]

  it('samples a collection with $sample and keeps the stored types', async () => {
    const { service, reads } = schemaServiceFor({ type: 'collection', docs })

    const schema = await service.collectionSchema('c1', 'app', 'orders')

    expect(reads).toEqual([
      {
        op: 'aggregate',
        arg: [{ $sample: { size: 200 } }],
        options: { raw: true, maxTimeMS: 5000 }
      }
    ])
    expect(schema.sampleSize).toBe(2)
    expect(schema.fields.map((f) => [f.path, f.types])).toEqual([
      ['_id', { objectId: 2 }],
      ['big', { long: 2 }],
      ['price', { double: 2 }],
      ['qty', { int: 2 }],
      ['re', { regex: 2 }]
    ])
  })

  it('reads a view with a limited find instead of $sample', async () => {
    const { service, reads } = schemaServiceFor({ type: 'view', docs })

    const schema = await service.collectionSchema('c1', 'app', 'orders_view')

    expect(reads).toEqual([
      { op: 'find', arg: {}, options: { raw: true, maxTimeMS: 5000, limit: 200 } }
    ])
    expect(schema.sampleSize).toBe(2)
  })

  it('keeps the server error code a number when sampling fails', async () => {
    const { service } = schemaServiceFor({
      type: 'collection',
      docs,
      failure: { code: 189, errmsg: 'Primary stepped down' }
    })

    const error = await service.collectionSchema('c1', 'app', 'orders').then(
      () => null,
      (e: unknown) => e
    )

    expect(mapError(error)).toMatchObject({ code: 'driver_error', details: { mongoCode: 189 } })
  })

  it('returns an empty schema for an empty collection', async () => {
    const { service } = schemaServiceFor({ type: 'collection', docs: [] })

    await expect(service.collectionSchema('c1', 'app', 'empty')).resolves.toEqual({
      sampleSize: 0,
      fields: [],
      truncated: false
    })
  })
})
