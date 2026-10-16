import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelRequests, withRequestId } from './queryCancellation'

const { cancel } = vi.hoisted(() => ({
  cancel: vi.fn((_request: { requestId: string }) => Promise.resolve())
}))
vi.mock('./api', () => ({ api: { query: { cancel } } }))

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const cancelledIds = () => cancel.mock.calls.map(([request]) => request.requestId)

beforeEach(() => {
  cancel.mockClear()
  cancelRequests(() => true)
  cancel.mockClear()
})

describe('withRequestId', () => {
  it('passes a fresh v4 uuid per run and returns the result', async () => {
    const ids: string[] = []
    const a = await withRequestId(['find', 1], async (id) => {
      ids.push(id)
      return 'a'
    })
    const b = await withRequestId(['find', 1], async (id) => {
      ids.push(id)
      return 'b'
    })
    expect([a, b]).toEqual(['a', 'b'])
    expect(ids[0]).toMatch(UUID)
    expect(ids[1]).toMatch(UUID)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('keeps the id registered while running and forgets it once settled', async () => {
    const run = deferred<string>()
    let requestId = ''
    const pending = withRequestId(['aggregate', 't1'], (id) => {
      requestId = id
      return run.promise
    })
    cancelRequests(() => true)
    expect(cancelledIds()).toEqual([requestId])

    run.resolve('done')
    await pending
    cancel.mockClear()
    cancelRequests(() => true)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('forgets the id when the run fails', async () => {
    await expect(
      withRequestId(['find', 2], () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    cancelRequests(() => true)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('aborts the older server op when the same key runs again', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let firstId = ''
    let secondId = ''
    const a = withRequestId(['shell', 't1', { epoch: 3 }], (id) => {
      firstId = id
      return first.promise
    })
    const b = withRequestId(['shell', 't1', { epoch: 3 }], (id) => {
      secondId = id
      return second.promise
    })
    expect(cancelledIds()).toEqual([firstId])

    // The superseded run settling later must not unregister the newer one.
    first.resolve('old')
    await a
    cancel.mockClear()
    cancelRequests(() => true)
    expect(cancelledIds()).toEqual([secondId])
    second.resolve('new')
    await b
  })
})

describe('cancelRequests', () => {
  it('aborts only matching running queries, once', async () => {
    const runs = [deferred<void>(), deferred<void>()]
    const ids: string[] = []
    const keys = [
      ['aggregate', 't1', 'c', 'db', 'coll', { pipeline: '[]', epoch: 4 }],
      ['aggregate', 't2', 'c', 'db', 'coll', { pipeline: '[]', epoch: 5 }]
    ]
    const pending = keys.map((key, i) =>
      withRequestId(key, (id) => {
        ids.push(id)
        return runs[i]?.promise ?? Promise.resolve()
      })
    )
    cancelRequests((key) => key[1] === 't2')
    expect(cancelledIds()).toEqual([ids[1]])
    cancelRequests((key) => key[1] === 't2')
    expect(cancel).toHaveBeenCalledTimes(1)

    for (const run of runs) run.resolve()
    await Promise.all(pending)
  })

  it('swallows a failing cancel request', async () => {
    cancel.mockImplementationOnce(() => Promise.reject(new Error('ipc down')))
    const run = deferred<void>()
    const pending = withRequestId(['find', 3], () => run.promise)
    expect(() => cancelRequests(() => true)).not.toThrow()
    run.resolve()
    await pending
  })
})
