import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInput, SshTunnelInput } from '@shared/types'

// The repository imports electron for the default userData path; every test
// passes an explicit directory instead, so getPath is never actually called.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { ConnectionsRepository, toRendererView } = await import('./ConnectionsRepository')

/**
 * Stand-in for safeStorage. Reversible on purpose — the point is not to test
 * DPAPI but to prove that whatever reaches the disk went through encrypt()
 * and that no cleartext travels alongside it.
 */
const CIPHER_PREFIX = 'enc:'
const secrets = {
  isAvailable: () => true,
  encrypt: (plaintext: string) => CIPHER_PREFIX + Buffer.from(plaintext, 'utf8').toString('base64'),
  decrypt: (cipher: string) =>
    Buffer.from(cipher.slice(CIPHER_PREFIX.length), 'base64').toString('utf8')
}

const SSH_PASSWORD = 'ssh-cleartext-password'
const SSH_PASSPHRASE = 'key-cleartext-passphrase'
const MONGO_PASSWORD = 'mongo-cleartext-password'

let dir: string
let repo: InstanceType<typeof ConnectionsRepository>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mongobench-repo-'))
  repo = new ConnectionsRepository(secrets, dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const onDisk = (): Promise<string> => readFile(join(dir, 'connections.json'), 'utf8')

function input(ssh?: Partial<SshTunnelInput>): ConnectionInput {
  return {
    name: 'Cluster',
    uri: 'mongodb://user@host:27017',
    password: MONGO_PASSWORD,
    ...(ssh !== undefined
      ? {
          ssh: {
            enabled: true,
            host: 'gateway.example.com',
            port: 22,
            username: 'tunneluser',
            authMethod: 'password',
            ...ssh
          }
        }
      : {})
  }
}

describe('secrets on disk', () => {
  it('never writes a cleartext password or passphrase', async () => {
    await repo.create(
      input({ authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' })
    )
    // Re-create with both secret kinds set to cover each field.
    await repo.create(input({ password: SSH_PASSWORD }))
    await repo.create(
      input({
        authMethod: 'privateKey',
        privateKeyPath: '/home/me/.ssh/id_ed25519',
        passphrase: SSH_PASSPHRASE
      })
    )

    const raw = await onDisk()
    expect(raw).not.toContain(MONGO_PASSWORD)
    expect(raw).not.toContain(SSH_PASSWORD)
    expect(raw).not.toContain(SSH_PASSPHRASE)
  })

  it('stores the SSH secrets as ciphertext that decrypts back', async () => {
    const created = await repo.create(input({ password: SSH_PASSWORD }))
    const stored = await repo.getStored(created.id)
    expect(stored?.ssh?.encryptedPassword).toMatch(/^enc:/)
    expect(repo.decryptSsh(stored!)).toEqual({ password: SSH_PASSWORD })
  })

  it('keeps the MongoDB password out of the stored URI', async () => {
    const created = await repo.create(input())
    const stored = await repo.getStored(created.id)
    expect(stored?.uri).not.toContain(MONGO_PASSWORD)
    expect(stored?.uri).toContain('%3CMONGOBENCH_PWD%3E')
  })

  it('stores only the private key path, never key material', async () => {
    const created = await repo.create(
      input({ authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' })
    )
    const stored = await repo.getStored(created.id)
    expect(Object.keys(stored?.ssh ?? {}).sort()).toEqual([
      'authMethod',
      'enabled',
      'host',
      'port',
      'privateKeyPath',
      'username'
    ])
  })
})

describe('secrets across edits', () => {
  it('keeps the stored secret when the form leaves the field blank', async () => {
    const created = await repo.create(input({ password: SSH_PASSWORD }))
    await repo.update(created.id, input({ password: '' }))
    const stored = await repo.getStored(created.id)
    expect(repo.decryptSsh(stored!)).toEqual({ password: SSH_PASSWORD })
  })

  it('drops the password when the auth method stops using it', async () => {
    const created = await repo.create(input({ password: SSH_PASSWORD }))
    await repo.update(
      created.id,
      input({ authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' })
    )
    const stored = await repo.getStored(created.id)
    expect(stored?.ssh?.encryptedPassword).toBeUndefined()
    expect(repo.decryptSsh(stored!)).toEqual({})
  })

  it('drops the passphrase when the auth method stops using it', async () => {
    const created = await repo.create(
      input({
        authMethod: 'privateKey',
        privateKeyPath: '/home/me/.ssh/id_ed25519',
        passphrase: SSH_PASSPHRASE
      })
    )
    await repo.update(created.id, input({ authMethod: 'agent' }))
    const stored = await repo.getStored(created.id)
    expect(stored?.ssh?.encryptedPassphrase).toBeUndefined()
  })

  it('keeps the tunnel settings when it is switched off', async () => {
    const created = await repo.create(input({ password: SSH_PASSWORD }))
    await repo.update(created.id, input({ enabled: false, password: '' }))
    const stored = await repo.getStored(created.id)
    expect(stored?.ssh?.enabled).toBe(false)
    expect(stored?.ssh?.host).toBe('gateway.example.com')
    expect(repo.decryptSsh(stored!)).toEqual({ password: SSH_PASSWORD })
  })
})

describe('toRendererView', () => {
  it('replaces the SSH secrets with hasStored flags', async () => {
    const created = await repo.create(input({ password: SSH_PASSWORD }))
    const stored = await repo.getStored(created.id)
    const view = toRendererView(stored!)

    expect(view.ssh).toEqual({
      enabled: true,
      host: 'gateway.example.com',
      port: 22,
      username: 'tunneluser',
      authMethod: 'password',
      hasStoredPassword: true,
      hasStoredPassphrase: false
    })
    // Nothing secret survives the projection, in any nesting.
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(CIPHER_PREFIX)
    expect(serialized).not.toContain(SSH_PASSWORD)
    expect(serialized).not.toContain('MONGOBENCH_PWD')
  })

  it('reports hasStoredPassphrase for a key with one', async () => {
    const created = await repo.create(
      input({
        authMethod: 'privateKey',
        privateKeyPath: '/home/me/.ssh/id_ed25519',
        passphrase: SSH_PASSPHRASE
      })
    )
    const view = toRendererView((await repo.getStored(created.id))!)
    expect(view.ssh?.hasStoredPassphrase).toBe(true)
    expect(view.ssh?.hasStoredPassword).toBe(false)
  })

  it('omits ssh entirely for connections that never had a tunnel', async () => {
    const created = await repo.create(input())
    const view = toRendererView((await repo.getStored(created.id))!)
    expect(view.ssh).toBeUndefined()
    expect(view.hasStoredPassword).toBe(true)
  })
})
