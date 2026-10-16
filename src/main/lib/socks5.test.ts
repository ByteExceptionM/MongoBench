import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocksClient } from 'socks'
import { createSocks5Server, type Socks5Server } from './socks5'

const USERNAME = 'proxy-user'
const PASSWORD = 'proxy-pass'

let server: Socks5Server | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

type Requested = { host: string; port: number }

/**
 * Starts a proxy whose outbound leg is a PassThrough — whatever the client
 * writes comes straight back, so a round-trip proves both pipe directions.
 */
async function startProxy(
  requested: Requested[],
  connect?: (host: string, port: number) => Promise<PassThrough>,
  onError?: (error: Error) => void
): Promise<Socks5Server> {
  server = await createSocks5Server({
    username: USERNAME,
    password: PASSWORD,
    connect: (host, port) => {
      requested.push({ host, port })
      return connect ? connect(host, port) : Promise.resolve(new PassThrough())
    },
    onError
  })
  return server
}

/**
 * Sends greeting, credentials and CONNECT in one write and never reads the
 * replies, so the test holds the raw socket while the outbound leg is pending.
 */
async function sendConnectRequest(proxyPort: number, destination: Requested): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port: proxyPort })
  await once(socket, 'connect')
  const host = Buffer.from(destination.host, 'utf8')
  const port = Buffer.alloc(2)
  port.writeUInt16BE(destination.port)
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x02]),
      Buffer.from([0x01, USERNAME.length]),
      Buffer.from(USERNAME, 'utf8'),
      Buffer.from([PASSWORD.length]),
      Buffer.from(PASSWORD, 'utf8'),
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      port
    ])
  )
  return socket
}

function connectThrough(
  proxyPort: number,
  destination: Requested,
  credentials: { userId?: string; password?: string } = { userId: USERNAME, password: PASSWORD }
): Promise<{ socket: Socket }> {
  return SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port: proxyPort, type: 5, ...credentials },
    command: 'connect',
    destination
  })
}

function firstChunk(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    socket.once('error', reject)
  })
}

describe('createSocks5Server', () => {
  it('binds an ephemeral loopback port', async () => {
    const proxy = await startProxy([])
    expect(proxy.port).toBeGreaterThan(0)
  })

  it('pipes payload in both directions after a successful CONNECT', async () => {
    const proxy = await startProxy([])
    const { socket } = await connectThrough(proxy.port, { host: 'mongo1.internal', port: 27017 })
    socket.write('ping')
    await expect(firstChunk(socket)).resolves.toBe('ping')
    socket.destroy()
  })

  it('passes a hostname destination through unresolved', async () => {
    const requested: Requested[] = []
    const proxy = await startProxy(requested)
    const { socket } = await connectThrough(proxy.port, { host: 'mongo2.internal', port: 27018 })
    socket.destroy()
    // The whole replica-set story hangs on this: the name must reach the
    // outbound leg untouched so the far side resolves it.
    expect(requested).toEqual([{ host: 'mongo2.internal', port: 27018 }])
  })

  it('formats an IPv4 destination as a dotted quad', async () => {
    const requested: Requested[] = []
    const proxy = await startProxy(requested)
    const { socket } = await connectThrough(proxy.port, { host: '10.0.0.7', port: 27017 })
    socket.destroy()
    expect(requested).toEqual([{ host: '10.0.0.7', port: 27017 }])
  })

  it('formats an IPv6 destination as colon-separated groups', async () => {
    const requested: Requested[] = []
    const proxy = await startProxy(requested)
    const { socket } = await connectThrough(proxy.port, { host: '::1', port: 27017 })
    socket.destroy()
    expect(requested).toEqual([{ host: '0:0:0:0:0:0:0:1', port: 27017 }])
  })

  it('rejects wrong credentials', async () => {
    const requested: Requested[] = []
    const proxy = await startProxy(requested)
    await expect(
      connectThrough(
        proxy.port,
        { host: 'mongo1.internal', port: 27017 },
        { userId: USERNAME, password: 'wrong' }
      )
    ).rejects.toThrow()
    expect(requested).toEqual([])
  })

  it('rejects a credential of the right length but the wrong content', async () => {
    const requested: Requested[] = []
    const proxy = await startProxy(requested)
    // Same length as PASSWORD, differing in one character — the length check
    // cannot catch this, so it proves the byte comparison does the work.
    expect('proxy-pasS'.length).toBe(PASSWORD.length)
    await expect(
      connectThrough(
        proxy.port,
        { host: 'mongo1.internal', port: 27017 },
        { userId: USERNAME, password: 'proxy-pasS' }
      )
    ).rejects.toThrow()
    await expect(
      connectThrough(
        proxy.port,
        { host: 'mongo1.internal', port: 27017 },
        { userId: 'proxy-useR', password: PASSWORD }
      )
    ).rejects.toThrow()
    expect(requested).toEqual([])
  })

  it('rejects a client that only offers no-auth', async () => {
    const requested: Requested[] = []
    const proxy = await startProxy(requested)
    await expect(
      connectThrough(proxy.port, { host: 'mongo1.internal', port: 27017 }, {})
    ).rejects.toThrow()
    expect(requested).toEqual([])
  })

  it('reports a failed outbound leg to the client', async () => {
    const proxy = await startProxy([], () => Promise.reject(new Error('channel open failed')))
    await expect(
      connectThrough(proxy.port, { host: 'mongo1.internal', port: 27017 })
    ).rejects.toThrow()
  })

  it('reports why the outbound leg could not be opened', async () => {
    const errors: Error[] = []
    const proxy = await startProxy(
      [],
      () => Promise.reject(new Error('(SSH) Channel open failure: administratively prohibited')),
      (error) => errors.push(error)
    )
    await expect(
      connectThrough(proxy.port, { host: 'mongo1.internal', port: 27017 })
    ).rejects.toThrow()
    expect(errors[0]?.message).toBe(
      'failed to forward to mongo1.internal:27017: (SSH) Channel open failure: administratively prohibited'
    )
  })

  it('destroys an outbound leg that opens after the client is gone', async () => {
    let openRemote: (remote: PassThrough) => void = () => undefined
    const pending = new Promise<PassThrough>((resolve) => (openRemote = resolve))
    const requested: Requested[] = []
    const errors: Error[] = []
    const proxy = await startProxy(
      requested,
      () => pending,
      (error) => errors.push(error)
    )

    const client = await sendConnectRequest(proxy.port, { host: 'mongo1.internal', port: 27017 })
    await vi.waitFor(() => expect(requested).toHaveLength(1))
    // A reset, unlike a FIN, leaves no 'end' that piping could pass on to the outbound leg.
    client.resetAndDestroy()
    await vi.waitFor(() => expect(errors).not.toHaveLength(0))

    const remote = new PassThrough()
    openRemote(remote)
    await vi.waitFor(() => expect(remote.destroyed).toBe(true))
  })

  it('destroys live connections on close', async () => {
    const proxy = await startProxy([])
    const { socket } = await connectThrough(proxy.port, { host: 'mongo1.internal', port: 27017 })
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    await proxy.close()
    server = null
    await expect(closed).resolves.toBeUndefined()
  })
})
