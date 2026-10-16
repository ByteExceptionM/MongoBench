import type { ConnectionConfig } from '@shared/types'

/**
 * Compose a human-readable connection string for display.
 *
 * The renderer-facing `connection.uri` has its auth section stripped on
 * the main side (see ConnectionsRepository.toRendererView), so the
 * cleartext password and the storage placeholder never reach the renderer.
 * For UI we re-attach the username and a `••••` mask when applicable.
 */
export function formatConnectionUri(connection: ConnectionConfig): string {
  const match = /^(mongodb(?:\+srv)?:\/\/)/.exec(connection.uri)
  if (!match || !connection.username) return connection.uri
  const scheme = match[0]
  const rest = connection.uri.slice(scheme.length)
  const auth = connection.hasStoredPassword
    ? `${connection.username}:••••@`
    : `${connection.username}@`
  return `${scheme}${auth}${rest}`
}

/** Where the connection goes: the Access hostname behind a Cloudflare tunnel, else its URI. */
export function formatConnectionAddress(connection: ConnectionConfig): string {
  // A Cloudflare tunnel never dials the URI's hosts; the Access hostname is where it goes.
  return connection.cloudflared?.enabled === true ? connection.cloudflared.hostname : connection.uri
}

/**
 * Compact host display for sidebar rows: just the host (and port, when present).
 * Drops the scheme, any path, and any query parameters. For comma-separated
 * replica-set hosts we keep them all.
 */
export function formatHostShort(connection: ConnectionConfig): string {
  const address = formatConnectionAddress(connection)
  const match = /^mongodb(?:\+srv)?:\/\//.exec(address)
  if (!match) return address
  const rest = address.slice(match[0].length)
  const stop = rest.search(/[/?#]/)
  return stop === -1 ? rest : rest.slice(0, stop)
}
