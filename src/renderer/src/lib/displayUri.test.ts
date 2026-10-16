import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { formatConnectionAddress, formatHostShort } from './displayUri'

function connection(patch: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'test',
    uri: 'mongodb://localhost:27017',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    hasStoredPassword: false,
    ...patch
  }
}

const cloudflared = {
  hostname: 'mongo.example.com',
  authMethod: 'browser',
  hasStoredServiceTokenSecret: false
} as const

describe('formatHostShort', () => {
  it('keeps every host and drops the path and options', () => {
    expect(formatHostShort(connection({ uri: 'mongodb://h1:27017,h2:27018/db?tls=true' }))).toBe(
      'h1:27017,h2:27018'
    )
    expect(formatHostShort(connection({ uri: 'mongodb+srv://cluster.example.net?x=1' }))).toBe(
      'cluster.example.net'
    )
  })

  it('shows the Access hostname while a Cloudflare tunnel is on', () => {
    const conn = connection({
      uri: 'mongodb://localhost/db',
      cloudflared: { ...cloudflared, enabled: true }
    })
    expect(formatHostShort(conn)).toBe('mongo.example.com')
  })

  it('shows the URI hosts while the Cloudflare tunnel is switched off', () => {
    const conn = connection({
      uri: 'mongodb://db.internal:27017/app',
      cloudflared: { ...cloudflared, enabled: false }
    })
    expect(formatHostShort(conn)).toBe('db.internal:27017')
  })
})

describe('formatConnectionAddress', () => {
  it('is the URI as stored without a Cloudflare tunnel', () => {
    const uri = 'mongodb://db.internal:27017/app?tls=true'
    expect(formatConnectionAddress(connection({ uri }))).toBe(uri)
    expect(
      formatConnectionAddress(connection({ uri, cloudflared: { ...cloudflared, enabled: false } }))
    ).toBe(uri)
  })

  it('is the Access hostname while a Cloudflare tunnel is on', () => {
    const conn = connection({
      uri: 'mongodb://localhost/db',
      cloudflared: { ...cloudflared, enabled: true }
    })
    expect(formatConnectionAddress(conn)).toBe('mongo.example.com')
  })
})
