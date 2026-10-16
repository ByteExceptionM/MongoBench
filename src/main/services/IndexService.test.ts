import { describe, expect, it } from 'vitest'
import { BSON, Decimal128, ObjectId, type Document } from 'bson'
import { IndexService } from './IndexService'
import type { ConnectionService } from './ConnectionService'

type Doc = Record<string, unknown>
type Stage = Record<string, unknown>

const SINCE = new Date('2026-10-01T08:00:00.000Z')

/** Collection double whose aggregate answers by first stage and honours `$limit` like a server. */
function fakeCollection(opts: {
  indexes?: Doc[]
  indexStats?: () => Promise<Doc[]>
  collStats?: () => Promise<Doc[]>
}) {
  const created: Array<{ keys: Doc; options: Doc }> = []
  return {
    created,
    createIndex: async (keys: Doc, options: Doc) => {
      created.push({ keys, options })
      return 'created_1'
    },
    listIndexes: () => ({ toArray: async () => opts.indexes ?? [] }),
    aggregate: (pipeline: Stage[]) => ({
      toArray: async () => {
        const first = pipeline[0] ?? {}
        const source =
          '$indexStats' in first ? opts.indexStats : '$collStats' in first ? opts.collStats : null
        if (!source) throw new Error(`unexpected pipeline ${JSON.stringify(pipeline)}`)
        const docs = await source()
        const limit = pipeline.find((s) => '$limit' in s)?.['$limit']
        return typeof limit === 'number' ? docs.slice(0, limit) : docs
      }
    })
  }
}

function serviceFor(collection: ReturnType<typeof fakeCollection>): IndexService {
  const connections = {
    getClient: () => ({ db: () => ({ collection: () => collection }) })
  }
  return new IndexService(connections as unknown as ConnectionService)
}

function shardStats(shard: string, indexSizes: Record<string, number>): Doc {
  return { ns: 'app.players', shard, storageStats: { indexSizes } }
}

describe('IndexService.listIndexes', () => {
  it('returns relaxed EJSON for the fields that carry user values', async () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011')
    const service = serviceFor(
      fakeCollection({
        indexes: [
          {
            v: 2,
            key: { status: 1 },
            name: 'status_1',
            partialFilterExpression: {
              status: { $in: [oid] },
              createdAt: { $gt: new Date('2026-01-15T10:30:00.123Z') },
              price: { $lt: Decimal128.fromString('9.99') }
            },
            collation: { locale: 'de', strength: 2 }
          },
          {
            v: 2,
            key: { _fts: 'text', _ftsx: 1 },
            name: 'bio_text',
            weights: { bio: 3 },
            default_language: 'german'
          },
          { v: 2, key: { '$**': 1 }, name: '$**_1', wildcardProjection: { secret: 0 } }
        ]
      })
    )

    const indexes = await service.listIndexes('c1', 'app', 'players')

    expect(indexes).toEqual([
      {
        v: 2,
        key: { status: 1 },
        name: 'status_1',
        partialFilterExpression: {
          status: { $in: [{ $oid: '507f1f77bcf86cd799439011' }] },
          createdAt: { $gt: { $date: '2026-01-15T10:30:00.123Z' } },
          price: { $lt: { $numberDecimal: '9.99' } }
        },
        collation: { locale: 'de', strength: 2 }
      },
      {
        v: 2,
        key: { _fts: 'text', _ftsx: 1 },
        name: 'bio_text',
        weights: { bio: 3 },
        default_language: 'german'
      },
      { v: 2, key: { '$**': 1 }, name: '$**_1', wildcardProjection: { secret: 0 } }
    ])
  })

  it('lists indexes without reading storage stats', async () => {
    const service = serviceFor(
      fakeCollection({
        indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
        collStats: async () => [shardStats('shard-a', { _id_: 4096 })]
      })
    )

    const indexes = await service.listIndexes('c1', 'app', 'players')

    expect(indexes).toEqual([{ v: 2, key: { _id: 1 }, name: '_id_' }])
  })
})

describe('IndexService.createIndex', () => {
  it('sends an Int64 bound beyond 2^53 in a partial filter exactly', async () => {
    const collection = fakeCollection({})

    await serviceFor(collection).createIndex('c1', 'app', 'players', '{"big":1}', {
      partialFilterExpression: '{"big":{"$gte":{"$numberLong":"9007199254740993"}}}'
    })

    const sent = collection.created[0]?.options['partialFilterExpression'] as Document
    const encoded = BSON.deserialize(BSON.serialize(sent), { promoteLongs: false })
    expect(String(encoded['big']['$gte'])).toBe('9007199254740993')
    expect(encoded['big']['$gte']._bsontype).toBe('Long')
  })

  it('keeps numeric key directions plain numbers', async () => {
    const collection = fakeCollection({})

    await serviceFor(collection).createIndex('c1', 'app', 'players', '{"a":1,"b":-1}', undefined)

    expect(collection.created[0]?.keys).toEqual({ a: 1, b: -1 })
  })
})

describe('IndexService.indexStats', () => {
  it('reads every shard and merges usage and sizes', async () => {
    const service = serviceFor(
      fakeCollection({
        indexStats: async () => [
          {
            name: '_id_',
            host: 'a1:27018',
            shard: 'shard-a',
            accesses: { ops: 4, since: SINCE }
          },
          {
            name: '_id_',
            host: 'b1:27018',
            shard: 'shard-b',
            accesses: { ops: 6, since: SINCE }
          }
        ],
        collStats: async () => [
          shardStats('shard-a', { _id_: 1000 }),
          shardStats('shard-b', { _id_: 3000 })
        ]
      })
    )

    const report = await service.indexStats('c1', 'app', 'players')

    expect(report).toEqual({
      indexes: [
        {
          name: '_id_',
          size: 4000,
          building: false,
          usage: [
            { host: 'a1:27018', shard: 'shard-a', ops: 4, since: '2026-10-01T08:00:00.000Z' },
            { host: 'b1:27018', shard: 'shard-b', ops: 6, since: '2026-10-01T08:00:00.000Z' }
          ]
        }
      ],
      usageUnavailable: null,
      storageUnavailable: null
    })
  })

  it('degrades the usage source alone when $indexStats is not authorized', async () => {
    const service = serviceFor(
      fakeCollection({
        indexStats: async () => {
          throw Object.assign(new Error('not authorized on app to execute command'), { code: 13 })
        },
        collStats: async () => [shardStats('shard-a', { _id_: 1000 })]
      })
    )

    const report = await service.indexStats('c1', 'app', 'players')

    expect(report).toEqual({
      indexes: [{ name: '_id_', size: 1000, building: false, usage: [] }],
      usageUnavailable: {
        reason: 'unauthorized',
        message: 'not authorized on app to execute command'
      },
      storageUnavailable: null
    })
  })

  it('rejects when the connection is not open', async () => {
    const connections = {
      getClient: () => {
        throw Object.assign(new Error('Connection c1 is not open'), { name: 'NotConnectedError' })
      }
    }
    const service = new IndexService(connections as unknown as ConnectionService)

    await expect(service.indexStats('c1', 'app', 'players')).rejects.toMatchObject({
      name: 'NotConnectedError'
    })
  })
})
