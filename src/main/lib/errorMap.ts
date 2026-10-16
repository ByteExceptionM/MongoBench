import type { ErrorCode } from '@shared/result'

/** An error `mapError` reports as `validation_error`: the request itself is invalid. */
export function validationError(message: string): Error {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

/** An error `mapError` reports as `cancelled`: the user stopped the operation, nothing failed. */
export function cancelledError(message: string): Error {
  const e = new Error(message)
  e.name = 'CancelledError'
  return e
}

/**
 * Map a thrown error (driver, filesystem, validation) to one of our
 * internal `ErrorCode`s. This is the only place that should pattern-match
 * driver-specific error fields.
 */
export function mapError(error: unknown): { code: ErrorCode; message: string; details?: unknown } {
  if (error instanceof Error) {
    const name = error.name
    const message = error.message
    const code = readNumberField(error, 'code')

    // Tunnel failures come before the driver checks: when a tunnel cannot be
    // opened the driver never runs, and reporting "server selection timed out"
    // for a rejected SSH key or a cloudflared that never started would point
    // at the wrong end of the problem.
    const named = CODE_BY_NAME.get(name)
    if (named !== undefined) {
      return { code: named, message }
    }

    if (
      name === 'MongoAuthenticationError' ||
      code === 18 ||
      code === 13 ||
      /authentication failed/i.test(message)
    ) {
      return { code: 'auth_failed', message }
    }

    // A failed insertMany / bulkWrite keeps earlier writes; saying so prevents a duplicating retry.
    if (name === 'MongoBulkWriteError') {
      const insertedCount = readNumberField(error, 'insertedCount')
      const progress = bulkProgress(error)
      return {
        code: 'driver_error',
        message: progress === null ? message : `${message} — ${progress} before this error`,
        details: {
          ...(code !== null ? { mongoCode: code } : {}),
          ...(insertedCount !== null ? { insertedCount } : {})
        }
      }
    }

    if (name === 'MongoServerError' || name === 'MongoWriteConcernError') {
      return {
        code: 'driver_error',
        message,
        details: code !== null ? { mongoCode: code } : undefined
      }
    }

    if (name === 'InvalidUriError' || /uri must start/i.test(message)) {
      return { code: 'validation_error', message }
    }

    if (name === 'ConnectionNotFoundError' || name === 'DocumentNotFoundError') {
      return { code: 'not_found', message }
    }

    if (name === 'DocumentConflictError' || name === 'DocumentImmutableIdError') {
      return { code: 'conflict', message }
    }

    if (name === 'ValidationError') {
      return { code: 'validation_error', message }
    }

    return { code: 'internal', message }
  }

  return { code: 'internal', message: 'Unknown error', details: error }
}

const CODE_BY_NAME: ReadonlyMap<string, ErrorCode> = new Map([
  ['SshHostKeyMismatchError', 'ssh_host_key_mismatch'],
  ['SshAuthError', 'ssh_auth_failed'],
  ['SshConnectError', 'ssh_connect_failed'],
  ['CloudflaredNotFoundError', 'cloudflared_not_found'],
  ['CloudflaredAuthError', 'cloudflared_auth_failed'],
  ['CloudflaredTunnelError', 'cloudflared_failed'],
  ['CancelledError', 'cancelled'],
  ['NotConnectedError', 'not_connected'],
  ['MongoServerSelectionError', 'server_selection_timeout'],
  ['MongoNetworkError', 'network_error'],
  ['MongoNetworkTimeoutError', 'network_error']
])

const BULK_COUNTS = [
  ['insertedCount', 'inserted'],
  ['matchedCount', 'matched'],
  ['modifiedCount', 'modified'],
  ['deletedCount', 'deleted'],
  ['upsertedCount', 'upserted']
] as const

type CountField = (typeof BULK_COUNTS)[number][0]

// "1 document was inserted, 3 matched and 2 deleted", or null when every counter is zero.
function bulkProgress(error: Error): string | null {
  const parts = BULK_COUNTS.flatMap(([field, verb]) => {
    const count = readNumberField(error, field)
    return count !== null && count > 0 ? [{ count, verb }] : []
  })
  const [first, ...rest] = parts
  if (first === undefined) return null
  const head = `${first.count} document${first.count === 1 ? ' was' : 's were'} ${first.verb}`
  const tail = rest.map(({ count, verb }) => `${count} ${verb}`)
  const last = tail.pop()
  return last === undefined ? head : `${[head, ...tail].join(', ')} and ${last}`
}

function readNumberField(error: Error, field: 'code' | CountField): number | null {
  const value = (error as unknown as Record<string, unknown>)[field]
  return typeof value === 'number' ? value : null
}
