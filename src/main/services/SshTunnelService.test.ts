import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SocksClient } from 'socks'
import { Server, utils, type Connection } from 'ssh2'

// The service logs through electron-log, which pulls in electron itself.
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))

const { SshAuthError, SshHostKeyMismatchError, SshTunnelService } =
  await import('./SshTunnelService')
const { fingerprint } = await import('../lib/knownHosts')
type SshTunnelServiceType = InstanceType<typeof SshTunnelService>
type TunnelProxyOptions = Awaited<ReturnType<SshTunnelServiceType['open']>>['proxyOptions']

const USERNAME = 'tunneluser'
const PASSWORD = 'tunnelsecret'
/** Points at nothing, so the developer's own known_hosts never interferes. */
const NO_KNOWN_HOSTS = 'C:\\nonexistent\\mongobench-test\\known_hosts'

let hostKeyPem: string

beforeAll(() => {
  // RSA rather than ed25519: PEM is the format ssh2's server side reads
  // without any conversion.
  hostKeyPem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  }).privateKey
})

/** The public key blob as it goes over the wire, for the pin-store fixtures. */
function hostKeyBlob(): Buffer {
  const parsed = utils.parseKey(hostKeyPem)
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

/**
 * A real in-process SSH server that accepts password auth and echoes back
 * everything sent through a direct-tcpip channel.
 */
async function startFixture(options: { storedHostKey?: Buffer } = {}): Promise<Fixture> {
  const forwarded: Forwarded[] = []
  const pinned: Array<{ host: string; port: number }> = []
  const dropped: string[] = []

  const live = new Set<Connection>()

  const server = new Server({ hostKeys: [hostKeyPem] }, (client: Connection) => {
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
      client.on('tcpip', (accept, _reject, info) => {
        forwarded.push({ host: info.destIP, port: info.destPort })
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

  const service = new SshTunnelService(trustStore, NO_KNOWN_HOSTS)

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
    stop: () =>
      new Promise<void>((resolve) => {
        killClients()
        server.close(() => resolve())
      })
  }
  return fixture
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

function throughProxy(
  tunnel: { proxyOptions: TunnelProxyOptions },
  destination: { host: string; port: number },
  timeout?: number
): ReturnType<typeof SocksClient.createConnection> {
  return SocksClient.createConnection({
    proxy: {
      host: tunnel.proxyOptions.proxyHost,
      port: tunnel.proxyOptions.proxyPort,
      type: 5,
      userId: tunnel.proxyOptions.proxyUsername,
      password: tunnel.proxyOptions.proxyPassword
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
