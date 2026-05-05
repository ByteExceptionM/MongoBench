import type { ErrorCode } from '@shared/result'

/**
 * Map a thrown error (driver, filesystem, validation) to one of our
 * internal `ErrorCode`s. This is the only place that should pattern-match
 * driver-specific error fields.
 */
export function mapError(error: unknown): { code: ErrorCode; message: string; details?: unknown } {
  if (error instanceof Error) {
    const name = error.name
    const message = error.message
    const code = readCodeField(error)

    if (name === 'MongoServerSelectionError') {
      return { code: 'server_selection_timeout', message }
    }

    if (name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError') {
      return { code: 'network_error', message }
    }

    if (
      name === 'MongoAuthenticationError' ||
      code === 18 ||
      code === 13 ||
      /authentication failed/i.test(message)
    ) {
      return { code: 'auth_failed', message }
    }

    if (name === 'MongoServerError' || name === 'MongoBulkWriteError') {
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

function readCodeField(error: Error): number | null {
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}
