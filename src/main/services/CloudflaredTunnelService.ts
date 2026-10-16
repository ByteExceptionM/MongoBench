import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer, type AddressInfo } from 'node:net'
import log from 'electron-log/main'
import { isCloudflaredExecutable } from '@shared/cloudflared'
import type { CloudflaredLoginPrompt } from '@shared/events'
import type { CloudflaredAuthMethod } from '@shared/types'
import { findLoginUrl, OutputTail, splitLines } from '../lib/cloudflaredLog'
import { cancelledError } from '../lib/errorMap'
import type { Tunnel } from '../lib/tunnel'

const LOOPBACK = '127.0.0.1'
const PATH_COMMAND = 'cloudflared'
const STARTUP_TIMEOUT_MS = 15_000
const PROBE_INTERVAL_MS = 100
// Last resort only: cloudflared gives up by itself after 10 long polls of up to 60 s.
const LOGIN_TIMEOUT_MS = 15 * 60_000
const VERSION_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 3_000
const BIND_ATTEMPTS = 2
// Spawn errors that mean the file cannot run; Windows reports a file that is no executable as UNKNOWN.
const FILE_ERRORS = new Set([
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'EPERM',
  'EINVAL',
  'ENOEXEC',
  'UNKNOWN'
])

/** Tunnel settings with every secret already decrypted. */
export type ResolvedCloudflaredTunnel = {
  hostname: string
  authMethod: CloudflaredAuthMethod
  serviceTokenId?: string
  serviceTokenSecret?: string
  /** Absent = `cloudflared` resolved through PATH. */
  binaryPath?: string
}

export class CloudflaredNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CloudflaredNotFoundError'
  }
}

export class CloudflaredAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CloudflaredAuthError'
  }
}

export class CloudflaredTunnelError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CloudflaredTunnelError'
  }
}

// Keeps the parent's name, so a bind failure the retry cannot fix still maps to cloudflared_failed.
class PortTakenError extends CloudflaredTunnelError {}

/** Process and socket primitives, injectable so tests never start cloudflared. */
export type CloudflaredRuntime = {
  spawn: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess
  freePort: () => Promise<number>
  /** True once something accepts TCP connections on the loopback port. */
  isListening: (port: number) => Promise<boolean>
}

const nodeRuntime: CloudflaredRuntime = {
  spawn: (command, args, env) =>
    // No shell: the hostname and path reach cloudflared as plain argv entries.
    spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  freePort: () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, LOOPBACK, () => {
        const { port } = server.address() as AddressInfo
        server.close(() => resolve(port))
      })
    }),
  isListening: (port) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host: LOOPBACK, port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
}

type Exit = { code: number | null; error: Error | null }

type Launched = {
  child: ChildProcess
  output: OutputTail
  /** Settles once the process is gone and its output has been read to the end. */
  exited: Promise<Exit>
  /** What `exited` settled with, or null while the process still runs. */
  ended: () => Exit | null
}

/** Runs one `cloudflared access tcp` process per tunnel, on a free loopback port the driver dials. */
export class CloudflaredTunnelService {
  private readonly active = new Set<Tunnel>()
  private readonly processes = new Set<ChildProcess>()
  private closing = false

  constructor(
    private readonly onLogin: (prompt: CloudflaredLoginPrompt) => void,
    /** Overridable so tests never spawn cloudflared. */
    private readonly runtime: CloudflaredRuntime = nodeRuntime
  ) {}

  get openCount(): number {
    return this.active.size
  }

  /**
   * Version of the cloudflared that would run.
   * @param binaryPath absolute path; omit to use PATH.
   * @throws CloudflaredNotFoundError when it cannot be run or reports no version.
   */
  async version(binaryPath?: string): Promise<string> {
    const command = commandFor(binaryPath)
    const { child, output, exited } = this.launch(command, ['--version'], cleanEnv())
    const timer = setTimeout(() => void this.stop(child), VERSION_TIMEOUT_MS)
    const { error } = await exited
    clearTimeout(timer)
    if (error !== null) throw spawnFailure(command, error)
    const version = /cloudflared version (\S+)/.exec(output.text())?.[1]
    if (version === undefined) {
      throw new CloudflaredNotFoundError(`${command} did not report a cloudflared version!`)
    }
    return version
  }

  /**
   * Starts a tunnel, signing in first for browser auth.
   * @param onDropped fires when cloudflared dies on its own, never on `close()`.
   * @param signal aborting it stops a pending sign-in; the open then rejects as cancelled.
   */
  async open(
    config: ResolvedCloudflaredTunnel,
    onDropped?: (reason: string) => void,
    signal?: AbortSignal
  ): Promise<Tunnel> {
    const command = commandFor(config.binaryPath)
    // Before any spawn, so an incomplete service token fails without starting anything.
    const env = tunnelEnv(config)
    // access tcp fetches its token only when the driver connects, racing the driver's timeout; access login returns at once with a cached session.
    if (config.authMethod === 'browser') await this.login(command, config.hostname, signal)

    for (let attempt = 1; ; attempt++) {
      try {
        const port = await this.runtime.freePort()
        throwIfCancelled(signal, config.hostname)
        return await this.start(command, config, env, port, onDropped)
      } catch (error) {
        // The port was only free when it was picked; another process can bind it before cloudflared does.
        if (error instanceof PortTakenError && attempt < BIND_ATTEMPTS) continue
        throw error
      }
    }
  }

  async closeAll(): Promise<void> {
    // One-way, since only quitting calls this: an open still on its way must not spawn after the sweep below.
    this.closing = true
    await Promise.allSettled([...this.active].map((tunnel) => tunnel.close()))
    // Sign-ins and tunnels still starting have no handle yet.
    await Promise.allSettled([...this.processes].map((child) => this.stop(child)))
  }

  private async login(command: string, hostname: string, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal, hostname)
    let prompted = false
    let timedOut = false
    const { child, output, exited } = this.launch(
      command,
      // --quiet keeps the JWT out of the captured output.
      ['access', 'login', '--quiet', '--auto-close', `https://${hostname}`],
      cleanEnv(),
      this.announceLogin(hostname, () => {
        prompted = true
      })
    )
    const timer = setTimeout(() => {
      timedOut = true
      void this.stop(child)
    }, LOGIN_TIMEOUT_MS)
    const stopOnAbort = (): void => void this.stop(child)
    signal?.addEventListener('abort', stopOnAbort, { once: true })
    const { code, error } = await exited
    clearTimeout(timer)
    signal?.removeEventListener('abort', stopOnAbort)

    if (prompted) this.onLogin({ hostname, state: 'finished' })
    if (error !== null) throw spawnFailure(command, error)
    throwIfCancelled(signal, hostname)
    if (timedOut) {
      throw new CloudflaredAuthError(
        `The Cloudflare Access sign-in to ${hostname} did not finish within ${LOGIN_TIMEOUT_MS / 60_000} minutes!`
      )
    }
    if (code !== 0) {
      throw new CloudflaredAuthError(
        `Cloudflare Access sign-in to ${hostname} failed: ${output.describe()}!`
      )
    }
  }

  private async start(
    command: string,
    config: ResolvedCloudflaredTunnel,
    env: NodeJS.ProcessEnv,
    port: number,
    onDropped?: (reason: string) => void
  ): Promise<Tunnel> {
    const { hostname } = config
    let loginPrompted = false
    const { child, output, exited, ended } = this.launch(
      command,
      ['access', 'tcp', `--hostname=${hostname}`, `--url=${LOOPBACK}:${port}`],
      env,
      // An Access session that expires while connected starts a browser sign-in of its own.
      this.announceLogin(hostname, () => {
        loginPrompted = true
      })
    )

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    // cloudflared logs "Start Websocket listener" before it binds, so only a TCP probe shows the port is ready.
    for (;;) {
      const listening = await this.runtime.isListening(port)
      const exit = ended()
      if (exit !== null) throw startupFailure(command, hostname, port, exit, output)
      if (listening) break
      if (Date.now() >= deadline) {
        await this.stop(child)
        throw new CloudflaredTunnelError(
          `cloudflared did not open its local port for ${hostname} within ${STARTUP_TIMEOUT_MS / 1000} s: ${output.describe()}!`
        )
      }
      await delay(PROBE_INTERVAL_MS)
    }

    let closed = false
    let diedWith: string | null = null
    const tunnel: Tunnel = {
      route: { kind: 'localPort', host: LOOPBACK, port },
      pinnedHostKey: null,
      failure: () => {
        // A service token Access did not accept falls back to the browser flow (non-strict organisations).
        if (loginPrompted && config.authMethod === 'serviceToken') {
          return new CloudflaredAuthError(
            `Cloudflare Access asked for a browser sign-in although a service token is configured — check the client ID and secret, and that ${hostname} has a Service Auth policy!`
          )
        }
        if (diedWith !== null) {
          return new CloudflaredTunnelError(`Cloudflare tunnel to ${hostname} failed: ${diedWith}!`)
        }
        const reason = output.lastError()
        return reason === null
          ? null
          : new CloudflaredTunnelError(`Cloudflare tunnel to ${hostname} failed: ${reason}!`)
      },
      close: async () => {
        if (closed) return
        closed = true
        this.active.delete(tunnel)
        await this.stop(child)
        log.info(`Cloudflare tunnel to ${hostname} closed`)
      }
    }
    this.active.add(tunnel)

    void exited.then(({ code }) => {
      if (closed) return
      closed = true
      this.active.delete(tunnel)
      diedWith = `cloudflared exited${code !== null ? ` with code ${code}` : ''}: ${output.describe()}`
      log.warn(`Cloudflare tunnel to ${hostname} dropped: ${diedWith}`)
      onDropped?.(diedWith)
    })

    log.info(`Cloudflare tunnel to ${hostname} up on ${LOOPBACK}:${port}`)
    return tunnel
  }

  private announceLogin(hostname: string, onPrompt: () => void): (line: string) => void {
    return (line) => {
      const url = findLoginUrl(line, hostname)
      if (url === null) return
      onPrompt()
      this.onLogin({ hostname, state: 'waiting', url })
    }
  }

  private launch(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onLine?: (line: string) => void
  ): Launched {
    if (this.closing) throw new CloudflaredTunnelError('MongoBench is shutting down!')
    let child: ChildProcess
    try {
      child = this.runtime.spawn(command, args, env)
    } catch (error) {
      // Node refuses some spawns synchronously, e.g. UNKNOWN for a file that is no executable.
      throw spawnFailure(command, error)
    }
    this.processes.add(child)

    const output = new OutputTail()
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue
      stream.setEncoding('utf8')
      const lines = splitLines((line) => {
        output.add(line)
        onLine?.(line)
      })
      stream.on('data', (chunk: string) => lines.write(chunk))
      stream.on('end', () => lines.end())
    }

    let result: Exit | null = null
    const exited = new Promise<Exit>((resolve) => {
      // 'exit' may not follow 'error', and output can still be arriving at 'exit'.
      child.once('close', (code: number | null) => resolve({ code, error: null }))
      // Stays attached: an 'error' with no listener would take the main process down.
      child.on('error', (error: Error) => resolve({ code: null, error }))
    }).then((exit) => {
      this.processes.delete(child)
      result = exit
      return exit
    })
    return { child, output, exited, ended: () => result }
  }

  private stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, STOP_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
  }
}

function commandFor(binaryPath?: string): string {
  if (binaryPath === undefined) return PATH_COMMAND
  // Checked again here: the schema guards new input, not what connections.json already holds.
  if (!isCloudflaredExecutable(binaryPath)) {
    throw new CloudflaredNotFoundError(`${binaryPath} is not a cloudflared executable!`)
  }
  return binaryPath
}

function cleanEnv(): NodeJS.ProcessEnv {
  // An inherited TUNNEL_SERVICE_* variable would silently change what this connection configures.
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('TUNNEL_SERVICE_'))
  )
}

function tunnelEnv(config: ResolvedCloudflaredTunnel): NodeJS.ProcessEnv {
  if (config.authMethod === 'browser') return cleanEnv()
  const id = config.serviceTokenId ?? ''
  const secret = config.serviceTokenSecret ?? ''
  if (id.length === 0) throw new CloudflaredAuthError('No service token client ID is configured!')
  if (secret.length === 0) {
    throw new CloudflaredAuthError('No service token secret is stored for this connection!')
  }
  // Environment, not argv: argv shows up in process listings.
  return { ...cleanEnv(), TUNNEL_SERVICE_TOKEN_ID: id, TUNNEL_SERVICE_TOKEN_SECRET: secret }
}

function spawnFailure(
  command: string,
  error: unknown
): CloudflaredNotFoundError | CloudflaredTunnelError {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null
  if (code === null || !FILE_ERRORS.has(code)) {
    // Only the code: Node's message for a refused environment quotes the value, which can be the token.
    return new CloudflaredTunnelError(`Cannot start ${command}: ${code ?? 'unknown error'}!`, {
      cause: error
    })
  }
  const message =
    command === PATH_COMMAND && code === 'ENOENT'
      ? 'cloudflared was not found on PATH — install it or choose its executable in the connection settings!'
      : `Cannot run ${command}: ${code}!`
  return new CloudflaredNotFoundError(message, { cause: error })
}

function throwIfCancelled(signal: AbortSignal | undefined, hostname: string): void {
  if (signal?.aborted === true) {
    throw cancelledError(`Connecting to ${hostname} through Cloudflare Access was cancelled!`)
  }
}

function startupFailure(
  command: string,
  hostname: string,
  port: number,
  exit: Exit,
  output: OutputTail
): Error {
  if (exit.error !== null) return spawnFailure(command, exit.error)
  // Matched on cloudflared's own wording; the OS part of the message after it is localized.
  if (output.text().includes('failed to start forwarding server')) {
    return new PortTakenError(
      `cloudflared could not listen on ${LOOPBACK}:${port}: ${output.describe()}!`
    )
  }
  return new CloudflaredTunnelError(
    `cloudflared stopped before the tunnel to ${hostname} was up: ${output.describe()}!`
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
