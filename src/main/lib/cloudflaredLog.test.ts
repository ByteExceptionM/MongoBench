import { describe, expect, it } from 'vitest'
import { findLoginUrl, OutputTail, parseLogLine, splitLines } from './cloudflaredLog'

// Lines cloudflared 2025.8.1 printed in local runs against a hostname that cannot resolve.
const INF_LINE = '2026-10-16T12:57:58Z INF Start Websocket listener host=127.0.0.1:62183'
const ERR_LINE =
  '2026-10-16T12:58:01Z ERR failed to connect to origin error="dial tcp: lookup mongo.example.invalid: no such host" originURL=https://mongo.example.invalid'
const EMPTY_MESSAGE_ERR_LINE =
  '2026-10-16T12:58:03Z ERR  error="failed to parse as URL: parse \\"https://-x\\": invalid character"'
const LOGIN_URL =
  'https://mongo.example.com/cdn-cgi/access/cli?aud=abc&redirect_url=https%3A%2F%2Fmongo.example.com&token=xyz'

describe('parseLogLine', () => {
  it('parses an INF line', () => {
    expect(parseLogLine(INF_LINE)).toEqual({
      level: 'INF',
      message: 'Start Websocket listener host=127.0.0.1:62183'
    })
  })

  it('parses an ERR line', () => {
    expect(parseLogLine(ERR_LINE)?.level).toBe('ERR')
    expect(parseLogLine(ERR_LINE)?.message).toMatch(/^failed to connect to origin error=/)
  })

  it('parses an ERR line whose message is empty down to its fields', () => {
    expect(parseLogLine(EMPTY_MESSAGE_ERR_LINE)).toEqual({
      level: 'ERR',
      message: 'error="failed to parse as URL: parse \\"https://-x\\": invalid character"'
    })
  })

  it('returns null for a line that is not a log line', () => {
    expect(parseLogLine('failed to get app info: Head "https://x": no such host')).toBeNull()
  })
})

describe('findLoginUrl', () => {
  it('returns the sign-in URL for the configured hostname', () => {
    expect(findLoginUrl(LOGIN_URL, 'mongo.example.com')).toBe(LOGIN_URL)
  })

  it('matches the hostname case-insensitively', () => {
    expect(findLoginUrl(LOGIN_URL, 'Mongo.Example.com')).toBe(LOGIN_URL)
  })

  it('trims surrounding whitespace', () => {
    expect(findLoginUrl(`  ${LOGIN_URL}\r`, 'mongo.example.com')).toBe(LOGIN_URL)
  })

  it('ignores a URL for another host', () => {
    expect(
      findLoginUrl('https://evil.example.net/cdn-cgi/access/cli?aud=abc', 'mongo.example.com')
    ).toBeNull()
  })

  it('ignores plain http', () => {
    expect(findLoginUrl(LOGIN_URL.replace('https:', 'http:'), 'mongo.example.com')).toBeNull()
  })

  it('ignores another path on the right host', () => {
    expect(findLoginUrl('https://mongo.example.com/somewhere/else', 'mongo.example.com')).toBeNull()
  })

  it('ignores prose', () => {
    expect(
      findLoginUrl('A browser window should have opened at the following URL:', 'mongo.example.com')
    ).toBeNull()
  })
})

describe('splitLines', () => {
  function collect(): { lines: string[]; splitter: ReturnType<typeof splitLines> } {
    const lines: string[] = []
    return { lines, splitter: splitLines((line) => lines.push(line)) }
  }

  it('joins a line split across chunks', () => {
    const { lines, splitter } = collect()
    splitter.write('first li')
    splitter.write('ne\nsecond\n')
    expect(lines).toEqual(['first line', 'second'])
  })

  it('splits CRLF line endings, also when \\r and \\n arrive in separate chunks', () => {
    const { lines, splitter } = collect()
    splitter.write('one\r\ntwo\r')
    splitter.write('\nthree\r\n')
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('flushes an unterminated last line on end', () => {
    const { lines, splitter } = collect()
    splitter.write('done\npartial')
    expect(lines).toEqual(['done'])
    splitter.end()
    expect(lines).toEqual(['done', 'partial'])
  })
})

describe('OutputTail', () => {
  it('keeps the newest ERR message even after many later lines', () => {
    const tail = new OutputTail()
    tail.add(ERR_LINE)
    for (let i = 0; i < 30; i++)
      tail.add(`2026-10-16T12:59:${String(i).padStart(2, '0')}Z INF tick ${i}`)
    expect(tail.lastError()).toMatch(/^failed to connect to origin error=/)
    expect(tail.describe()).toBe(tail.lastError())
  })

  it('reports no error before an ERR or FTL line', () => {
    const tail = new OutputTail()
    tail.add(INF_LINE)
    expect(tail.lastError()).toBeNull()
  })

  it('describes a failure by the last plain line when nothing was logged as an error', () => {
    const tail = new OutputTail()
    tail.add(INF_LINE)
    tail.add('failed to get app info: Head "https://mongo.example.invalid": no such host')
    expect(tail.describe()).toBe(
      'failed to get app info: Head "https://mongo.example.invalid": no such host'
    )
  })

  it('describes a log line by its message', () => {
    const tail = new OutputTail()
    tail.add(INF_LINE)
    expect(tail.describe()).toBe('Start Websocket listener host=127.0.0.1:62183')
  })

  it('says so when cloudflared printed nothing', () => {
    const tail = new OutputTail()
    tail.add('   ')
    expect(tail.describe()).toBe('cloudflared printed nothing')
    expect(tail.text()).toBe('')
  })

  it('keeps only the last 20 lines', () => {
    const tail = new OutputTail()
    for (let i = 0; i < 25; i++) tail.add(`line ${i}`)
    const kept = tail.text().split('\n')
    expect(kept).toHaveLength(20)
    expect(kept[0]).toBe('line 5')
    expect(kept[19]).toBe('line 24')
  })

  it('truncates a long line to 500 characters', () => {
    const tail = new OutputTail()
    tail.add('x'.repeat(2000))
    expect(tail.text()).toHaveLength(500)
  })
})
