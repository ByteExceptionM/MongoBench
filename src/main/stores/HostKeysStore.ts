import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fingerprint } from '../lib/knownHosts'

const FILE_NAME = 'ssh-host-keys.json'
const FILE_VERSION = 1

export type PinnedHostKey = {
  /** Raw public key blob, base64. */
  key: string
  fingerprint: string
  pinnedAt: string
}

type FileShape = {
  version: number
  hosts: Record<string, PinnedHostKey>
}

/**
 * Trust-on-first-use store for SSH host keys, consulted only for hosts the
 * user's own `~/.ssh/known_hosts` says nothing about. Recording the first key
 * is what turns the tunnel from "encrypted to whoever answers" into "encrypted
 * to the same server as last time".
 *
 * Its own file, not part of connections.json: trust belongs to a host, and
 * several connections may share one SSH server.
 */
export class HostKeysStore {
  private readonly filePath: string
  private cache: Record<string, PinnedHostKey> | null = null

  constructor(userDataPath?: string) {
    this.filePath = join(userDataPath ?? app.getPath('userData'), FILE_NAME)
  }

  async get(host: string, port: number): Promise<Buffer | null> {
    const hosts = await this.load()
    const pinned = hosts[hostKey(host, port)]
    return pinned === undefined ? null : Buffer.from(pinned.key, 'base64')
  }

  async pin(host: string, port: number, key: Buffer): Promise<void> {
    const hosts = await this.load()
    hosts[hostKey(host, port)] = {
      key: key.toString('base64'),
      // Not read back — it is here so the file can be eyeballed.
      fingerprint: fingerprint(key),
      pinnedAt: new Date().toISOString()
    }
    await this.save(hosts)
  }

  private async load(): Promise<Record<string, PinnedHostKey>> {
    if (this.cache !== null) return this.cache
    try {
      const data = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(data) as FileShape
      this.cache = typeof parsed.hosts === 'object' && parsed.hosts !== null ? parsed.hosts : {}
      return this.cache
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {}
        return this.cache
      }
      throw error
    }
  }

  private async save(hosts: Record<string, PinnedHostKey>): Promise<void> {
    this.cache = hosts
    const tmpPath = `${this.filePath}.tmp`
    const payload: FileShape = { version: FILE_VERSION, hosts }
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(tmpPath, this.filePath)
  }
}

function hostKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`
}
