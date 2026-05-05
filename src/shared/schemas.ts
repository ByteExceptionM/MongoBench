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
    clearStoredPassword: z.boolean().optional(),
    authSource: z.string().trim().max(120).optional(),
    authMechanism: AuthMechanismSchema.optional(),
    tls: z.boolean().optional(),
    serverSelectionTimeoutMS: z.number().int().min(1000).max(60_000).optional(),
    appName: z.string().trim().max(120).optional(),
    directConnection: z.boolean().optional(),
    replicaSet: z.string().trim().max(120).optional(),
    readPreference: ReadPreferenceSchema.optional(),
    uuidEncoding: UuidEncodingSchema.optional(),
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

export const DeleteOneRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    db: dbName,
    coll: collName,
    id: idString,
    expectedHash: hashString
  })
  .strict()
