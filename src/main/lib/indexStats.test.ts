import { describe, expect, it } from 'vitest'
import { Long } from 'bson'
import { buildIndexStatsReport, classifyStatsError } from './indexStats'

type RawDocs = Array<Record<string, unknown>>

const SINCE = new Date('2026-10-01T08:00:00.000Z')

function fulfilled(value: RawDocs): PromiseSettledResult<RawDocs> {
  return { status: 'fulfilled', value }
}

function rejected(reason: unknown): PromiseSettledResult<RawDocs> {
  return { status: 'rejected', reason }
}

function serverError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code })
}

function usageDoc(name: string, ops: unknown, extra: Record<string, unknown> = {}) {
  return { name, key: { a: 1 }, host: 'db1:27017', accesses: { ops, since: SINCE }, ...extra }
}

function storageDoc(indexSizes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ns: 'app.players', storageStats: { indexSizes, ...extra } }
}

describe('buildIndexStatsReport', () => {
  it('turns a single host into ISO samples and merges sizes', () => {
    const report = buildIndexStatsReport(
      fulfilled([usageDoc('_id_', 12), usageDoc('name_1', 0)]),
      fulfilled([storageDoc({ _id_: 4096, name_1: 2048 })])
    )

    expect(report).toEqual({
      indexes: [
        {
          name: '_id_',
          size: 4096,
          building: false,
          usage: [{ host: 'db1:27017', ops: 12, since: '2026-10-01T08:00:00.000Z' }]
        },
        {
          name: 'name_1',
          size: 2048,
          building: false,
          usage: [{ host: 'db1:27017', ops: 0, since: '2026-10-01T08:00:00.000Z' }]
        }
      ],
      usageUnavailable: null,
      storageUnavailable: null
    })
    expect(report.indexes[0]?.usage[0]).not.toHaveProperty('shard')
  })

  it('converts Long and bigint counters to numbers', () => {
    const report = buildIndexStatsReport(
      fulfilled([
        usageDoc('a_1', Long.fromNumber(3)),
        usageDoc('b_1', Long.fromString('9007199254740993')),
        usageDoc('c_1', 5n)
      ]),
      fulfilled([])
    )

    expect(report.indexes.map((i) => i.usage[0]?.ops)).toEqual([3, 9007199254740992, 5])
  })

  it('keeps one sample per shard in input order and sums sizes across shards', () => {
    const report = buildIndexStatsReport(
      fulfilled([
        usageDoc('name_1', 7, { host: 'a1:27018', shard: 'shard-a' }),
        usageDoc('name_1', 9, { host: 'b1:27018', shard: 'shard-b' })
      ]),
      fulfilled([
        storageDoc({ name_1: 1000 }, { shard: 'shard-a' }),
        storageDoc({ name_1: 1500 }, { shard: 'shard-b' })
      ])
    )

    expect(report.indexes).toEqual([
      {
        name: 'name_1',
        size: 2500,
        building: false,
        usage: [
          { host: 'a1:27018', shard: 'shard-a', ops: 7, since: '2026-10-01T08:00:00.000Z' },
          { host: 'b1:27018', shard: 'shard-b', ops: 9, since: '2026-10-01T08:00:00.000Z' }
        ]
      }
    ])
  })

  it('marks an index building from $indexStats', () => {
    const report = buildIndexStatsReport(
      fulfilled([usageDoc('name_1', 0, { building: true })]),
      fulfilled([])
    )

    expect(report.indexes[0]?.building).toBe(true)
  })

  it('marks an index building from indexBuilds even when usage was rejected', () => {
    const report = buildIndexStatsReport(
      rejected(serverError('not authorized', 13)),
      fulfilled([storageDoc({ _id_: 4096, x_1: 0 }, { indexBuilds: ['x_1'] })])
    )

    expect(report.indexes).toEqual([
      { name: '_id_', size: 4096, building: false, usage: [] },
      { name: 'x_1', size: 0, building: true, usage: [] }
    ])
  })

  it('skips a usage document without a name', () => {
    const report = buildIndexStatsReport(
      fulfilled([{ key: { a: 1 }, host: 'db1:27017', accesses: { ops: 1, since: SINCE } }]),
      fulfilled([])
    )

    expect(report.indexes).toEqual([])
  })

  it('keeps the entry but drops the sample of a malformed usage document', () => {
    const report = buildIndexStatsReport(
      fulfilled([
        {
          name: 'string_since',
          host: 'db1:27017',
          accesses: { ops: 1, since: SINCE.toISOString() }
        },
        { name: 'no_accesses', host: 'db1:27017' },
        usageDoc('bad_ops', 'x'),
        usageDoc('no_host', 1, { host: 42 }),
        usageDoc('invalid_date', 1, { accesses: { ops: 1, since: new Date(Number.NaN) } })
      ]),
      fulfilled([])
    )

    expect(report.indexes).toEqual([
      { name: 'string_since', building: false, usage: [] },
      { name: 'no_accesses', building: false, usage: [] },
      { name: 'bad_ops', building: false, usage: [] },
      { name: 'no_host', building: false, usage: [] },
      { name: 'invalid_date', building: false, usage: [] }
    ])
  })

  it('skips a non-numeric index size', () => {
    const report = buildIndexStatsReport(
      fulfilled([]),
      fulfilled([storageDoc({ _id_: 'large', name_1: 2048 })])
    )

    expect(report.indexes).toEqual([{ name: 'name_1', size: 2048, building: false, usage: [] }])
  })

  it('reports usage as unauthorized on code 13 and still returns sizes', () => {
    const report = buildIndexStatsReport(
      rejected(serverError('not authorized on app to execute command', 13)),
      fulfilled([storageDoc({ _id_: 4096 })])
    )

    expect(report.usageUnavailable).toEqual({
      reason: 'unauthorized',
      message: 'not authorized on app to execute command'
    })
    expect(report.storageUnavailable).toBeNull()
    expect(report.indexes).toEqual([{ name: '_id_', size: 4096, building: false, usage: [] }])
  })

  it('reports storage as unsupported on code 166 and still returns usage', () => {
    const report = buildIndexStatsReport(
      fulfilled([usageDoc('_id_', 3)]),
      rejected(serverError('Namespace app.v is a view, not a collection', 166))
    )

    expect(report.storageUnavailable).toEqual({
      reason: 'unsupported',
      message: 'Namespace app.v is a view, not a collection'
    })
    expect(report.usageUnavailable).toBeNull()
    expect(report.indexes).toEqual([
      {
        name: '_id_',
        building: false,
        usage: [{ host: 'db1:27017', ops: 3, since: '2026-10-01T08:00:00.000Z' }]
      }
    ])
  })

  it('does not throw when both sources are rejected', () => {
    const report = buildIndexStatsReport(rejected(new Error('boom')), rejected('down'))

    expect(report).toEqual({
      indexes: [],
      usageUnavailable: { reason: 'failed', message: 'boom' },
      storageUnavailable: { reason: 'failed', message: 'down' }
    })
  })

  it('creates an entry for a name only $collStats reports', () => {
    const report = buildIndexStatsReport(
      fulfilled([usageDoc('_id_', 1)]),
      fulfilled([storageDoc({ _id_: 4096, fresh_1: 1024 })])
    )

    expect(report.indexes[1]).toEqual({ name: 'fresh_1', size: 1024, building: false, usage: [] })
  })

  it('merges an index named __proto__ like any other', () => {
    const indexSizes: Record<string, unknown> = {}
    Object.defineProperty(indexSizes, '__proto__', {
      value: 256,
      enumerable: true,
      configurable: true,
      writable: true
    })

    const report = buildIndexStatsReport(
      fulfilled([usageDoc('__proto__', 2)]),
      fulfilled([storageDoc(indexSizes)])
    )

    expect(report.indexes).toEqual([
      {
        name: '__proto__',
        size: 256,
        building: false,
        usage: [{ host: 'db1:27017', ops: 2, since: '2026-10-01T08:00:00.000Z' }]
      }
    ])
  })
})

describe('classifyStatsError', () => {
  it.each([115, 166, 40324])('reports code %i as unsupported', (code) => {
    expect(classifyStatsError(serverError('nope', code))).toEqual({
      reason: 'unsupported',
      message: 'nope'
    })
  })

  it('reports code 13 as unauthorized', () => {
    expect(classifyStatsError(serverError('not authorized', 13)).reason).toBe('unauthorized')
  })

  it.each([
    ['another server code', serverError('boom', 2)],
    ['an Error without a code', new Error('boom')],
    ['a thrown string', 'boom']
  ])('reports %s as failed and keeps the message', (_label, error) => {
    expect(classifyStatsError(error)).toEqual({ reason: 'failed', message: 'boom' })
  })
})
