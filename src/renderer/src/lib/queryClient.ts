import { QueryClient } from '@tanstack/react-query'
import type { ErrorCode } from '@shared/result'
import { ApiError } from './api'

/** Retrying these cannot change the answer — the input has to change first. */
const NEVER_RETRIED = new Set<ErrorCode>([
  'validation_error',
  'auth_failed',
  'ssh_auth_failed',
  'ssh_host_key_mismatch'
])

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && NEVER_RETRIED.has(error.code)) return false
        return failureCount < 1
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: false
    }
  }
})

export const queryKeys = {
  connections: ['connections'] as const,
  databases: (connectionId: string) => ['databases', connectionId] as const,
  collections: (connectionId: string, db: string) => ['collections', connectionId, db] as const,
  collectionStats: (connectionId: string, db: string, coll: string) =>
    ['collection-stats', connectionId, db, coll] as const,
  indexes: (connectionId: string, db: string, coll: string) =>
    ['indexes', connectionId, db, coll] as const,
  fieldPaths: (connectionId: string, db: string, coll: string) =>
    ['field-paths', connectionId, db, coll] as const,
  users: (connectionId: string, db: string) => ['users', connectionId, db] as const,
  serverStats: (connectionId: string) => ['server-stats', connectionId] as const,
  find: (
    connectionId: string,
    db: string,
    coll: string,
    filter: string,
    projection: string,
    sort: string,
    skip: number,
    limit: number,
    epoch: number
  ) => ['find', connectionId, db, coll, { filter, projection, sort, skip, limit, epoch }] as const,
  aggregate: (connectionId: string, db: string, coll: string, pipeline: string, epoch: number) =>
    ['aggregate', connectionId, db, coll, { pipeline, epoch }] as const,
  shell: (connectionId: string, db: string, coll: string, command: string, epoch: number) =>
    ['shell', connectionId, db, coll, { command, epoch }] as const,
  count: (connectionId: string, db: string, coll: string, filter: string) =>
    ['count', connectionId, db, coll, { filter }] as const
}
