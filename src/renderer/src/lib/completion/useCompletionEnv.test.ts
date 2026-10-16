import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, environmentManager } from '@tanstack/react-query'
import { createSchemaBuilder, resolveSchemaField } from '@shared/collectionSchema'
import type { CollectionSchema, DocumentEnvelope } from '@shared/types'
import { api } from '../api'
import { SCHEMA_STALE_MS, schemaAccess } from './useCompletionEnv'

const REF = { connectionId: 'c1', db: 'app', coll: 'users' }

const schemaOf = (...docs: unknown[]): CollectionSchema => {
  const builder = createSchemaBuilder()
  for (const doc of docs) builder.add(doc)
  return builder.build()
}

const SAMPLED: Record<string, CollectionSchema> = {
  users: schemaOf({ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'ada' }),
  orders: schemaOf({ _id: { $oid: '507f1f77bcf86cd799439012' }, total: { $numberInt: '3' } })
}

const envelope = (canonical: unknown): DocumentEnvelope => ({
  id: null,
  hash: '',
  data: {},
  canonical: JSON.stringify(canonical)
})

const schemaCall = vi.spyOn(api.collections, 'schema')

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient()
  schemaCall.mockReset()
  schemaCall.mockImplementation(async ({ coll }) => {
    const schema = SAMPLED[coll]
    if (!schema) throw new Error(`no sample for ${coll}`)
    return schema
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const access = (documents: readonly DocumentEnvelope[] | undefined = undefined) =>
  schemaAccess(queryClient, REF, ['users', 'orders'], () => documents)

describe('schemaAccess', () => {
  it('never samples a name that is not a collection of the database', async () => {
    await expect(access().loadSchema('typed_by_user')).resolves.toBeNull()
    expect(schemaCall).not.toHaveBeenCalled()
  })

  it('samples each collection once and serves later requests from the cache', async () => {
    const { loadSchema } = access()
    const [first, concurrent] = await Promise.all([loadSchema('users'), loadSchema('users')])
    const later = await loadSchema('users')
    const other = await loadSchema('orders')

    expect(first).toEqual(SAMPLED.users)
    expect(concurrent).toEqual(SAMPLED.users)
    expect(later).toEqual(SAMPLED.users)
    expect(other).toEqual(SAMPLED.orders)
    expect(schemaCall.mock.calls).toEqual([[{ ...REF }], [{ ...REF, coll: 'orders' }]])
  })

  it('prefetches the own collection', async () => {
    access().prefetchSchema()
    await vi.waitFor(() => expect(schemaCall).toHaveBeenCalledTimes(1))
    expect(schemaCall).toHaveBeenCalledWith(REF)
  })

  it('folds loaded documents into the own collection only', async () => {
    const docs = [envelope({ _id: { $oid: '507f1f77bcf86cd799439013' }, nickname: 'lin' })]
    const { loadSchema } = access(docs)

    const own = await loadSchema('users')
    const other = await loadSchema('orders')

    expect(own?.sampleSize).toBe(2)
    expect(resolveSchemaField(own!, 'nickname')?.types).toEqual({ string: 1 })
    expect(resolveSchemaField(own!, 'name')?.docCount).toBe(1)
    expect(other).toEqual(SAMPLED.orders)
  })

  it('reuses the folded schema until the documents change', async () => {
    let docs = [envelope({ nickname: 'lin' })]
    const { loadSchema } = schemaAccess(queryClient, REF, [], () => docs)

    const first = await loadSchema('users')
    expect(await loadSchema('users')).toBe(first)

    docs = [envelope({ nickname: 'kai' })]
    const next = await loadSchema('users')
    expect(next).not.toBe(first)
    expect(resolveSchemaField(next!, 'nickname')?.values).toEqual([{ ejson: '"kai"', count: 1 }])
  })

  it('folds new documents into the cached sample ahead of the next request', async () => {
    let docs = [envelope({ nickname: 'lin' })]
    const { loadSchema, foldDocuments } = schemaAccess(queryClient, REF, [], () => docs)
    foldDocuments()
    expect(schemaCall).not.toHaveBeenCalled()

    await loadSchema('users')
    docs = [envelope({ nickname: 'kai' })]
    const parse = vi.spyOn(JSON, 'parse')
    try {
      foldDocuments()
      expect(parse).toHaveBeenCalledTimes(1)
      const schema = await loadSchema('users')
      expect(parse).toHaveBeenCalledTimes(1)
      expect(resolveSchemaField(schema!, 'nickname')?.values).toEqual([
        { ejson: '"kai"', count: 1 }
      ])
    } finally {
      parse.mockRestore()
    }
  })

  it('folds the documents once a prefetched sample arrives', async () => {
    const { loadSchema, prefetchSchema } = access([envelope({ nickname: 'lin' })])
    const parse = vi.spyOn(JSON, 'parse')
    try {
      prefetchSchema()
      await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1))
      expect((await loadSchema('users'))?.sampleSize).toBe(2)
      expect(parse).toHaveBeenCalledTimes(1)
    } finally {
      parse.mockRestore()
    }
  })

  it('builds the schema from loaded documents when sampling fails', async () => {
    schemaCall.mockRejectedValue(new Error('not authorized'))
    const { loadSchema } = access([envelope({ nickname: 'lin' })])

    const schema = await loadSchema('users')

    expect(schema?.sampleSize).toBe(1)
    expect(schema?.fields.map((f) => f.path)).toEqual(['nickname'])
  })

  it('does not retry a failed sample per request until it is refreshed', async () => {
    schemaCall.mockRejectedValueOnce(new Error('not authorized'))
    const { loadSchema, refreshSchema } = access()

    await expect(loadSchema('users')).resolves.toBeNull()
    await expect(loadSchema('users')).resolves.toBeNull()
    expect(schemaCall).toHaveBeenCalledTimes(1)

    refreshSchema()
    await vi.waitFor(() => expect(schemaCall).toHaveBeenCalledTimes(2))
    await expect(loadSchema('users')).resolves.toEqual(SAMPLED.users)
  })

  it('retries a failed sample once it is older than the stale time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    schemaCall.mockRejectedValueOnce(new Error('timed out'))
    const { loadSchema } = access()

    await expect(loadSchema('users')).resolves.toBeNull()
    vi.setSystemTime(Date.now() + SCHEMA_STALE_MS + 1)

    await expect(loadSchema('users')).resolves.toEqual(SAMPLED.users)
    expect(schemaCall).toHaveBeenCalledTimes(2)
  })

  it('keeps an unobserved sample cached for the stale time in the renderer', async () => {
    const serverCheck = environmentManager.isServer()
    // The Electron renderer has a window, so query-core applies its browser cache lifetime.
    environmentManager.setIsServer(() => false)
    try {
      vi.useFakeTimers()
      const { loadSchema } = access()
      await loadSchema('users')
      await vi.advanceTimersByTimeAsync(SCHEMA_STALE_MS - 60_000)
      await loadSchema('users')
      expect(schemaCall).toHaveBeenCalledTimes(1)
    } finally {
      environmentManager.setIsServer(() => serverCheck)
    }
  })

  it('keeps suppressing a failed sample for the stale time in the renderer', async () => {
    const serverCheck = environmentManager.isServer()
    environmentManager.setIsServer(() => false)
    try {
      vi.useFakeTimers()
      schemaCall.mockRejectedValueOnce(new Error('timed out'))
      const { loadSchema } = access()
      await expect(loadSchema('users')).resolves.toBeNull()
      await vi.advanceTimersByTimeAsync(SCHEMA_STALE_MS - 60_000)
      await expect(loadSchema('users')).resolves.toBeNull()
      expect(schemaCall).toHaveBeenCalledTimes(1)
    } finally {
      environmentManager.setIsServer(() => serverCheck)
    }
  })

  it('refreshes by sampling again and keeps serving the old schema meanwhile', async () => {
    const { loadSchema, refreshSchema } = access()
    await loadSchema('users')
    const updated = schemaOf({ renamed: true })
    let finish!: (schema: CollectionSchema) => void
    schemaCall.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))

    refreshSchema()
    await vi.waitFor(() => expect(schemaCall).toHaveBeenCalledTimes(2))
    await expect(loadSchema('users')).resolves.toEqual(SAMPLED.users)

    finish(updated)
    await vi.waitFor(async () => expect(await loadSchema('users')).toEqual(updated))
  })
})
