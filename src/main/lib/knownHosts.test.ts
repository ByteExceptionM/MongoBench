import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  findHostKeys,
  isRevoked,
  keyMatches,
  keyTypeOf,
  orderHostKeyAlgorithms,
  parseKnownHosts
} from './knownHosts'

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

const RSA_KEY = Buffer.from(
  'AAAAB3NzaC1yc2EAAAADAQABAAAAgQC/gX/7WgOQ6kBJXm40rYn/ObaTIBNCWsuJI/6S/wSImH72Nfe2K50W7fBtgBtvhfhY9b56Mfhzh/jXNBdjJtKXjfjRPS2004BGz2jsaLdKeviBryT/jbo4tEX4SA/+NDKlIUwXb5TgSzN+7yTNcCNTdC0zsU77JVcOEgxyu5jYiQ==',
  'base64'
)
const ECDSA_KEY = Buffer.from(
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBCXAVIxb/s+tZzJwt47GTXuciOdpToANn3jirNMDAYBn0pFQlw0DJ0dTMFgTO8GN36IeBxjU159s/yYS5CmVk7g=',
  'base64'
)

/** ssh2's own default order on a runtime with ed25519 support. */
const SSH2_DEFAULTS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa'
] as const

describe('parseKnownHosts', () => {
  it('skips comments, blank lines and @cert-authority lines', () => {
    const entries = parseKnownHosts(
      [
        '# a comment',
        '',
        '   ',
        `@cert-authority *.example.com ssh-ed25519 ${KEY_BASE64}`,
        `gate.example.com ssh-ed25519 ${KEY_BASE64}`
      ].join('\n')
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.keyType).toBe('ssh-ed25519')
    expect(entries[0]?.revoked).toBe(false)
  })

  it('keeps an @revoked line as a revoked entry', () => {
    const entries = parseKnownHosts(`@revoked * ssh-ed25519 ${KEY_BASE64}`)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.revoked).toBe(true)
    expect(entries[0]?.key).toEqual(KEY)
  })

  it('skips lines with an unknown marker', () => {
    expect(parseKnownHosts(`@unknown gate.example.com ssh-ed25519 ${KEY_BASE64}`)).toEqual([])
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

  it('never returns a revoked key', () => {
    const entries = parseKnownHosts(
      [
        `@revoked gate.example.com ssh-ed25519 ${KEY_BASE64}`,
        `gate.example.com ssh-ed25519 ${OTHER_KEY.toString('base64')}`
      ].join('\n')
    )
    expect(findHostKeys(entries, 'gate.example.com', 22)).toEqual([OTHER_KEY])
  })
})

describe('isRevoked', () => {
  it('applies a wildcard revocation to any host presenting that key', () => {
    const entries = parseKnownHosts(`@revoked * ssh-ed25519 ${KEY_BASE64}`)
    expect(isRevoked(entries, 'gate.example.com', 22, KEY)).toBe(true)
    expect(isRevoked(entries, 'other.example.org', 2222, KEY)).toBe(true)
  })

  it('does not apply to a different key', () => {
    const entries = parseKnownHosts(`@revoked * ssh-ed25519 ${KEY_BASE64}`)
    expect(isRevoked(entries, 'gate.example.com', 22, OTHER_KEY)).toBe(false)
  })

  it('only applies to hosts its patterns match', () => {
    const entries = parseKnownHosts(`@revoked gate.example.com ssh-ed25519 ${KEY_BASE64}`)
    expect(isRevoked(entries, 'gate.example.com', 22, KEY)).toBe(true)
    expect(isRevoked(entries, 'other.example.com', 22, KEY)).toBe(false)
  })

  it('ignores plain entries carrying the same key', () => {
    const entries = parseKnownHosts(`gate.example.com ssh-ed25519 ${KEY_BASE64}`)
    expect(isRevoked(entries, 'gate.example.com', 22, KEY)).toBe(false)
  })
})

describe('keyTypeOf', () => {
  it('reads the type name of an ed25519 blob', () => {
    expect(keyTypeOf(KEY)).toBe('ssh-ed25519')
  })

  it('reads the type name of an RSA blob', () => {
    expect(keyTypeOf(RSA_KEY)).toBe('ssh-rsa')
  })

  it('reads the type name of an ECDSA blob', () => {
    expect(keyTypeOf(ECDSA_KEY)).toBe('ecdsa-sha2-nistp256')
  })

  it('returns null for a blob cut off inside the type name', () => {
    expect(keyTypeOf(KEY.subarray(0, 8))).toBeNull()
  })

  it('returns null for a blob too short to hold a length', () => {
    expect(keyTypeOf(Buffer.from([0, 0]))).toBeNull()
  })
})

describe('orderHostKeyAlgorithms', () => {
  it('puts every RSA signature algorithm first for a known ssh-rsa key', () => {
    expect(orderHostKeyAlgorithms(['ssh-rsa'], SSH2_DEFAULTS)).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521'
    ])
  })

  it('keeps the default order among several known types', () => {
    expect(orderHostKeyAlgorithms(['ssh-rsa', 'ecdsa-sha2-nistp384'], SSH2_DEFAULTS)).toEqual([
      'ecdsa-sha2-nistp384',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp521'
    ])
  })

  it('keeps the defaults when no type is known', () => {
    expect(orderHostKeyAlgorithms([], SSH2_DEFAULTS)).toEqual([...SSH2_DEFAULTS])
  })

  it('ignores known types the defaults do not offer', () => {
    expect(orderHostKeyAlgorithms(['ssh-dss'], SSH2_DEFAULTS)).toEqual([...SSH2_DEFAULTS])
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
