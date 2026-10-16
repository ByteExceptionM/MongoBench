import type { MongoClientOptions } from 'mongodb'
import type { PinnedHostKeyNotice } from '@shared/types'
import { firstHostName, replaceHosts } from './connectionUri'
import { mapError } from './errorMap'

/** What the driver needs to route through a SOCKS5 tunnel. */
export type TunnelProxyOptions = {
  proxyHost: string
  proxyPort: number
  proxyUsername: string
  proxyPassword: string
}

/**
 * How the driver reaches the server through an open tunnel: a SOCKS5 proxy that
 * forwards any host by name, or one loopback port that leads to exactly one server.
 */
export type TunnelRoute =
  { kind: 'socks5'; proxy: TunnelProxyOptions } | { kind: 'localPort'; host: string; port: number }

/** An open tunnel. The caller owns it and is responsible for closing it. */
export type Tunnel = {
  route: TunnelRoute
  /** Set only when this open pinned a host key it had never seen. */
  pinnedHostKey: PinnedHostKeyNotice | null
  /** The tunnel's own error for traffic it could not carry, when it has one. */
  failure: () => Error | null
  close: () => Promise<void>
}

/**
 * The URI and options that send every driver socket through `route`.
 * @throws InvalidUriError when a local-port route meets a `mongodb+srv://` URI.
 */
export function applyTunnelRoute(
  uri: string,
  options: MongoClientOptions,
  route: TunnelRoute
): { uri: string; options: MongoClientOptions } {
  if (route.kind === 'socks5') return { uri, options: { ...options, ...route.proxy } }
  const servername = firstHostName(uri)
  return {
    uri: replaceHosts(uri, `${route.host}:${route.port}`),
    options: {
      ...options,
      // The port leads to one server; discovery would send the driver to member hosts the tunnel does not reach.
      directConnection: true,
      // The certificate names the server, not 127.0.0.1.
      ...(servername !== null ? { servername } : {})
    }
  }
}

/** A driver timeout behind a tunnel that knows why it failed is reported as the tunnel's reason. */
export function preferTunnelFailure(error: unknown, tunnel: Tunnel | null): unknown {
  const failure = tunnel?.failure() ?? null
  if (failure === null) return error
  const { code } = mapError(error)
  return code === 'server_selection_timeout' || code === 'network_error' ? failure : error
}
