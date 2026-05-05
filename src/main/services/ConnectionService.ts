import { MongoClient, type MongoClientOptions } from 'mongodb'
import log from 'electron-log/main'
import type { ConnectionInput, ConnectionTestResult, StoredConnection } from '@shared/types'
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

const DEFAULT_TIMEOUT = 3000

export class NotConnectedError extends Error {
  constructor(id: string) {
    super(`Connection ${id} is not currently connected`)
    this.name = 'NotConnectedError'
  }
}

/**
 * Holds open MongoClient instances keyed by connection id. Multiple
 * connections may be active concurrently (multi-active model — see
 * design spec §14.1).
 */
export class ConnectionService {
  private clients = new Map<string, MongoClient>()

  constructor(private readonly repo: ConnectionsRepository) {}

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
    const client = new MongoClient(uri, this.optionsFromInput(input))
    const startedAt = Date.now()
    try {
      await client.connect()
      const ping = (await client.db('admin').command({ ping: 1 })) as { ok?: number }
      const buildInfo = (await client.db('admin').command({ buildInfo: 1 })) as {
        version?: string
      }
      return {
        ok: ping.ok === 1,
        latencyMs: Date.now() - startedAt,
        ...(buildInfo.version !== undefined ? { serverVersion: buildInfo.version } : {})
      }
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  async connect(id: string): Promise<{ connectionId: string }> {
    if (this.clients.has(id)) return { connectionId: id }
    const stored = await this.repo.getStored(id)
    if (!stored) throw new ConnectionNotFoundError(id)
    const uri = this.materializeFromStored(stored)
    const client = new MongoClient(uri, this.optionsFromStored(stored))
    await client.connect()
    this.clients.set(id, client)
    log.info(`Connected ${stored.name} (${id})`)
    return { connectionId: id }
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (!client) return
    this.clients.delete(id)
    await client.close()
    log.info(`Disconnected ${id}`)
  }

  async closeAll(): Promise<void> {
    const ids = [...this.clients.keys()]
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
  }

  isConnected(id: string): boolean {
    return this.clients.has(id)
  }

  getClient(id: string): MongoClient {
    const client = this.clients.get(id)
    if (!client) throw new NotConnectedError(id)
    return client
  }

  private async materializeFromInput(input: ConnectionInput, existingId?: string): Promise<string> {
    const formPassword =
      input.password !== undefined && input.password.length > 0 ? input.password : undefined
    let effectivePassword = formPassword
    if (effectivePassword === undefined && existingId !== undefined && !input.clearStoredPassword) {
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
