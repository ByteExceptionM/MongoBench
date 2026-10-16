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
  CollectionsSchema: 'collections:schema',

  IndexesList: 'indexes:list',
  IndexesCreate: 'indexes:create',
  IndexesDrop: 'indexes:drop',
  IndexesStats: 'indexes:stats',

  UsersList: 'users:list',
  UsersCreate: 'users:create',
  UsersUpdate: 'users:update',
  UsersDrop: 'users:drop',
  RolesList: 'roles:list',

  QueryFind: 'query:find',
  QueryAggregate: 'query:aggregate',
  QueryCount: 'query:count',
  QueryReplaceOne: 'query:replaceOne',
  QueryInsertOne: 'query:insertOne',
  QueryInsertMany: 'query:insertMany',
  QueryDeleteOne: 'query:deleteOne',
  QueryDeleteMany: 'query:deleteMany',
  QueryDistinct: 'query:distinct',
  QueryCancel: 'query:cancel',
  QueryWrite: 'query:write',

  UpdaterCheck: 'updater:check',
  UpdaterDownload: 'updater:download',
  UpdaterInstall: 'updater:install',

  CloudflaredVersion: 'cloudflared:version',

  DialogPickPrivateKey: 'dialog:pickPrivateKey',
  DialogPickCloudflared: 'dialog:pickCloudflared'
} as const

export type ChannelName = (typeof Channels)[keyof typeof Channels]

/** main → renderer pushes. Subscribed to in the preload, never `handle`d. */
export const EventChannels = {
  UpdaterProgress: 'updater:progress',
  ConnectionDropped: 'connections:dropped',
  CloudflaredLogin: 'cloudflared:login'
} as const
