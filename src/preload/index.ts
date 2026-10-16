import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '@shared/api'
import type {
  CloudflaredLoginPrompt,
  ConnectionDropped,
  UpdateCheckResult,
  UpdateProgress
} from '@shared/events'
import type { Result } from '@shared/result'
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
} from '@shared/types'

const invoke = <T>(channel: string, payload?: unknown): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Result<T>>

/**
 * Subscribes to a main → renderer push and returns an unsubscribe. The raw
 * IpcRendererEvent is dropped — it carries `sender`, which would hand the
 * renderer an Electron object and defeat contextIsolation.
 */
const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: Api = {
  connections: {
    list: () => invoke<ConnectionConfig[]>('connections:list'),
    create: (input: ConnectionInput) => invoke<ConnectionConfig>('connections:create', input),
    update: (payload: ConnectionUpdatePayload) =>
      invoke<ConnectionConfig>('connections:update', payload),
    delete: (id: string) => invoke<void>('connections:delete', { id }),
    test: (input: ConnectionInput, existingId?: string) =>
      invoke<ConnectionTestResult>('connections:test', { input, existingId }),
    connect: (id: string) => invoke<ConnectResult>('connections:connect', { id }),
    disconnect: (connectionId: string) => invoke<void>('connections:disconnect', { connectionId }),
    reorder: (ids: string[]) => invoke<void>('connections:reorder', { ids }),
    onDropped: (listener: (payload: ConnectionDropped) => void) =>
      subscribe<ConnectionDropped>('connections:dropped', listener)
  },
  cloudflared: {
    version: (binaryPath?: string) => invoke<string>('cloudflared:version', { binaryPath }),
    onLogin: (listener: (prompt: CloudflaredLoginPrompt) => void) =>
      subscribe<CloudflaredLoginPrompt>('cloudflared:login', listener)
  },
  dialog: {
    pickPrivateKey: () => invoke<string | null>('dialog:pickPrivateKey'),
    pickCloudflared: () => invoke<string | null>('dialog:pickCloudflared')
  },
  databases: {
    list: (connectionId: string) => invoke<DatabaseInfo[]>('databases:list', { connectionId }),
    create: (payload: { connectionId: string; db: string; firstColl: string }) =>
      invoke<void>('databases:create', payload),
    drop: (payload: { connectionId: string; db: string }) => invoke<void>('databases:drop', payload)
  },
  server: {
    stats: (connectionId: string) => invoke<ServerStats>('server:stats', { connectionId })
  },
  collections: {
    list: (payload: { connectionId: string; db: string }) =>
      invoke<CollectionInfo[]>('collections:list', payload),
    stats: (payload: { connectionId: string; db: string; coll: string }) =>
      invoke<CollectionStats>('collections:stats', payload),
    create: (payload: { connectionId: string; db: string; name: string }) =>
      invoke<void>('collections:create', payload),
    drop: (payload: { connectionId: string; db: string; coll: string }) =>
      invoke<void>('collections:drop', payload),
    rename: (payload: RenameCollectionPayload) => invoke<void>('collections:rename', payload),
    schema: (payload: { connectionId: string; db: string; coll: string }) =>
      invoke<CollectionSchema>('collections:schema', payload)
  },
  query: {
    find: (request: FindRequest) => invoke<FindResponse>('query:find', request),
    aggregate: (request: AggregateRequest) => invoke<AggregateResponse>('query:aggregate', request),
    count: (request: CountRequest) => invoke<CountResponse>('query:count', request),
    replaceOne: (request: ReplaceOneRequest) =>
      invoke<ReplaceOneResponse>('query:replaceOne', request),
    insertOne: (request: InsertOneRequest) => invoke<InsertOneResponse>('query:insertOne', request),
    insertMany: (request: InsertManyRequest) =>
      invoke<InsertManyResponse>('query:insertMany', request),
    deleteOne: (request: DeleteOneRequest) => invoke<DeleteOneResponse>('query:deleteOne', request),
    deleteMany: (request: DeleteManyRequest) =>
      invoke<DeleteManyResponse>('query:deleteMany', request),
    distinct: (request: DistinctRequest) => invoke<DistinctResponse>('query:distinct', request),
    cancel: (request: CancelQueryRequest) => invoke<void>('query:cancel', request),
    write: (request: WriteRequest) => invoke<WriteResponse>('query:write', request)
  },
  users: {
    list: (payload: { connectionId: string; db: string }) =>
      invoke<DatabaseUser[]>('users:list', payload),
    create: (payload: CreateUserPayload) => invoke<void>('users:create', payload),
    update: (payload: UpdateUserPayload) => invoke<void>('users:update', payload),
    drop: (payload: DropUserPayload) => invoke<void>('users:drop', payload)
  },
  roles: {
    list: (payload: { connectionId: string; db: string }) =>
      invoke<DatabaseRoleInfo[]>('roles:list', payload)
  },
  indexes: {
    list: (payload: { connectionId: string; db: string; coll: string }) =>
      invoke<IndexInfo[]>('indexes:list', payload),
    create: (payload: CreateIndexPayload) => invoke<{ name: string }>('indexes:create', payload),
    drop: (payload: DropIndexPayload) => invoke<void>('indexes:drop', payload),
    stats: (payload: { connectionId: string; db: string; coll: string }) =>
      invoke<IndexStatsReport>('indexes:stats', payload)
  },
  updater: {
    check: () => invoke<UpdateCheckResult>('updater:check'),
    download: () => invoke<void>('updater:download'),
    install: () => invoke<void>('updater:install'),
    onProgress: (listener: (progress: UpdateProgress) => void) =>
      subscribe<UpdateProgress>('updater:progress', listener)
  }
}

if (!process.contextIsolated) {
  throw new Error('contextIsolation must be enabled; refusing to expose preload API')
}

contextBridge.exposeInMainWorld('api', api)
