/**
 * Render a `Date` (or ms / ISO string) as an ISO-8601 string in a specific
 * IANA timezone, with explicit numeric offset (`+01:00`) — never a Z unless
 * the zone is actually UTC. Round-trips through `new Date(...)` to the
 * same UTC instant, so storage stays UTC even when the user sees local
 * time in the editor and table.
 */
export function formatIsoInZone(input: number | string | Date, tz: string): string {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return String(input)
  const zone = tz && tz.length > 0 ? tz : 'UTC'
  if (zone === 'UTC') return d.toISOString()

  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
      fractionalSecondDigits: 3,
      timeZoneName: 'longOffset'
    }).formatToParts(d)
  } catch {
    return d.toISOString()
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const ms = get('fractionalSecond') || '000'
  // `longOffset` returns "GMT+01:00" / "GMT-08:00" / "GMT" (UTC) — and uses
  // the unicode minus sign U+2212 in some locales. Normalize to ASCII.
  const tzn = get('timeZoneName')
  const offset = tzn === 'GMT' || tzn === '' ? '+00:00' : tzn.replace('GMT', '').replace('−', '-')
  // Some Chromium builds report `24` for midnight under hourCycle: 'h23'.
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}.${ms}${offset}`
}

/**
 * Format a date for compact table display, in the connection's timezone.
 * Format: `dd.MM.yyyy HH:mm:ss.fff` plus a tiny `+01:00`-style suffix when
 * the zone is not UTC, so the user can spot the rendering offset at a glance.
 */
export function formatDateInZone(input: number | string | Date, tz: string): string {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return String(input)
  const zone = tz && tz.length > 0 ? tz : 'UTC'
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
      fractionalSecondDigits: 3,
      timeZoneName: zone === 'UTC' ? undefined : 'longOffset'
    }).formatToParts(d)
  } catch {
    return d.toISOString()
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  const ms = get('fractionalSecond') || '000'
  const base = `${get('day')}.${get('month')}.${get('year')} ${hour}:${get('minute')}:${get('second')}.${ms}`
  if (zone === 'UTC') return `${base} UTC`
  const tzn = get('timeZoneName')
  const offset = tzn === 'GMT' || tzn === '' ? '+00:00' : tzn.replace('GMT', '').replace('−', '-')
  return `${base} ${offset}`
}
