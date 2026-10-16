import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionInput,
  StoredCloudflaredTunnel,
  StoredConnection,
  StoredSshTunnel
} from '@shared/types'
import type { Tunnel, TunnelRoute } from '../lib/tunnel'
import type { ConnectionsRepository } from '../stores/ConnectionsRepository'
import type { CloudflaredTunnelService } from './CloudflaredTunnelService'
import type { SshTunnelService } from './SshTunnelService'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))
// The repository module reads electron's userData path; these tests pass a fake repository.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

/** MongoClient stand-in: records how it was built; `connect` is steered per test. */
const driver = vi.hoisted(() => {
  const created: FakeMongoClient[] = []
  const connect = vi.fn((): Promise<void> => Promise.resolve())
  class FakeMongoClient {
    readonly close = vi.fn((): Promise<void> => Promise.resolve())
    readonly connect = connect
    constructor(
      readonly uri: string,
      readonly options: Record<string, unknown>
    ) {
      created.push(this)
    }
    db(): { command: (command: Record<string, unknown>) => Promise<unknown> } {
      return {
        command: (command) => Promise.resolve('ping' in command ? { ok: 1 } : { version: '8.0.4' })
      }
    }
  }
  return { FakeMongoClient, created, connect }
})
vi.mock('mongodb', () => ({ MongoClient: driver.FakeMongoClient }))

const { ConnectionService } = await import('./ConnectionService')

const ID = '6f1d3c2a-8b4e-4f5a-9c7d-1e2f3a4b5c6d'
const SOCKS_ROUTE: TunnelRoute = {
  kind: 'socks5',
  proxy: { proxyHost: '127.0.0.1', proxyPort: 1080, proxyUsername: 'u', proxyPassword: 'p' }
}
const LOCAL_ROUTE: TunnelRoute = { kind: 'localPort', host: '127.0.0.1', port: 5001 }
const SSH: StoredSshTunnel = {
  enabled: true,
  host: 'gateway.example.com',
  username: 'tunneluser',
  authMethod: 'agent'
}
const CLOUDFLARED: StoredCloudflaredTunnel = {
  enabled: true,
  hostname: 'mongo.example.com',
  authMethod: 'serviceToken',
  serviceTokenId: 'abc.access',
  encryptedServiceTokenSecret: 'enc:secret'
}
const STORED_SECRET = 'decrypted-token-secret'

function stored(overrides: Partial<StoredConnection> = {}): StoredConnection {
  return {
    id: ID,
    name: 'Production',
    uri: 'mongodb://db.example.com:27017/admin',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides
  }
}

type Opened = { config: unknown; onDropped?: (reason: string) => void; tunnel: Tunnel }

function fakeTunnels(route: TunnelRoute): {
  service: { open: ReturnType<typeof vi.fn>; closeAll: ReturnType<typeof vi.fn> }
  opened: Opened[]
} {
  const opened: Opened[] = []
  const service = {
    open: vi.fn((config: unknown, onDropped?: (reason: string) => void) => {
      const tunnel: Tunnel = {
        route,
        pinnedHostKey: null,
        failure: vi.fn((): Error | null => null),
        close: vi.fn((): Promise<void> => Promise.resolve())
      }
      opened.push({ config, ...(onDropped !== undefined ? { onDropped } : {}), tunnel })
      return Promise.resolve(tunnel)
    }),
    closeAll: vi.fn((): Promise<void> => Promise.resolve())
  }
  return { service, opened }
}

function setup(connections: StoredConnection[], options: { password?: string } = {}) {
  const repo = {
    getStored: vi.fn((id: string) => Promise.resolve(connections.find((c) => c.id === id) ?? null)),
    decryptPassword: vi.fn(() => options.password ?? null),
    decryptSsh: vi.fn(() => ({})),
    decryptCloudflared: vi.fn((connection: StoredConnection) =>
      connection.cloudflared?.encryptedServiceTokenSecret !== undefined
        ? { serviceTokenSecret: STORED_SECRET }
        : {}
    )
  }
  const ssh = fakeTunnels(SOCKS_ROUTE)
  const cloudflared = fakeTunnels(LOCAL_ROUTE)
  const onDropped = vi.fn()
  const service = new ConnectionService(
    repo as unknown as ConnectionsRepository,
    ssh.service as unknown as SshTunnelService,
    cloudflared.service as unknown as CloudflaredTunnelService,
    onDropped
  )
  return { service, repo, ssh, cloudflared, onDropped }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createdAt(index: number): InstanceType<typeof driver.FakeMongoClient> {
  const client = driver.created[index]
  if (client === undefined) throw new Error(`no client at ${index}`)
  return client
}

function openedAt(opened: Opened[], index: number): Opened {
  const call = opened[index]
  if (call === undefined) throw new Error(`no tunnel at ${index}`)
  return call
}

function driverError(name: string): Error {
  return Object.assign(new Error(`${name} from the driver`), { name })
}

afterEach(() => {
  driver.created.length = 0
  driver.connect.mockReset()
  driver.connect.mockImplementation(() => Promise.resolve())
})

describe('connect', () => {
  it('joins a connect already in flight instead of opening a second client and tunnel', async () => {
    const { service, ssh } = setup([stored({ ssh: SSH })])
    const gate = deferred()
    driver.connect.mockImplementation(() => gate.promise)

    const first = service.connect(ID)
    const second = service.connect(ID)
    await vi.waitFor(() => expect(driver.created).toHaveLength(1))
    gate.resolve()

    expect(await first).toEqual({ connectionId: ID })
    expect(await second).toEqual({ connectionId: ID })
    expect(driver.created).toHaveLength(1)
    expect(ssh.service.open).toHaveBeenCalledTimes(1)
    expect(service.isConnected(ID)).toBe(true)
  })

  it('lets a failed connect be retried', async () => {
    const { service } = setup([stored()])
    driver.connect.mockImplementationOnce(() =>
      Promise.reject(driverError('MongoServerSelectionError'))
    )

    await expect(service.connect(ID)).rejects.toThrow('MongoServerSelectionError')
    await expect(service.connect(ID)).resolves.toEqual({ connectionId: ID })
    expect(driver.created).toHaveLength(2)
    expect(createdAt(0).close).toHaveBeenCalled()
  })
})

describe('disconnect', () => {
  it('waits for a connect in flight and then closes what it opened', async () => {
    const { service, ssh } = setup([stored({ ssh: SSH })])
    const gate = deferred()
    driver.connect.mockImplementation(() => gate.promise)

    const connecting = service.connect(ID)
    await vi.waitFor(() => expect(driver.created).toHaveLength(1))
    let disconnected = false
    const disconnecting = service.disconnect(ID).then(() => {
      disconnected = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(disconnected).toBe(false)

    gate.resolve()
    await connecting
    await disconnecting

    expect(service.isConnected(ID)).toBe(false)
    expect(createdAt(0).close).toHaveBeenCalled()
    expect(openedAt(ssh.opened, 0).tunnel.close).toHaveBeenCalled()
  })

  it('aborts a Cloudflare sign-in in flight instead of waiting for it', async () => {
    const { service, cloudflared } = setup([
      stored({ cloudflared: { ...CLOUDFLARED, authMethod: 'browser' } })
    ])
    cloudflared.service.open.mockImplementationOnce(
      (_config: unknown, _onDropped: unknown, signal?: AbortSignal) =>
        new Promise<Tunnel>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('sign-in cancelled'), { name: 'CancelledError' }))
          )
        })
    )

    const connecting = service.connect(ID).catch((e: unknown) => e)
    await vi.waitFor(() => expect(cloudflared.service.open).toHaveBeenCalled())
    await service.disconnect(ID)

    expect(((await connecting) as Error).name).toBe('CancelledError')
    expect(service.isConnected(ID)).toBe(false)
    expect(driver.created).toHaveLength(0)
  })

  it('still returns when the connect in flight fails', async () => {
    const { service } = setup([stored()])
    const gate = deferred()
    driver.connect.mockImplementation(() => gate.promise)

    const connecting = service.connect(ID).catch((e: unknown) => e)
    await vi.waitFor(() => expect(driver.created).toHaveLength(1))
    const disconnecting = service.disconnect(ID)
    gate.reject(driverError('MongoServerSelectionError'))

    await disconnecting
    expect(await connecting).toBeInstanceOf(Error)
    expect(service.isConnected(ID)).toBe(false)
  })
})

describe('tunnel drops', () => {
  it('closes the connection when its own tunnel dies', async () => {
    const { service, ssh, onDropped } = setup([stored({ ssh: SSH })])
    await service.connect(ID)

    openedAt(ssh.opened, 0).onDropped?.('the SSH connection closed')

    expect(service.isConnected(ID)).toBe(false)
    expect(createdAt(0).close).toHaveBeenCalled()
    expect(onDropped).toHaveBeenCalledWith(ID, 'the SSH connection closed')
  })

  it('ignores the death of a tunnel that belonged to an earlier connection', async () => {
    const { service, ssh, onDropped } = setup([stored({ ssh: SSH })])
    await service.connect(ID)
    await service.disconnect(ID)
    await service.connect(ID)

    openedAt(ssh.opened, 0).onDropped?.('stale tunnel died')

    expect(service.isConnected(ID)).toBe(true)
    expect(createdAt(1).close).not.toHaveBeenCalled()
    expect(onDropped).not.toHaveBeenCalled()
  })
})

describe('Cloudflare tunnel', () => {
  it('points the driver at the tunnel port with the stored secret decrypted', async () => {
    const { service, ssh, cloudflared } = setup(
      [
        stored({
          uri: 'mongodb://alice:%3CMONGOBENCH_PWD%3E@Mongo.Example.com:27017/admin?tls=true',
          username: 'alice',
          encryptedPassword: 'enc:pw',
          cloudflared: CLOUDFLARED
        })
      ],
      { password: 'mongo-pw' }
    )

    await service.connect(ID)

    expect(cloudflared.service.open).toHaveBeenCalledWith(
      {
        hostname: 'mongo.example.com',
        authMethod: 'serviceToken',
        serviceTokenId: 'abc.access',
        serviceTokenSecret: STORED_SECRET
      },
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(ssh.service.open).not.toHaveBeenCalled()
    const client = createdAt(0)
    expect(client.uri).toBe('mongodb://alice:mongo-pw@127.0.0.1:5001/admin?tls=true')
    expect(client.options).toMatchObject({
      directConnection: true,
      servername: 'mongo.example.com'
    })
  })

  it('leaves a switched-off Cloudflare section alone', async () => {
    const { service, cloudflared } = setup([
      stored({ cloudflared: { ...CLOUDFLARED, enabled: false } })
    ])
    await service.connect(ID)
    expect(cloudflared.service.open).not.toHaveBeenCalled()
    expect(createdAt(0).uri).toBe('mongodb://db.example.com:27017/admin')
  })

  it('refuses a stored connection with both tunnels switched on', async () => {
    const { service, ssh, cloudflared } = setup([stored({ ssh: SSH, cloudflared: CLOUDFLARED })])

    const error = await service.connect(ID).catch((e: unknown) => e)
    expect((error as Error).name).toBe('ValidationError')
    expect(ssh.service.open).not.toHaveBeenCalled()
    expect(cloudflared.service.open).not.toHaveBeenCalled()
  })

  it("reports the tunnel's own error instead of a driver timeout", async () => {
    const { service, cloudflared } = setup([stored({ cloudflared: CLOUDFLARED })])
    const reason = Object.assign(new Error('Cloudflare tunnel failed: bad handshake!'), {
      name: 'CloudflaredTunnelError'
    })
    cloudflared.service.open.mockImplementationOnce(() =>
      Promise.resolve({
        route: LOCAL_ROUTE,
        pinnedHostKey: null,
        failure: () => reason,
        close: vi.fn(() => Promise.resolve())
      })
    )
    driver.connect.mockImplementation(() =>
      Promise.reject(driverError('MongoServerSelectionError'))
    )

    await expect(service.connect(ID)).rejects.toBe(reason)
    expect(createdAt(0).close).toHaveBeenCalled()
  })

  it('never hides a MongoDB authentication error behind the tunnel', async () => {
    const { service, cloudflared } = setup([stored({ cloudflared: CLOUDFLARED })])
    cloudflared.service.open.mockImplementationOnce(() =>
      Promise.resolve({
        route: LOCAL_ROUTE,
        pinnedHostKey: null,
        failure: () => new Error('tunnel trouble'),
        close: vi.fn(() => Promise.resolve())
      })
    )
    const authError = driverError('MongoAuthenticationError')
    driver.connect.mockImplementation(() => Promise.reject(authError))

    await expect(service.connect(ID)).rejects.toBe(authError)
  })
})

describe('test', () => {
  const input: ConnectionInput = {
    name: 'Production',
    uri: 'mongodb://localhost/admin',
    cloudflared: {
      enabled: true,
      hostname: 'mongo.example.com',
      authMethod: 'serviceToken',
      serviceTokenId: 'abc.access',
      serviceTokenSecret: ''
    }
  }

  it('runs through a Cloudflare tunnel, using the saved secret when the form left it blank', async () => {
    const { service, cloudflared } = setup([stored({ cloudflared: CLOUDFLARED })])

    const result = await service.test(input, ID)

    expect(result).toMatchObject({ ok: true, serverVersion: '8.0.4' })
    expect(cloudflared.service.open).toHaveBeenCalledWith({
      hostname: 'mongo.example.com',
      authMethod: 'serviceToken',
      serviceTokenId: 'abc.access',
      serviceTokenSecret: STORED_SECRET
    })
    expect(createdAt(0).uri).toBe('mongodb://127.0.0.1:5001/admin')
    expect(openedAt(cloudflared.opened, 0).tunnel.close).toHaveBeenCalled()
    expect(createdAt(0).close).toHaveBeenCalled()
  })

  it.each([
    ['another hostname', { hostname: 'other-app.attacker.invalid' }],
    ['another client ID', { serviceTokenId: 'other.access' }]
  ])('never sends the saved secret to %s', async (_case, edit) => {
    const { service, cloudflared } = setup([stored({ cloudflared: CLOUDFLARED })])
    const edited = { ...input, cloudflared: { ...input.cloudflared!, ...edit } }

    await service.test(edited, ID)

    const opened = openedAt(cloudflared.opened, 0).config as Record<string, unknown>
    expect(opened).toMatchObject(edit)
    expect(opened).not.toHaveProperty('serviceTokenSecret')
  })

  it('closes the tunnel when the connection string cannot go through it', async () => {
    const { service, cloudflared } = setup([])

    await expect(
      service.test({ ...input, uri: 'mongodb+srv://cluster.example.com/admin' })
    ).rejects.toThrow('mongodb+srv://')
    expect(openedAt(cloudflared.opened, 0).tunnel.close).toHaveBeenCalled()
  })
})

describe('closeAll', () => {
  it('closes the connections, then sweeps both tunnel services', async () => {
    const { service, ssh, cloudflared } = setup([stored()])
    await service.connect(ID)

    await service.closeAll()

    expect(service.isConnected(ID)).toBe(false)
    expect(createdAt(0).close).toHaveBeenCalled()
    expect(ssh.service.closeAll).toHaveBeenCalled()
    expect(cloudflared.service.closeAll).toHaveBeenCalled()
  })
})
