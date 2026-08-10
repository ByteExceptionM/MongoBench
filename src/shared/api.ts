import type {
  AggregateRequest,
  AggregateResponse,
  CollectionInfo,
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
  DatabaseUser,
  DeleteManyRequest,
  DeleteManyResponse,
  DeleteOneRequest,
  DeleteOneResponse,
  DropIndexPayload,
  DropUserPayload,
  FindRequest,
  FindResponse,
  IndexInfo,
  InsertManyRequest,
  InsertManyResponse,
  InsertOneRequest,
  InsertOneResponse,
  RenameCollectionPayload,
  ReplaceOneRequest,
  ReplaceOneResponse,
  ServerStats,
  UpdateUserPayload
} from './types'
import type { ConnectionDropped, UpdateCheckResult, UpdateProgress } from './events'
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

  dialog: {
    /** Absolute path, or null when the user cancelled. */
    pickPrivateKey: () => Promise<Result<string | null>>
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
  }

  users: {
    list: (payload: { connectionId: string; db: string }) => Promise<Result<DatabaseUser[]>>
    create: (payload: CreateUserPayload) => Promise<Result<void>>
    update: (payload: UpdateUserPayload) => Promise<Result<void>>
    drop: (payload: DropUserPayload) => Promise<Result<void>>
  }

  indexes: {
    list: (payload: {
      connectionId: string
      db: string
      coll: string
    }) => Promise<Result<IndexInfo[]>>
    create: (payload: CreateIndexPayload) => Promise<Result<{ name: string }>>
    drop: (payload: DropIndexPayload) => Promise<Result<void>>
  }

  /** `onProgress` is the only member that is a push subscription, not a request. */
  updater: {
    check: () => Promise<Result<UpdateCheckResult>>
    download: () => Promise<Result<void>>
    install: () => Promise<Result<void>>
    onProgress: (listener: (progress: UpdateProgress) => void) => () => void
  }
}
