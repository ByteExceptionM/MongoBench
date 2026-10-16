import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudflaredLoginPrompt } from '@shared/events'
import type { CloudflaredRuntime } from './CloudflaredTunnelService'

// The service logs through electron-log, which pulls in electron itself.
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))

const {
  CloudflaredAuthError,
  CloudflaredNotFoundError,
  CloudflaredTunnelError,
  CloudflaredTunnelService
} = await import('./CloudflaredTunnelService')
const log = (await import('electron-log/main')).default

const HOSTNAME = 'mongo.example.com'
const TOKEN_ID = '0123456789abcdef0123456789abcdef.access'
const TOKEN_SECRET = 'cfast_service-token-secret'
const TOKEN_CONFIG = {
  hostname: HOSTNAME,
  authMethod: 'serviceToken' as const,
  serviceTokenId: TOKEN_ID,
  serviceTokenSecret: TOKEN_SECRET
}
const BROWSER_CONFIG = { hostname: HOSTNAME, authMethod: 'browser' as const }

const LOGIN_URL = `https://${HOSTNAME}/cdn-cgi/access/cli?aud=abc&redirect_url=https%3A%2F%2F${HOSTNAME}`
const LOGIN_PROMPT = `A browser window should have opened at the following URL:\n\n${LOGIN_URL}\n\n`
const ORIGIN_ERROR =
  '2026-10-16T12:58:01Z ERR failed to connect to origin error="websocket: bad handshake" originURL=https://mongo.example.com'
const BIND_ERROR = (port: number): string =>
  `2026-10-16T12:58:00Z ERR Error on Websocket listener error="failed to start forwarding server: listen tcp 127.0.0.1:${port}: bind: Only one usage of each socket address is normally permitted."`

/** Stands in for a cloudflared child: stdio streams plus the exit events Node emits. */
class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn((): boolean => {
    queueMicrotask(() => this.finish(null, 'SIGTERM'))
    return true
  })

  /** cloudflared logs to stderr. */
  log(text: string): void {
    this.stderr.write(text)
  }

  /** 'exit' first, then 'close' once both streams have been read to the end. */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    let open = 2
    const drained = (): void => {
      open -= 1
      if (open === 0) this.emit('close', code, signal)
    }
    this.stdout.once('end', drained)
    this.stderr.once('end', drained)
    this.stdout.end()
    this.stderr.end()
  }

  /** A spawn failure: 'error', then 'close', and never 'exit'. */
  fail(code: string): void {
    this.emit('error', Object.assign(new Error(`spawn cloudflared ${code}`), { code }))
    this.emit('close', -4058, null)
  }
}

type Spawned = { command: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeProcess }

/** `access login` succeeds at once; every other process keeps running. */
function signInAtOnce({ args, child }: Spawned): void {
  if (args[1] === 'login') child.finish(0)
}

function fakeRuntime(
  options: { onSpawn?: (spawned: Spawned) => void; listening?: (port: number) => boolean } = {}
): { runtime: CloudflaredRuntime; spawned: Spawned[] } {
  const spawned: Spawned[] = []
  const ports = [5001, 5002]
  const runtime: CloudflaredRuntime = {
    spawn: vi.fn((command: string, args: string[], env: NodeJS.ProcessEnv) => {
      const child = new FakeProcess()
      const call = { command, args, env, child }
      spawned.push(call)
      // After launch() attached its listeners, as with a real child.
      queueMicrotask(() => (options.onSpawn ?? signInAtOnce)(call))
      return child as unknown as ChildProcess
    }),
    freePort: vi.fn(() => Promise.resolve(ports.shift() ?? 6000)),
    isListening: vi.fn((port: number) => Promise.resolve(options.listening?.(port) ?? true))
  }
  return { runtime, spawned }
}

function noPrompts(): void {}

function spawnedAt(spawned: Spawned[], index: number): Spawned {
  const call = spawned[index]
  if (call === undefined) throw new Error(`nothing was spawned at ${index}`)
  return call
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  delete process.env['TUNNEL_SERVICE_HOSTNAME']
})

describe('open with a service token', () => {
  it('runs access tcp with plain argv and the token only in the environment', async () => {
    process.env['TUNNEL_SERVICE_HOSTNAME'] = 'inherited.example.net'
    const { runtime, spawned } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const tunnel = await service.open(TOKEN_CONFIG)

    expect(spawned).toHaveLength(1)
    const { command, args, env } = spawnedAt(spawned, 0)
    expect(command).toBe('cloudflared')
    expect(args).toEqual(['access', 'tcp', '--hostname=mongo.example.com', '--url=127.0.0.1:5001'])
    expect(env['TUNNEL_SERVICE_TOKEN_ID']).toBe(TOKEN_ID)
    expect(env['TUNNEL_SERVICE_TOKEN_SECRET']).toBe(TOKEN_SECRET)
    expect(env['TUNNEL_SERVICE_HOSTNAME']).toBeUndefined()
    // cloudflared itself still has to be found and must reach the network.
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'PATH')).toBe(true)
    expect(args.join(' ')).not.toContain(TOKEN_SECRET)
    expect(tunnel.route).toEqual({ kind: 'localPort', host: '127.0.0.1', port: 5001 })
    expect(service.openCount).toBe(1)
  })

  it('never writes the secret to the log', async () => {
    const { runtime } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const tunnel = await service.open(TOKEN_CONFIG)
    await tunnel.close()

    const logged = JSON.stringify([
      vi.mocked(log.info).mock.calls,
      vi.mocked(log.warn).mock.calls,
      vi.mocked(log.debug).mock.calls,
      vi.mocked(log.error).mock.calls
    ])
    expect(logged).toContain(HOSTNAME)
    expect(logged).not.toContain(TOKEN_SECRET)
  })

  it('rejects a missing client ID or secret before spawning anything', async () => {
    const { runtime } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(service.open({ ...TOKEN_CONFIG, serviceTokenId: '' })).rejects.toThrow(
      CloudflaredAuthError
    )
    const { serviceTokenSecret: _secret, ...withoutSecret } = TOKEN_CONFIG
    await expect(service.open(withoutSecret)).rejects.toThrow(CloudflaredAuthError)
    expect(runtime.spawn).not.toHaveBeenCalled()
  })
})

describe('open with browser sign-in', () => {
  it('signs in with access login first and starts the tunnel only after it exits', async () => {
    const { runtime, spawned } = fakeRuntime({ onSpawn: () => undefined })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const opening = service.open(BROWSER_CONFIG)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    expect(spawnedAt(spawned, 0).args).toEqual([
      'access',
      'login',
      '--quiet',
      '--auto-close',
      'https://mongo.example.com'
    ])
    expect(spawnedAt(spawned, 0).env['TUNNEL_SERVICE_TOKEN_SECRET']).toBeUndefined()
    // Still signing in: no tunnel yet.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawned).toHaveLength(1)

    spawnedAt(spawned, 0).child.finish(0)
    const tunnel = await opening
    expect(spawnedAt(spawned, 1).args.slice(0, 2)).toEqual(['access', 'tcp'])
    expect(tunnel.route).toEqual({ kind: 'localPort', host: '127.0.0.1', port: 5001 })
  })

  it('reports a failed sign-in and never starts the tunnel', async () => {
    const { runtime, spawned } = fakeRuntime({
      onSpawn: ({ child }) => {
        child.log('failed to get app info: Head "https://mongo.example.com": no such host\n')
        child.finish(1)
      }
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const error = await service.open(BROWSER_CONFIG).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudflaredAuthError)
    expect((error as Error).message).toContain('failed to get app info')
    expect(spawned).toHaveLength(1)
  })

  it('stops a waiting sign-in when the open is aborted and never starts the tunnel', async () => {
    const { runtime, spawned } = fakeRuntime({ onSpawn: () => undefined })
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const aborting = new AbortController()

    const opening = service.open(BROWSER_CONFIG, undefined, aborting.signal)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    aborting.abort()

    const error = await opening.catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'CancelledError' })
    expect((error as Error).message).toContain('cancelled')
    expect(spawnedAt(spawned, 0).child.kill).toHaveBeenCalled()
    expect(spawned).toHaveLength(1)
  })

  it('starts nothing for an open that was aborted before it began', async () => {
    const { runtime } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(
      service.open(BROWSER_CONFIG, undefined, AbortSignal.abort())
    ).rejects.toMatchObject({ name: 'CancelledError' })
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('does not start the tunnel when the open is aborted after the sign-in', async () => {
    const { runtime, spawned } = fakeRuntime()
    const aborting = new AbortController()
    vi.mocked(runtime.freePort).mockImplementationOnce(() => {
      aborting.abort()
      return Promise.resolve(5001)
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(service.open(BROWSER_CONFIG, undefined, aborting.signal)).rejects.toMatchObject({
      name: 'CancelledError'
    })
    expect(spawned.map(({ args }) => args[1])).toEqual(['login'])
  })

  it('announces the sign-in URL while waiting and once more when done', async () => {
    const prompts: CloudflaredLoginPrompt[] = []
    const { runtime } = fakeRuntime({
      onSpawn: ({ args, child }) => {
        if (args[1] !== 'login') return
        child.log('https://evil.example.net/cdn-cgi/access/cli?aud=abc\n')
        child.log(LOGIN_PROMPT)
        child.finish(0)
      }
    })
    const service = new CloudflaredTunnelService((prompt) => prompts.push(prompt), runtime)

    await service.open(BROWSER_CONFIG)

    expect(prompts).toEqual([
      { hostname: HOSTNAME, state: 'waiting', url: LOGIN_URL },
      { hostname: HOSTNAME, state: 'finished' }
    ])
  })
})

describe('choosing the executable', () => {
  it('refuses a binary path that does not name cloudflared, without spawning it', async () => {
    const { runtime } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(
      service.open({ ...TOKEN_CONFIG, binaryPath: 'C:\\tools\\calc.exe' })
    ).rejects.toThrow(CloudflaredNotFoundError)
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('refuses a cloudflared on another machine, without spawning it', async () => {
    const { runtime } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const remote = '\\\\attacker.invalid@SSL\\DavWWWRoot\\cloudflared.exe'

    await expect(service.open({ ...TOKEN_CONFIG, binaryPath: remote })).rejects.toThrow(
      CloudflaredNotFoundError
    )
    await expect(service.version(remote)).rejects.toThrow(CloudflaredNotFoundError)
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('runs a chosen cloudflared executable', async () => {
    const { runtime, spawned } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await service.open({ ...TOKEN_CONFIG, binaryPath: 'C:\\tools\\cloudflared.exe' })
    expect(spawnedAt(spawned, 0).command).toBe('C:\\tools\\cloudflared.exe')
  })

  it('explains a cloudflared missing from PATH', async () => {
    const { runtime } = fakeRuntime({
      onSpawn: ({ child }) => child.fail('ENOENT'),
      listening: () => false
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const error = await service.open(TOKEN_CONFIG).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudflaredNotFoundError)
    expect((error as Error).message).toContain('not found on PATH')
  })

  it('reports a file Node refuses to run as not found', async () => {
    const { runtime } = fakeRuntime()
    vi.mocked(runtime.spawn).mockImplementation(() => {
      throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(
      service.open({ ...TOKEN_CONFIG, binaryPath: 'C:\\tools\\cloudflared.exe' })
    ).rejects.toThrow(CloudflaredNotFoundError)
  })

  it('reports a spawn refused over its environment as a tunnel failure, without the token', async () => {
    const { runtime } = fakeRuntime()
    vi.mocked(runtime.spawn).mockImplementation(() => {
      throw Object.assign(
        new TypeError(
          `The property 'options.env' must be a string without null bytes. Received '${TOKEN_SECRET}'`
        ),
        { code: 'ERR_INVALID_ARG_VALUE' }
      )
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const error = await service.open(TOKEN_CONFIG).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudflaredTunnelError)
    expect((error as Error).name).toBe('CloudflaredTunnelError')
    expect((error as Error).message).toContain('ERR_INVALID_ARG_VALUE')
    expect((error as Error).message).not.toContain(TOKEN_SECRET)
  })
})

describe('startup', () => {
  it('reports why cloudflared quit before the port opened', async () => {
    const { runtime } = fakeRuntime({
      onSpawn: ({ child }) => {
        child.log(
          '2026-10-16T12:58:03Z ERR  error="failed to parse as URL: parse \\"https://x\\": invalid"\n'
        )
        child.stdout.write('NAME:\n   cloudflared access tcp - ...\n')
        child.finish(0)
      },
      listening: () => false
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const error = await service.open(TOKEN_CONFIG).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudflaredTunnelError)
    expect((error as Error).message).toContain('failed to parse as URL')
    expect(service.openCount).toBe(0)
  })

  it('retries once on another port when the picked one was taken', async () => {
    const { runtime, spawned } = fakeRuntime({
      onSpawn: ({ args, child }) => {
        if (args[3] !== '--url=127.0.0.1:5001') return
        child.log(`${BIND_ERROR(5001)}\n`)
        child.finish(1)
      },
      listening: (port) => port !== 5001
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const tunnel = await service.open(TOKEN_CONFIG)
    expect(tunnel.route).toEqual({ kind: 'localPort', host: '127.0.0.1', port: 5002 })
    expect(spawned).toHaveLength(2)
  })

  it('gives up when the second port is taken too', async () => {
    const { runtime, spawned } = fakeRuntime({
      onSpawn: ({ args, child }) => {
        child.log(`${BIND_ERROR(Number(args[3]?.split(':').pop()))}\n`)
        child.finish(1)
      },
      listening: () => false
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const error = await service.open(TOKEN_CONFIG).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudflaredTunnelError)
    expect((error as Error).name).toBe('CloudflaredTunnelError')
    expect((error as Error).message).toContain('failed to start forwarding server')
    expect(spawned).toHaveLength(2)
  })

  it('stops cloudflared when the port never opens', async () => {
    vi.useFakeTimers()
    const { runtime, spawned } = fakeRuntime({ listening: () => false })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const failed = expect(service.open(TOKEN_CONFIG)).rejects.toThrow(
      /did not open its local port for mongo\.example\.com within 15 s/
    )
    await vi.advanceTimersByTimeAsync(15_200)
    await failed
    expect(spawnedAt(spawned, 0).child.kill).toHaveBeenCalled()
  })
})

describe('an open tunnel', () => {
  it('stops cloudflared on close without reporting a drop, once', async () => {
    const { runtime, spawned } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const dropped: string[] = []
    const tunnel = await service.open(TOKEN_CONFIG, (reason) => dropped.push(reason))

    await tunnel.close()
    await tunnel.close()

    const { child } = spawnedAt(spawned, 0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(service.openCount).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dropped).toEqual([])
  })

  it('reports a drop with the exit code and the last error when cloudflared dies', async () => {
    const { runtime, spawned } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const dropped: string[] = []
    const tunnel = await service.open(TOKEN_CONFIG, (reason) => dropped.push(reason))
    const { child } = spawnedAt(spawned, 0)

    child.log(`${ORIGIN_ERROR}\n`)
    child.finish(1)
    await vi.waitFor(() => expect(dropped).toHaveLength(1))

    expect(dropped[0]).toContain('code 1')
    expect(dropped[0]).toContain('websocket: bad handshake')
    expect(service.openCount).toBe(0)
    expect(tunnel.failure()).toBeInstanceOf(CloudflaredTunnelError)
    await tunnel.close()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('knows no failure until cloudflared logs an error', async () => {
    const { runtime, spawned } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const tunnel = await service.open(TOKEN_CONFIG)
    expect(tunnel.failure()).toBeNull()

    spawnedAt(spawned, 0).child.log(`${ORIGIN_ERROR}\n`)
    await vi.waitFor(() => expect(tunnel.failure()).not.toBeNull())
    const failure = tunnel.failure()
    expect(failure).toBeInstanceOf(CloudflaredTunnelError)
    expect(failure?.message).toContain('websocket: bad handshake')
  })

  it('blames the service token when Access falls back to a browser sign-in', async () => {
    const { runtime, spawned } = fakeRuntime()
    const service = new CloudflaredTunnelService(noPrompts, runtime)
    const tunnel = await service.open(TOKEN_CONFIG)

    spawnedAt(spawned, 0).child.log(LOGIN_PROMPT)
    await vi.waitFor(() => expect(tunnel.failure()).toBeInstanceOf(CloudflaredAuthError))
    expect(tunnel.failure()?.message).toContain('Service Auth policy')
  })
})

describe('closeAll', () => {
  it('stops open tunnels and sign-ins still waiting, reporting no drops', async () => {
    const prompts: CloudflaredLoginPrompt[] = []
    const { runtime, spawned } = fakeRuntime({
      onSpawn: ({ args, child }) => {
        if (args[1] === 'login') child.log(LOGIN_PROMPT)
      }
    })
    const service = new CloudflaredTunnelService((prompt) => prompts.push(prompt), runtime)
    const dropped: string[] = []

    await service.open(TOKEN_CONFIG, (reason) => dropped.push(reason))
    const signingIn = service.open(BROWSER_CONFIG, (reason) => dropped.push(reason))
    const signInStopped = expect(signingIn).rejects.toThrow(CloudflaredAuthError)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))

    await service.closeAll()
    await signInStopped

    expect(spawnedAt(spawned, 0).child.kill).toHaveBeenCalled()
    expect(spawnedAt(spawned, 1).child.kill).toHaveBeenCalled()
    expect(spawned).toHaveLength(2)
    expect(prompts.map((prompt) => prompt.state)).toEqual(['waiting', 'finished'])
    expect(service.openCount).toBe(0)
    expect(dropped).toEqual([])
  })

  it('starts no tunnel for an open that was between sign-in and start', async () => {
    const { runtime, spawned } = fakeRuntime()
    let portPicked!: (port: number) => void
    vi.mocked(runtime.freePort).mockImplementationOnce(
      () => new Promise<number>((resolve) => (portPicked = resolve))
    )
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    const opening = service.open(BROWSER_CONFIG)
    await vi.waitFor(() => expect(runtime.freePort).toHaveBeenCalled())
    await service.closeAll()
    portPicked(5001)

    await expect(opening).rejects.toThrow(CloudflaredTunnelError)
    expect(spawned.map(({ args }) => args[1])).toEqual(['login'])
    expect(service.openCount).toBe(0)
  })
})

describe('version', () => {
  it('reads the version cloudflared reports', async () => {
    const { runtime, spawned } = fakeRuntime({
      onSpawn: ({ child }) => {
        child.stdout.write('cloudflared version 2025.8.1 (built 2025-08-21-1534 UTC)\n')
        child.finish(0)
      }
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(service.version()).resolves.toBe('2025.8.1')
    expect(spawnedAt(spawned, 0).args).toEqual(['--version'])
  })

  it('reports a cloudflared missing from PATH as not found', async () => {
    const { runtime } = fakeRuntime({ onSpawn: ({ child }) => child.fail('ENOENT') })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(service.version()).rejects.toThrow(/not found on PATH/)
  })

  it('reports a program that names no cloudflared version as not found', async () => {
    const { runtime } = fakeRuntime({
      onSpawn: ({ child }) => {
        child.stdout.write('something else entirely\n')
        child.finish(0)
      }
    })
    const service = new CloudflaredTunnelService(noPrompts, runtime)

    await expect(service.version('C:\\tools\\cloudflared.exe')).rejects.toThrow(
      CloudflaredNotFoundError
    )
  })
})
