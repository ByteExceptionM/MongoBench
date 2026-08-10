/**
 * A loopback-bound SOCKS5 proxy — just enough of RFC 1928 for the MongoDB
 * driver, the only client that ever talks to it.
 *
 * The outbound leg is not opened here: the requested host and port go to the
 * injected `connect` callback, and the host string is passed through
 * unresolved. That is what lets the far side of an SSH tunnel resolve names
 * that only exist there.
 *
 * Username/password auth (RFC 1929) is mandatory — the port is loopback-only,
 * but every local process can still reach it, and this is a hole into a
 * remote network.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

const VERSION = 0x05
const AUTH_VERSION = 0x01
const METHOD_USERNAME_PASSWORD = 0x02
const METHOD_NONE_ACCEPTABLE = 0xff
const AUTH_FAILURE = 0x01
const CMD_CONNECT = 0x01

const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

const REPLY_SUCCESS = 0x00
const REPLY_GENERAL_FAILURE = 0x01
const REPLY_CONNECTION_REFUSED = 0x05
const REPLY_COMMAND_NOT_SUPPORTED = 0x07
const REPLY_ADDRESS_NOT_SUPPORTED = 0x08

const LOOPBACK = '127.0.0.1'
const HANDSHAKE_TIMEOUT_MS = 15_000

export type Socks5Options = {
  /** Opens the outbound leg. An unresolved `host` stays unresolved. */
  connect: (host: string, port: number) => Promise<Duplex>
  username: string
  password: string
  /** Handshake and forwarding failures, for logging. */
  onError?: (error: Error) => void
}

export type Socks5Server = {
  /** Ephemeral port on 127.0.0.1. */
  port: number
  /** Closes the listener and destroys every connection still open on it. */
  close: () => Promise<void>
}

/** Carries the SOCKS reply code to send before hanging up. */
class Socks5ProtocolError extends Error {
  readonly reply: number

  constructor(message: string, reply: number) {
    super(message)
    this.name = 'Socks5ProtocolError'
    this.reply = reply
  }
}

/**
 * Reads exactly `need` bytes. The socket never enters flowing mode, so
 * anything pipelined behind the handshake stays buffered for the later
 * `pipe()`.
 */
function readBytes(socket: Socket, need: number): Promise<Buffer> {
  if (need === 0) return Promise.resolve(Buffer.alloc(0))
  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeListener('readable', onReadable)
      socket.removeListener('end', onEnd)
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onReadable = (): void => {
      const chunk: Buffer | null = socket.read(need)
      if (chunk === null) return
      cleanup()
      resolve(chunk)
    }
    const onEnd = (): void => fail(new Error('client closed the connection mid-handshake'))
    const onError = (error: Error): void => fail(error)
    const onTimeout = (): void => fail(new Error('SOCKS5 handshake timed out'))

    socket.on('readable', onReadable)
    socket.once('end', onEnd)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    onReadable()
  })
}

/**
 * Constant-time compare. timingSafeEqual throws on a length mismatch, so the
 * length is checked first — which reveals nothing, since both credentials are
 * fixed-length random hex the caller generated itself.
 */
function secretMatches(received: Buffer, expected: string): boolean {
  const want = Buffer.from(expected, 'utf8')
  return received.length === want.length && timingSafeEqual(received, want)
}

async function readAddress(socket: Socket, addressType: number): Promise<string> {
  if (addressType === ATYP_IPV4) {
    return [...(await readBytes(socket, 4))].join('.')
  }
  if (addressType === ATYP_DOMAIN) {
    const length = (await readBytes(socket, 1)).readUInt8(0)
    if (length === 0) {
      throw new Socks5ProtocolError('empty destination hostname', REPLY_ADDRESS_NOT_SUPPORTED)
    }
    return (await readBytes(socket, length)).toString('utf8')
  }
  if (addressType === ATYP_IPV6) {
    const raw = await readBytes(socket, 16)
    const groups: string[] = []
    for (let offset = 0; offset < raw.length; offset += 2) {
      groups.push(raw.readUInt16BE(offset).toString(16))
    }
    return groups.join(':')
  }
  throw new Socks5ProtocolError(
    `unsupported address type 0x${addressType.toString(16)}`,
    REPLY_ADDRESS_NOT_SUPPORTED
  )
}

/** Greeting → authentication → CONNECT request. */
async function negotiate(
  socket: Socket,
  options: Socks5Options
): Promise<{ host: string; port: number }> {
  const greeting = await readBytes(socket, 2)
  if (greeting.readUInt8(0) !== VERSION) {
    throw new Socks5ProtocolError(
      `unsupported SOCKS version 0x${greeting.readUInt8(0).toString(16)}`,
      REPLY_GENERAL_FAILURE
    )
  }
  const methods = await readBytes(socket, greeting.readUInt8(1))
  if (!methods.includes(METHOD_USERNAME_PASSWORD)) {
    socket.end(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]))
    throw new Socks5ProtocolError(
      'client did not offer username/password authentication',
      REPLY_GENERAL_FAILURE
    )
  }
  socket.write(Buffer.from([VERSION, METHOD_USERNAME_PASSWORD]))

  const authHeader = await readBytes(socket, 2)
  if (authHeader.readUInt8(0) !== AUTH_VERSION) {
    throw new Socks5ProtocolError(
      'unsupported authentication subnegotiation version',
      REPLY_GENERAL_FAILURE
    )
  }
  const username = await readBytes(socket, authHeader.readUInt8(1))
  const passwordLength = (await readBytes(socket, 1)).readUInt8(0)
  const password = await readBytes(socket, passwordLength)
  if (!secretMatches(username, options.username) || !secretMatches(password, options.password)) {
    socket.end(Buffer.from([AUTH_VERSION, AUTH_FAILURE]))
    throw new Socks5ProtocolError('rejected SOCKS5 credentials', REPLY_GENERAL_FAILURE)
  }
  socket.write(Buffer.from([AUTH_VERSION, REPLY_SUCCESS]))

  const request = await readBytes(socket, 4)
  if (request.readUInt8(0) !== VERSION) {
    throw new Socks5ProtocolError('malformed SOCKS5 request', REPLY_GENERAL_FAILURE)
  }
  if (request.readUInt8(1) !== CMD_CONNECT) {
    throw new Socks5ProtocolError('only CONNECT is supported', REPLY_COMMAND_NOT_SUPPORTED)
  }
  const host = await readAddress(socket, request.readUInt8(3))
  const port = (await readBytes(socket, 2)).readUInt16BE(0)
  return { host, port }
}

/** BND.ADDR / BND.PORT stay zero — meaningless for CONNECT, ignored by clients. */
function replyFrame(code: number): Buffer {
  return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

function handleClient(socket: Socket, options: Socks5Options): void {
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS)
  // Kept for the whole life of the socket: an unhandled 'error' on a bare
  // net.Socket takes the process down, and the handshake's own listeners are
  // removed after each read.
  socket.on('error', (error) => options.onError?.(error))
  negotiate(socket, options)
    .then(async ({ host, port }) => {
      let remote: Duplex
      try {
        remote = await options.connect(host, port)
      } catch (cause) {
        socket.end(replyFrame(REPLY_CONNECTION_REFUSED))
        throw new Error(`failed to forward to ${host}:${port}`, { cause })
      }
      // The driver drives its own idle timeouts from here on.
      socket.setTimeout(0)
      socket.write(replyFrame(REPLY_SUCCESS))

      remote.on('error', () => socket.destroy())
      socket.once('close', () => remote.destroy())
      remote.once('close', () => socket.destroy())
      socket.pipe(remote)
      remote.pipe(socket)
    })
    .catch((error: unknown) => {
      if (error instanceof Socks5ProtocolError && !socket.writableEnded) {
        socket.end(replyFrame(error.reply))
      }
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
      if (!socket.writableEnded) socket.destroy()
    })
}

export function createSocks5Server(options: Socks5Options): Promise<Socks5Server> {
  const live = new Set<Socket>()
  const server = createServer((socket) => {
    live.add(socket)
    socket.once('close', () => live.delete(socket))
    handleClient(socket, options)
  })

  return new Promise<Socks5Server>((resolve, reject) => {
    const rejectListen = (error: Error): void => reject(error)
    server.once('error', rejectListen)
    server.listen(0, LOOPBACK, () => {
      server.removeListener('error', rejectListen)
      // Past bind, a listener error must not become an unhandled 'error'.
      server.on('error', (error) => options.onError?.(error))

      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('SOCKS5 server did not bind to a TCP port'))
        return
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((closed) => {
            for (const socket of live) socket.destroy()
            live.clear()
            server.close(() => closed())
          })
      })
    })
  })
}
