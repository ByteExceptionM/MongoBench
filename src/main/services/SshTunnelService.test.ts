import { generateKeyPairSync } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SocksClient } from 'socks'
import { Server, utils, type Connection } from 'ssh2'
import type { Tunnel, TunnelProxyOptions } from '../lib/tunnel'

// The service logs through electron-log, which pulls in electron itself.
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))

const { SshAuthError, SshHostKeyMismatchError, SshTunnelService } =
  await import('./SshTunnelService')
const { fingerprint } = await import('../lib/knownHosts')
const { default: log } = await import('electron-log/main')
type SshTunnelServiceType = InstanceType<typeof SshTunnelService>

const USERNAME = 'tunneluser'
const PASSWORD = 'tunnelsecret'
/** Points at nothing, so the developer's own known_hosts never interferes. */
const NO_KNOWN_HOSTS = 'C:\\nonexistent\\mongobench-test\\known_hosts'

let hostKeyPem: string
let ed25519HostKey: string

beforeAll(() => {
  // RSA rather than ed25519: PEM is the format ssh2's server side reads
  // without any conversion.
  hostKeyPem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  }).privateKey
  ed25519HostKey = utils.generateKeyPairSync('ed25519').private
})

/** The public key blob as it goes over the wire, for the pin-store fixtures. */
function hostKeyBlob(privateKey = hostKeyPem): Buffer {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw parsed
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (key === undefined) throw new Error('no key parsed')
  return key.getPublicSSH()
}

type Forwarded = { host: string; port: number }

type Fixture = {
  service: SshTunnelServiceType
  sshPort: number
  forwarded: Forwarded[]
  pinned: Array<{ host: string; port: number }>
  dropped: string[]
  /** Hangs up on every live SSH connection, leaving the listener up. */
  killClients: () => void
  /** Hangs up and stops the listener. */
  stop: () => Promise<void>
}

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.service.closeAll()
  await fixture?.stop()
  fixture = null
})

type FixtureOptions = {
  storedHostKey?: Buffer
  /** Also offer an ed25519 host key, which ssh2 clients prefer by default. */
  withEd25519HostKey?: boolean
  /** known_hosts content for the fixture's port; omitted means no file. */
  knownHosts?: (sshPort: number) => string
  /** Refuse every direct-tcpip channel, as sshd does with AllowTcpForwarding no. */
  refuseForwards?: boolean
}

/**
 * A real in-process SSH server that accepts password auth and echoes back
 * everything sent through a direct-tcpip channel.
 */
async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const forwarded: Forwarded[] = []
  const pinned: Array<{ host: string; port: number }> = []
  const dropped: string[] = []

  const live = new Set<Connection>()

  const hostKeys = options.withEd25519HostKey ? [hostKeyPem, ed25519HostKey] : [hostKeyPem]
  const server = new Server({ hostKeys }, (client: Connection) => {
    live.add(client)
    client.on('close', () => live.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        ctx.accept()
        return
      }
      // Announce password auth so the client does not keep guessing.
      ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        forwarded.push({ host: info.destIP, port: info.destPort })
        if (options.refuseForwards) {
          reject()
          return
        }
        const channel = accept()
        channel.on('data', (chunk: Buffer) => channel.write(chunk))
      })
    })
    // A rejected handshake surfaces as an error here; nothing to do.
    client.on('error', () => undefined)
  })

  const sshPort = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })

  const trustStore = {
    get: () => Promise.resolve(options.storedHostKey ?? null),
    pin: (host: string, port: number) => {
      pinned.push({ host, port })
      return Promise.resolve()
    }
  }

  let knownHostsDir: string | null = null
  let knownHostsPath = NO_KNOWN_HOSTS
  if (options.knownHosts) {
    knownHostsDir = await fs.mkdtemp(join(tmpdir(), 'mongobench-known-hosts-'))
    knownHostsPath = join(knownHostsDir, 'known_hosts')
    await fs.writeFile(knownHostsPath, options.knownHosts(sshPort), 'utf8')
  }

  const service = new SshTunnelService(trustStore, knownHostsPath)

  const killClients = (): void => {
    for (const client of live) client.end()
    live.clear()
  }

  fixture = {
    service,
    sshPort,
    forwarded,
    pinned,
    dropped,
    killClients,
    // close() alone waits for open connections, so hang up first.
    stop: async () => {
      await new Promise<void>((resolve) => {
        killClients()
        server.close(() => resolve())
      })
      if (knownHostsDir !== null) await fs.rm(knownHostsDir, { recursive: true, force: true })
    }
  }
  return fixture
}

function rsaKnownHostsLine(sshPort: number, marker = ''): string {
  return `${marker}[127.0.0.1]:${sshPort} ssh-rsa ${hostKeyBlob().toString('base64')}\n`
}

function passwordConfig(port: number) {
  return {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authMethod: 'password' as const,
    password: PASSWORD
  }
}

function socksProxy(tunnel: Tunnel): TunnelProxyOptions {
  if (tunnel.route.kind !== 'socks5') throw new Error('expected a SOCKS5 route')
  return tunnel.route.proxy
}

function throughProxy(
  tunnel: Tunnel,
  destination: { host: string; port: number },
  timeout?: number
): ReturnType<typeof SocksClient.createConnection> {
  const proxy = socksProxy(tunnel)
  return SocksClient.createConnection({
    proxy: {
      host: proxy.proxyHost,
      port: proxy.proxyPort,
      type: 5,
      userId: proxy.proxyUsername,
      password: proxy.proxyPassword
    },
    command: 'connect',
    destination,
    ...(timeout !== undefined ? { timeout } : {})
  })
}

describe('SshTunnelService', () => {
  it('forwards a hostname destination through the SSH session unresolved', async () => {
    const f = await startFixture()
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    const { socket } = await throughProxy(tunnel, { host: 'mongo2.internal', port: 27017 })

    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      socket.once('error', reject)
      socket.write('hello')
    })
    socket.destroy()

    expect(echoed).toBe('hello')
    // The name reached the SSH server, which is where it gets resolved —
    // this is what makes discovered replica-set members reachable.
    expect(f.forwarded).toEqual([{ host: 'mongo2.internal', port: 27017 }])
  })

  it('logs the SSH reason when the server refuses to forward', async () => {
    const f = await startFixture({ refuseForwards: true })
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    vi.mocked(log.warn).mockClear()

    await expect(throughProxy(tunnel, { host: 'mongo1.internal', port: 27017 })).rejects.toThrow()

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'failed to forward to mongo1.internal:27017: (SSH) Channel open failure'
      )
    )
  })

  it('pins a host key it has never seen and reports it', async () => {
    const f = await startFixture()
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    expect(tunnel.pinnedHostKey).toEqual({
      host: '127.0.0.1',
      fingerprint: fingerprint(hostKeyBlob())
    })
    expect(f.pinned).toEqual([{ host: '127.0.0.1', port: f.sshPort }])
  })

  it('reports nothing when the pinned key already matches', async () => {
    const f = await startFixture({ storedHostKey: hostKeyBlob() })
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    expect(tunnel.pinnedHostKey).toBeNull()
    expect(f.pinned).toEqual([])
  })

  it('refuses a host key that differs from the pinned one', async () => {
    const f = await startFixture({ storedHostKey: Buffer.from('a different key entirely') })
    await expect(f.service.open(passwordConfig(f.sshPort))).rejects.toThrow(SshHostKeyMismatchError)
    expect(f.service.openCount).toBe(0)
  })

  it('negotiates the key type known_hosts lists when the server also has a preferred one', async () => {
    const f = await startFixture({
      withEd25519HostKey: true,
      knownHosts: (sshPort) => rsaKnownHostsLine(sshPort)
    })
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    expect(tunnel.pinnedHostKey).toBeNull()
    expect(f.pinned).toEqual([])
  })

  it('ignores the type of an older pin once known_hosts lists the host', async () => {
    const f = await startFixture({
      withEd25519HostKey: true,
      storedHostKey: hostKeyBlob(ed25519HostKey),
      knownHosts: (sshPort) => rsaKnownHostsLine(sshPort)
    })
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    expect(tunnel.pinnedHostKey).toBeNull()
  })

  it('negotiates the pinned key type when the server gained a preferred one', async () => {
    const f = await startFixture({ withEd25519HostKey: true, storedHostKey: hostKeyBlob() })
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    expect(tunnel.pinnedHostKey).toBeNull()
    expect(f.pinned).toEqual([])
  })

  it('refuses a host key known_hosts marks as revoked instead of pinning it', async () => {
    const f = await startFixture({
      knownHosts: () => `@revoked * ssh-rsa ${hostKeyBlob().toString('base64')}\n`
    })
    const opening = f.service.open(passwordConfig(f.sshPort))
    await expect(opening).rejects.toThrow(SshHostKeyMismatchError)
    await expect(opening).rejects.toThrow(/marks as revoked!$/)
    expect(f.pinned).toEqual([])
    expect(f.service.openCount).toBe(0)
  })

  it('refuses a revoked host key even though it was pinned earlier', async () => {
    const f = await startFixture({
      storedHostKey: hostKeyBlob(),
      knownHosts: (sshPort) => rsaKnownHostsLine(sshPort, '@revoked ')
    })
    await expect(f.service.open(passwordConfig(f.sshPort))).rejects.toThrow(SshHostKeyMismatchError)
  })

  it('reports bad credentials as an auth failure', async () => {
    const f = await startFixture()
    await expect(
      f.service.open({ ...passwordConfig(f.sshPort), password: 'wrong' })
    ).rejects.toThrow(SshAuthError)
    expect(f.service.openCount).toBe(0)
  })

  it('rejects password auth with no stored password before touching the network', async () => {
    const f = await startFixture()
    await expect(f.service.open({ ...passwordConfig(f.sshPort), password: '' })).rejects.toThrow(
      SshAuthError
    )
  })

  it('fails when the private key file does not exist', async () => {
    const f = await startFixture()
    await expect(
      f.service.open({
        host: '127.0.0.1',
        port: f.sshPort,
        username: USERNAME,
        authMethod: 'privateKey',
        privateKeyPath: 'C:\\nonexistent\\mongobench-test\\id_ed25519'
      })
    ).rejects.toThrow(SshAuthError)
  })

  it('closes the proxy along with the tunnel', async () => {
    const f = await startFixture()
    const tunnel = await f.service.open(passwordConfig(f.sshPort))
    expect(f.service.openCount).toBe(1)

    await tunnel.close()
    expect(f.service.openCount).toBe(0)

    await expect(
      throughProxy(tunnel, { host: 'mongo1.internal', port: 27017 }, 2000)
    ).rejects.toThrow()
  })

  it('does not report a drop for a tunnel closed on request', async () => {
    const f = await startFixture()
    const tunnel = await f.service.open(passwordConfig(f.sshPort), (reason) =>
      f.dropped.push(reason)
    )
    await tunnel.close()
    // Give any stray close/end handler a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(f.dropped).toEqual([])
  })

  it('reports a drop when the SSH server hangs up', async () => {
    const f = await startFixture()
    await f.service.open(passwordConfig(f.sshPort), (reason) => f.dropped.push(reason))

    const reported = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (f.dropped.length > 0) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    f.killClients()
    await reported

    expect(f.dropped[0]).toBeTypeOf('string')
    // Cleaned up without a close() call, so a reconnect starts from scratch.
    expect(f.service.openCount).toBe(0)
  })

  it('closeAll closes every open tunnel', async () => {
    const f = await startFixture()
    await f.service.open(passwordConfig(f.sshPort))
    await f.service.open(passwordConfig(f.sshPort))
    expect(f.service.openCount).toBe(2)

    await f.service.closeAll()
    expect(f.service.openCount).toBe(0)
    expect(f.dropped).toEqual([])
  })
})
