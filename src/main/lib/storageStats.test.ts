import { describe, expect, it } from 'vitest'
import { mergeStorageStats, storageParts, sumIndexSizes } from './storageStats'

describe('mergeStorageStats', () => {
  it('passes a single document through', () => {
    const merged = mergeStorageStats([
      {
        ns: 'app.players',
        storageStats: {
          count: 4,
          size: 400,
          avgObjSize: 100,
          storageSize: 8192,
          freeStorageSize: 1024,
          totalIndexSize: 4096,
          totalSize: 12288,
          indexSizes: { _id_: 2048, name_1: 2048 },
          nindexes: 2,
          capped: false,
          wiredTiger: { uri: 'statistics:table:collection-0' }
        }
      }
    ])

    expect(merged).toEqual({
      ns: 'app.players',
      storage: {
        count: 4,
        size: 400,
        storageSize: 8192,
        freeStorageSize: 1024,
        totalIndexSize: 4096,
        totalSize: 12288,
        indexSizes: { _id_: 2048, name_1: 2048 },
        nindexes: 2,
        capped: false
      }
    })
  })

  it('sums every shard and merges indexSizes by name', () => {
    const merged = mergeStorageStats([
      {
        ns: 'app.players',
        shard: 'shard-a',
        storageStats: {
          count: 3,
          size: 300,
          avgObjSize: 100,
          storageSize: 4096,
          freeStorageSize: 0,
          totalIndexSize: 3000,
          totalSize: 7096,
          indexSizes: { _id_: 1000, name_1: 2000 },
          nindexes: 2,
          capped: false,
          numOrphanDocs: 1
        }
      },
      {
        ns: 'app.players',
        shard: 'shard-b',
        storageStats: {
          count: 1,
          size: 500,
          avgObjSize: 500,
          storageSize: 8192,
          freeStorageSize: 512,
          totalIndexSize: 700,
          totalSize: 8892,
          indexSizes: { _id_: 300, region_1: 400 },
          nindexes: 3,
          capped: true,
          numOrphanDocs: 2
        }
      }
    ])

    expect(merged).toEqual({
      ns: 'app.players',
      storage: {
        count: 4,
        size: 800,
        storageSize: 12288,
        freeStorageSize: 512,
        totalIndexSize: 3700,
        totalSize: 15988,
        numOrphanDocs: 3,
        indexSizes: { _id_: 1300, name_1: 2000, region_1: 400 },
        nindexes: 2,
        capped: false
      }
    })
  })

  it('leaves numOrphanDocs out when no shard reports it', () => {
    const { storage } = mergeStorageStats([
      { ns: 'app.players', storageStats: { count: 1, size: 10 } },
      { ns: 'app.players', storageStats: { count: 1, size: 10 } }
    ])

    expect(storage).not.toHaveProperty('numOrphanDocs')
  })

  it('counts non-number values as 0', () => {
    const { storage } = mergeStorageStats([
      { ns: 'app.players', storageStats: { count: 2, size: 'big', storageSize: null } },
      { ns: 'app.players', storageStats: { count: Number.NaN, size: 60, indexSizes: { a_1: 'x' } } }
    ])

    expect(storage).toMatchObject({
      count: 2,
      size: 60,
      storageSize: 0,
      indexSizes: {}
    })
  })

  it('leaves count out when no shard reports one, as for a time-series collection', () => {
    const { storage } = mergeStorageStats([
      {
        ns: 'app.system.buckets.readings',
        storageStats: { size: 959, timeseries: { bucketCount: 3 } }
      }
    ])

    expect(storage).not.toHaveProperty('count')
    expect(storage['size']).toBe(959)
  })

  it('keeps an index named __proto__ as an own entry', () => {
    const indexSizes: Record<string, unknown> = {}
    Object.defineProperty(indexSizes, '__proto__', {
      value: 512,
      enumerable: true,
      configurable: true,
      writable: true
    })

    const { storage } = mergeStorageStats([
      { ns: 'app.players', storageStats: { indexSizes } },
      { ns: 'app.players', storageStats: { indexSizes } }
    ])

    expect(Object.entries(storage['indexSizes'] as object)).toEqual([['__proto__', 1024]])
  })

  it('gives an empty storage object and no ns for no documents', () => {
    expect(mergeStorageStats([])).toEqual({ ns: null, storage: {} })
  })
})

describe('storageParts', () => {
  it('takes the storageStats of each document and gives {} where there is none', () => {
    expect(
      storageParts([{ storageStats: { size: 1 } }, { storageStats: null }, { ns: 'app.players' }])
    ).toEqual([{ size: 1 }, {}, {}])
  })
})

describe('sumIndexSizes', () => {
  it('sums each index over the parts and skips parts without indexSizes', () => {
    expect(
      sumIndexSizes([{ indexSizes: { _id_: 10, a_1: 5 } }, {}, { indexSizes: { _id_: 30 } }])
    ).toEqual({ _id_: 40, a_1: 5 })
  })
})
