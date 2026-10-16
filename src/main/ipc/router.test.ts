import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Result } from '@shared/result'

type Handler = (event: unknown, payload?: unknown) => Promise<Result<unknown>>

const ipc = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), warn: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => ipc.handlers.set(channel, handler) }
}))
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: ipc.warn, debug: vi.fn(), error: vi.fn() }
}))

const { registerIpcHandlers } = await import('./router')
const { Channels } = await import('./channels')
type Services = Parameters<typeof registerIpcHandlers>[0]

const FIND = {
  connectionId: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
  db: 'app',
  coll: 'players',
  skip: 0
}

const queries = { find: vi.fn() }
const repo = { list: vi.fn() }
registerIpcHandlers({ queries, repo } as unknown as Services)

function invoke(channel: string, payload?: unknown): Promise<Result<unknown>> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, payload)
}

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

beforeEach(() => {
  ipc.warn.mockClear()
})

describe('IPC handler failures', () => {
  it('returns a cancelled run as an error without logging a warning', async () => {
    queries.find.mockRejectedValueOnce(named('CancelledError', 'Query cancelled'))

    await expect(invoke(Channels.QueryFind, FIND)).resolves.toEqual({
      ok: false,
      error: { code: 'cancelled', message: 'Query cancelled' }
    })
    expect(ipc.warn).not.toHaveBeenCalled()
  })

  it('logs every other failure as a warning', async () => {
    queries.find.mockRejectedValueOnce(named('DocumentNotFoundError', 'gone'))

    await expect(invoke(Channels.QueryFind, FIND)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(ipc.warn).toHaveBeenCalledWith('IPC handler failed', {
      code: 'not_found',
      message: 'gone'
    })
  })

  it('treats a cancel the same way in handlers without input', async () => {
    repo.list.mockRejectedValueOnce(named('CancelledError', 'Query cancelled'))

    await expect(invoke(Channels.ConnectionsList)).resolves.toMatchObject({
      error: { code: 'cancelled' }
    })
    expect(ipc.warn).not.toHaveBeenCalled()
  })
})
