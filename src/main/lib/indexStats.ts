import { Long } from 'bson'
import type {
  IndexRuntimeStats,
  IndexStatsReport,
  IndexStatsUnavailable,
  IndexUsageSample
} from '@shared/types'
import { isDocument } from '@shared/writeOps'
import { storageParts, sumIndexSizes } from './storageStats'

type RawDocs = ReadonlyArray<Record<string, unknown>>

const UNSUPPORTED_CODES = new Set([
  115, // CommandNotSupported
  166, // CommandNotSupportedOnView
  40324 // Unrecognized pipeline stage name: servers/emulators without $indexStats
])

/** Merges `$indexStats` and `$collStats` output into one entry per index name; never throws. */
export function buildIndexStatsReport(
  usage: PromiseSettledResult<RawDocs>,
  storage: PromiseSettledResult<RawDocs>
): IndexStatsReport {
  // A Map, not an object: an index may be named "__proto__".
  const entries = new Map<string, IndexRuntimeStats>()
  const entry = (name: string): IndexRuntimeStats => {
    let stats = entries.get(name)
    if (!stats) {
      stats = { name, building: false, usage: [] }
      entries.set(name, stats)
    }
    return stats
  }

  if (usage.status === 'fulfilled') {
    for (const doc of usage.value) {
      const name = doc['name']
      if (typeof name !== 'string') continue
      const stats = entry(name)
      if (doc['building'] === true) stats.building = true
      const sample = usageSample(doc)
      if (sample) stats.usage.push(sample)
    }
  }

  if (storage.status === 'fulfilled') {
    const parts = storageParts(storage.value)
    for (const [name, size] of Object.entries(sumIndexSizes(parts))) entry(name).size = size
    for (const part of parts) {
      const builds = part['indexBuilds']
      if (!Array.isArray(builds)) continue
      for (const name of builds) {
        if (typeof name === 'string') entry(name).building = true
      }
    }
  }

  return {
    indexes: [...entries.values()],
    usageUnavailable: usage.status === 'rejected' ? classifyStatsError(usage.reason) : null,
    storageUnavailable: storage.status === 'rejected' ? classifyStatsError(storage.reason) : null
  }
}

/** Maps a failed stats read to a reason the UI can explain; `message` keeps the server text. */
export function classifyStatsError(error: unknown): IndexStatsUnavailable {
  const message = error instanceof Error ? error.message : String(error)
  const code = isDocument(error) && typeof error['code'] === 'number' ? error['code'] : null
  if (code === 13) return { reason: 'unauthorized', message }
  if (code !== null && UNSUPPORTED_CODES.has(code)) return { reason: 'unsupported', message }
  return { reason: 'failed', message }
}

function usageSample(doc: Record<string, unknown>): IndexUsageSample | undefined {
  const host = doc['host']
  const accesses = doc['accesses']
  if (typeof host !== 'string' || !isDocument(accesses)) return undefined
  const ops = toSafeNumber(accesses['ops'])
  const since = accesses['since']
  if (ops === undefined || !(since instanceof Date) || Number.isNaN(since.getTime())) {
    return undefined
  }
  const shard = doc['shard']
  return {
    host,
    ...(typeof shard === 'string' ? { shard } : {}),
    ops,
    since: since.toISOString()
  }
}

function toSafeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  // The driver promotes Longs to numbers only while they fit in 53 bits.
  if (Long.isLong(value)) return value.toNumber()
  return undefined
}
