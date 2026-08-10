import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import log from 'electron-log/main'
import { Client, type ConnectConfig } from 'ssh2'
import type { PinnedHostKeyNotice, SshAuthMethod } from '@shared/types'
import {
  findHostKeys,
  fingerprint,
  keyMatches,
  parseKnownHosts,
  type KnownHostEntry
} from '../lib/knownHosts'
import { createSocks5Server, type Socks5Server } from '../lib/socks5'

const READY_TIMEOUT_MS = 15_000
/** Idle sessions get dropped by firewalls and by sshd's own timeouts. */
const KEEPALIVE_INTERVAL_MS = 20_000
const LOOPBACK = '127.0.0.1'

/** Tunnel settings with every secret already decrypted. */
export type ResolvedSshTunnel = {
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  privateKeyPath?: string
  password?: string
  passphrase?: string
}

/** What the driver needs to route through the tunnel. */
export type TunnelProxyOptions = {
  proxyHost: string
  proxyPort: number
  proxyUsername: string
  proxyPassword: string
}

/** An open tunnel. The caller owns it and is responsible for closing it. */
export type Tunnel = {
  proxyOptions: TunnelProxyOptions
  /** Set only when this open pinned a host key it had never seen. */
  pinnedHostKey: PinnedHostKeyNotice | null
  close: () => Promise<void>
}

export class SshConnectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SshConnectError'
  }
}

export class SshAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SshAuthError'
  }
}

export class SshHostKeyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshHostKeyMismatchError'
  }
}

/** The slice of HostKeysStore this service needs. */
export type HostKeyTrustStore = {
  get: (host: string, port: number) => Promise<Buffer | null>
  pin: (host: string, port: number, key: Buffer) => Promise<void>
}

/**
 * Opens SSH sessions with a loopback SOCKS5 proxy in front of each one.
 *
 * A dynamic proxy rather than a fixed port forward, because the driver picks
 * its own hosts: after topology discovery it dials the replica-set members the
 * server named, and those names only resolve on the far side. A SOCKS5 proxy
 * forwards them by name, so every socket the driver opens lands in the tunnel.
 *
 * `open()` returns a handle instead of registering an id — the caller already
 * knows what the tunnel belongs to, and a handle cannot be closed by anyone
 * who does not hold it. The service only tracks what is open so it can close
 * everything at quit.
 */
export class SshTunnelService {
  private readonly active = new Set<Tunnel>()

  constructor(
    private readonly hostKeys: HostKeyTrustStore,
    /** Overridable so tests do not depend on the developer's own file. */
    private readonly knownHostsPath: string = join(homedir(), '.ssh', 'known_hosts')
  ) {}

  get openCount(): number {
    return this.active.size
  }

  /** `onDropped` fires when the session dies on its own, never on `close()`. */
  async open(config: ResolvedSshTunnel, onDropped?: (reason: string) => void): Promise<Tunnel> {
    const auth = await authConfig(config)
    const client = new Client()

    // hostVerifier can only answer yes/no, so the reason is kept here to make
    // the rejection say more than 'Handshake failed'.
    let hostKeyError: Error | null = null
    let pinnedHostKey: PinnedHostKeyNotice | null = null

    // This 'error' listener stays attached after 'ready' wins the race, and
    // deliberately so: an ssh2 client with no 'error' listener takes the
    // process down. Rejecting a settled promise does nothing.
    const ready = new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', (error: Error) => reject(hostKeyError ?? translateSshError(error)))
    })

    try {
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
          this.verifyHostKey(config.host, config.port, key)
            .then((pinned) => {
              pinnedHostKey = pinned
              verify(true)
            })
            .catch((error: unknown) => {
              hostKeyError = error instanceof Error ? error : new Error(String(error))
              verify(false)
            })
        },
        ...auth
      })
      await ready
    } catch (error) {
      client.destroy()
      // connect() also throws synchronously, e.g. for an unparseable key.
      throw asSshError(error)
    }

    const proxyUsername = randomBytes(16).toString('hex')
    const proxyPassword = randomBytes(24).toString('hex')

    let server: Socks5Server
    try {
      server = await createSocks5Server({
        username: proxyUsername,
        password: proxyPassword,
        connect: (host, port) => forwardOut(client, host, port),
        onError: (error) => log.debug(`SOCKS5 proxy: ${error.message}`)
      })
    } catch (error) {
      client.destroy()
      throw error
    }

    let closed = false
    const teardown = async (): Promise<void> => {
      closed = true
      this.active.delete(tunnel)
      await server.close()
    }

    const tunnel: Tunnel = {
      proxyOptions: { proxyHost: LOOPBACK, proxyPort: server.port, proxyUsername, proxyPassword },
      pinnedHostKey,
      close: async () => {
        if (closed) return
        await teardown()
        client.end()
        log.info(`SSH tunnel to ${config.host} closed`)
      }
    }
    this.active.add(tunnel)

    const drop = (reason: string): void => {
      if (closed) return
      void teardown()
      client.destroy()
      log.warn(`SSH tunnel to ${config.host} dropped: ${reason}`)
      onDropped?.(reason)
    }
    client.on('error', (error: Error) => drop(error.message))
    client.on('end', () => drop('the SSH server ended the connection'))
    client.on('close', () => drop('the SSH connection closed'))

    log.info(
      `SSH tunnel up via ${config.username}@${config.host}:${config.port}, SOCKS5 on ${LOOPBACK}:${server.port}`
    )
    return tunnel
  }

  async closeAll(): Promise<void> {
    const tunnels = [...this.active]
    await Promise.allSettled(tunnels.map((tunnel) => tunnel.close()))
  }

  /**
   * Trust order: the user's own known_hosts wins, then our pin store, and only
   * a host neither knows about gets pinned on the spot.
   */
  private async verifyHostKey(
    host: string,
    port: number,
    key: Buffer
  ): Promise<PinnedHostKeyNotice | null> {
    const allowed = findHostKeys(await readKnownHosts(this.knownHostsPath), host, port)
    if (allowed.length > 0) {
      if (allowed.some((known) => keyMatches(key, known))) return null
      throw new SshHostKeyMismatchError(
        `${host} presented host key ${fingerprint(key)}, which is not one of the keys your ~/.ssh/known_hosts lists for it!`
      )
    }

    const pinned = await this.hostKeys.get(host, port)
    if (pinned !== null) {
      if (keyMatches(key, pinned)) return null
      throw new SshHostKeyMismatchError(
        `${host} presented host key ${fingerprint(key)}, which differs from the key MongoBench pinned for it earlier!`
      )
    }

    await this.hostKeys.pin(host, port, key)
    const notice = { host, fingerprint: fingerprint(key) }
    log.warn(`Pinned a previously unseen SSH host key for ${host}:${port} — ${notice.fingerprint}`)
    return notice
  }
}

function forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    // srcIP / srcPort are only reported to the server for logging.
    client.forwardOut(LOOPBACK, 0, host, port, (error, channel) => {
      if (error) reject(error)
      else resolve(channel)
    })
  })
}

async function readKnownHosts(path: string): Promise<KnownHostEntry[]> {
  try {
    return parseKnownHosts(await fs.readFile(path, 'utf8'))
  } catch {
    // No file, no permission — either way there is nothing to compare against.
    return []
  }
}

async function authConfig(config: ResolvedSshTunnel): Promise<ConnectConfig> {
  if (config.authMethod === 'password') {
    if (config.password === undefined || config.password.length === 0) {
      throw new SshAuthError('No SSH password is stored for this connection!')
    }
    return { password: config.password }
  }

  if (config.authMethod === 'privateKey') {
    const path = config.privateKeyPath ?? ''
    if (path.length === 0) throw new SshAuthError('No private key file is configured!')
    let privateKey: Buffer
    try {
      privateKey = await fs.readFile(path)
    } catch (cause) {
      throw new SshAuthError(`Cannot read the private key at ${path}!`, { cause })
    }
    return {
      privateKey,
      ...(config.passphrase !== undefined && config.passphrase.length > 0
        ? { passphrase: config.passphrase }
        : {})
    }
  }

  return { agent: agentAddress() }
}

function agentAddress(): string {
  const fromEnv = process.env['SSH_AUTH_SOCK']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  throw new SshAuthError('No SSH agent found: SSH_AUTH_SOCK is not set!')
}

function asSshError(error: unknown): Error {
  if (
    error instanceof SshAuthError ||
    error instanceof SshConnectError ||
    error instanceof SshHostKeyMismatchError
  ) {
    return error
  }
  return translateSshError(error instanceof Error ? error : new Error(String(error)))
}

/**
 * ssh2 reports everything as a plain Error, so "your credentials are wrong" vs
 * "the server is unreachable" has to be recovered from the message.
 */
function translateSshError(error: Error): Error {
  const message = error.message
  if (
    /authentication methods failed/i.test(message) ||
    /Cannot parse privateKey/i.test(message) ||
    /does not contain a \(valid\) private key/i.test(message) ||
    /no passphrase given/i.test(message) ||
    /bad passphrase/i.test(message)
  ) {
    return new SshAuthError(`SSH authentication failed: ${message}!`, { cause: error })
  }
  return new SshConnectError(`Cannot reach the SSH server: ${message}!`, { cause: error })
}
