/**
 * Single source of truth for IPC channel names. Each entry must be
 * unique across the whole app; the renderer talks to main exclusively
 * via these channels.
 */
export const Channels = {
  ConnectionsList: 'connections:list',
  ConnectionsCreate: 'connections:create',
  ConnectionsUpdate: 'connections:update',
  ConnectionsDelete: 'connections:delete',
  ConnectionsTest: 'connections:test',
  ConnectionsConnect: 'connections:connect',
  ConnectionsDisconnect: 'connections:disconnect',
  ConnectionsReorder: 'connections:reorder',

  DatabasesList: 'databases:list',
  DatabasesCreate: 'databases:create',
  DatabasesDrop: 'databases:drop',
  ServerStats: 'server:stats',
  CollectionsList: 'collections:list',
  CollectionsStats: 'collections:stats',
  CollectionsCreate: 'collections:create',
  CollectionsDrop: 'collections:drop',
  CollectionsRename: 'collections:rename',

  UsersList: 'users:list',
  UsersCreate: 'users:create',
  UsersUpdate: 'users:update',
  UsersDrop: 'users:drop',

  QueryFind: 'query:find',
  QueryCount: 'query:count',
  QueryReplaceOne: 'query:replaceOne',
  QueryInsertOne: 'query:insertOne',
  QueryDeleteOne: 'query:deleteOne'
} as const

export type ChannelName = (typeof Channels)[keyof typeof Channels]
