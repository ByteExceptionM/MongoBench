/**
 * Reading side of cloudflared's console output: zerolog lines on stderr, with
 * no colour when piped, plus the plain text `access login` prints. Pure — the
 * service feeds it what the process wrote.
 */

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\S+\s+(DBG|INF|WRN|ERR|FTL)\s+(.*)$/
const LOGIN_PATH = '/cdn-cgi/access/cli'
const MAX_LINES = 20
const MAX_LINE_LENGTH = 500

/** A cloudflared console log line such as `2025-08-21T15:34:00Z ERR failed to connect to origin error="…"`. */
export function parseLogLine(
  line: string
): { level: 'DBG' | 'INF' | 'WRN' | 'ERR' | 'FTL'; message: string } | null {
  const match = LOG_LINE.exec(line.trim())
  if (match === null) return null
  return {
    level: match[1] as 'DBG' | 'INF' | 'WRN' | 'ERR' | 'FTL',
    message: (match[2] ?? '').trim()
  }
}

/** The Access sign-in URL cloudflared printed for `hostname`, or null. */
export function findLoginUrl(line: string, hostname: string): string | null {
  let url: URL
  try {
    url = new URL(line.trim())
  } catch {
    return null
  }
  // The renderer opens this in the browser, so only Access's own sign-in page passes.
  if (url.protocol !== 'https:') return null
  if (url.hostname !== hostname.toLowerCase()) return null
  if (url.pathname !== LOGIN_PATH) return null
  return url.href
}

/** Splits a text stream into lines; `end` flushes a final unterminated line. */
export function splitLines(onLine: (line: string) => void): {
  write: (chunk: string) => void
  end: () => void
} {
  let pending = ''
  return {
    write: (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    },
    end: () => {
      if (pending.length > 0) onLine(pending)
      pending = ''
    }
  }
}

/** Keeps the end of a cloudflared process's output so errors can quote it. */
export class OutputTail {
  private readonly lines: string[] = []
  // Held apart from `lines` so a burst of later INF lines cannot evict the reason.
  private newestError: string | null = null

  add(line: string): void {
    const kept = line.trim().slice(0, MAX_LINE_LENGTH)
    if (kept.length === 0) return
    this.lines.push(kept)
    if (this.lines.length > MAX_LINES) this.lines.shift()
    const parsed = parseLogLine(kept)
    if (parsed !== null && (parsed.level === 'ERR' || parsed.level === 'FTL')) {
      this.newestError = parsed.message
    }
  }

  /** The newest ERR or FTL message, or null when cloudflared logged none. */
  lastError(): string | null {
    return this.newestError
  }

  /** The best single line to explain a failure. */
  describe(): string {
    if (this.newestError !== null) return this.newestError
    const last = this.lines.at(-1)
    if (last === undefined) return 'cloudflared printed nothing'
    return parseLogLine(last)?.message ?? last
  }

  /** Every kept line, newline-joined. */
  text(): string {
    return this.lines.join('\n')
  }
}
