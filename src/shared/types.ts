/**
 * Domain types shared between main and renderer.
 *
 * Three distinct connection shapes (see design spec §6.1):
 *  - StoredConnection: on-disk shape (lives in connections.json)
 *  - ConnectionConfig: what the renderer sees (no secrets)
 *  - ConnectionInput:  what the renderer sends when creating/editing
 *
 * StoredConnection lives only in the main process; do not import this
 * type into renderer code.
 */

export type AuthMechanism = 'SCRAM-SHA-256' | 'SCRAM-SHA-1' | 'DEFAULT'

export type ReadPreference =
  'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest'

/**
 * Client-side UUID display preference.
 *  - 'default': BSON Binary subType 04 (standard) is rendered as a UUID;
 *    subType 03 (legacy) is rendered as Binary(…).
 *  - 'java': BSON Binary subType 03 is also rendered as a UUID, decoded
 *    using the Java legacy byte order (same as standard).
 *
 * Applied entirely in the renderer; no driver-level option (the v7+ driver
 * removed `uuidRepresentation`).
 */
export type UuidEncoding = 'default' | 'java'

export type SshAuthMethod = 'password' | 'privateKey' | 'agent'

export const DEFAULT_SSH_PORT = 22

/**
 * Tunnel settings, in the same three shapes as the connection itself.
 *
 * Main puts a loopback SOCKS5 proxy in front of the SSH session and hands it
 * to the driver, so every socket the driver opens — including the replica-set
 * members it only learns about during topology discovery — goes through the
 * tunnel and resolves on the SSH server. The URI therefore names the hosts as
 * the SSH server sees them.
 */
export type SshTunnelInput = {
  enabled: boolean
  host: string
  port?: number
  username: string
  authMethod: SshAuthMethod
  /** Only the path is stored, never the key itself. */
  privateKeyPath?: string
  /** Cleartext only in-flight. Blank on edit = keep what is stored. */
  password?: string
  /** Cleartext only in-flight. Blank on edit = keep what is stored. */
  passphrase?: string
}

/** On-disk shape — main process only. */
export type StoredSshTunnel = {
  enabled: boolean
  host: string
  port?: number
  username: string
  authMethod: SshAuthMethod
  privateKeyPath?: string
  /** Base64 of safeStorage.encryptString(cleartext). */
  encryptedPassword?: string
  encryptedPassphrase?: string
}

/** Renderer-facing view — never carries cleartext or ciphertext secrets. */
export type SshTunnelView = {
  enabled: boolean
  host: string
  port?: number
  username: string
  authMethod: SshAuthMethod
  privateKeyPath?: string
  hasStoredPassword: boolean
  hasStoredPassphrase: boolean
}

export type CloudflaredAuthMethod = 'browser' | 'serviceToken'

/** Cloudflare Access tunnel settings; the driver dials only the tunnel's loopback port, never the URI's hosts. */
export type CloudflaredTunnelInput = {
  enabled: boolean
  /** Public hostname of the Access application, e.g. `mongo.example.com`. */
  hostname: string
  authMethod: CloudflaredAuthMethod
  serviceTokenId?: string
  /** Cleartext only in-flight. Blank on edit = keep what is stored, if hostname and client ID are unchanged. */
  serviceTokenSecret?: string
  /** Absent = `cloudflared` from PATH. */
  binaryPath?: string
}

/** On-disk shape — main process only. */
export type StoredCloudflaredTunnel = {
  enabled: boolean
  hostname: string
  authMethod: CloudflaredAuthMethod
  serviceTokenId?: string
  /** Base64 of safeStorage.encryptString(cleartext). */
  encryptedServiceTokenSecret?: string
  binaryPath?: string
}

/** Renderer-facing view — never carries cleartext or ciphertext secrets. */
export type CloudflaredTunnelView = {
  enabled: boolean
  hostname: string
  authMethod: CloudflaredAuthMethod
  serviceTokenId?: string
  binaryPath?: string
  hasStoredServiceTokenSecret: boolean
}

export type AdvancedOptions = {
  directConnection?: boolean
  replicaSet?: string
  readPreference?: ReadPreference
  uuidEncoding?: UuidEncoding
  /** IANA timezone name. Used purely for date *display* — storage stays UTC. */
  timezone?: string
  maxPoolSize?: number
  minPoolSize?: number
  connectTimeoutMS?: number
  socketTimeoutMS?: number
  retryWrites?: boolean
  retryReads?: boolean
}

/** On-disk shape — main process only. */
export type StoredConnection = {
  id: string
  name: string
  /** Connection URI with the password placeholder removed (`<password>` if user/pass present). */
  uri: string
  /** Base64 of safeStorage.encryptString(passwordCleartext). Absent if no password is stored. */
  encryptedPassword?: string
  username?: string
  authSource?: string
  authMechanism?: AuthMechanism
  tls?: boolean
  /** Default 3000 ms. */
  serverSelectionTimeoutMS?: number
  appName?: string
  /** Absent on connections that reach their hosts directly. */
  ssh?: StoredSshTunnel
  /** Absent on connections that reach their hosts directly. */
  cloudflared?: StoredCloudflaredTunnel
  // Advanced driver options
  directConnection?: boolean
  replicaSet?: string
  readPreference?: ReadPreference
  uuidEncoding?: UuidEncoding
  timezone?: string
  /**
   * When true, the explorer only lists databases and collections the
   * authenticated user has *any* privilege on. Default (false) lists
   * everything the server returns — admin / readAnyDatabase users see
   * the full cluster.
   */
  authorizedOnly?: boolean
  maxPoolSize?: number
  minPoolSize?: number
  connectTimeoutMS?: number
  socketTimeoutMS?: number
  retryWrites?: boolean
  retryReads?: boolean
  createdAt: string
  updatedAt: string
}

/** Renderer-facing view — never carries cleartext or ciphertext secrets. */
export type ConnectionConfig = {
  id: string
  name: string
  uri: string
  username?: string
  authSource?: string
  authMechanism?: AuthMechanism
  tls?: boolean
  /** Default 3000 ms. */
  serverSelectionTimeoutMS?: number
  appName?: string
  /** Absent on connections that reach their hosts directly. */
  ssh?: SshTunnelView
  /** Absent on connections that reach their hosts directly. */
  cloudflared?: CloudflaredTunnelView
  directConnection?: boolean
  replicaSet?: string
  readPreference?: ReadPreference
  uuidEncoding?: UuidEncoding
  timezone?: string
  /**
   * When true, the explorer only lists databases and collections the
   * authenticated user has *any* privilege on. Default (false) lists
   * everything the server returns — admin / readAnyDatabase users see
   * the full cluster.
   */
  authorizedOnly?: boolean
  maxPoolSize?: number
  minPoolSize?: number
  connectTimeoutMS?: number
  socketTimeoutMS?: number
  retryWrites?: boolean
  retryReads?: boolean
  createdAt: string
  updatedAt: string
  hasStoredPassword: boolean
}

/** Form payload for create / update. */
export type ConnectionInput = {
  name: string
  uri: string
  username?: string
  /** Cleartext only in-flight; main encrypts immediately and discards. */
  password?: string
  authSource?: string
  authMechanism?: AuthMechanism
  tls?: boolean
  /** Default 3000 ms. */
  serverSelectionTimeoutMS?: number
  appName?: string
  ssh?: SshTunnelInput
  cloudflared?: CloudflaredTunnelInput
  directConnection?: boolean
  replicaSet?: string
  readPreference?: ReadPreference
  uuidEncoding?: UuidEncoding
  timezone?: string
  /**
   * When true, the explorer only lists databases and collections the
   * authenticated user has *any* privilege on. Default (false) lists
   * everything the server returns — admin / readAnyDatabase users see
   * the full cluster.
   */
  authorizedOnly?: boolean
  maxPoolSize?: number
  minPoolSize?: number
  connectTimeoutMS?: number
  socketTimeoutMS?: number
  retryWrites?: boolean
  retryReads?: boolean
}

/**
 * Reported when a host key was seen for the first time and pinned, so the user
 * can check the fingerprint against the server before trusting the tunnel.
 */
export type PinnedHostKeyNotice = {
  host: string
  /** OpenSSH format, e.g. `SHA256:qGZ…`. */
  fingerprint: string
}

export type ConnectionTestResult = {
  ok: boolean
  latencyMs: number
  serverVersion?: string
  message?: string
  pinnedHostKey?: PinnedHostKeyNotice
}

export type ConnectResult = {
  connectionId: string
  pinnedHostKey?: PinnedHostKeyNotice
}

export type DatabaseInfo = {
  name: string
  sizeOnDisk?: number
  empty?: boolean
}

export type CollectionInfo = {
  name: string
  type: 'collection' | 'view'
}

export type CollectionStats = {
  ns: string
  count: number
  /** Logical size of all documents (uncompressed). */
  size: number
  /** On-disk size after compression. */
  storageSize: number
  freeStorageSize: number
  avgObjSize: number
  totalIndexSize: number
  indexSizes: Record<string, number>
  nindexes: number
  capped: boolean
  /** size + totalIndexSize. */
  totalSize: number
  numOrphanDocs?: number
}

export type ServerStats = {
  host: string
  version: string
  uptimeSeconds: number
  process: string
  /** mongod / mongos / atlas, etc. */
  storageEngine?: string
  connections: {
    current: number
    available: number
    totalCreated: number
    active?: number
  }
  opcounters: {
    insert: number
    query: number
    update: number
    delete: number
    getmore: number
    command: number
  }
  network: {
    bytesIn: number
    bytesOut: number
    numRequests: number
  }
  mem: {
    residentMb: number
    virtualMb: number
  }
  cache?: {
    bytesInCache: number
    maxBytesConfigured: number
    pagesRead: number
    pagesRequested: number
  }
  /**
   * Cumulative latency counters since server start (microseconds total + op
   * count). The renderer takes deltas between consecutive samples to get
   * the *recent* per-op average — using the cumulative ratio directly hides
   * any short-term change because it converges to the long-run mean.
   */
  latencies?: {
    reads: { latencyMicros: number; ops: number }
    writes: { latencyMicros: number; ops: number }
    commands: { latencyMicros: number; ops: number }
  }
  /** Cumulative document-level counters since startup. */
  documents: {
    inserted: number
    returned: number
    updated: number
    deleted: number
  }
  asserts: {
    regular: number
    warning: number
    msg: number
    user: number
    rollovers: number
  }
  cursors: {
    open: number
    noTimeout: number
    timedOut: number
  }
  /** WiredTiger concurrent transaction tickets (read/write throttling). */
  concurrent?: {
    read: { available: number; out: number; total: number }
    write: { available: number; out: number; total: number }
  }
  databases: Array<{ name: string; sizeOnDisk: number; empty: boolean }>
  totalSizeOnDisk: number
}

export type RenameCollectionPayload = {
  connectionId: string
  db: string
  coll: string
  newName: string
}

export type DatabaseUserRole = {
  role: string
  db: string
}

export type DatabaseUser = {
  user: string
  db: string
  roles: DatabaseUserRole[]
  /** Relaxed EJSON. */
  customData?: Record<string, unknown>
  mechanisms?: string[]
}

/** A role as reported by `rolesInfo`, built-in roles included. */
export type DatabaseRoleInfo = {
  role: string
  db: string
  isBuiltin: boolean
}

export type CreateUserPayload = {
  connectionId: string
  db: string
  username: string
  password: string
  roles: DatabaseUserRole[]
}

export type UpdateUserPayload = {
  connectionId: string
  db: string
  username: string
  /** null = keep existing password. */
  password: string | null
  /** null = leave roles unchanged. */
  roles: DatabaseUserRole[] | null
}

export type DropUserPayload = {
  connectionId: string
  db: string
  username: string
}

export type ConnectionUpdatePayload = {
  id: string
  patch: ConnectionInput
}

/**
 * Renderer-facing document representation.
 * - `data`: the document in relaxed-EJSON object form (BSON types appear as
 *   `{$oid:…}`/`{$date:…}`/…). Used by the table view.
 * - `canonical`: the document as a canonical-EJSON string (every BSON type
 *   wrapped). Used by the document editor for type-precise round-trips.
 * - `id`: the document's `_id` in canonical-EJSON string form — the write
 *   target for replace / delete. null when the result has no `_id`; only
 *   unique for documents read from a collection, derived rows (aggregation,
 *   distinct) may repeat it.
 * - `hash`: sha-256 over `canonical`. Used for optimistic concurrency on
 *   replace / delete.
 */
export type DocumentEnvelope = {
  id: string | null
  data: Record<string, unknown>
  canonical: string
  hash: string
}

export type ReplaceOneRequest = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON string of the original `_id`. */
  id: string
  /** sha-256 of the document at read time. */
  expectedHash: string
  /** Canonical-EJSON string of the full replacement document. */
  replacement: string
}

export type InsertOneRequest = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON string of the document to insert. */
  document: string
}

export type InsertOneResponse = {
  insertedId: string
}

export type InsertManyRequest = {
  connectionId: string
  db: string
  coll: string
  documents: string[]
}

export type InsertManyResponse = {
  insertedIds: string[]
}

export type DeleteOneRequest = {
  connectionId: string
  db: string
  coll: string
  id: string
  expectedHash: string
}

export type DeleteOneResponse = {
  deletedCount: number
}

/**
 * Bulk delete by document `_id`. Skips the per-document hash check that
 * `deleteOne` performs — bulk delete is reached via an explicit confirm
 * dialog so a stale view between selection and delete is acceptable.
 */
export type DeleteManyRequest = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON strings of each `_id`, mirroring `DocumentEnvelope.id`. */
  ids: string[]
}

export type DeleteManyResponse = {
  deletedCount: number
}

export type ReplaceOneResponse = {
  matched: number
  modified: number
}

export type FindRequest = {
  connectionId: string
  db: string
  coll: string
  filter?: string
  projection?: string
  sort?: string
  skip: number
  /** Omit or pass undefined to fetch all matching documents. */
  limit?: number
  /** Lets `query.cancel` abort this run server-side. */
  requestId?: string
}

export type FindResponse = {
  documents: DocumentEnvelope[]
  tookMs: number
}

/** Max rows an aggregation, shell or distinct run returns; one extra row is fetched to detect truncation. */
export const RESULT_CAP = 1000

/** Max documents one insert request carries. */
export const MAX_INSERT_DOCUMENTS = 10_000

export type AggregateRequest = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON string of the pipeline (an array of stage objects). */
  pipeline: string
  /** Lets `query.cancel` abort this run server-side. */
  requestId?: string
}

export type AggregateResponse = {
  documents: DocumentEnvelope[]
  tookMs: number
  /** More than RESULT_CAP documents came back; only the first RESULT_CAP are included. */
  truncated: boolean
}

export type CountRequest = {
  connectionId: string
  db: string
  coll: string
  filter?: string
  /** Always countDocuments; otherwise an empty filter uses the metadata estimate. */
  exact?: boolean
  /** Lets `query.cancel` abort this run server-side. */
  requestId?: string
}

export type CountResponse = {
  count: number
  estimated: boolean
  tookMs: number
}

export type DistinctRequest = {
  connectionId: string
  db: string
  coll: string
  field: string
  filter?: string
}

/** Distinct values, each wrapped as a `{ value }` document; capped at RESULT_CAP. */
export type DistinctResponse = {
  documents: DocumentEnvelope[]
  tookMs: number
  truncated: boolean
}

export type CancelQueryRequest = {
  requestId: string
}

/** Collection methods that write; also the write methods Shell mode runs. */
export const WRITE_METHODS = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'bulkWrite'
] as const

export type WriteMethod = (typeof WRITE_METHODS)[number]

/**
 * A write Shell mode runs, every value a canonical-EJSON string. `options` is the method's
 * options object; an aggregation write is a pipeline ending in `$out` or `$merge`.
 */
export type WriteOp =
  | { method: 'insertOne'; document: string; options?: string }
  | { method: 'insertMany'; documents: string[]; options?: string }
  | {
      method: 'updateOne' | 'updateMany' | 'findOneAndUpdate'
      filter: string
      /** Update operators document, or an update pipeline array. */
      update: string
      options?: string
    }
  | {
      method: 'replaceOne' | 'findOneAndReplace'
      filter: string
      replacement: string
      options?: string
    }
  | { method: 'deleteOne' | 'deleteMany' | 'findOneAndDelete'; filter: string; options?: string }
  | { method: 'bulkWrite'; operations: string; options?: string }
  | { method: 'aggregate'; pipeline: string }

export type WriteRequest = {
  connectionId: string
  db: string
  coll: string
  op: WriteOp
}

export type WriteResponse = {
  tookMs: number
  /** Counters the server reported for this method; absent ones do not apply to it. */
  counts: {
    inserted?: number
    matched?: number
    modified?: number
    deleted?: number
    upserted?: number
  }
  /** Canonical EJSON of the inserted or upserted `_id`s, at most RESULT_CAP. */
  ids: string[]
  /** More ids existed than `ids` holds. */
  idsTruncated: boolean
  /**
   * findOneAnd*: the returned document, null when nothing matched; absent for other methods.
   * Main decodes it with value promotion (an integral Double may read as Int32): not round-trippable.
   */
  document?: DocumentEnvelope | null
}

/** BSON type of a sampled value; `uuid` / `uuidLegacy` split binData subtypes 04 / 03 out of `binData`. */
export type BsonTypeName =
  | 'double'
  | 'int'
  | 'long'
  | 'decimal'
  | 'string'
  | 'bool'
  | 'date'
  | 'objectId'
  | 'uuid'
  | 'uuidLegacy'
  | 'binData'
  | 'null'
  | 'undefined'
  | 'regex'
  | 'timestamp'
  | 'object'
  | 'array'
  | 'minKey'
  | 'maxKey'
  | 'javascript'
  | 'symbol'
  | 'dbPointer'
  | 'dbRef'

export type TypeCounts = Partial<Record<BsonTypeName, number>>

export type SchemaValue = {
  /** Canonical-EJSON JSON text of the value. */
  ejson: string
  count: number
}

export type SchemaField = {
  /** Dot notation; array elements share their parent's path, keys of a map-like object collapse to `*`. */
  path: string
  /** Sampled documents containing the path at least once. */
  docCount: number
  /** Occurrences per type; an array counts once as `array`, its elements count in `elementTypes`. */
  types: TypeCounts
  elementTypes?: TypeCounts
  /** Most frequent distinct scalar values, by count. */
  values?: SchemaValue[]
  /** More distinct values occurred than `values` holds. */
  valuesTruncated?: boolean
  /** Object whose keys are data (ids, numbers) rather than a fixed set of fields. */
  mapLike?: boolean
}

export type CollectionSchema = {
  /** Number of documents the schema was inferred from. */
  sampleSize: number
  /** Sorted by path. */
  fields: SchemaField[]
  /** The field cap was hit; rarer paths are missing. */
  truncated: boolean
}

export type DatabaseRef = {
  connectionId: string
  db: string
}

export type CollectionRef = {
  connectionId: string
  db: string
  coll: string
}

/** A single field's role inside an index key spec. */
export type IndexKeyDirection = 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed'

/**
 * One index, as reported by `listIndexes`. The `key` object's insertion
 * order matters — it determines compound-index field order.
 */
export type IndexInfo = {
  name: string
  key: Record<string, IndexKeyDirection | string | number>
  v?: number
  unique?: boolean
  sparse?: boolean
  expireAfterSeconds?: number
  /** Relaxed EJSON. */
  partialFilterExpression?: Record<string, unknown>
  /** Relaxed EJSON. */
  collation?: Record<string, unknown>
  hidden?: boolean
  background?: boolean
  /** text index — per-field weight overrides, relaxed EJSON. */
  weights?: Record<string, number>
  /** text index — language used when a doc has no explicit `language`. */
  default_language?: string
  /** text index — name of the per-document field that overrides language. */
  language_override?: string
  textIndexVersion?: number
  '2dsphereIndexVersion'?: number
  /** 2d index — geohash precision. */
  bits?: number
  /** 2d index — coordinate min/max. */
  min?: number
  max?: number
  /** wildcard index — projection of paths to include/exclude, relaxed EJSON. */
  wildcardProjection?: Record<string, unknown>
}

/** Why one source of index statistics could not be read; `message` is the server's text. */
export type IndexStatsUnavailable = {
  reason: 'unauthorized' | 'unsupported' | 'failed'
  message: string
}

/** One mongod's `$indexStats` counters for one index. */
export type IndexUsageSample = {
  /** host:port of the mongod that counted. */
  host: string
  /** Sharded clusters only. */
  shard?: string
  /** User operations that used the index since `since`. */
  ops: number
  /** ISO-8601 instant the counter started (mongod start, index build or collMod). */
  since: string
}

/** Runtime statistics of one index, merged across shards. */
export type IndexRuntimeStats = {
  name: string
  /** Bytes on disk summed across shards; absent when not reported. */
  size?: number
  /** A build is in progress on at least one shard. */
  building: boolean
  /** Empty when usage is unavailable or no mongod reported this index. */
  usage: IndexUsageSample[]
}

/** Result of `indexes:stats`; each source degrades independently. */
export type IndexStatsReport = {
  indexes: IndexRuntimeStats[]
  /** null when `$indexStats` succeeded. */
  usageUnavailable: IndexStatsUnavailable | null
  /** null when `$collStats` storage stats succeeded. */
  storageUnavailable: IndexStatsUnavailable | null
}

export type IndexCreateOptions = {
  name?: string
  unique?: boolean
  sparse?: boolean
  hidden?: boolean
  /** TTL — only meaningful on a single-field date index. */
  expireAfterSeconds?: number
  /** Canonical-EJSON object string. */
  partialFilterExpression?: string
  /** Canonical-EJSON object string. */
  collation?: string
  /** text index — Canonical-EJSON object string mapping field → weight. */
  weights?: string
  /** text index. */
  default_language?: string
  /** text index. */
  language_override?: string
  textIndexVersion?: number
  '2dsphereIndexVersion'?: number
  /** 2d index. */
  bits?: number
  min?: number
  max?: number
  /** wildcard index — Canonical-EJSON object string. */
  wildcardProjection?: string
}

export type CreateIndexPayload = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON object string of the key spec; field order is preserved. */
  keys: string
  options?: IndexCreateOptions
}

export type DropIndexPayload = {
  connectionId: string
  db: string
  coll: string
  name: string
}
