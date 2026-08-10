import { MongoClient, type MongoClientOptions } from 'mongodb'
import log from 'electron-log/main'
import {
  DEFAULT_SSH_PORT,
  type ConnectionInput,
  type ConnectionTestResult,
  type ConnectResult,
  type StoredSshTunnel,
  type SshTunnelInput,
  type StoredConnection
} from '@shared/types'
import {
  type ConnectionsRepository,
  ConnectionNotFoundError
} from '../stores/ConnectionsRepository'
import {
  canonicalize,
  hasPasswordPlaceholder,
  injectExternalCredentials,
  injectStoredPassword
} from '../lib/connectionUri'
import type { ResolvedSshTunnel, SshTunnelService, Tunnel } from './SshTunnelService'

const DEFAULT_TIMEOUT = 3000

export class NotConnectedError extends Error {
  constructor(id: string) {
    super(`Connection ${id} is not currently connected`)
    this.name = 'NotConnectedError'
  }
}

/** A live connection, plus the tunnel it runs through if it has one. */
type Active = { client: MongoClient; tunnel: Tunnel | null }

/**
 * Holds open MongoClient instances keyed by connection id. Multiple
 * connections may be active concurrently (multi-active model — see
 * design spec §14.1).
 *
 * A tunnel is held next to the client it belongs to, so the two always come
 * and go together.
 */
export class ConnectionService {
  private clients = new Map<string, Active>()

  constructor(
    private readonly repo: ConnectionsRepository,
    private readonly tunnels: SshTunnelService,
    /** Called when main takes a connection down by itself. */
    private readonly onDropped: (connectionId: string, reason: string) => void
  ) {}

  /**
   * Open a temporary client, ping the server, close it. Reports latency
   * and server version. Used by the "Test connection" button before save.
   *
   * When `existingId` is provided and `input.password` is empty, falls back
   * to the password stored on the existing connection — so editing a saved
   * connection without re-entering the password still works.
   */
  async test(input: ConnectionInput, existingId?: string): Promise<ConnectionTestResult> {
    const uri = await this.materializeFromInput(input, existingId)
    // A probe's tunnel is nobody else's: it is closed in the finally below, and
    // its death needs no drop callback — the in-flight ping reports it.
    const tunnel =
      input.ssh?.enabled === true
        ? await this.tunnels.open(await this.resolveSshFromInput(input.ssh, existingId))
        : null

    const startedAt = Date.now()
    let client: MongoClient | null = null
    try {
      // Inside the try: the constructor parses the URI and throws on a bad
      // option, which would otherwise leak the tunnel.
      client = new MongoClient(uri, {
        ...this.optionsFromInput(input),
        ...(tunnel?.proxyOptions ?? {})
      })
      await client.connect()
      const ping = (await client.db('admin').command({ ping: 1 })) as { ok?: number }
      const buildInfo = (await client.db('admin').command({ buildInfo: 1 })) as {
        version?: string
      }
      return {
        ok: ping.ok === 1,
        latencyMs: Date.now() - startedAt,
        ...(buildInfo.version !== undefined ? { serverVersion: buildInfo.version } : {}),
        ...(tunnel?.pinnedHostKey ? { pinnedHostKey: tunnel.pinnedHostKey } : {})
      }
    } finally {
      await client?.close().catch(() => undefined)
      await tunnel?.close().catch(() => undefined)
    }
  }

  async connect(id: string): Promise<ConnectResult> {
    if (this.clients.has(id)) return { connectionId: id }
    const stored = await this.repo.getStored(id)
    if (!stored) throw new ConnectionNotFoundError(id)
    const uri = this.materializeFromStored(stored)

    const ssh = stored.ssh
    const tunnel =
      ssh?.enabled === true
        ? await this.tunnels.open(this.resolveSshFromStored(stored, ssh), (reason) =>
            this.dropConnection(id, reason)
          )
        : null

    let client: MongoClient | null = null
    try {
      client = new MongoClient(uri, {
        ...this.optionsFromStored(stored),
        ...(tunnel?.proxyOptions ?? {})
      })
      await client.connect()
    } catch (error) {
      await client?.close().catch(() => undefined)
      await tunnel?.close().catch(() => undefined)
      throw error
    }
    this.clients.set(id, { client, tunnel })
    log.info(`Connected ${stored.name} (${id})`)
    return {
      connectionId: id,
      ...(tunnel?.pinnedHostKey ? { pinnedHostKey: tunnel.pinnedHostKey } : {})
    }
  }

  async disconnect(id: string): Promise<void> {
    const active = this.clients.get(id)
    if (!active) return
    this.clients.delete(id)
    try {
      await active.client.close()
    } finally {
      await active.tunnel?.close()
    }
    log.info(`Disconnected ${id}`)
  }

  async closeAll(): Promise<void> {
    const ids = [...this.clients.keys()]
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
    // Sweeps anything a failed open left behind.
    await this.tunnels.closeAll()
  }

  isConnected(id: string): boolean {
    return this.clients.has(id)
  }

  getClient(id: string): MongoClient {
    const active = this.clients.get(id)
    if (!active) throw new NotConnectedError(id)
    return active.client
  }

  /** The tunnel died on its own; the client on top of it is finished too. */
  private dropConnection(id: string, reason: string): void {
    const active = this.clients.get(id)
    if (active === undefined) return
    this.clients.delete(id)
    void active.client.close().catch(() => undefined)
    log.warn(`Closed ${id} because its SSH tunnel dropped: ${reason}`)
    this.onDropped(id, reason)
  }

  /**
   * Per-connection toggle: when true, the explorer should only list
   * databases / collections the authenticated user has privileges on.
   * Reads from the in-memory repo cache, so it's effectively sync.
   */
  async isAuthorizedOnly(id: string): Promise<boolean> {
    const stored = await this.repo.getStored(id)
    return stored?.authorizedOnly === true
  }

  private async materializeFromInput(input: ConnectionInput, existingId?: string): Promise<string> {
    let effectivePassword = nonEmpty(input.password)
    if (effectivePassword === undefined && existingId !== undefined) {
      const stored = await this.repo.getStored(existingId)
      if (stored) {
        effectivePassword = this.repo.decryptPassword(stored) ?? undefined
      }
    }
    const canonical = canonicalize({
      uri: input.uri,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(effectivePassword !== undefined ? { password: effectivePassword } : {})
    })
    return canonical.password !== null
      ? injectStoredPassword(canonical.storageUri, canonical.password)
      : canonical.storageUri
  }

  private materializeFromStored(stored: StoredConnection): string {
    const password = this.repo.decryptPassword(stored)
    if (hasPasswordPlaceholder(stored.uri)) {
      if (password === null) {
        throw new Error(
          `Stored connection ${stored.id} has a placeholder but no encrypted password`
        )
      }
      return injectStoredPassword(stored.uri, password)
    }
    if (password !== null && stored.username !== undefined && stored.username.length > 0) {
      // Self-heal: stored URI was saved without the password placeholder
      // (older broken save) but we still have an encrypted password and a
      // username. Build the credentialed URI from scratch.
      return injectExternalCredentials(stored.uri, stored.username, password)
    }
    return stored.uri
  }

  private resolveSshFromStored(stored: StoredConnection, ssh: StoredSshTunnel): ResolvedSshTunnel {
    const secrets = this.repo.decryptSsh(stored)
    return {
      host: ssh.host,
      port: ssh.port ?? DEFAULT_SSH_PORT,
      username: ssh.username,
      authMethod: ssh.authMethod,
      ...(ssh.privateKeyPath !== undefined ? { privateKeyPath: ssh.privateKeyPath } : {}),
      ...(secrets.password !== undefined ? { password: secrets.password } : {}),
      ...(secrets.passphrase !== undefined ? { passphrase: secrets.passphrase } : {})
    }
  }

  /**
   * Same, for the unsaved form payload behind "Test connection". A blank secret
   * falls back to what the edited connection has stored, exactly as
   * materializeFromInput does for the MongoDB password.
   */
  private async resolveSshFromInput(
    input: SshTunnelInput,
    existingId?: string
  ): Promise<ResolvedSshTunnel> {
    let password = nonEmpty(input.password)
    let passphrase = nonEmpty(input.passphrase)
    if ((password === undefined || passphrase === undefined) && existingId !== undefined) {
      const stored = await this.repo.getStored(existingId)
      if (stored) {
        const secrets = this.repo.decryptSsh(stored)
        password ??= secrets.password
        passphrase ??= secrets.passphrase
      }
    }
    const privateKeyPath = nonEmpty(input.privateKeyPath)
    return {
      host: input.host,
      port: input.port ?? DEFAULT_SSH_PORT,
      username: input.username,
      authMethod: input.authMethod,
      ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(passphrase !== undefined ? { passphrase } : {})
    }
  }

  private optionsFromInput(input: ConnectionInput): MongoClientOptions {
    return buildOptions({
      serverSelectionTimeoutMS: input.serverSelectionTimeoutMS,
      appName: input.appName,
      tls: input.tls,
      authSource: input.authSource,
      authMechanism: input.authMechanism,
      directConnection: input.directConnection,
      replicaSet: input.replicaSet,
      readPreference: input.readPreference,
      maxPoolSize: input.maxPoolSize,
      minPoolSize: input.minPoolSize,
      connectTimeoutMS: input.connectTimeoutMS,
      socketTimeoutMS: input.socketTimeoutMS,
      retryWrites: input.retryWrites,
      retryReads: input.retryReads
    })
  }

  private optionsFromStored(stored: StoredConnection): MongoClientOptions {
    return buildOptions({
      serverSelectionTimeoutMS: stored.serverSelectionTimeoutMS,
      appName: stored.appName,
      tls: stored.tls,
      authSource: stored.authSource,
      authMechanism: stored.authMechanism,
      directConnection: stored.directConnection,
      replicaSet: stored.replicaSet,
      readPreference: stored.readPreference,
      maxPoolSize: stored.maxPoolSize,
      minPoolSize: stored.minPoolSize,
      connectTimeoutMS: stored.connectTimeoutMS,
      socketTimeoutMS: stored.socketTimeoutMS,
      retryWrites: stored.retryWrites,
      retryReads: stored.retryReads
    })
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

type DriverInputs = {
  serverSelectionTimeoutMS?: number
  appName?: string
  tls?: boolean
  authSource?: string
  authMechanism?: 'SCRAM-SHA-256' | 'SCRAM-SHA-1' | 'DEFAULT'
  directConnection?: boolean
  replicaSet?: string
  readPreference?: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest'
  maxPoolSize?: number
  minPoolSize?: number
  connectTimeoutMS?: number
  socketTimeoutMS?: number
  retryWrites?: boolean
  retryReads?: boolean
}

function buildOptions(input: DriverInputs): MongoClientOptions {
  const o: MongoClientOptions = {
    serverSelectionTimeoutMS: input.serverSelectionTimeoutMS ?? DEFAULT_TIMEOUT,
    appName: input.appName ?? 'MongoBench'
  }
  if (input.tls !== undefined) o.tls = input.tls
  if (input.authSource !== undefined) o.authSource = input.authSource
  if (input.authMechanism !== undefined && input.authMechanism !== 'DEFAULT') {
    o.authMechanism = input.authMechanism
  }
  if (input.directConnection !== undefined) o.directConnection = input.directConnection
  if (input.replicaSet !== undefined && input.replicaSet.length > 0) {
    o.replicaSet = input.replicaSet
  }
  if (input.readPreference !== undefined) o.readPreference = input.readPreference
  if (input.maxPoolSize !== undefined) o.maxPoolSize = input.maxPoolSize
  if (input.minPoolSize !== undefined) o.minPoolSize = input.minPoolSize
  if (input.connectTimeoutMS !== undefined) o.connectTimeoutMS = input.connectTimeoutMS
  if (input.socketTimeoutMS !== undefined) o.socketTimeoutMS = input.socketTimeoutMS
  if (input.retryWrites !== undefined) o.retryWrites = input.retryWrites
  if (input.retryReads !== undefined) o.retryReads = input.retryReads
  return o
}
