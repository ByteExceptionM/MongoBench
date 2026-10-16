import type {
  IndexInfo,
  IndexRuntimeStats,
  IndexStatsReport,
  IndexStatsUnavailable,
  IndexUsageSample
} from '@shared/types'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
// Extrapolating a per-day rate from under a minute of counting is noise.
const MIN_RATE_WINDOW_MS = MINUTE_MS
// Zero ops over less than a day says nothing: counters reset on every mongod restart.
const UNUSED_MIN_WINDOW_MS = DAY_MS

export type IndexUsageSummary = {
  ops: number
  /** null when every host has counted for less than a minute. */
  opsPerDay: number | null
  /** Earliest counter start across hosts, ms epoch. */
  since: number
  /** Latest counter start: all hosts have counted since then, ms epoch. */
  coveredSince: number
  hosts: IndexUsageSample[]
}

export type IndexRow = {
  index: IndexInfo
  size: number | undefined
  building: boolean
  usage: IndexUsageSummary | null
  unused: boolean
}

export type IndexSortKey = 'name' | 'size' | 'ops'
export type IndexSort = { key: IndexSortKey; dir: 'asc' | 'desc' } | null

const DEFAULT_DIR: Record<IndexSortKey, 'asc' | 'desc'> = { name: 'asc', size: 'desc', ops: 'desc' }

const UNAVAILABLE_TEXT: Record<
  'usage' | 'storage',
  Record<IndexStatsUnavailable['reason'], string>
> = {
  usage: {
    unauthorized: 'Usage counters need the indexStats privilege (e.g. the clusterMonitor role).',
    unsupported: 'This server does not support $indexStats.',
    failed: 'Could not read usage counters.'
  },
  storage: {
    unauthorized: 'Index sizes need the collStats privilege.',
    unsupported: 'This server does not report index sizes.',
    failed: 'Could not read index sizes.'
  }
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Folds per-host samples into one summary; null when there are none. */
export function summarizeUsage(
  samples: readonly IndexUsageSample[],
  now: number
): IndexUsageSummary | null {
  if (samples.length === 0) return null
  let ops = 0
  let since = Infinity
  let coveredSince = -Infinity
  let opsPerDay: number | null = null
  for (const sample of samples) {
    const start = Date.parse(sample.since)
    const window = now - start
    ops += sample.ops
    since = Math.min(since, start)
    coveredSince = Math.max(coveredSince, start)
    // Hosts reset independently, so each contributes its own rate.
    if (window >= MIN_RATE_WINDOW_MS) opsPerDay = (opsPerDay ?? 0) + (sample.ops / window) * DAY_MS
  }
  return { ops, opsPerDay, since, coveredSince, hosts: [...samples] }
}

/** Whether the report carries usage counters; index sizes may still be missing. */
export function usageAvailable(report: IndexStatsReport | undefined): boolean {
  return report !== undefined && report.usageUnavailable === null
}

/** Joins list order with the stats report; rows follow `indexes`, stats for unlisted names are ignored. */
export function buildIndexRows(
  indexes: readonly IndexInfo[],
  report: IndexStatsReport | undefined,
  now: number
): IndexRow[] {
  const byName = new Map<string, IndexRuntimeStats>(report?.indexes.map((s) => [s.name, s]))
  const withUsage = usageAvailable(report)
  return indexes.map((index) => {
    const stats = byName.get(index.name)
    const building = stats?.building ?? false
    const usage = withUsage ? summarizeUsage(stats?.usage ?? [], now) : null
    const unused =
      usage !== null &&
      usage.ops === 0 &&
      index.name !== '_id_' &&
      index.hidden !== true &&
      index.expireAfterSeconds === undefined &&
      !building &&
      now - usage.coveredSince >= UNUSED_MIN_WINDOW_MS
    return { index, size: stats?.size, building, usage, unused }
  })
}

/** Sorts a copy; null keeps server order, rows lacking the value go last in both directions, ties keep server order. */
export function sortIndexRows(rows: readonly IndexRow[], sort: IndexSort): IndexRow[] {
  const sorted = [...rows]
  if (sort === null) return sorted
  const sign = sort.dir === 'asc' ? 1 : -1
  // Array#sort is stable, so equal values keep server order.
  if (sort.key === 'name') {
    return sorted.sort((a, b) => sign * a.index.name.localeCompare(b.index.name))
  }
  const value = (row: IndexRow): number | undefined =>
    sort.key === 'size' ? row.size : row.usage?.ops
  return sorted.sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va === undefined || vb === undefined) {
      return va === vb ? 0 : va === undefined ? 1 : -1
    }
    return sign * (va - vb)
  })
}

/** Header click cycle: default direction, then reversed, then server order. */
export function nextSort(current: IndexSort, key: IndexSortKey): IndexSort {
  const dir = DEFAULT_DIR[key]
  if (current?.key !== key) return { key, dir }
  if (current.dir === dir) return { key, dir: dir === 'asc' ? 'desc' : 'asc' }
  return null
}

/** Distinct sorted hosts and shards that contributed usage samples. */
export function usageSources(report: IndexStatsReport): { hosts: string[]; shards: string[] } {
  const hosts = new Set<string>()
  const shards = new Set<string>()
  for (const stats of report.indexes) {
    for (const sample of stats.usage) {
      hosts.add(sample.host)
      if (sample.shard !== undefined) shards.add(sample.shard)
    }
  }
  return { hosts: [...hosts].sort(), shards: [...shards].sort() }
}

/** Tooltip notes for a usage cell (unused verdict, hidden, TTL). */
export function usageNotes(row: IndexRow, now: number): string[] {
  const notes: string[] = []
  if (row.unused && row.usage !== null) {
    const unique = row.index.unique === true ? ' It still enforces uniqueness on writes.' : ''
    notes.push(`No recorded use for ${formatAge(now - row.usage.coveredSince)}.${unique}`)
  }
  if (row.index.hidden === true) notes.push('Hidden from the query planner.')
  if (row.index.expireAfterSeconds !== undefined) notes.push('TTL deletions are not counted.')
  return notes
}

/** Explains why one statistics source is missing. */
export function unavailableText(source: 'usage' | 'storage', info: IndexStatsUnavailable): string {
  return UNAVAILABLE_TEXT[source][info.reason]
}

/** Op count in full below 1000, compact above (1K, 1.3K, 1.2M). */
export function formatCount(n: number): string {
  return n < 1000 ? String(n) : COMPACT.format(n)
}

/** Ops per day as a short rate; below one per day it switches to per week. */
export function formatRate(opsPerDay: number): string {
  if (opsPerDay >= 1) return `${formatCount(Math.round(opsPerDay))}/day`
  if (opsPerDay >= 1 / 7) return `${Math.round(opsPerDay * 7)}/wk`
  if (opsPerDay > 0) return '<1/wk'
  return '0/day'
}

/** Duration in one coarse unit: <1m, 5m, 3h, 4d, 4mo (30-day months), 2y (365-day years). */
export function formatAge(ms: number): string {
  if (ms < MINUTE_MS) return '<1m'
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`
  const days = ms / DAY_MS
  if (days < 90) return `${Math.floor(days)}d`
  if (days < 730) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}
