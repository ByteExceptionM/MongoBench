import { describe, expect, it } from 'vitest'
import type { IndexInfo, IndexStatsReport, IndexUsageSample } from '@shared/types'
import {
  buildIndexRows,
  formatAge,
  formatCount,
  formatRate,
  nextSort,
  sortIndexRows,
  summarizeUsage,
  unavailableText,
  usageAvailable,
  usageNotes,
  usageSources,
  type IndexRow
} from './indexUsage'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = Date.parse('2026-03-01T00:00:00.000Z')

const iso = (ms: number): string => new Date(ms).toISOString()

const sample = (
  ops: number,
  ageMs: number,
  host = 'h1:27017',
  shard?: string
): IndexUsageSample => ({
  host,
  ...(shard !== undefined ? { shard } : {}),
  ops,
  since: iso(NOW - ageMs)
})

const index = (name: string, extra: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  key: { [name.replace(/_-?1$/, '')]: 1 },
  ...extra
})

const report = (
  indexes: IndexStatsReport['indexes'],
  extra: Partial<IndexStatsReport> = {}
): IndexStatsReport => ({
  indexes,
  usageUnavailable: null,
  storageUnavailable: null,
  ...extra
})

const row = (name: string, size: number | undefined, ops: number | null): IndexRow => ({
  index: index(name),
  size,
  building: false,
  usage:
    ops === null
      ? null
      : { ops, opsPerDay: null, since: NOW - DAY, coveredSince: NOW - DAY, hosts: [] },
  unused: false
})

const names = (rows: readonly IndexRow[]): string[] => rows.map((r) => r.index.name)

describe('summarizeUsage', () => {
  it('returns null without samples', () => {
    expect(summarizeUsage([], NOW)).toBeNull()
  })

  it('extrapolates a per-day rate from one host', () => {
    const summary = summarizeUsage([sample(1000, 10 * DAY)], NOW)
    expect(summary).toEqual({
      ops: 1000,
      opsPerDay: 100,
      since: NOW - 10 * DAY,
      coveredSince: NOW - 10 * DAY,
      hosts: [sample(1000, 10 * DAY)]
    })
  })

  it('sums ops and per-host rates and spans the earliest and latest counter start', () => {
    const summary = summarizeUsage([sample(100, DAY, 'a:1'), sample(50, 10 * DAY, 'b:1')], NOW)
    expect(summary?.ops).toBe(150)
    expect(summary?.opsPerDay).toBeCloseTo(105)
    expect(summary?.since).toBe(NOW - 10 * DAY)
    expect(summary?.coveredSince).toBe(NOW - DAY)
  })

  it('leaves hosts that counted for under a minute out of the rate', () => {
    const summary = summarizeUsage([sample(10, DAY, 'a:1'), sample(500, 30_000, 'b:1')], NOW)
    expect(summary?.ops).toBe(510)
    expect(summary?.opsPerDay).toBeCloseTo(10)
  })

  it('has no rate when every host counted for under a minute', () => {
    expect(summarizeUsage([sample(5, 59_999)], NOW)?.opsPerDay).toBeNull()
  })

  it('counts a host from exactly one minute on', () => {
    expect(summarizeUsage([sample(1, MINUTE)], NOW)?.opsPerDay).toBeCloseTo(1440)
  })

  it('gives no negative rate for a counter start in the future', () => {
    const summary = summarizeUsage([sample(5, -HOUR)], NOW)
    expect(summary?.ops).toBe(5)
    expect(summary?.opsPerDay).toBeNull()
  })

  it('copies the samples instead of sharing the input array', () => {
    const samples = [sample(1, DAY)]
    expect(summarizeUsage(samples, NOW)?.hosts).not.toBe(samples)
  })
})

describe('usageAvailable', () => {
  it('is true only for a report whose usage counters could be read', () => {
    expect(usageAvailable(report([]))).toBe(true)
    expect(usageAvailable(undefined)).toBe(false)
    expect(
      usageAvailable(report([], { usageUnavailable: { reason: 'unsupported', message: 'no' } }))
    ).toBe(false)
  })

  it('ignores missing index sizes', () => {
    const storageOnly = { storageUnavailable: { reason: 'failed' as const, message: 'no' } }
    expect(usageAvailable(report([], storageOnly))).toBe(true)
  })
})

describe('buildIndexRows', () => {
  it('has no statistics without a report', () => {
    expect(buildIndexRows([index('a_1')], undefined, NOW)).toEqual([
      { index: index('a_1'), size: undefined, building: false, usage: null, unused: false }
    ])
  })

  it('joins size, build state and usage by index name', () => {
    const rows = buildIndexRows(
      [index('a_1')],
      report([{ name: 'a_1', size: 4096, building: true, usage: [sample(7, 2 * DAY)] }]),
      NOW
    )
    expect(rows[0]?.size).toBe(4096)
    expect(rows[0]?.building).toBe(true)
    expect(rows[0]?.usage?.ops).toBe(7)
  })

  it('has no usage when usage counters are unavailable', () => {
    const rows = buildIndexRows(
      [index('a_1')],
      report([{ name: 'a_1', size: 10, building: false, usage: [] }], {
        usageUnavailable: { reason: 'unauthorized', message: 'not authorized' }
      }),
      NOW
    )
    expect(rows[0]?.usage).toBeNull()
    expect(rows[0]?.unused).toBe(false)
    expect(rows[0]?.size).toBe(10)
  })

  it('has no usage for an index the report does not mention', () => {
    const rows = buildIndexRows([index('a_1')], report([]), NOW)
    expect(rows[0]?.usage).toBeNull()
    expect(rows[0]?.unused).toBe(false)
  })

  it('follows list order and ignores statistics of unlisted indexes', () => {
    const rows = buildIndexRows(
      [index('b_1'), index('a_1')],
      report([
        { name: 'a_1', size: 1, building: false, usage: [] },
        { name: 'gone_1', size: 2, building: false, usage: [] },
        { name: 'b_1', size: 3, building: false, usage: [] }
      ]),
      NOW
    )
    expect(rows.map((r) => [r.index.name, r.size])).toEqual([
      ['b_1', 3],
      ['a_1', 1]
    ])
  })

  it('joins an index named __proto__ like any other', () => {
    const rows = buildIndexRows(
      [index('__proto__')],
      report([{ name: '__proto__', size: 8, building: false, usage: [sample(2, DAY)] }]),
      NOW
    )
    expect(rows[0]?.size).toBe(8)
    expect(rows[0]?.usage?.ops).toBe(2)
  })

  describe('unused verdict', () => {
    const unusedFor = (info: IndexInfo, samples: IndexUsageSample[], building = false): boolean =>
      buildIndexRows([info], report([{ name: info.name, building, usage: samples }]), NOW)[0]!
        .unused

    it('flags a plain index without ops over two days', () => {
      expect(unusedFor(index('a_1'), [sample(0, 2 * DAY)])).toBe(true)
    })

    it('flags a unique index too', () => {
      expect(unusedFor(index('a_1', { unique: true }), [sample(0, 2 * DAY)])).toBe(true)
    })

    it('flags from exactly one day of counting on', () => {
      expect(unusedFor(index('a_1'), [sample(0, DAY)])).toBe(true)
    })

    it('never flags the _id_ index', () => {
      expect(unusedFor(index('_id_'), [sample(0, 2 * DAY)])).toBe(false)
    })

    it('never flags a hidden index', () => {
      expect(unusedFor(index('a_1', { hidden: true }), [sample(0, 2 * DAY)])).toBe(false)
    })

    it('never flags a TTL index, even with expireAfterSeconds 0', () => {
      expect(unusedFor(index('a_1', { expireAfterSeconds: 0 }), [sample(0, 2 * DAY)])).toBe(false)
    })

    it('never flags an index that is being built', () => {
      expect(unusedFor(index('a_1'), [sample(0, 2 * DAY)], true)).toBe(false)
    })

    it('does not flag after only 23 hours of counting', () => {
      expect(unusedFor(index('a_1'), [sample(0, 23 * HOUR)])).toBe(false)
    })

    it('does not flag an index with ops', () => {
      expect(unusedFor(index('a_1'), [sample(1, 2 * DAY)])).toBe(false)
    })

    it('waits until every host has counted for a day', () => {
      const samples = [sample(0, 5 * DAY, 'a:1'), sample(0, 12 * HOUR, 'b:1')]
      expect(unusedFor(index('a_1'), samples)).toBe(false)
    })
  })
})

describe('sortIndexRows', () => {
  const rows = [row('b', 300, 5), row('c', undefined, null), row('a', 100, 5), row('d', 200, 9)]

  it('keeps server order in a new array for no sort', () => {
    const sorted = sortIndexRows(rows, null)
    expect(sorted).not.toBe(rows)
    expect(names(sorted)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('does not change the input', () => {
    sortIndexRows(rows, { key: 'name', dir: 'asc' })
    expect(names(rows)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('sorts by name in both directions', () => {
    expect(names(sortIndexRows(rows, { key: 'name', dir: 'asc' }))).toEqual(['a', 'b', 'c', 'd'])
    expect(names(sortIndexRows(rows, { key: 'name', dir: 'desc' }))).toEqual(['d', 'c', 'b', 'a'])
  })

  it('puts rows without a size last in both directions', () => {
    expect(names(sortIndexRows(rows, { key: 'size', dir: 'desc' }))).toEqual(['b', 'd', 'a', 'c'])
    expect(names(sortIndexRows(rows, { key: 'size', dir: 'asc' }))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('puts rows without usage last and keeps server order on equal ops', () => {
    expect(names(sortIndexRows(rows, { key: 'ops', dir: 'desc' }))).toEqual(['d', 'b', 'a', 'c'])
    expect(names(sortIndexRows(rows, { key: 'ops', dir: 'asc' }))).toEqual(['b', 'a', 'd', 'c'])
  })
})

describe('nextSort', () => {
  it('cycles name through ascending, descending and server order', () => {
    const first = nextSort(null, 'name')
    expect(first).toEqual({ key: 'name', dir: 'asc' })
    const second = nextSort(first, 'name')
    expect(second).toEqual({ key: 'name', dir: 'desc' })
    expect(nextSort(second, 'name')).toBeNull()
  })

  it('cycles size and ops through descending, ascending and server order', () => {
    for (const key of ['size', 'ops'] as const) {
      const first = nextSort(null, key)
      expect(first).toEqual({ key, dir: 'desc' })
      const second = nextSort(first, key)
      expect(second).toEqual({ key, dir: 'asc' })
      expect(nextSort(second, key)).toBeNull()
    }
  })

  it("starts a different key at that key's default direction", () => {
    expect(nextSort({ key: 'name', dir: 'desc' }, 'size')).toEqual({ key: 'size', dir: 'desc' })
    expect(nextSort({ key: 'ops', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'asc' })
  })
})

describe('usageSources', () => {
  it('lists distinct hosts and shards in sorted order', () => {
    const sources = usageSources(
      report([
        {
          name: 'a_1',
          building: false,
          usage: [sample(1, DAY, 'm2:27018', 'rs1'), sample(1, DAY, 'm1:27018', 'rs0')]
        },
        {
          name: 'b_1',
          building: false,
          usage: [sample(1, DAY, 'm1:27018', 'rs0'), sample(1, DAY, 'm2:27018', 'rs1')]
        }
      ])
    )
    expect(sources).toEqual({ hosts: ['m1:27018', 'm2:27018'], shards: ['rs0', 'rs1'] })
  })

  it('has no shards on a replica set and nothing without samples', () => {
    expect(
      usageSources(report([{ name: 'a_1', building: false, usage: [sample(1, DAY, 'h:1')] }]))
    ).toEqual({ hosts: ['h:1'], shards: [] })
    expect(usageSources(report([{ name: 'a_1', building: false, usage: [] }]))).toEqual({
      hosts: [],
      shards: []
    })
  })
})

describe('usageNotes', () => {
  const notesFor = (info: IndexInfo, ops: number): string[] => {
    const [r] = buildIndexRows(
      [info],
      report([{ name: info.name, building: false, usage: [sample(ops, 3 * DAY)] }]),
      NOW
    )
    return usageNotes(r!, NOW)
  }

  it('explains an unused verdict with the covered window', () => {
    expect(notesFor(index('a_1'), 0)).toEqual(['No recorded use for 3d.'])
  })

  it('adds that an unused unique index still enforces uniqueness', () => {
    expect(notesFor(index('a_1', { unique: true }), 0)).toEqual([
      'No recorded use for 3d. It still enforces uniqueness on writes.'
    ])
  })

  it('notes a hidden index', () => {
    expect(notesFor(index('a_1', { hidden: true }), 0)).toEqual(['Hidden from the query planner.'])
  })

  it('notes that TTL deletions are not counted', () => {
    expect(notesFor(index('a_1', { expireAfterSeconds: 3600 }), 4)).toEqual([
      'TTL deletions are not counted.'
    ])
  })

  it('combines hidden and TTL notes', () => {
    expect(notesFor(index('a_1', { hidden: true, expireAfterSeconds: 0 }), 0)).toEqual([
      'Hidden from the query planner.',
      'TTL deletions are not counted.'
    ])
  })

  it('has nothing to say about a used plain index', () => {
    expect(notesFor(index('a_1', { unique: true }), 12)).toEqual([])
  })
})

describe('unavailableText', () => {
  const info = (reason: 'unauthorized' | 'unsupported' | 'failed') => ({ reason, message: 'x' })

  it('explains each reason for usage counters', () => {
    expect(unavailableText('usage', info('unauthorized'))).toBe(
      'Usage counters need the indexStats privilege (e.g. the clusterMonitor role).'
    )
    expect(unavailableText('usage', info('unsupported'))).toBe(
      'This server does not support $indexStats.'
    )
    expect(unavailableText('usage', info('failed'))).toBe('Could not read usage counters.')
  })

  it('explains each reason for index sizes', () => {
    expect(unavailableText('storage', info('unauthorized'))).toBe(
      'Index sizes need the collStats privilege.'
    )
    expect(unavailableText('storage', info('unsupported'))).toBe(
      'This server does not report index sizes.'
    )
    expect(unavailableText('storage', info('failed'))).toBe('Could not read index sizes.')
  })
})

describe('formatCount', () => {
  it('prints counts below 1000 in full and larger ones compact', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1000)).toBe('1K')
    expect(formatCount(1250)).toBe('1.3K')
    expect(formatCount(1234567)).toBe('1.2M')
  })
})

describe('formatRate', () => {
  it('prints daily rates down to one per day', () => {
    expect(formatRate(100.4)).toBe('100/day')
    expect(formatRate(2500)).toBe('2.5K/day')
    expect(formatRate(1)).toBe('1/day')
  })

  it('switches to weekly rates below one per day', () => {
    expect(formatRate(0.5)).toBe('4/wk')
    expect(formatRate(1 / 7)).toBe('1/wk')
    expect(formatRate(0.1)).toBe('<1/wk')
  })

  it('prints a zero rate per day', () => {
    expect(formatRate(0)).toBe('0/day')
  })
})

describe('formatAge', () => {
  it('prints under a minute, including negative durations, as <1m', () => {
    expect(formatAge(30_000)).toBe('<1m')
    expect(formatAge(-5_000)).toBe('<1m')
  })

  it('prints one coarse unit', () => {
    expect(formatAge(5 * MINUTE)).toBe('5m')
    expect(formatAge(3 * HOUR)).toBe('3h')
    expect(formatAge(4 * DAY)).toBe('4d')
    expect(formatAge(89 * DAY)).toBe('89d')
    expect(formatAge(120 * DAY)).toBe('4mo')
    expect(formatAge(800 * DAY)).toBe('2y')
  })
})
