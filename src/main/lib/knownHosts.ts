/**
 * Reading side of OpenSSH's `known_hosts`. MongoBench never writes that file,
 * it only consults it, so a host the user already accepted in their own SSH
 * client is trusted here too. Pure — the caller supplies the contents.
 *
 * Supported: plain patterns (with `*` / `?` wildcards and `!` negation), the
 * `[host]:port` form, and `|1|salt|hash` hashed entries. `@cert-authority` and
 * `@revoked` lines are skipped; we do not implement CA validation, and
 * skipping is the safe direction since such a line then authorises nothing.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DEFAULT_SSH_PORT } from '@shared/types'

export type HostMatcher =
  | { kind: 'plain'; pattern: string; negated: boolean }
  | { kind: 'hashed'; salt: Buffer; digest: Buffer }

export type KnownHostEntry = {
  hosts: HostMatcher[]
  /** e.g. `ssh-ed25519`. Diagnostics only; matching goes by key bytes. */
  keyType: string
  key: Buffer
}

export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith('@')) continue

    const [hostField, keyType, keyBase64] = line.split(/\s+/)
    if (hostField === undefined || keyType === undefined || keyBase64 === undefined) continue

    const key = Buffer.from(keyBase64, 'base64')
    if (key.length === 0) continue

    const hosts = hostField.split(',').flatMap(parseMatcher)
    if (hosts.length === 0) continue

    entries.push({ hosts, keyType, key })
  }
  return entries
}

function parseMatcher(token: string): HostMatcher[] {
  if (token.length === 0) return []

  if (token.startsWith('|')) {
    // |1|<base64 salt>|<base64 HMAC-SHA1 of the host name>
    const parts = token.split('|')
    if (parts.length !== 4 || parts[1] !== '1') return []
    const salt = Buffer.from(parts[2] ?? '', 'base64')
    const digest = Buffer.from(parts[3] ?? '', 'base64')
    if (salt.length === 0 || digest.length === 0) return []
    return [{ kind: 'hashed', salt, digest }]
  }

  const negated = token.startsWith('!')
  return [{ kind: 'plain', pattern: negated ? token.slice(1) : token, negated }]
}

/**
 * The names OpenSSH looks up: the bare name on port 22, `[name]:port`
 * otherwise. Hashed entries hash exactly these strings, so one list drives
 * both matcher kinds.
 */
function candidateNames(host: string, port: number): string[] {
  const name = host.toLowerCase()
  return port === DEFAULT_SSH_PORT ? [name, `[${name}]:${port}`] : [`[${name}]:${port}`]
}

/** Every key the file authorises for this host, in file order. */
export function findHostKeys(entries: KnownHostEntry[], host: string, port: number): Buffer[] {
  const names = candidateNames(host, port)
  const keys: Buffer[] = []
  for (const entry of entries) {
    if (entryMatches(entry, names)) keys.push(entry.key)
  }
  return keys
}

function entryMatches(entry: KnownHostEntry, names: string[]): boolean {
  let matched = false
  for (const matcher of entry.hosts) {
    for (const name of names) {
      if (!matcherMatches(matcher, name)) continue
      // A negated pattern vetoes the whole line, however else it matched.
      if (matcher.kind === 'plain' && matcher.negated) return false
      matched = true
    }
  }
  return matched
}

function matcherMatches(matcher: HostMatcher, name: string): boolean {
  if (matcher.kind === 'hashed') {
    const digest = createHmac('sha1', matcher.salt).update(name).digest()
    return keyMatches(digest, matcher.digest)
  }
  return globMatches(matcher.pattern.toLowerCase(), name)
}

function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === value
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${expression}$`).test(value)
}

/** Length-tolerant constant-time compare of two key blobs. */
export function keyMatches(candidate: Buffer, known: Buffer): boolean {
  return candidate.length === known.length && timingSafeEqual(candidate, known)
}

/** OpenSSH's `SHA256:…` fingerprint of a raw public key blob. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}
