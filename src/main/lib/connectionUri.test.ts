import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  firstHostName,
  hasPasswordPlaceholder,
  injectStoredPassword,
  InvalidUriError,
  parseUri,
  replaceHosts
} from './connectionUri'

describe('parseUri', () => {
  it('parses an anonymous mongodb URI', () => {
    const parts = parseUri('mongodb://host:27017/db')
    expect(parts.scheme).toBe('mongodb')
    expect(parts.inlineUsername).toBeNull()
    expect(parts.inlinePassword).toBeNull()
    expect(parts.hostAndRest).toBe('host:27017/db')
  })

  it('parses an SRV URI', () => {
    const parts = parseUri('mongodb+srv://cluster.mongodb.net/db?retryWrites=true')
    expect(parts.scheme).toBe('mongodb+srv')
    expect(parts.hostAndRest).toBe('cluster.mongodb.net/db?retryWrites=true')
  })

  it('extracts inline username and password', () => {
    const parts = parseUri('mongodb://alice:secret@host/db')
    expect(parts.inlineUsername).toBe('alice')
    expect(parts.inlinePassword).toBe('secret')
    expect(parts.hostAndRest).toBe('host/db')
  })

  it('decodes URL-encoded credentials', () => {
    const parts = parseUri('mongodb://alice%40corp:p%40ss%3Aword@host/db')
    expect(parts.inlineUsername).toBe('alice@corp')
    expect(parts.inlinePassword).toBe('p@ss:word')
  })

  it('handles username without password', () => {
    const parts = parseUri('mongodb://alice@host/db')
    expect(parts.inlineUsername).toBe('alice')
    expect(parts.inlinePassword).toBeNull()
  })

  it('does not treat @ in path as auth separator', () => {
    const parts = parseUri('mongodb://host/db?foo=a@b')
    expect(parts.inlineUsername).toBeNull()
    expect(parts.inlinePassword).toBeNull()
  })

  it('rejects non-mongodb schemes', () => {
    expect(() => parseUri('http://host/db')).toThrow(InvalidUriError)
  })
})

describe('canonicalize', () => {
  it('keeps anonymous URIs untouched', () => {
    const result = canonicalize({ uri: 'mongodb://host:27017' })
    expect(result.storageUri).toBe('mongodb://host:27017')
    expect(result.username).toBeNull()
    expect(result.password).toBeNull()
  })

  it('replaces inline password with placeholder', () => {
    const result = canonicalize({ uri: 'mongodb://alice:secret@host/db' })
    expect(result.storageUri).toContain('alice:%3CMONGOBENCH_PWD%3E@host/db')
    expect(hasPasswordPlaceholder(result.storageUri)).toBe(true)
    expect(result.username).toBe('alice')
    expect(result.password).toBe('secret')
  })

  it('inline URI credentials win over form fields', () => {
    const result = canonicalize({
      uri: 'mongodb://alice:secret@host/db',
      username: 'bob',
      password: 'other'
    })
    expect(result.username).toBe('alice')
    expect(result.password).toBe('secret')
  })

  it('uses form credentials when URI has none', () => {
    const result = canonicalize({
      uri: 'mongodb://host/db',
      username: 'bob',
      password: 'p@ss'
    })
    expect(result.username).toBe('bob')
    expect(result.password).toBe('p@ss')
    expect(result.storageUri).toBe('mongodb://bob:%3CMONGOBENCH_PWD%3E@host/db')
  })

  it('handles username only (no password)', () => {
    const result = canonicalize({ uri: 'mongodb://host/db', username: 'bob' })
    expect(result.username).toBe('bob')
    expect(result.password).toBeNull()
    expect(result.storageUri).toBe('mongodb://bob@host/db')
  })

  it('encodes special characters in username when serializing', () => {
    const result = canonicalize({ uri: 'mongodb://host/db', username: 'alice@corp' })
    expect(result.storageUri).toBe('mongodb://alice%40corp@host/db')
  })
})

describe('injectStoredPassword', () => {
  it('substitutes the placeholder with an encoded password', () => {
    const stored = 'mongodb://alice:%3CMONGOBENCH_PWD%3E@host/db'
    expect(injectStoredPassword(stored, 'secret')).toBe('mongodb://alice:secret@host/db')
  })

  it('encodes special characters in the password', () => {
    const stored = 'mongodb://alice:%3CMONGOBENCH_PWD%3E@host/db'
    expect(injectStoredPassword(stored, 'p@ss:word')).toBe('mongodb://alice:p%40ss%3Aword@host/db')
  })

  it('is a no-op on URIs without a placeholder', () => {
    const uri = 'mongodb://host/db'
    expect(injectStoredPassword(uri, 'secret')).toBe(uri)
  })

  it('round-trips an inline-credentialed URI through canonicalize + inject', () => {
    const original = 'mongodb://alice:p%40ss%3Aword@host/db'
    const canonical = canonicalize({ uri: original })
    expect(canonical.password).toBe('p@ss:word')
    const restored = injectStoredPassword(canonical.storageUri, canonical.password!)
    expect(restored).toBe(original)
  })
})

describe('replaceHosts', () => {
  it('swaps every host and keeps credentials, database and options byte for byte', () => {
    expect(
      replaceHosts('mongodb://alice:p%40ss@h1:27017,h2:27018/db?authSource=admin', '127.0.0.1:5000')
    ).toBe('mongodb://alice:p%40ss@127.0.0.1:5000/db?authSource=admin')
  })

  it('handles a URI with no path', () => {
    expect(replaceHosts('mongodb://host', '127.0.0.1:5000')).toBe('mongodb://127.0.0.1:5000')
  })

  it('handles options without a slash before them', () => {
    expect(replaceHosts('mongodb://host?tls=true', '127.0.0.1:5000')).toBe(
      'mongodb://127.0.0.1:5000?tls=true'
    )
  })

  it('keeps the stored password placeholder', () => {
    expect(replaceHosts('mongodb://alice:%3CMONGOBENCH_PWD%3E@host/db', '127.0.0.1:5000')).toBe(
      'mongodb://alice:%3CMONGOBENCH_PWD%3E@127.0.0.1:5000/db'
    )
  })

  it('replaces an IPv6 literal', () => {
    expect(replaceHosts('mongodb://[::1]:27017/db', '127.0.0.1:5000')).toBe(
      'mongodb://127.0.0.1:5000/db'
    )
  })

  it('rejects mongodb+srv://, whose hosts come from DNS', () => {
    expect(() => replaceHosts('mongodb+srv://cluster.example.com/db', '127.0.0.1:5000')).toThrow(
      InvalidUriError
    )
  })
})

describe('firstHostName', () => {
  it('returns a DNS name in lower case, without the port', () => {
    expect(firstHostName('mongodb://Mongo.Internal:27017/db')).toBe('mongo.internal')
  })

  it('returns null for an IPv4 literal', () => {
    expect(firstHostName('mongodb://10.0.0.1:27017')).toBeNull()
  })

  it('returns null for an IPv6 literal', () => {
    expect(firstHostName('mongodb://[::1]:27017')).toBeNull()
  })

  it('returns null for a percent-encoded socket path', () => {
    expect(firstHostName('mongodb://%2Ftmp%2Fm.sock')).toBeNull()
  })

  it('returns the first host of a multi-host URI', () => {
    expect(
      firstHostName('mongodb://a.example.com:27017,b.example.com:27018/db?replicaSet=rs')
    ).toBe('a.example.com')
  })

  it('ignores credentials', () => {
    expect(firstHostName('mongodb://alice:p%40ss@db.example.com/admin')).toBe('db.example.com')
  })
})
