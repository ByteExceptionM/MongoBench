import type { MongoClient } from 'mongodb'
import { createSchemaBuilder } from '@shared/collectionSchema'
import type {
  CollectionInfo,
  CollectionSchema,
  CollectionStats,
  DatabaseInfo,
  ServerStats
} from '@shared/types'
import { decodeDocument, toCanonical } from '../lib/ejson'
import { validationError } from '../lib/errorMap'
import { mergeStorageStats } from '../lib/storageStats'
import type { ConnectionService } from './ConnectionService'

const COLLECTION_NAME_RE = /^[^$\0]+$/
const SCHEMA_SAMPLE_SIZE = 200
const SCHEMA_SAMPLE_MAX_TIME_MS = 5_000

type Privilege = {
  resource?: {
    db?: string
    collection?: string
    cluster?: boolean
    anyResource?: boolean
  }
}

/** Metadata + light mutating operations on databases and collections. */
export class DatabaseService {
  constructor(private readonly connections: ConnectionService) {}

  async listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
    const client = this.connections.getClient(connectionId)
    const authOnly = await this.connections.isAuthorizedOnly(connectionId)
    if (!authOnly) {
      const result = (await client.db('admin').admin().listDatabases()) as {
        databases: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }>
      }
      return result.databases
    }

    const [result, allowed] = await Promise.all([
      client.db('admin').admin().listDatabases({ authorizedDatabases: true }) as Promise<{
        databases: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }>
      }>,
      authorizedDatabases(client)
    ])
    if (allowed === 'all') return result.databases
    return result.databases.filter((d) => allowed.has(d.name))
  }

  async listCollections(connectionId: string, db: string): Promise<CollectionInfo[]> {
    const client = this.connections.getClient(connectionId)
    const authOnly = await this.connections.isAuthorizedOnly(connectionId)
    const cursor = client
      .db(db)
      .listCollections({}, { nameOnly: true, authorizedCollections: authOnly })
    const items = await cursor.toArray()
    return items
      .map((info) => ({
        name: info.name as string,
        type: (info.type as 'collection' | 'view' | undefined) ?? 'collection'
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async collectionStats(connectionId: string, db: string, coll: string): Promise<CollectionStats> {
    const collection = this.connections.getClient(connectionId).db(db).collection(coll)
    const cursor = collection.aggregate([{ $collStats: { storageStats: {} } }])
    const docs = await cursor.toArray()
    if (docs.length === 0) {
      const e = new Error(`collStats returned no result for ${db}.${coll}`)
      e.name = 'DocumentNotFoundError'
      throw e
    }
    const merged = mergeStorageStats(docs)
    const ns = merged.ns ?? `${db}.${coll}`
    const s = merged.storage
    // Time-series collections report the storage of their buckets but no document count.
    const count =
      typeof s['count'] === 'number' ? s['count'] : await collection.estimatedDocumentCount()
    const size = numberOr(s['size'], 0)
    return {
      ns,
      count,
      size,
      storageSize: numberOr(s['storageSize'], 0),
      freeStorageSize: numberOr(s['freeStorageSize'], 0),
      avgObjSize: count > 0 ? size / count : 0,
      totalIndexSize: numberOr(s['totalIndexSize'], 0),
      indexSizes: (s['indexSizes'] as Record<string, number>) ?? {},
      nindexes: numberOr(s['nindexes'], 0),
      capped: Boolean(s['capped']),
      totalSize: numberOr(s['totalSize'], 0),
      ...(s['numOrphanDocs'] !== undefined
        ? { numOrphanDocs: numberOr(s['numOrphanDocs'], 0) }
        : {})
    }
  }

  /** Field schema inferred from a random sample of up to 200 documents; empty for an empty collection. */
  async collectionSchema(
    connectionId: string,
    db: string,
    coll: string
  ): Promise<CollectionSchema> {
    const database = this.connections.getClient(connectionId).db(db)
    const [info] = await database
      .listCollections({ name: coll }, { nameOnly: true, authorizedCollections: true })
      .toArray()
    const collection = database.collection(coll)
    const options = { raw: true, maxTimeMS: SCHEMA_SAMPLE_MAX_TIME_MS }
    // $sample on a view runs the whole view pipeline first; a limited find streams.
    const cursor =
      info?.type === 'view'
        ? collection.find<Uint8Array>({}, { ...options, limit: SCHEMA_SAMPLE_SIZE })
        : collection.aggregate<Uint8Array>([{ $sample: { size: SCHEMA_SAMPLE_SIZE } }], options)
    const builder = createSchemaBuilder()
    for await (const bytes of cursor) builder.add(toCanonical(decodeDocument(bytes)))
    return builder.build()
  }

  async dropCollection(connectionId: string, db: string, coll: string): Promise<void> {
    const client = this.connections.getClient(connectionId)
    await client.db(db).collection(coll).drop()
  }

  async createCollection(connectionId: string, db: string, name: string): Promise<void> {
    assertCollectionName(name)
    const client = this.connections.getClient(connectionId)
    await client.db(db).createCollection(name)
  }

  /**
   * MongoDB does not have a "create database" command — a database is
   * materialized by writing to a collection inside it. We accept the
   * first collection name as part of the call so the new DB shows up
   * in `listDatabases()` immediately.
   */
  async createDatabase(connectionId: string, db: string, firstColl: string): Promise<void> {
    assertDatabaseName(db)
    assertCollectionName(firstColl)
    const client = this.connections.getClient(connectionId)
    await client.db(db).createCollection(firstColl)
  }

  async dropDatabase(connectionId: string, db: string): Promise<void> {
    const client = this.connections.getClient(connectionId)
    await client.db(db).dropDatabase()
  }

  async renameCollection(
    connectionId: string,
    db: string,
    coll: string,
    newName: string
  ): Promise<void> {
    if (newName === coll) return
    if (!COLLECTION_NAME_RE.test(newName)) {
      throw validationError('Collection name must not contain $ or null bytes')
    }
    if (newName.startsWith('system.')) {
      throw validationError('Collection name must not start with "system."')
    }
    const client = this.connections.getClient(connectionId)
    await client.db(db).collection(coll).rename(newName)
  }

  async serverStats(connectionId: string): Promise<ServerStats> {
    const client = this.connections.getClient(connectionId)
    const admin = client.db('admin')
    const authOnly = await this.connections.isAuthorizedOnly(connectionId)
    const [status, dbs] = await Promise.all([
      admin.command({ serverStatus: 1 }) as Promise<Record<string, unknown>>,
      admin.admin().listDatabases(authOnly ? { authorizedDatabases: true } : {}) as Promise<{
        databases: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }>
        totalSize?: number
      }>
    ])

    const conn = (status['connections'] ?? {}) as Record<string, unknown>
    const op = (status['opcounters'] ?? {}) as Record<string, unknown>
    const net = (status['network'] ?? {}) as Record<string, unknown>
    const mem = (status['mem'] ?? {}) as Record<string, unknown>
    const wt = status['wiredTiger'] as Record<string, unknown> | undefined
    const wtCache = wt?.['cache'] as Record<string, unknown> | undefined
    const storageEngine = (status['storageEngine'] as Record<string, unknown> | undefined)?.[
      'name'
    ] as string | undefined

    const cache = wtCache
      ? {
          bytesInCache: numberOr(wtCache['bytes currently in the cache'], 0),
          maxBytesConfigured: numberOr(wtCache['maximum bytes configured'], 0),
          pagesRead: numberOr(wtCache['pages read into cache'], 0),
          pagesRequested: numberOr(wtCache['pages requested from the cache'], 0)
        }
      : undefined

    const opLat = status['opLatencies'] as Record<string, unknown> | undefined
    const latencies = opLat
      ? {
          reads: rawLatency(opLat['reads']),
          writes: rawLatency(opLat['writes']),
          commands: rawLatency(opLat['commands'])
        }
      : undefined

    const docMetrics = (status['metrics'] as Record<string, unknown> | undefined)?.['document'] as
      Record<string, unknown> | undefined
    const documents = {
      inserted: numberOr(docMetrics?.['inserted'], 0),
      returned: numberOr(docMetrics?.['returned'], 0),
      updated: numberOr(docMetrics?.['updated'], 0),
      deleted: numberOr(docMetrics?.['deleted'], 0)
    }

    const ass = (status['asserts'] ?? {}) as Record<string, unknown>
    const asserts = {
      regular: numberOr(ass['regular'], 0),
      warning: numberOr(ass['warning'], 0),
      msg: numberOr(ass['msg'], 0),
      user: numberOr(ass['user'], 0),
      rollovers: numberOr(ass['rollovers'], 0)
    }

    const cursorMetrics = (status['metrics'] as Record<string, unknown> | undefined)?.['cursor'] as
      Record<string, unknown> | undefined
    const cursorOpen = cursorMetrics?.['open'] as Record<string, unknown> | undefined
    const cursors = {
      open: numberOr(cursorOpen?.['total'], 0),
      noTimeout: numberOr(cursorOpen?.['noTimeout'], 0),
      timedOut: numberOr(cursorMetrics?.['timedOut'], 0)
    }

    const wtConc = wt?.['concurrentTransactions'] as Record<string, unknown> | undefined
    const concurrent = wtConc
      ? {
          read: tickets(wtConc['read']),
          write: tickets(wtConc['write'])
        }
      : undefined

    const databases = (dbs.databases ?? []).map((d) => ({
      name: d.name,
      sizeOnDisk: numberOr(d.sizeOnDisk, 0),
      empty: Boolean(d.empty)
    }))

    return {
      host: stringOr(status['host'], 'unknown'),
      version: stringOr(status['version'], 'unknown'),
      uptimeSeconds: numberOr(status['uptime'], 0),
      // Some launchers (mongodb-memory-server, custom installs) spawn
      // mongod with a full path as argv[0], which then leaks back through
      // `serverStatus.process`. Reduce to the basename so the dashboard
      // shows `mongod` / `mongos` rather than a filesystem path.
      process: basename(stringOr(status['process'], 'unknown')),
      ...(storageEngine !== undefined ? { storageEngine } : {}),
      connections: {
        current: numberOr(conn['current'], 0),
        available: numberOr(conn['available'], 0),
        totalCreated: numberOr(conn['totalCreated'], 0),
        ...(conn['active'] !== undefined ? { active: numberOr(conn['active'], 0) } : {})
      },
      opcounters: {
        insert: numberOr(op['insert'], 0),
        query: numberOr(op['query'], 0),
        update: numberOr(op['update'], 0),
        delete: numberOr(op['delete'], 0),
        getmore: numberOr(op['getmore'], 0),
        command: numberOr(op['command'], 0)
      },
      network: {
        bytesIn: numberOr(net['bytesIn'], 0),
        bytesOut: numberOr(net['bytesOut'], 0),
        numRequests: numberOr(net['numRequests'], 0)
      },
      mem: {
        residentMb: numberOr(mem['resident'], 0),
        virtualMb: numberOr(mem['virtual'], 0)
      },
      ...(cache !== undefined ? { cache } : {}),
      ...(latencies !== undefined ? { latencies } : {}),
      documents,
      asserts,
      cursors,
      ...(concurrent !== undefined ? { concurrent } : {}),
      databases,
      totalSizeOnDisk: numberOr(
        dbs.totalSize,
        databases.reduce((s, d) => s + d.sizeOnDisk, 0)
      )
    }
  }
}

/**
 * Returns the set of database names the authenticated user has any privilege on,
 * or 'all' when the user holds an any-database / anyResource privilege (or auth
 * is disabled and no privilege list is reported).
 *
 * Why: `listDatabases({ authorizedDatabases: true })` is ignored server-side for
 * users that hold the `listDatabases` cluster action — they get every DB back.
 * We post-filter using `connectionStatus` so the UI never lists DBs the user
 * cannot actually open.
 */
async function authorizedDatabases(client: MongoClient): Promise<Set<string> | 'all'> {
  try {
    const status = (await client
      .db('admin')
      .command({ connectionStatus: 1, showPrivileges: true })) as {
      authInfo?: {
        authenticatedUsers?: Array<{ user: string; db: string }>
        authenticatedUserPrivileges?: Privilege[]
      }
    }
    const auth = status.authInfo
    if (!auth || (auth.authenticatedUsers ?? []).length === 0) return 'all'
    return databasesFromPrivileges(auth.authenticatedUserPrivileges ?? [])
  } catch {
    return 'all'
  }
}

/** Databases the privileges reach, or 'all'; db '' means every database (*AnyDatabase roles). */
export function databasesFromPrivileges(privs: readonly Privilege[]): Set<string> | 'all' {
  const dbs = new Set<string>()
  for (const p of privs) {
    const r = p.resource
    if (!r) continue
    if (r.anyResource || r.db === '') return 'all'
    if (typeof r.db === 'string') dbs.add(r.db)
  }
  return dbs
}

/**
 * Pull the raw cumulative latency / ops counters out of the
 * `opLatencies.{reads,writes,commands}` block. The renderer derives a
 * *recent* per-op average by diffing consecutive samples — a cumulative
 * ratio computed here would barely move once the server has been up.
 */
function rawLatency(node: unknown): { latencyMicros: number; ops: number } {
  if (typeof node !== 'object' || node === null) return { latencyMicros: 0, ops: 0 }
  const r = node as Record<string, unknown>
  return {
    latencyMicros: numberOr(r['latency'], 0),
    ops: numberOr(r['ops'], 0)
  }
}

function tickets(node: unknown): { available: number; out: number; total: number } {
  if (typeof node !== 'object' || node === null) return { available: 0, out: 0, total: 0 }
  const r = node as Record<string, unknown>
  const available = numberOr(r['available'], 0)
  const out = numberOr(r['out'], 0)
  const total = numberOr(r['totalTickets'], available + out)
  return { available, out, total }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw validationError('Collection name must not contain $ or null bytes')
  }
  if (name.startsWith('system.')) {
    throw validationError('Collection name must not start with "system."')
  }
}

function assertDatabaseName(name: string): void {
  if (name.length === 0 || name.length > 64) {
    throw validationError('Database name must be 1–64 characters')
  }
  if (/[\s/\\."$*<>:|?\0]/.test(name)) {
    throw validationError('Database name contains invalid characters')
  }
}
