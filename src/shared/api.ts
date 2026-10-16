import type {
  AggregateRequest,
  AggregateResponse,
  CancelQueryRequest,
  CollectionInfo,
  CollectionSchema,
  CollectionStats,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  ConnectionUpdatePayload,
  ConnectResult,
  CountRequest,
  CountResponse,
  CreateIndexPayload,
  CreateUserPayload,
  DatabaseInfo,
  DatabaseRoleInfo,
  DatabaseUser,
  DeleteManyRequest,
  DeleteManyResponse,
  DeleteOneRequest,
  DeleteOneResponse,
  DistinctRequest,
  DistinctResponse,
  DropIndexPayload,
  DropUserPayload,
  FindRequest,
  FindResponse,
  IndexInfo,
  IndexStatsReport,
  InsertManyRequest,
  InsertManyResponse,
  InsertOneRequest,
  InsertOneResponse,
  RenameCollectionPayload,
  ReplaceOneRequest,
  ReplaceOneResponse,
  ServerStats,
  UpdateUserPayload,
  WriteRequest,
  WriteResponse
} from './types'
import type {
  CloudflaredLoginPrompt,
  ConnectionDropped,
  UpdateCheckResult,
  UpdateProgress
} from './events'
import type { Result } from './result'

/**
 * The typed surface exposed from the preload script to the renderer
 * via `contextBridge.exposeInMainWorld('api', ...)`.
 *
 * Renderer-side: `window.api` (see src/renderer/src/global.d.ts).
 * Preload-side: implemented in src/preload/index.ts.
 *
 * Keep this file free of Electron / Node imports so it can be
 * consumed by both processes.
 */
export type Api = {
  connections: {
    list: () => Promise<Result<ConnectionConfig[]>>
    create: (input: ConnectionInput) => Promise<Result<ConnectionConfig>>
    update: (payload: ConnectionUpdatePayload) => Promise<Result<ConnectionConfig>>
    delete: (id: string) => Promise<Result<void>>
    test: (input: ConnectionInput, existingId?: string) => Promise<Result<ConnectionTestResult>>
    connect: (id: string) => Promise<Result<ConnectResult>>
    disconnect: (connectionId: string) => Promise<Result<void>>
    reorder: (ids: string[]) => Promise<Result<void>>
    /** Main tore a connection down by itself. Returns an unsubscribe. */
    onDropped: (listener: (payload: ConnectionDropped) => void) => () => void
  }

  cloudflared: {
    /** Version of the cloudflared that would run; omit the path to use PATH. */
    version: (binaryPath?: string) => Promise<Result<string>>
    /** cloudflared waits for (or finished) a browser sign-in. Returns an unsubscribe. */
    onLogin: (listener: (prompt: CloudflaredLoginPrompt) => void) => () => void
  }

  dialog: {
    /** Absolute path, or null when the user cancelled. */
    pickPrivateKey: () => Promise<Result<string | null>>
    /** Absolute path, or null when the user cancelled. */
    pickCloudflared: () => Promise<Result<string | null>>
  }

  databases: {
    list: (connectionId: string) => Promise<Result<DatabaseInfo[]>>
    create: (payload: {
      connectionId: string
      db: string
      firstColl: string
    }) => Promise<Result<void>>
    drop: (payload: { connectionId: string; db: string }) => Promise<Result<void>>
  }

  server: {
    stats: (connectionId: string) => Promise<Result<ServerStats>>
  }

  collections: {
    list: (payload: { connectionId: string; db: string }) => Promise<Result<CollectionInfo[]>>
    stats: (payload: {
      connectionId: string
      db: string
      coll: string
    }) => Promise<Result<CollectionStats>>
    create: (payload: { connectionId: string; db: string; name: string }) => Promise<Result<void>>
    drop: (payload: { connectionId: string; db: string; coll: string }) => Promise<Result<void>>
    rename: (payload: RenameCollectionPayload) => Promise<Result<void>>
    /** Field schema inferred from a random sample of the collection's documents. */
    schema: (payload: {
      connectionId: string
      db: string
      coll: string
    }) => Promise<Result<CollectionSchema>>
  }

  query: {
    find: (request: FindRequest) => Promise<Result<FindResponse>>
    aggregate: (request: AggregateRequest) => Promise<Result<AggregateResponse>>
    count: (request: CountRequest) => Promise<Result<CountResponse>>
    replaceOne: (request: ReplaceOneRequest) => Promise<Result<ReplaceOneResponse>>
    insertOne: (request: InsertOneRequest) => Promise<Result<InsertOneResponse>>
    insertMany: (request: InsertManyRequest) => Promise<Result<InsertManyResponse>>
    deleteOne: (request: DeleteOneRequest) => Promise<Result<DeleteOneResponse>>
    deleteMany: (request: DeleteManyRequest) => Promise<Result<DeleteManyResponse>>
    distinct: (request: DistinctRequest) => Promise<Result<DistinctResponse>>
    /** Aborts a running find / aggregate / count by its requestId; unknown ids are ignored. */
    cancel: (request: CancelQueryRequest) => Promise<Result<void>>
    /** Runs one filter-based write, e.g. from the shell; never retried. */
    write: (request: WriteRequest) => Promise<Result<WriteResponse>>
  }

  users: {
    list: (payload: { connectionId: string; db: string }) => Promise<Result<DatabaseUser[]>>
    create: (payload: CreateUserPayload) => Promise<Result<void>>
    update: (payload: UpdateUserPayload) => Promise<Result<void>>
    drop: (payload: DropUserPayload) => Promise<Result<void>>
  }

  roles: {
    list: (payload: { connectionId: string; db: string }) => Promise<Result<DatabaseRoleInfo[]>>
  }

  indexes: {
    list: (payload: {
      connectionId: string
      db: string
      coll: string
    }) => Promise<Result<IndexInfo[]>>
    create: (payload: CreateIndexPayload) => Promise<Result<{ name: string }>>
    drop: (payload: DropIndexPayload) => Promise<Result<void>>
    stats: (payload: {
      connectionId: string
      db: string
      coll: string
    }) => Promise<Result<IndexStatsReport>>
  }

  /** `onProgress` is the only member that is a push subscription, not a request. */
  updater: {
    check: () => Promise<Result<UpdateCheckResult>>
    download: () => Promise<Result<void>>
    install: () => Promise<Result<void>>
    onProgress: (listener: (progress: UpdateProgress) => void) => () => void
  }
}
