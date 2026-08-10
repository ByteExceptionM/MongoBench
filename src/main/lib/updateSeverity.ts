import type { UpdateSeverity } from '@shared/events'

type Version = { major: number; minor: number; patch: number }

function parse(version: string): Version | null {
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0]
  if (core === undefined) return null
  const segments = core.split('.')
  if (segments.length !== 3) return null
  const [rawMajor, rawMinor, rawPatch] = segments
  if (rawMajor === undefined || rawMinor === undefined || rawPatch === undefined) return null
  if (!/^\d+$/.test(rawMajor) || !/^\d+$/.test(rawMinor) || !/^\d+$/.test(rawPatch)) return null
  return { major: Number(rawMajor), minor: Number(rawMinor), patch: Number(rawPatch) }
}

/**
 * How far `latest` is ahead of `current`, driving how loud the update toast is.
 * Null when `latest` is not newer or either version is unparseable.
 *
 * Hand-rolled because `semver` is only present transitively via electron-updater.
 * Prerelease suffixes are ignored, so callers that already know an update exists
 * should fall back to the quietest level rather than hide the notice.
 */
export function updateSeverity(current: string, latest: string): UpdateSeverity | null {
  const from = parse(current)
  const to = parse(latest)
  if (from === null || to === null) return null
  if (to.major !== from.major) return to.major > from.major ? 'major' : null
  if (to.minor !== from.minor) return to.minor > from.minor ? 'minor' : null
  if (to.patch !== from.patch) return to.patch > from.patch ? 'patch' : null
  return null
}
