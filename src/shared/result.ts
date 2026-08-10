/**
 * Result envelope used for every IPC handler return value.
 * No exceptions cross the IPC boundary — handlers always resolve a Result.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiErrorPayload }

export type ApiErrorPayload = {
  code: ErrorCode
  message: string
  details?: unknown
}

export const ErrorCodes = [
  'validation_error',
  'not_connected',
  'auth_failed',
  'network_error',
  'server_selection_timeout',
  'ssh_connect_failed',
  'ssh_auth_failed',
  'ssh_host_key_mismatch',
  'driver_error',
  'not_found',
  'conflict',
  'internal'
] as const

export type ErrorCode = (typeof ErrorCodes)[number]

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function err(code: ErrorCode, message: string, details?: unknown): Result<never> {
  const payload: ApiErrorPayload =
    details === undefined ? { code, message } : { code, message, details }
  return { ok: false, error: payload }
}
