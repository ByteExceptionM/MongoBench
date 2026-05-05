import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '@shared/api'
import type { Result } from '@shared/result'
import type {
  CollectionInfo,
  CollectionStats,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  ConnectionUpdatePayload,
  CountRequest,
  CountResponse,
  CreateUserPayload,
  DatabaseInfo,
  DatabaseUser,
  DeleteOneRequest,
  DeleteOneResponse,
  DropUserPayload,
  FindRequest,
  FindResponse,
  InsertOneRequest,
  InsertOneResponse,
  RenameCollectionPayload,
  ReplaceOneRequest,
  ReplaceOneResponse,
  ServerStats,
  UpdateUserPayload
} from '@shared/types'

const invoke = <T>(channel: string, payload?: unknown): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Result<T>>

const api: Api = {
  connections: {
    list: () => invoke<ConnectionConfig[]>('connections:list'),
    create: (input: ConnectionInput) => invoke<ConnectionConfig>('connections:create', input),
    update: (payload: ConnectionUpdatePayload) =>
      invoke<ConnectionConfig>('connections:update', payload),
    delete: (id: string) => invoke<void>('connections:delete', { id }),
    test: (input: ConnectionInput, existingId?: string) =>
      invoke<ConnectionTestResult>('connections:test', { input, existingId }),
    connect: (id: string) => invoke<{ connectionId: string }>('connections:connect', { id }),
    disconnect: (connectionId: string) => invoke<void>('connections:disconnect', { connectionId }),
    reorder: (ids: string[]) => invoke<void>('connections:reorder', { ids })
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
    rename: (payload: RenameCollectionPayload) => invoke<void>('collections:rename', payload)
  },
  query: {
    find: (request: FindRequest) => invoke<FindResponse>('query:find', request),
    count: (request: CountRequest) => invoke<CountResponse>('query:count', request),
    replaceOne: (request: ReplaceOneRequest) =>
      invoke<ReplaceOneResponse>('query:replaceOne', request),
    insertOne: (request: InsertOneRequest) => invoke<InsertOneResponse>('query:insertOne', request),
    deleteOne: (request: DeleteOneRequest) => invoke<DeleteOneResponse>('query:deleteOne', request)
  },
  users: {
    list: (payload: { connectionId: string; db: string }) =>
      invoke<DatabaseUser[]>('users:list', payload),
    create: (payload: CreateUserPayload) => invoke<void>('users:create', payload),
    update: (payload: UpdateUserPayload) => invoke<void>('users:update', payload),
    drop: (payload: DropUserPayload) => invoke<void>('users:drop', payload)
  }
}

if (!process.contextIsolated) {
  throw new Error('contextIsolation must be enabled; refusing to expose preload API')
}

contextBridge.exposeInMainWorld('api', api)
