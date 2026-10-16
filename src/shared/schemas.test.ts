import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  AggregateRequestSchema,
  CancelQuerySchema,
  CloudflaredVersionSchema,
  CollectionRefSchema,
  ConnectionInputSchema,
  ConnectionTestPayloadSchema,
  ConnectionUpdateSchema,
  CountRequestSchema,
  CreateDatabaseSchema,
  CreateIndexSchema,
  CreateUserSchema,
  DatabaseRefSchema,
  DistinctRequestSchema,
  DropIndexSchema,
  DropUserSchema,
  FindRequestSchema,
  InsertOneRequestSchema,
  ReplaceOneRequestSchema,
  UpdateUserSchema
} from './schemas'

const CONNECTION_ID = '00000000-0000-4000-8000-000000000000'
const HASH = 'ab'.repeat(32)
const MiB = 1024 * 1024

function issuePaths(schema: ZodType, input: unknown): PropertyKey[][] {
  return schema.safeParse(input).error?.issues.map((issue) => issue.path) ?? []
}

describe('ConnectionInputSchema with a Cloudflare tunnel', () => {
  const base = { name: 'Prod', uri: 'mongodb://mongo.internal:27017' }
  const access = { enabled: true, hostname: 'mongo.example.com', authMethod: 'browser' as const }
  const sshOn = {
    enabled: true,
    host: 'bastion.example.com',
    username: 'deploy',
    authMethod: 'agent' as const
  }

  it('accepts an enabled browser sign-in tunnel', () => {
    const parsed = ConnectionInputSchema.parse({ ...base, cloudflared: access })
    expect(parsed.cloudflared).toEqual(access)
  })

  it('accepts service-token mode with a client ID and no secret', () => {
    const cloudflared = {
      enabled: true,
      hostname: 'mongo.example.com',
      authMethod: 'serviceToken',
      serviceTokenId: '0123456789abcdef0123456789abcdef.access'
    }
    expect(ConnectionInputSchema.safeParse({ ...base, cloudflared }).success).toBe(true)
  })

  it('trims hostname, client ID and binary path before checking them', () => {
    const parsed = ConnectionInputSchema.parse({
      ...base,
      cloudflared: {
        enabled: true,
        hostname: '  mongo.example.com ',
        authMethod: 'serviceToken',
        serviceTokenId: ' id.access ',
        binaryPath: ' C:\\tools\\cloudflared.exe '
      }
    })
    expect(parsed.cloudflared).toMatchObject({
      hostname: 'mongo.example.com',
      serviceTokenId: 'id.access',
      binaryPath: 'C:\\tools\\cloudflared.exe'
    })
  })

  it.each(['https://mongo.example.com', 'mongo.example.com:443', 'localhost', ''])(
    'rejects the hostname %j once enabled',
    (hostname) => {
      expect(
        issuePaths(ConnectionInputSchema, { ...base, cloudflared: { ...access, hostname } })
      ).toContainEqual(['cloudflared', 'hostname'])
    }
  )

  it.each([undefined, '', '   '])(
    'rejects service-token mode with the client ID %j',
    (serviceTokenId) => {
      const cloudflared = { ...access, authMethod: 'serviceToken', serviceTokenId }
      expect(issuePaths(ConnectionInputSchema, { ...base, cloudflared })).toContainEqual([
        'cloudflared',
        'serviceTokenId'
      ])
    }
  )

  it.each([
    'C:\\Windows\\System32\\calc.exe',
    'cloudflared.exe',
    '',
    '\\\\attacker.invalid\\share\\cloudflared.exe'
  ])('rejects the binary path %j once enabled', (binaryPath) => {
    const cloudflared = { ...access, binaryPath }
    expect(issuePaths(ConnectionInputSchema, { ...base, cloudflared })).toContainEqual([
      'cloudflared',
      'binaryPath'
    ])
  })

  it.each(['serviceTokenId', 'serviceTokenSecret'])(
    'rejects a NUL character in %s, even while switched off',
    (field) => {
      const cloudflared = {
        enabled: false,
        hostname: 'mongo.example.com',
        authMethod: 'serviceToken',
        serviceTokenId: 'abc.access',
        [field]: 'abc\0def'
      }
      expect(issuePaths(ConnectionInputSchema, { ...base, cloudflared })).toContainEqual([
        'cloudflared',
        field
      ])
    }
  )

  it('accepts a disabled, half-filled section', () => {
    const cloudflared = { enabled: false, hostname: 'mongo.', authMethod: 'serviceToken' }
    expect(ConnectionInputSchema.safeParse({ ...base, cloudflared }).success).toBe(true)
  })

  it('rejects unknown keys in the section', () => {
    const cloudflared = { ...access, token: 'secret' }
    expect(ConnectionInputSchema.safeParse({ ...base, cloudflared }).success).toBe(false)
  })

  it('rejects SSH and Cloudflare tunnels enabled together', () => {
    expect(
      issuePaths(ConnectionInputSchema, { ...base, ssh: sshOn, cloudflared: access })
    ).toContainEqual(['cloudflared', 'enabled'])
  })

  it('accepts an enabled SSH tunnel next to a disabled Cloudflare section', () => {
    const input = { ...base, ssh: sshOn, cloudflared: { ...access, enabled: false } }
    expect(ConnectionInputSchema.safeParse(input).success).toBe(true)
  })

  it('rejects a mongodb+srv:// connection string with the tunnel enabled', () => {
    const input = { ...base, uri: 'mongodb+srv://cluster.example.com', cloudflared: access }
    expect(issuePaths(ConnectionInputSchema, input)).toContainEqual(['uri'])
  })

  it('accepts a mongodb+srv:// connection string with the tunnel disabled', () => {
    const input = {
      ...base,
      uri: 'mongodb+srv://cluster.example.com',
      cloudflared: { ...access, enabled: false }
    }
    expect(ConnectionInputSchema.safeParse(input).success).toBe(true)
  })

  it('applies the same rules when updating and testing a connection', () => {
    const patch = { ...base, ssh: sshOn, cloudflared: access }
    expect(ConnectionUpdateSchema.safeParse({ id: CONNECTION_ID, patch }).success).toBe(false)
    expect(ConnectionTestPayloadSchema.safeParse({ input: patch }).success).toBe(false)
  })
})

describe('CloudflaredVersionSchema', () => {
  it('accepts an absent binary path, meaning cloudflared from PATH', () => {
    expect(CloudflaredVersionSchema.safeParse({}).success).toBe(true)
    expect(CloudflaredVersionSchema.safeParse({ binaryPath: undefined }).success).toBe(true)
  })

  it('accepts an absolute cloudflared path and trims it', () => {
    expect(CloudflaredVersionSchema.parse({ binaryPath: ' /usr/local/bin/cloudflared ' })).toEqual({
      binaryPath: '/usr/local/bin/cloudflared'
    })
  })

  it.each([
    'C:\\Windows\\System32\\calc.exe',
    'cloudflared',
    '',
    '\\\\attacker.invalid@SSL\\DavWWWRoot\\cloudflared.exe'
  ])('rejects the binary path %j', (binaryPath) => {
    expect(CloudflaredVersionSchema.safeParse({ binaryPath }).success).toBe(false)
  })
})

describe('user schemas', () => {
  const ref = { connectionId: CONNECTION_ID, db: 'admin' }
  const roles = (count: number): Array<{ role: string; db: string }> =>
    Array.from({ length: count }, (_, i) => ({ role: 'readWrite', db: `tenant_${i}` }))

  it('accepts 200 roles on create and update', () => {
    expect(
      CreateUserSchema.safeParse({ ...ref, username: 'svc', password: 'pw', roles: roles(200) })
        .success
    ).toBe(true)
    expect(
      UpdateUserSchema.safeParse({ ...ref, username: 'svc', password: null, roles: roles(200) })
        .success
    ).toBe(true)
  })

  it('accepts 10 000 roles and rejects 10 001', () => {
    const update = { ...ref, username: 'svc', password: null }
    expect(UpdateUserSchema.safeParse({ ...update, roles: roles(10_000) }).success).toBe(true)
    expect(UpdateUserSchema.safeParse({ ...update, roles: roles(10_001) }).success).toBe(false)
    expect(
      CreateUserSchema.safeParse({ ...ref, username: 'svc', password: 'pw', roles: roles(10_001) })
        .success
    ).toBe(false)
  })

  it('accepts roles: null on update to leave the roles unchanged', () => {
    const parsed = UpdateUserSchema.parse({ ...ref, username: 'svc', password: 'new', roles: null })
    expect(parsed.roles).toBeNull()
  })

  it.each(['report reader', ' bob', 'bob '])(
    'updates and drops the existing user %j verbatim',
    (username) => {
      expect(
        UpdateUserSchema.parse({ ...ref, username, password: 'pw', roles: null }).username
      ).toBe(username)
      expect(DropUserSchema.parse({ ...ref, username }).username).toBe(username)
    }
  )

  it('trims the name of a new user', () => {
    const parsed = CreateUserSchema.parse({ ...ref, username: ' bob ', password: 'pw', roles: [] })
    expect(parsed.username).toBe('bob')
  })

  it.each(['a b', 'a\tb', '   '])('rejects the new user name %j', (username) => {
    expect(
      CreateUserSchema.safeParse({ ...ref, username, password: 'pw', roles: [] }).success
    ).toBe(false)
  })

  it('rejects a NUL character in every user name', () => {
    const username = 'a\0b'
    expect(
      CreateUserSchema.safeParse({ ...ref, username, password: 'pw', roles: [] }).success
    ).toBe(false)
    expect(
      UpdateUserSchema.safeParse({ ...ref, username, password: 'pw', roles: null }).success
    ).toBe(false)
    expect(DropUserSchema.safeParse({ ...ref, username }).success).toBe(false)
  })

  it('rejects an empty name on update and drop', () => {
    expect(
      UpdateUserSchema.safeParse({ ...ref, username: '', password: 'pw', roles: null }).success
    ).toBe(false)
    expect(DropUserSchema.safeParse({ ...ref, username: '' }).success).toBe(false)
  })
})

describe('index name schemas', () => {
  const ref = { connectionId: CONNECTION_ID, db: 'app', coll: 'players' }

  it.each(['$**_1', 'a.$**_1'])('drops the wildcard index %j', (name) => {
    expect(DropIndexSchema.safeParse({ ...ref, name }).success).toBe(true)
  })

  it('drops an index with a 200-character name', () => {
    expect(DropIndexSchema.safeParse({ ...ref, name: 'k'.repeat(200) }).success).toBe(true)
  })

  it.each([
    ['an empty name', ''],
    ['a NUL character', 'a\0b'],
    ['more than 1024 characters', 'k'.repeat(1025)]
  ])('rejects an index name with %s', (_case, name) => {
    expect(DropIndexSchema.safeParse({ ...ref, name }).success).toBe(false)
  })

  it('accepts a wildcard index name on create', () => {
    const request = { ...ref, keys: '{"$**":1}', options: { name: '$**_1' } }
    expect(CreateIndexSchema.safeParse(request).success).toBe(true)
  })
})

describe('payload caps', () => {
  const ref = { connectionId: CONNECTION_ID, db: 'app', coll: 'players' }
  const oidIn = JSON.stringify({
    _id: {
      $in: Array.from({ length: 32_000 }, (_, i) => ({ $oid: i.toString(16).padStart(24, '0') }))
    }
  })

  it('accepts skip and limit past one million', () => {
    expect(FindRequestSchema.safeParse({ ...ref, skip: 5_000_000, limit: 5_000_000 }).success).toBe(
      true
    )
  })

  it('accepts skip up to the largest safe integer', () => {
    expect(FindRequestSchema.safeParse({ ...ref, skip: Number.MAX_SAFE_INTEGER }).success).toBe(
      true
    )
    expect(FindRequestSchema.safeParse({ ...ref, skip: 2 ** 53 }).success).toBe(false)
  })

  it('rejects a negative or fractional skip', () => {
    expect(FindRequestSchema.safeParse({ ...ref, skip: -1 }).success).toBe(false)
    expect(FindRequestSchema.safeParse({ ...ref, skip: 1.5 }).success).toBe(false)
  })

  it('treats an absent limit as no limit and rejects limit 0', () => {
    expect(FindRequestSchema.safeParse({ ...ref, skip: 0 }).success).toBe(true)
    expect(FindRequestSchema.safeParse({ ...ref, skip: 0, limit: 0 }).success).toBe(false)
  })

  it('accepts a filter of more than 1 MiB', () => {
    expect(oidIn.length).toBeGreaterThan(MiB)
    expect(CountRequestSchema.safeParse({ ...ref, filter: oidIn }).success).toBe(true)
    expect(FindRequestSchema.safeParse({ ...ref, filter: oidIn, skip: 0 }).success).toBe(true)
  })

  it('accepts a pipeline of more than 1 MiB', () => {
    const pipeline = JSON.stringify([{ $match: JSON.parse(oidIn) }])
    expect(AggregateRequestSchema.safeParse({ ...ref, pipeline }).success).toBe(true)
  })

  it('rejects a filter above 16 MiB', () => {
    const filter = 'x'.repeat(16 * MiB + 1)
    expect(CountRequestSchema.safeParse({ ...ref, filter }).success).toBe(false)
  })

  it('accepts a 2 MiB document on replace and insert', () => {
    const document = JSON.stringify({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      blob: { $binary: { base64: 'A'.repeat(2 * MiB), subType: '00' } }
    })
    expect(
      ReplaceOneRequestSchema.safeParse({
        ...ref,
        id: '{"$oid":"507f1f77bcf86cd799439011"}',
        expectedHash: HASH,
        replacement: document
      }).success
    ).toBe(true)
    expect(InsertOneRequestSchema.safeParse({ ...ref, document }).success).toBe(true)
  })

  it('rejects a document above 64 MiB', () => {
    const document = 'x'.repeat(64 * MiB + 1)
    expect(InsertOneRequestSchema.safeParse({ ...ref, document }).success).toBe(false)
  })
})

describe('database name schemas', () => {
  const create = (db: string): unknown => ({
    connectionId: CONNECTION_ID,
    db,
    firstColl: 'items'
  })

  it.each(['app:prod', 'tenant*42', 'a<b>', 'a|b', 'a?b'])(
    'opens the server-legal database %j but does not create it',
    (db) => {
      expect(DatabaseRefSchema.safeParse({ connectionId: CONNECTION_ID, db }).success).toBe(true)
      expect(
        CollectionRefSchema.safeParse({ connectionId: CONNECTION_ID, db, coll: 'items' }).success
      ).toBe(true)
      expect(CreateDatabaseSchema.safeParse(create(db)).success).toBe(false)
    }
  )

  it.each(['a.b', 'a b', 'a\0b', 'a/b', 'a\\b', 'a"b', 'a$b', ''])(
    'rejects the database name %j everywhere',
    (db) => {
      expect(DatabaseRefSchema.safeParse({ connectionId: CONNECTION_ID, db }).success).toBe(false)
      expect(CreateDatabaseSchema.safeParse(create(db)).success).toBe(false)
    }
  )

  it('creates a portable database name', () => {
    expect(CreateDatabaseSchema.safeParse(create('app_prod-2')).success).toBe(true)
  })
})

describe('query request ids and options', () => {
  const ref = { connectionId: CONNECTION_ID, db: 'app', coll: 'players' }

  it('accepts a random UUID as requestId on find, count and aggregate', () => {
    const requestId = randomUUID()
    expect(FindRequestSchema.safeParse({ ...ref, skip: 0, requestId }).success).toBe(true)
    expect(CountRequestSchema.safeParse({ ...ref, requestId }).success).toBe(true)
    expect(AggregateRequestSchema.safeParse({ ...ref, pipeline: '[]', requestId }).success).toBe(
      true
    )
  })

  it('rejects a requestId that is not a UUID', () => {
    const requestId = 'run-1'
    expect(FindRequestSchema.safeParse({ ...ref, skip: 0, requestId }).success).toBe(false)
    expect(CountRequestSchema.safeParse({ ...ref, requestId }).success).toBe(false)
    expect(AggregateRequestSchema.safeParse({ ...ref, pipeline: '[]', requestId }).success).toBe(
      false
    )
  })

  it('accepts a boolean exact flag on count and nothing else', () => {
    expect(CountRequestSchema.safeParse({ ...ref, exact: true }).success).toBe(true)
    expect(CountRequestSchema.safeParse({ ...ref, exact: false }).success).toBe(true)
    expect(CountRequestSchema.safeParse({ ...ref, exact: 'yes' }).success).toBe(false)
  })

  it('accepts distinct with a field and an optional filter', () => {
    expect(DistinctRequestSchema.safeParse({ ...ref, field: 'meta.region' }).success).toBe(true)
    expect(
      DistinctRequestSchema.safeParse({ ...ref, field: 'meta.region', filter: '{"active":true}' })
        .success
    ).toBe(true)
  })

  it('rejects distinct with an empty or over-long field', () => {
    expect(DistinctRequestSchema.safeParse({ ...ref, field: '' }).success).toBe(false)
    expect(DistinctRequestSchema.safeParse({ ...ref, field: 'a'.repeat(1025) }).success).toBe(false)
  })

  it('rejects a requestId on distinct, which is not cancellable server-side', () => {
    const request = { ...ref, field: 'meta.region', requestId: randomUUID() }
    expect(DistinctRequestSchema.safeParse(request).success).toBe(false)
  })

  it('accepts a cancel request with a UUID', () => {
    const requestId = randomUUID()
    expect(CancelQuerySchema.parse({ requestId })).toEqual({ requestId })
  })

  it('rejects a cancel request without a UUID or with extra keys', () => {
    expect(CancelQuerySchema.safeParse({}).success).toBe(false)
    expect(CancelQuerySchema.safeParse({ requestId: 'run-1' }).success).toBe(false)
    expect(CancelQuerySchema.safeParse({ requestId: randomUUID(), all: true }).success).toBe(false)
  })
})
