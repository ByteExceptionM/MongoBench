type PoolEntry = { text: string; lower: string }

// Orders like a default localeCompare, without resolving the locale on every comparison.
const collator = new Intl.Collator()
// Pools are memoized arrays ranked on every keystroke; lowercase each one once.
const loweredPools = new WeakMap<readonly string[], PoolEntry[]>()

function lowered(pool: readonly string[]): PoolEntry[] {
  let entries = loweredPools.get(pool)
  if (entries === undefined) {
    entries = pool.map((text) => ({ text, lower: text.toLowerCase() }))
    loweredPools.set(pool, entries)
  }
  return entries
}

/** Case-insensitive substring matches, prefix matches first; empty once value equals the only match. */
export function rankSuggestions(value: string, pool: readonly string[], limit = 50): string[] {
  const trimmed = value.trim()
  const needle = trimmed.toLowerCase()
  let ranked: readonly string[] = pool
  if (needle) {
    const prefix: string[] = []
    const infix: string[] = []
    for (const { text, lower } of lowered(pool)) {
      const at = lower.indexOf(needle)
      if (at === 0) prefix.push(text)
      else if (at > 0) infix.push(text)
    }
    ranked = [...prefix.sort(collator.compare), ...infix.sort(collator.compare)]
  }
  // Nothing left to complete once the value matches the only candidate.
  if (ranked.length === 1 && ranked[0] === trimmed) return []
  return ranked.slice(0, limit)
}
