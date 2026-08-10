import type { ConnectionDropped, UpdateCheckResult, UpdateProgress } from '@shared/events'
import type { ApiErrorPayload, ErrorCode, Result } from '@shared/result'
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
} from '@shared/types'

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly details: unknown
  constructor(payload: ApiErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.details = payload.details
  }
}

async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise
  if (result.ok) return result.data
  throw new ApiError(result.error)
}

export const api = {
  connections: {
    list: (): Promise<ConnectionConfig[]> => unwrap(window.api.connections.list()),
    create: (input: ConnectionInput): Promise<ConnectionConfig> =>
      unwrap(window.api.connections.create(input)),
    update: (payload: ConnectionUpdatePayload): Promise<ConnectionConfig> =>
      unwrap(window.api.connections.update(payload)),
    delete: (id: string): Promise<void> => unwrap(window.api.connections.delete(id)),
    test: (input: ConnectionInput, existingId?: string): Promise<ConnectionTestResult> =>
      unwrap(window.api.connections.test(input, existingId)),
    connect: (id: string): Promise<ConnectResult> => unwrap(window.api.connections.connect(id)),
    disconnect: (connectionId: string): Promise<void> =>
      unwrap(window.api.connections.disconnect(connectionId)),
    reorder: (ids: string[]): Promise<void> => unwrap(window.api.connections.reorder(ids)),
    onDropped: (listener: (payload: ConnectionDropped) => void): (() => void) =>
      window.api.connections.onDropped(listener)
  },
  databases: {
    list: (connectionId: string): Promise<DatabaseInfo[]> =>
      unwrap(window.api.databases.list(connectionId)),
    create: (payload: { connectionId: string; db: string; firstColl: string }): Promise<void> =>
      unwrap(window.api.databases.create(payload)),
    drop: (payload: { connectionId: string; db: string }): Promise<void> =>
      unwrap(window.api.databases.drop(payload))
  },
  server: {
    stats: (connectionId: string): Promise<ServerStats> =>
      unwrap(window.api.server.stats(connectionId))
  },
  collections: {
    list: (payload: { connectionId: string; db: string }): Promise<CollectionInfo[]> =>
      unwrap(window.api.collections.list(payload)),
    stats: (payload: {
      connectionId: string
      db: string
      coll: string
    }): Promise<CollectionStats> => unwrap(window.api.collections.stats(payload)),
    create: (payload: { connectionId: string; db: string; name: string }): Promise<void> =>
      unwrap(window.api.collections.create(payload)),
    drop: (payload: { connectionId: string; db: string; coll: string }): Promise<void> =>
      unwrap(window.api.collections.drop(payload)),
    rename: (payload: RenameCollectionPayload): Promise<void> =>
      unwrap(window.api.collections.rename(payload))
  },
  query: {
    find: (request: FindRequest): Promise<FindResponse> => unwrap(window.api.query.find(request)),
    aggregate: (request: AggregateRequest): Promise<AggregateResponse> =>
      unwrap(window.api.query.aggregate(request)),
    count: (request: CountRequest): Promise<CountResponse> =>
      unwrap(window.api.query.count(request)),
    replaceOne: (request: ReplaceOneRequest): Promise<ReplaceOneResponse> =>
      unwrap(window.api.query.replaceOne(request)),
    insertOne: (request: InsertOneRequest): Promise<InsertOneResponse> =>
      unwrap(window.api.query.insertOne(request)),
    insertMany: (request: InsertManyRequest): Promise<InsertManyResponse> =>
      unwrap(window.api.query.insertMany(request)),
    deleteOne: (request: DeleteOneRequest): Promise<DeleteOneResponse> =>
      unwrap(window.api.query.deleteOne(request)),
    deleteMany: (request: DeleteManyRequest): Promise<DeleteManyResponse> =>
      unwrap(window.api.query.deleteMany(request))
  },
  users: {
    list: (payload: { connectionId: string; db: string }): Promise<DatabaseUser[]> =>
      unwrap(window.api.users.list(payload)),
    create: (payload: CreateUserPayload): Promise<void> => unwrap(window.api.users.create(payload)),
    update: (payload: UpdateUserPayload): Promise<void> => unwrap(window.api.users.update(payload)),
    drop: (payload: DropUserPayload): Promise<void> => unwrap(window.api.users.drop(payload))
  },
  indexes: {
    list: (payload: { connectionId: string; db: string; coll: string }): Promise<IndexInfo[]> =>
      unwrap(window.api.indexes.list(payload)),
    create: (payload: CreateIndexPayload): Promise<{ name: string }> =>
      unwrap(window.api.indexes.create(payload)),
    drop: (payload: DropIndexPayload): Promise<void> => unwrap(window.api.indexes.drop(payload))
  },
  dialog: {
    pickPrivateKey: (): Promise<string | null> => unwrap(window.api.dialog.pickPrivateKey())
  },
  updater: {
    check: (): Promise<UpdateCheckResult> => unwrap(window.api.updater.check()),
    download: (): Promise<void> => unwrap(window.api.updater.download()),
    install: (): Promise<void> => unwrap(window.api.updater.install()),
    // A push subscription — no Result to unwrap.
    onProgress: (listener: (progress: UpdateProgress) => void): (() => void) =>
      window.api.updater.onProgress(listener)
  }
}
