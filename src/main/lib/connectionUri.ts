/**
 * Helpers for splitting / reassembling MongoDB connection URIs.
 *
 * MongoBench stores URIs in a "canonical" form where the password (if any)
 * is replaced by a placeholder token; the cleartext password lives only in
 * the encrypted secret slot. When connecting, we reverse the replacement.
 *
 * The placeholder is itself URL-encoded so it never collides with user data
 * and is invariant under accidental decode/encode round-trips by other code.
 */

import { isIP } from 'node:net'

const SCHEME_RE = /^(mongodb(?:\+srv)?):\/\//
const PASSWORD_PLACEHOLDER = '%3CMONGOBENCH_PWD%3E'

export class InvalidUriError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidUriError'
  }
}

export type UriParts = {
  scheme: 'mongodb' | 'mongodb+srv'
  schemeWithSep: string
  inlineUsername: string | null
  inlinePassword: string | null
  hostAndRest: string
}

export function parseUri(uri: string): UriParts {
  const match = SCHEME_RE.exec(uri)
  if (!match) {
    throw new InvalidUriError('URI must start with mongodb:// or mongodb+srv://')
  }
  const schemeWithSep = match[0]
  const scheme = match[1] as 'mongodb' | 'mongodb+srv'
  const rest = uri.slice(schemeWithSep.length)
  const slashIdx = rest.indexOf('/')
  const atIdx = rest.indexOf('@')
  const hasAuth = atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)

  if (!hasAuth) {
    return {
      scheme,
      schemeWithSep,
      inlineUsername: null,
      inlinePassword: null,
      hostAndRest: rest
    }
  }

  const userInfo = rest.slice(0, atIdx)
  const colonIdx = userInfo.indexOf(':')
  const usernameRaw = colonIdx === -1 ? userInfo : userInfo.slice(0, colonIdx)
  const passwordRaw = colonIdx === -1 ? null : userInfo.slice(colonIdx + 1)

  return {
    scheme,
    schemeWithSep,
    inlineUsername: decodeURIComponent(usernameRaw),
    inlinePassword: passwordRaw === null ? null : decodeURIComponent(passwordRaw),
    hostAndRest: rest.slice(atIdx + 1)
  }
}

/**
 * Combine a URI with optional form-supplied credentials and return:
 *  - storageUri: URI with the password (if any) replaced by the placeholder
 *  - username:   the effective username (URI inline wins over form input)
 *  - password:   the effective cleartext password, or null
 *
 * Inline URI credentials always take precedence over form fields.
 */
export function canonicalize(input: { uri: string; username?: string; password?: string }): {
  storageUri: string
  username: string | null
  password: string | null
} {
  const parts = parseUri(input.uri)
  const username = parts.inlineUsername ?? input.username ?? null
  const password = parts.inlinePassword ?? input.password ?? null

  if (username === null) {
    return {
      storageUri: `${parts.schemeWithSep}${parts.hostAndRest}`,
      username: null,
      password: null
    }
  }

  const auth =
    password !== null
      ? `${encodeURIComponent(username)}:${PASSWORD_PLACEHOLDER}@`
      : `${encodeURIComponent(username)}@`

  return {
    storageUri: `${parts.schemeWithSep}${auth}${parts.hostAndRest}`,
    username,
    password
  }
}

/**
 * Substitute the password placeholder in a stored URI with an encoded
 * cleartext password. If no placeholder is present, returns the URI unchanged.
 */
export function injectStoredPassword(storageUri: string, password: string): string {
  return storageUri.split(PASSWORD_PLACEHOLDER).join(encodeURIComponent(password))
}

/**
 * Returns true if the URI has the placeholder (i.e., a stored password
 * is needed before this URI can be used to connect).
 */
export function hasPasswordPlaceholder(storageUri: string): boolean {
  return storageUri.includes(PASSWORD_PLACEHOLDER)
}

/**
 * Ensure a storage URI carries the password placeholder for its inline
 * username. No-op if the URI has no username, or if it already has any
 * password segment (inc. the placeholder).
 *
 * Used to repair the storage URI when an existing encrypted password is
 * preserved through an edit but the form-supplied password was empty,
 * which would otherwise produce `mongodb://user@host` with no slot for
 * the stored password to be injected at connect time.
 */
export function ensurePasswordPlaceholder(storageUri: string): string {
  const parts = parseUri(storageUri)
  if (parts.inlineUsername === null) return storageUri
  if (parts.inlinePassword !== null) return storageUri
  return `${parts.schemeWithSep}${encodeURIComponent(parts.inlineUsername)}:${PASSWORD_PLACEHOLDER}@${parts.hostAndRest}`
}

/**
 * Build a URI with explicit username and password, replacing any existing
 * auth section. Used to heal stored connections whose URI lost its
 * placeholder during an earlier broken save round-trip.
 */
export function injectExternalCredentials(uri: string, username: string, password: string): string {
  const parts = parseUri(uri)
  return `${parts.schemeWithSep}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parts.hostAndRest}`
}

/**
 * Swaps the host list of a `mongodb://` URI for one address, keeping credentials, database and options byte for byte.
 * @param address `host:port` the driver should dial instead.
 * @throws InvalidUriError for `mongodb+srv://`, whose hosts come from DNS.
 */
export function replaceHosts(uri: string, address: string): string {
  const parts = parseUri(uri)
  if (parts.scheme === 'mongodb+srv') {
    throw new InvalidUriError('mongodb+srv:// cannot run through a single forwarded port')
  }
  // Raw slice, so an injected password or the placeholder survives unchanged.
  const prefix = uri.slice(0, uri.length - parts.hostAndRest.length)
  const stop = parts.hostAndRest.search(/[/?]/)
  return prefix + address + (stop === -1 ? '' : parts.hostAndRest.slice(stop))
}

/**
 * The first host of a URI when it is a DNS name, lower-cased, for TLS certificate checks.
 * @returns null for IP literals (incl. `[…]`) and percent-encoded socket paths.
 */
export function firstHostName(uri: string): string | null {
  const { hostAndRest } = parseUri(uri)
  const stop = hostAndRest.search(/[/?]/)
  const hosts = stop === -1 ? hostAndRest : hostAndRest.slice(0, stop)
  const first = hosts.split(',')[0] ?? ''
  if (first.startsWith('[')) return null
  const colon = first.lastIndexOf(':')
  const host = decodeURIComponent(colon === -1 ? first : first.slice(0, colon))
  if (host.length === 0 || host.includes('/') || isIP(host) !== 0) return null
  return host.toLowerCase()
}
