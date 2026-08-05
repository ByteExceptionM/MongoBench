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
  | 'primary'
  | 'primaryPreferred'
  | 'secondary'
  | 'secondaryPreferred'
  | 'nearest'

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

export type ConnectionTestResult = {
  ok: boolean
  latencyMs: number
  serverVersion?: string
  message?: string
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
  customData?: Record<string, unknown>
  mechanisms?: string[]
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
 * - `id`: the document's `_id` in canonical-EJSON string form — stable
 *   identity for row keys and write preconditions.
 * - `hash`: sha-256 over `canonical`. Used for optimistic concurrency on
 *   replace / delete.
 */
export type DocumentEnvelope = {
  id: string
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

/**
 * Filter based write, issued by the shell surface. The id based
 * `replaceOne` / `deleteOne` / `deleteMany` requests above stay reserved
 * for the document table, which knows the exact documents it touches.
 */
export type UpdateByFilterRequest = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON string of the filter. */
  filter: string
  /** Canonical-EJSON string of the update document (must use operators). */
  update: string
  /** false = updateOne, true = updateMany. */
  many: boolean
  upsert: boolean
}

export type UpdateByFilterResponse = {
  matched: number
  modified: number
  upsertedId: string | null
}

export type DeleteByFilterRequest = {
  connectionId: string
  db: string
  coll: string
  filter: string
  /** false = deleteOne, true = deleteMany. */
  many: boolean
}

export type DeleteByFilterResponse = {
  deletedCount: number
}

export type ReplaceByFilterRequest = {
  connectionId: string
  db: string
  coll: string
  filter: string
  /** Canonical-EJSON string of the replacement document. */
  replacement: string
  upsert: boolean
}

export type ReplaceByFilterResponse = {
  matched: number
  modified: number
  upsertedId: string | null
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
}

export type FindResponse = {
  documents: DocumentEnvelope[]
  tookMs: number
}

export type AggregateRequest = {
  connectionId: string
  db: string
  coll: string
  /** Canonical-EJSON string of the pipeline (an array of stage objects). */
  pipeline: string
}

export type AggregateResponse = {
  documents: DocumentEnvelope[]
  tookMs: number
}

export type CountRequest = {
  connectionId: string
  db: string
  coll: string
  filter?: string
}

export type CountResponse = {
  count: number
  estimated: boolean
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
  partialFilterExpression?: Record<string, unknown>
  collation?: Record<string, unknown>
  hidden?: boolean
  background?: boolean
  /** text index — per-field weight overrides. */
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
  /** wildcard index — projection of paths to include/exclude. */
  wildcardProjection?: Record<string, unknown>
  /** Bytes on disk; populated from collStats's `indexSizes`. */
  size?: number
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
