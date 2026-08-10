import { describe, expect, it } from 'vitest'
import { fingerprint, findHostKeys, keyMatches, parseKnownHosts } from './knownHosts'

// Real ed25519 key plus the two hashed lines OpenSSH itself produced for it
// via `ssh-keygen -H`, so the HMAC matching is checked against the reference
// implementation rather than against our own arithmetic.
const KEY_BASE64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIC3ZaX2ORSFJDIra++POwfcRoWepjw8gcywl33ojmW9U'
const KEY = Buffer.from(KEY_BASE64, 'base64')
const FINGERPRINT = 'SHA256:q+XnGzOPN1oDhKcAZC4Q2F03RfNaJ5zPwCLwaTc+jaw'
const HASHED_DEFAULT_PORT = '|1|a4f9lggJrrrtBTGjg90w3NUPHNk=|fNvB+sOQiLKPXVSEwRHNXZ5uQQ0='
const HASHED_PORT_2222 = '|1|6ztXlwedZiR/OZHPHaSRp1+559k=|KgysaTZ17zd24ZXmROwPufpfvgE='

const OTHER_KEY = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64'
)

describe('parseKnownHosts', () => {
  it('skips comments, blank lines and marker lines', () => {
    const entries = parseKnownHosts(
      [
        '# a comment',
        '',
        '   ',
        `@cert-authority *.example.com ssh-ed25519 ${KEY_BASE64}`,
        `@revoked gate.example.com ssh-ed25519 ${KEY_BASE64}`,
        `gate.example.com ssh-ed25519 ${KEY_BASE64}`
      ].join('\n')
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.keyType).toBe('ssh-ed25519')
  })

  it('reads several patterns off one line', () => {
    const entries = parseKnownHosts(`gate.example.com,10.0.0.1 ssh-ed25519 ${KEY_BASE64}`)
    expect(entries[0]?.hosts).toHaveLength(2)
  })

  it('tolerates CRLF line endings', () => {
    const entries = parseKnownHosts(`gate.example.com ssh-ed25519 ${KEY_BASE64}\r\n`)
    expect(entries).toHaveLength(1)
  })

  it('drops lines without a key', () => {
    expect(parseKnownHosts('gate.example.com ssh-ed25519')).toEqual([])
  })
})

describe('findHostKeys', () => {
  it('matches a plain entry on the default port', () => {
    const entries = parseKnownHosts(`gate.example.com ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([KEY])
  })

  it('is case-insensitive on the host name', () => {
    const entries = parseKnownHosts(`Gate.Example.COM ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.EXAMPLE.com', 22)).toEqual([KEY])
  })

  it('does not match a plain entry when a non-default port is requested', () => {
    const entries = parseKnownHosts(`gate.example.com ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 2222)).toEqual([])
  })

  it('matches the [host]:port form', () => {
    const entries = parseKnownHosts(`[gate.example.com]:2222 ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 2222)).toEqual([KEY])
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([])
  })

  it('accepts an explicit [host]:22 entry for the default port', () => {
    const entries = parseKnownHosts(`[gate.example.com]:22 ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([KEY])
  })

  it('matches a hashed entry produced by ssh-keygen -H', () => {
    const entries = parseKnownHosts(`${HASHED_DEFAULT_PORT} ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([KEY])
    expect(findHostKeys(entries, 'other.example.com', 22)).toEqual([])
  })

  it('matches a hashed entry for a non-default port', () => {
    const entries = parseKnownHosts(`${HASHED_PORT_2222} ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 2222)).toEqual([KEY])
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([])
  })

  it('honours wildcard patterns', () => {
    const entries = parseKnownHosts(`*.example.com ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([KEY])
    expect(findHostKeys(entries, 'gate.example.org', 22)).toEqual([])
  })

  it('lets a negated pattern veto its own line', () => {
    const entries = parseKnownHosts(`*.example.com,!gate.example.com ssh-ed25519 ${KEY_BASE64}`)
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([])
    expect(findHostKeys(entries, 'other.example.com', 22)).toEqual([KEY])
  })

  it('returns every key a host is allowed to present', () => {
    const entries = parseKnownHosts(
      [
        `gate.example.com ssh-ed25519 ${KEY_BASE64}`,
        `gate.example.com ssh-ed25519 ${OTHER_KEY.toString('base64')}`
      ].join('\n')
    )
    expect(findHostKeys(entries, 'gate.example.com', 22)).toHaveLength(2)
  })
})

describe('keyMatches', () => {
  it('accepts an identical blob', () => {
    expect(keyMatches(Buffer.from(KEY), KEY)).toBe(true)
  })

  it('rejects a different blob of the same length', () => {
    expect(keyMatches(OTHER_KEY, KEY)).toBe(false)
  })

  it('rejects a blob of a different length without throwing', () => {
    expect(keyMatches(KEY.subarray(0, 10), KEY)).toBe(false)
  })
})

describe('fingerprint', () => {
  it('matches what ssh-keygen -l reports', () => {
    expect(fingerprint(KEY)).toBe(FINGERPRINT)
  })
})
