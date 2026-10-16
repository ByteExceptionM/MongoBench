/**
 * Rules for the Cloudflare Access tunnel, shared by main, the IPC schemas and
 * the connection form so all of them apply the same ones.
 */

import type { ConnectionInput } from './types'

// Two or more DNS labels: no scheme, port, path or wildcard — and no leading '-' that cloudflared could read as a flag.
const ACCESS_HOSTNAME =
  /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+(?!-)[a-z0-9-]{2,63}(?<!-)$/i
// A drive or POSIX root, then no ':' (alternate data streams) and no NUL; `\\`, `//` and `\\?\` reach other machines or devices.
const LOCAL_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\/(?![\\/]))[^:\0]*$/i
// The names cloudflared releases ship under, e.g. cloudflared.exe or cloudflared-linux-amd64; no other extension.
const CLOUDFLARED_FILE_NAME = /^cloudflared[\w-]*(?:\.exe)?$/i

type AccessTarget = { hostname: string; serviceTokenId?: string }

/** A rule an enabled tunnel breaks, with the path of the connection input field it concerns. */
export type CloudflaredTunnelProblem = { path: string[]; message: string }

/** Shown wherever a binary path fails `isCloudflaredExecutable`. */
export const INVALID_CLOUDFLARED_PATH_MESSAGE =
  'Choose the cloudflared executable on this computer (absolute path)'

/** True for a bare DNS hostname such as `mongo.example.com`. */
export function isAccessHostname(value: string): boolean {
  return ACCESS_HOSTNAME.test(value)
}

/** True for an absolute local path to a file named like a cloudflared release. */
export function isCloudflaredExecutable(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  // Main runs whatever this names; tying it to a local cloudflared file keeps a renderer from picking any binary.
  return LOCAL_ABSOLUTE_PATH.test(path) && CLOUDFLARED_FILE_NAME.test(name)
}

/** Rules of an enabled tunnel that `input` breaks, in form field order; empty while it is off. */
export function cloudflaredTunnelProblems(
  input: Pick<ConnectionInput, 'uri' | 'cloudflared'>
): CloudflaredTunnelProblem[] {
  const cf = input.cloudflared
  if (cf?.enabled !== true) return []
  const problems: CloudflaredTunnelProblem[] = []
  if (input.uri.startsWith('mongodb+srv://')) {
    problems.push({
      path: ['uri'],
      message:
        'A Cloudflare tunnel needs a mongodb:// connection string — mongodb+srv:// resolves its hosts through DNS'
    })
  }
  if (!isAccessHostname(cf.hostname)) {
    problems.push({
      path: ['cloudflared', 'hostname'],
      message: 'Enter the Access application hostname, e.g. mongo.example.com'
    })
  }
  if (cf.authMethod === 'serviceToken' && (cf.serviceTokenId ?? '').length === 0) {
    problems.push({
      path: ['cloudflared', 'serviceTokenId'],
      message: 'Service token client ID is required'
    })
  }
  if (cf.binaryPath !== undefined && !isCloudflaredExecutable(cf.binaryPath)) {
    problems.push({
      path: ['cloudflared', 'binaryPath'],
      message: INVALID_CLOUDFLARED_PATH_MESSAGE
    })
  }
  return problems
}

/** True when a saved service token secret may go to `next`: only the hostname and client ID it was saved for. */
export function canReuseServiceTokenSecret(
  saved: AccessTarget | undefined,
  next: AccessTarget
): boolean {
  return (
    saved !== undefined &&
    saved.hostname === next.hostname &&
    (saved.serviceTokenId ?? '') === (next.serviceTokenId ?? '')
  )
}
