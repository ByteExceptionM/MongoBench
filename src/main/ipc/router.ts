import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import type { ZodType } from 'zod'
import {
  CollectionRefSchema,
  ConnectionIdSchema,
  ConnectionInputSchema,
  ConnectionRefSchema,
  ConnectionTestPayloadSchema,
  ConnectionUpdateSchema,
  CountRequestSchema,
  CreateCollectionSchema,
  CreateDatabaseSchema,
  CreateUserSchema,
  DatabaseRefSchema,
  DeleteOneRequestSchema,
  DropUserSchema,
  FindRequestSchema,
  InsertOneRequestSchema,
  RenameCollectionSchema,
  ReorderConnectionsSchema,
  ReplaceOneRequestSchema,
  UpdateUserSchema
} from '@shared/schemas'
import type { Result } from '@shared/result'
import { err, ok } from '@shared/result'
import { mapError } from '../lib/errorMap'
import type { ConnectionsRepository } from '../stores/ConnectionsRepository'
import type { ConnectionService } from '../services/ConnectionService'
import type { DatabaseService } from '../services/DatabaseService'
import type { QueryService } from '../services/QueryService'
import type { UserService } from '../services/UserService'
import { Channels } from './channels'

export type Services = {
  repo: ConnectionsRepository
  connections: ConnectionService
  databases: DatabaseService
  queries: QueryService
  users: UserService
}

function withResult<P, R>(
  schema: ZodType<P>,
  fn: (payload: P) => Promise<R>
): (event: IpcMainInvokeEvent, raw: unknown) => Promise<Result<R>> {
  return async (_event, raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return err('validation_error', parsed.error.issues.map((i) => i.message).join('; '), {
        issues: parsed.error.issues
      })
    }
    try {
      return ok(await fn(parsed.data))
    } catch (error) {
      const mapped = mapError(error)
      log.warn(`IPC handler failed`, mapped)
      return err(mapped.code, mapped.message, mapped.details)
    }
  }
}

function withoutInput<R>(fn: () => Promise<R>): (event: IpcMainInvokeEvent) => Promise<Result<R>> {
  return async (_event) => {
    try {
      return ok(await fn())
    } catch (error) {
      const mapped = mapError(error)
      log.warn(`IPC handler failed`, mapped)
      return err(mapped.code, mapped.message, mapped.details)
    }
  }
}

export function registerIpcHandlers(services: Services): void {
  const { repo, connections, databases, queries, users } = services

  ipcMain.handle(
    Channels.ConnectionsList,
    withoutInput(() => repo.list())
  )

  ipcMain.handle(
    Channels.ConnectionsCreate,
    withResult(ConnectionInputSchema, (input) => repo.create(input))
  )

  ipcMain.handle(
    Channels.ConnectionsUpdate,
    withResult(ConnectionUpdateSchema, ({ id, patch }) => repo.update(id, patch))
  )

  ipcMain.handle(
    Channels.ConnectionsDelete,
    withResult(ConnectionIdSchema, async ({ id }) => {
      await connections.disconnect(id).catch(() => undefined)
      await repo.delete(id)
    })
  )

  ipcMain.handle(
    Channels.ConnectionsTest,
    withResult(ConnectionTestPayloadSchema, ({ input, existingId }) =>
      connections.test(input, existingId)
    )
  )

  ipcMain.handle(
    Channels.ConnectionsConnect,
    withResult(ConnectionIdSchema, ({ id }) => connections.connect(id))
  )

  ipcMain.handle(
    Channels.ConnectionsDisconnect,
    withResult(ConnectionRefSchema, ({ connectionId }) => connections.disconnect(connectionId))
  )

  ipcMain.handle(
    Channels.ConnectionsReorder,
    withResult(ReorderConnectionsSchema, ({ ids }) => repo.reorder(ids))
  )

  ipcMain.handle(
    Channels.DatabasesList,
    withResult(ConnectionRefSchema, ({ connectionId }) => databases.listDatabases(connectionId))
  )

  ipcMain.handle(
    Channels.CollectionsList,
    withResult(DatabaseRefSchema, ({ connectionId, db }) =>
      databases.listCollections(connectionId, db)
    )
  )

  ipcMain.handle(
    Channels.CollectionsStats,
    withResult(CollectionRefSchema, ({ connectionId, db, coll }) =>
      databases.collectionStats(connectionId, db, coll)
    )
  )

  ipcMain.handle(
    Channels.CollectionsDrop,
    withResult(CollectionRefSchema, ({ connectionId, db, coll }) =>
      databases.dropCollection(connectionId, db, coll)
    )
  )

  ipcMain.handle(
    Channels.CollectionsRename,
    withResult(RenameCollectionSchema, ({ connectionId, db, coll, newName }) =>
      databases.renameCollection(connectionId, db, coll, newName)
    )
  )

  ipcMain.handle(
    Channels.CollectionsCreate,
    withResult(CreateCollectionSchema, ({ connectionId, db, name }) =>
      databases.createCollection(connectionId, db, name)
    )
  )

  ipcMain.handle(
    Channels.DatabasesCreate,
    withResult(CreateDatabaseSchema, ({ connectionId, db, firstColl }) =>
      databases.createDatabase(connectionId, db, firstColl)
    )
  )

  ipcMain.handle(
    Channels.DatabasesDrop,
    withResult(DatabaseRefSchema, ({ connectionId, db }) =>
      databases.dropDatabase(connectionId, db)
    )
  )

  ipcMain.handle(
    Channels.ServerStats,
    withResult(ConnectionRefSchema, ({ connectionId }) => databases.serverStats(connectionId))
  )

  ipcMain.handle(
    Channels.QueryFind,
    withResult(FindRequestSchema, (request) => queries.find(request))
  )

  ipcMain.handle(
    Channels.QueryCount,
    withResult(CountRequestSchema, (request) => queries.count(request))
  )

  ipcMain.handle(
    Channels.QueryReplaceOne,
    withResult(ReplaceOneRequestSchema, (request) => queries.replaceOne(request))
  )

  ipcMain.handle(
    Channels.QueryInsertOne,
    withResult(InsertOneRequestSchema, (request) => queries.insertOne(request))
  )

  ipcMain.handle(
    Channels.QueryDeleteOne,
    withResult(DeleteOneRequestSchema, (request) => queries.deleteOne(request))
  )

  ipcMain.handle(
    Channels.UsersList,
    withResult(DatabaseRefSchema, ({ connectionId, db }) => users.listUsers(connectionId, db))
  )

  ipcMain.handle(
    Channels.UsersCreate,
    withResult(CreateUserSchema, ({ connectionId, db, username, password, roles }) =>
      users.createUser(connectionId, db, username, password, roles)
    )
  )

  ipcMain.handle(
    Channels.UsersUpdate,
    withResult(UpdateUserSchema, ({ connectionId, db, username, password, roles }) =>
      users.updateUser(connectionId, db, username, password, roles)
    )
  )

  ipcMain.handle(
    Channels.UsersDrop,
    withResult(DropUserSchema, ({ connectionId, db, username }) =>
      users.dropUser(connectionId, db, username)
    )
  )
}
