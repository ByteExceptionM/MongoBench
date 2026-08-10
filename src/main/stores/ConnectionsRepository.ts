import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ConnectionConfig,
  ConnectionInput,
  SshTunnelInput,
  SshTunnelView,
  StoredConnection,
  StoredSshTunnel
} from '@shared/types'
import { canonicalize, ensurePasswordPlaceholder, parseUri } from '../lib/connectionUri'
import type { SecretsStore } from './SecretsStore'

const FILE_NAME = 'connections.json'
const FILE_VERSION = 1

export class ConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`Connection ${id} not found`)
    this.name = 'ConnectionNotFoundError'
  }
}

type FileShape = {
  version: number
  connections: StoredConnection[]
}

/**
 * Reads / writes connections.json in the user-data folder, applying
 * encryption to the password field via SecretsStore. The repository
 * is the only module allowed to materialize StoredConnection objects.
 */
export class ConnectionsRepository {
  private readonly filePath: string
  private cache: StoredConnection[] | null = null

  constructor(
    private readonly secrets: SecretsStore,
    userDataPath?: string
  ) {
    this.filePath = join(userDataPath ?? app.getPath('userData'), FILE_NAME)
  }

  async list(): Promise<ConnectionConfig[]> {
    const stored = await this.load()
    return stored.map(toRendererView)
  }

  async create(input: ConnectionInput): Promise<ConnectionConfig> {
    const stored = this.fromInput(input)
    const all = await this.load()
    all.push(stored)
    await this.save(all)
    return toRendererView(stored)
  }

  async update(id: string, patch: ConnectionInput): Promise<ConnectionConfig> {
    const all = await this.load()
    const idx = all.findIndex((c) => c.id === id)
    if (idx === -1) throw new ConnectionNotFoundError(id)
    const existing = all[idx]!
    const updated = this.fromInput(patch, existing)
    all[idx] = updated
    await this.save(all)
    return toRendererView(updated)
  }

  async delete(id: string): Promise<void> {
    const all = await this.load()
    const next = all.filter((c) => c.id !== id)
    if (next.length === all.length) throw new ConnectionNotFoundError(id)
    await this.save(next)
  }

  async reorder(ids: string[]): Promise<void> {
    const all = await this.load()
    if (ids.length !== all.length) {
      const e = new Error('Reorder request id count does not match stored connections')
      e.name = 'ValidationError'
      throw e
    }
    const map = new Map(all.map((c) => [c.id, c]))
    const next: StoredConnection[] = []
    for (const id of ids) {
      const c = map.get(id)
      if (!c) throw new ConnectionNotFoundError(id)
      next.push(c)
    }
    await this.save(next)
  }

  async getStored(id: string): Promise<StoredConnection | null> {
    const all = await this.load()
    return all.find((c) => c.id === id) ?? null
  }

  decryptPassword(stored: StoredConnection): string | null {
    if (!stored.encryptedPassword) return null
    return this.secrets.decrypt(stored.encryptedPassword)
  }

  /** The SSH secrets in cleartext. Empty when the connection has none. */
  decryptSsh(stored: StoredConnection): { password?: string; passphrase?: string } {
    const ssh = stored.ssh
    if (ssh === undefined) return {}
    return {
      ...(ssh.encryptedPassword !== undefined
        ? { password: this.secrets.decrypt(ssh.encryptedPassword) }
        : {}),
      ...(ssh.encryptedPassphrase !== undefined
        ? { passphrase: this.secrets.decrypt(ssh.encryptedPassphrase) }
        : {})
    }
  }

  private fromInput(input: ConnectionInput, existing?: StoredConnection): StoredConnection {
    const now = new Date().toISOString()
    const canonical = canonicalize({
      uri: input.uri,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.password !== undefined && input.password.length > 0
        ? { password: input.password }
        : {})
    })

    const ssh = this.sshFromInput(input.ssh, existing?.ssh)
    let encryptedPassword: string | undefined = existing?.encryptedPassword
    let storageUri = canonical.storageUri

    if (canonical.password !== null) {
      encryptedPassword = this.secrets.encrypt(canonical.password)
    } else if (encryptedPassword !== undefined) {
      if (canonical.username === null) {
        // Username got cleared but a password was stored — drop the orphan.
        encryptedPassword = undefined
      } else {
        // Preserve the stored password; make sure the URI has a placeholder
        // for it to be injected back at connect time.
        storageUri = ensurePasswordPlaceholder(storageUri)
      }
    }

    return {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      uri: storageUri,
      ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
      ...(canonical.username !== null ? { username: canonical.username } : {}),
      ...(input.authSource !== undefined ? { authSource: input.authSource } : {}),
      ...(input.authMechanism !== undefined ? { authMechanism: input.authMechanism } : {}),
      ...(input.tls !== undefined ? { tls: input.tls } : {}),
      ...(input.serverSelectionTimeoutMS !== undefined
        ? { serverSelectionTimeoutMS: input.serverSelectionTimeoutMS }
        : {}),
      ...(input.appName !== undefined ? { appName: input.appName } : {}),
      ...(ssh !== undefined ? { ssh } : {}),
      ...(input.directConnection !== undefined ? { directConnection: input.directConnection } : {}),
      ...(input.replicaSet !== undefined ? { replicaSet: input.replicaSet } : {}),
      ...(input.readPreference !== undefined ? { readPreference: input.readPreference } : {}),
      ...(input.uuidEncoding !== undefined ? { uuidEncoding: input.uuidEncoding } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.authorizedOnly !== undefined ? { authorizedOnly: input.authorizedOnly } : {}),
      ...(input.maxPoolSize !== undefined ? { maxPoolSize: input.maxPoolSize } : {}),
      ...(input.minPoolSize !== undefined ? { minPoolSize: input.minPoolSize } : {}),
      ...(input.connectTimeoutMS !== undefined ? { connectTimeoutMS: input.connectTimeoutMS } : {}),
      ...(input.socketTimeoutMS !== undefined ? { socketTimeoutMS: input.socketTimeoutMS } : {}),
      ...(input.retryWrites !== undefined ? { retryWrites: input.retryWrites } : {}),
      ...(input.retryReads !== undefined ? { retryReads: input.retryReads } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  }

  /**
   * Encrypts the SSH secrets, or carries the stored ciphertext over when the
   * form left the field blank — the same "blank means keep" convention the
   * MongoDB password uses.
   *
   * A secret only survives while the auth method it belongs to is still
   * selected, so switching to key auth does not leave a password behind in
   * connections.json that nothing will ever use again.
   */
  private sshFromInput(
    input: SshTunnelInput | undefined,
    existing: StoredSshTunnel | undefined
  ): StoredSshTunnel | undefined {
    if (input === undefined) return undefined

    const carriedPassword =
      input.authMethod === 'password' ? existing?.encryptedPassword : undefined
    const carriedPassphrase =
      input.authMethod === 'privateKey' ? existing?.encryptedPassphrase : undefined

    const encryptedPassword =
      input.password !== undefined && input.password.length > 0
        ? this.secrets.encrypt(input.password)
        : carriedPassword
    const encryptedPassphrase =
      input.passphrase !== undefined && input.passphrase.length > 0
        ? this.secrets.encrypt(input.passphrase)
        : carriedPassphrase

    return {
      enabled: input.enabled,
      host: input.host,
      ...(input.port !== undefined ? { port: input.port } : {}),
      username: input.username,
      authMethod: input.authMethod,
      ...(input.privateKeyPath !== undefined && input.privateKeyPath.length > 0
        ? { privateKeyPath: input.privateKeyPath }
        : {}),
      ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
      ...(encryptedPassphrase !== undefined ? { encryptedPassphrase } : {})
    }
  }

  private async load(): Promise<StoredConnection[]> {
    if (this.cache !== null) return [...this.cache]
    try {
      const data = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(data) as FileShape
      this.cache = Array.isArray(parsed.connections) ? parsed.connections : []
      return [...this.cache]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = []
        return []
      }
      throw error
    }
  }

  private async save(connections: StoredConnection[]): Promise<void> {
    this.cache = connections
    const tmpPath = `${this.filePath}.tmp`
    const payload: FileShape = { version: FILE_VERSION, connections }
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(tmpPath, this.filePath)
  }
}

/**
 * Project a StoredConnection to the renderer-facing view.
 * Strips the encryptedPassword AND the entire URI auth section, so the
 * renderer never sees either the placeholder token or any cleartext.
 * The username remains available as its own field; the renderer can
 * reconstruct a display string from `{uri, username, hasStoredPassword}`.
 * The SSH secrets go the same way, down to `hasStored…` flags.
 *
 * THIS IS THE ONLY PLACE THIS PROJECTION SHOULD HAPPEN.
 */
export function toRendererView(stored: StoredConnection): ConnectionConfig {
  const { encryptedPassword, ssh, ...rest } = stored
  const parts = parseUri(stored.uri)
  const bareUri = `${parts.schemeWithSep}${parts.hostAndRest}`
  return {
    ...rest,
    uri: bareUri,
    ...(ssh !== undefined ? { ssh: toSshView(ssh) } : {}),
    hasStoredPassword: encryptedPassword !== undefined
  }
}

function toSshView(ssh: StoredSshTunnel): SshTunnelView {
  const { encryptedPassword, encryptedPassphrase, ...rest } = ssh
  return {
    ...rest,
    hasStoredPassword: encryptedPassword !== undefined,
    hasStoredPassphrase: encryptedPassphrase !== undefined
  }
}
