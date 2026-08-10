import { z } from 'zod'

const AuthMechanismSchema = z.enum(['SCRAM-SHA-256', 'SCRAM-SHA-1', 'DEFAULT'])
const ReadPreferenceSchema = z.enum([
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest'
])
const UuidEncodingSchema = z.enum(['default', 'java'])
const SshAuthMethodSchema = z.enum(['password', 'privateKey', 'agent'])

/**
 * Fields stay permissive while `enabled` is false so a half-filled tunnel
 * section can still be saved with the tunnel switched off. Everything the
 * tunnel actually needs is only required once it is on.
 */
export const SshTunnelInputSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().max(255),
    port: z.number().int().min(1).max(65_535).optional(),
    username: z.string().trim().max(255),
    authMethod: SshAuthMethodSchema,
    privateKeyPath: z.string().trim().max(4096).optional(),
    password: z.string().max(1024).optional(),
    passphrase: z.string().max(1024).optional()
  })
  .strict()
  .superRefine((ssh, ctx) => {
    if (!ssh.enabled) return
    if (ssh.host.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'SSH host is required', path: ['host'] })
    }
    if (ssh.username.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'SSH username is required', path: ['username'] })
    }
    if (ssh.authMethod === 'privateKey' && (ssh.privateKeyPath ?? '').length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Private key file is required',
        path: ['privateKeyPath']
      })
    }
  })

export const ConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    uri: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(
        (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
        'URI must start with mongodb:// or mongodb+srv://'
      ),
    username: z.string().trim().max(255).optional(),
    password: z.string().max(1024).optional(),
    authSource: z.string().trim().max(120).optional(),
    authMechanism: AuthMechanismSchema.optional(),
    tls: z.boolean().optional(),
    serverSelectionTimeoutMS: z.number().int().min(1000).max(60_000).optional(),
    appName: z.string().trim().max(120).optional(),
    ssh: SshTunnelInputSchema.optional(),
    directConnection: z.boolean().optional(),
    replicaSet: z.string().trim().max(120).optional(),
    readPreference: ReadPreferenceSchema.optional(),
    uuidEncoding: UuidEncodingSchema.optional(),
    timezone: z.string().trim().min(1).max(120).optional(),
    authorizedOnly: z.boolean().optional(),
    maxPoolSize: z.number().int().min(1).max(10_000).optional(),
    minPoolSize: z.number().int().min(0).max(10_000).optional(),
    connectTimeoutMS: z.number().int().min(500).max(120_000).optional(),
    socketTimeoutMS: z.number().int().min(500).max(600_000).optional(),
    retryWrites: z.boolean().optional(),
    retryReads: z.boolean().optional()
  })
  .strict()

export const ConnectionUpdateSchema = z
  .object({
    id: z.string().uuid(),
    patch: ConnectionInputSchema
  })
  .strict()

export const ConnectionTestPayloadSchema = z
  .object({
    input: ConnectionInputSchema,
    existingId: z.string().uuid().optional()
  })
  .strict()

export const ConnectionIdSchema = z.object({ id: z.string().uuid() }).strict()
export const ConnectionRefSchema = z.object({ connectionId: z.string().uuid() }).strict()
export const ReorderConnectionsSchema = z
  .object({ ids: z.array(z.string().uuid()).min(1) })
  .strict()

const dbName = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => !/[\s/\\."$*<>:|?]/.test(v), 'invalid database name')
const collName = z.string().min(1).max(255)
const ejsonString = z.string().max(64 * 1024)

export const DatabaseRefSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName
  })
  .strict()

export const CollectionRefSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName
  })
  .strict()

const validCollName = collName.refine(
  (v) => !v.includes('$') && !v.includes('\0') && !v.startsWith('system.'),
  'invalid collection name'
)

export const RenameCollectionSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    newName: validCollName
  })
  .strict()

export const CreateCollectionSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    name: validCollName
  })
  .strict()

export const CreateDatabaseSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    firstColl: validCollName
  })
  .strict()

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => !/[\s\0]/.test(v), 'invalid username')

const RoleSchema = z
  .object({
    role: z.string().trim().min(1).max(120),
    db: z.string().trim().min(1).max(64)
  })
  .strict()

export const CreateUserSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    username: usernameSchema,
    password: z.string().min(1).max(1024),
    roles: z.array(RoleSchema).max(64)
  })
  .strict()

export const UpdateUserSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    username: usernameSchema,
    password: z.string().min(1).max(1024).nullable(),
    roles: z.array(RoleSchema).max(64).nullable()
  })
  .strict()

export const DropUserSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    username: usernameSchema
  })
  .strict()

export const FindRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    filter: ejsonString.optional(),
    projection: ejsonString.optional(),
    sort: ejsonString.optional(),
    skip: z.number().int().min(0).max(1_000_000),
    /** Omit / undefined = no limit. */
    limit: z.number().int().min(1).max(1_000_000).optional()
  })
  .strict()

export const CountRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    filter: ejsonString.optional()
  })
  .strict()

export const AggregateRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    pipeline: z.string().max(256 * 1024)
  })
  .strict()

const idString = z
  .string()
  .min(1)
  .max(64 * 1024)
const hashString = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha-256 hex digest')
const documentString = z
  .string()
  .min(1)
  .max(1024 * 1024)

export const ReplaceOneRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    id: idString,
    expectedHash: hashString,
    replacement: documentString
  })
  .strict()

export const InsertOneRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    document: documentString
  })
  .strict()

export const InsertManyRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    documents: z.array(documentString).min(1).max(10_000)
  })
  .strict()

export const DeleteOneRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    id: idString,
    expectedHash: hashString
  })
  .strict()

export const DeleteManyRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    ids: z.array(idString).min(1).max(10_000)
  })
  .strict()

const indexName = z
  .string()
  .min(1)
  .max(127)
  .refine((v) => !v.includes('$') && !v.includes('\0'), 'invalid index name')

const ejsonObject = z
  .string()
  .min(2)
  .max(64 * 1024)

export const IndexCreateOptionsSchema = z
  .object({
    name: indexName.optional(),
    unique: z.boolean().optional(),
    sparse: z.boolean().optional(),
    hidden: z.boolean().optional(),
    expireAfterSeconds: z.number().int().min(0).max(2_147_483_647).optional(),
    partialFilterExpression: ejsonObject.optional(),
    collation: ejsonObject.optional(),
    weights: ejsonObject.optional(),
    default_language: z.string().trim().min(1).max(40).optional(),
    language_override: z.string().trim().min(1).max(120).optional(),
    textIndexVersion: z.number().int().min(1).max(3).optional(),
    '2dsphereIndexVersion': z.number().int().min(1).max(3).optional(),
    bits: z.number().int().min(1).max(32).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    wildcardProjection: ejsonObject.optional()
  })
  .strict()

export const IndexesListSchema = CollectionRefSchema

export const CreateIndexSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    keys: ejsonObject,
    options: IndexCreateOptionsSchema.optional()
  })
  .strict()

export const DropIndexSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    name: indexName
  })
  .strict()
