import { isDocument } from '@shared/writeOps'

type StorageDoc = Record<string, unknown>

/**
 * Sums per-shard `$collStats` storage stats; `nindexes` and `capped` come from the first shard.
 * @param docs one `$collStats` document per shard
 * @returns the namespace and summed stats; `count` only when a shard reports one
 */
export function mergeStorageStats(docs: ReadonlyArray<StorageDoc>): {
  ns: string | null
  storage: Record<string, unknown>
} {
  const first = docs[0]
  if (!first) return { ns: null, storage: {} }
  const parts = storageParts(docs)
  const firstPart = parts[0] ?? {}
  return {
    ns: typeof first['ns'] === 'string' ? first['ns'] : null,
    storage: {
      ...(parts.some((p) => p['count'] !== undefined) ? { count: sum(parts, 'count') } : {}),
      size: sum(parts, 'size'),
      storageSize: sum(parts, 'storageSize'),
      freeStorageSize: sum(parts, 'freeStorageSize'),
      totalIndexSize: sum(parts, 'totalIndexSize'),
      totalSize: sum(parts, 'totalSize'),
      ...(parts.some((p) => p['numOrphanDocs'] !== undefined)
        ? { numOrphanDocs: sum(parts, 'numOrphanDocs') }
        : {}),
      indexSizes: sumIndexSizes(parts),
      nindexes: firstPart['nindexes'],
      capped: firstPart['capped']
    }
  }
}

function sum(parts: ReadonlyArray<StorageDoc>, key: string): number {
  return parts.reduce((total, part) => total + (finiteNumber(part[key]) ?? 0), 0)
}

/** The `storageStats` of each `$collStats` document; `{}` where a document has none. */
export function storageParts(docs: ReadonlyArray<StorageDoc>): StorageDoc[] {
  return docs.map((doc) => {
    const stats = doc['storageStats']
    return isDocument(stats) ? stats : {}
  })
}

/** Each index's size summed over `storageParts`; sizes that are not finite numbers are skipped. */
export function sumIndexSizes(parts: ReadonlyArray<StorageDoc>): Record<string, number> {
  // A Map, not an object: an index may be named "__proto__".
  const sizes = new Map<string, number>()
  for (const part of parts) {
    const indexSizes = part['indexSizes']
    if (!isDocument(indexSizes)) continue
    for (const [name, value] of Object.entries(indexSizes)) {
      const size = finiteNumber(value)
      if (size !== undefined) sizes.set(name, (sizes.get(name) ?? 0) + size)
    }
  }
  return Object.fromEntries(sizes)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
