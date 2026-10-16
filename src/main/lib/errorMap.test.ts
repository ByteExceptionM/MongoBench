import { describe, expect, it } from 'vitest'
import { MongoBulkWriteError, type BulkWriteResult } from 'mongodb'
import { cancelledError, mapError, validationError } from './errorMap'

function named(name: string, message = 'boom', fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name }, fields)
}

/** The driver's real class: `insertedCount` is a prototype getter over `result`, not an own field. */
function bulkWriteError(insertedCount: number): MongoBulkWriteError {
  return new MongoBulkWriteError(
    { message: 'E11000 duplicate key error collection: app.users index: _id_', code: 11000 },
    { insertedCount } as unknown as BulkWriteResult
  )
}

describe('mapError — tunnels', () => {
  it.each([
    ['SshHostKeyMismatchError', 'ssh_host_key_mismatch'],
    ['SshAuthError', 'ssh_auth_failed'],
    ['SshConnectError', 'ssh_connect_failed'],
    ['CloudflaredNotFoundError', 'cloudflared_not_found'],
    ['CloudflaredAuthError', 'cloudflared_auth_failed'],
    ['CloudflaredTunnelError', 'cloudflared_failed']
  ])('maps %s to %s and keeps the message', (name, code) => {
    expect(mapError(named(name, 'tunnel says no'))).toEqual({ code, message: 'tunnel says no' })
  })

  it('reports a tunnel failure even when its message mentions authentication', () => {
    expect(mapError(named('CloudflaredAuthError', 'Access authentication failed')).code).toBe(
      'cloudflared_auth_failed'
    )
    expect(mapError(named('SshAuthError', 'SSH authentication failed for tunneluser')).code).toBe(
      'ssh_auth_failed'
    )
  })
})

describe('mapError — app errors', () => {
  it('maps an error made by cancelledError to cancelled', () => {
    expect(mapError(cancelledError('Query cancelled'))).toEqual({
      code: 'cancelled',
      message: 'Query cancelled'
    })
  })

  it('maps NotConnectedError to not_connected', () => {
    expect(mapError(named('NotConnectedError', 'Connection c1 is not connected'))).toEqual({
      code: 'not_connected',
      message: 'Connection c1 is not connected'
    })
  })

  it.each([
    ['InvalidUriError', 'validation_error'],
    ['ValidationError', 'validation_error'],
    ['ConnectionNotFoundError', 'not_found'],
    ['DocumentNotFoundError', 'not_found'],
    ['DocumentConflictError', 'conflict'],
    ['DocumentImmutableIdError', 'conflict']
  ])('maps %s to %s', (name, code) => {
    expect(mapError(named(name, 'nope'))).toEqual({ code, message: 'nope' })
  })

  it('maps an error made by validationError to validation_error', () => {
    expect(mapError(validationError('bad input'))).toEqual({
      code: 'validation_error',
      message: 'bad input'
    })
  })

  it('treats an untagged "URI must start" message as a validation error', () => {
    expect(mapError(new Error('URI must start with mongodb:// or mongodb+srv://')).code).toBe(
      'validation_error'
    )
  })
})

describe('mapError — driver errors', () => {
  it('maps MongoServerSelectionError to server_selection_timeout', () => {
    expect(mapError(named('MongoServerSelectionError', 'timed out'))).toEqual({
      code: 'server_selection_timeout',
      message: 'timed out'
    })
  })

  it.each(['MongoNetworkError', 'MongoNetworkTimeoutError'])('maps %s to network_error', (name) => {
    expect(mapError(named(name, 'socket hang up'))).toEqual({
      code: 'network_error',
      message: 'socket hang up'
    })
  })

  it('recognises authentication failures by name, code 18, code 13 and message', () => {
    expect(mapError(named('MongoAuthenticationError')).code).toBe('auth_failed')
    expect(mapError(named('MongoServerError', 'x', { code: 18 })).code).toBe('auth_failed')
    expect(mapError(named('MongoServerError', 'x', { code: 13 })).code).toBe('auth_failed')
    expect(mapError(new Error('Authentication failed.')).code).toBe('auth_failed')
  })

  it('maps MongoServerError to driver_error with its numeric code', () => {
    expect(mapError(named('MongoServerError', 'ns not found', { code: 26 }))).toEqual({
      code: 'driver_error',
      message: 'ns not found',
      details: { mongoCode: 26 }
    })
  })

  it('maps MongoWriteConcernError to driver_error with its numeric code', () => {
    expect(
      mapError(named('MongoWriteConcernError', 'waiting for replication timed out', { code: 64 }))
    ).toEqual({
      code: 'driver_error',
      message: 'waiting for replication timed out',
      details: { mongoCode: 64 }
    })
  })

  it('omits details for a MongoServerError without a numeric code', () => {
    expect(mapError(named('MongoServerError', 'odd', { code: 'Location1' }))).toEqual({
      code: 'driver_error',
      message: 'odd',
      details: undefined
    })
  })
})

describe('mapError — MongoBulkWriteError', () => {
  it('says how many documents an ordered insertMany kept before failing', () => {
    const mapped = mapError(bulkWriteError(49))
    expect(mapped.code).toBe('driver_error')
    expect(mapped.message).toContain('E11000 duplicate key error')
    expect(mapped.message).toContain('49 documents were inserted')
    expect(mapped.details).toEqual({ mongoCode: 11000, insertedCount: 49 })
  })

  it('uses the singular for one inserted document', () => {
    expect(mapError(bulkWriteError(1)).message).toContain('1 document was inserted')
  })

  it('keeps the driver message unchanged when nothing was inserted', () => {
    expect(mapError(bulkWriteError(0))).toEqual({
      code: 'driver_error',
      message: 'E11000 duplicate key error collection: app.users index: _id_',
      details: { mongoCode: 11000, insertedCount: 0 }
    })
  })

  it('reports every non-zero counter of a partial bulkWrite', () => {
    const error = new MongoBulkWriteError({ message: 'E11000 duplicate key error', code: 11000 }, {
      insertedCount: 1,
      matchedCount: 4,
      modifiedCount: 3,
      deletedCount: 2,
      upsertedCount: 1
    } as unknown as BulkWriteResult)
    expect(mapError(error).message).toBe(
      'E11000 duplicate key error — 1 document was inserted, 4 matched, 3 modified, 2 deleted and 1 upserted before this error'
    )
  })

  it('leaves zero counters out and names the documents with the first one left', () => {
    const error = new MongoBulkWriteError({ message: 'E11000 duplicate key error', code: 11000 }, {
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 1,
      deletedCount: 2,
      upsertedCount: 0
    } as unknown as BulkWriteResult)
    expect(mapError(error).message).toBe(
      'E11000 duplicate key error — 1 document was modified and 2 deleted before this error'
    )
  })

  it('reports documents that only matched', () => {
    const error = new MongoBulkWriteError({ message: 'E11000 duplicate key error', code: 11000 }, {
      insertedCount: 0,
      matchedCount: 5,
      modifiedCount: 0
    } as unknown as BulkWriteResult)
    expect(mapError(error).message).toBe(
      'E11000 duplicate key error — 5 documents were matched before this error'
    )
  })

  it('keeps the driver message unchanged when every counter is zero', () => {
    const error = new MongoBulkWriteError({ message: 'E11000 duplicate key error', code: 11000 }, {
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0
    } as unknown as BulkWriteResult)
    expect(mapError(error)).toEqual({
      code: 'driver_error',
      message: 'E11000 duplicate key error',
      details: { mongoCode: 11000, insertedCount: 0 }
    })
  })
})

describe('mapError — fallbacks', () => {
  it('maps an unknown Error to internal with its message', () => {
    expect(mapError(named('Socks5ProtocolError', 'bad reply'))).toEqual({
      code: 'internal',
      message: 'bad reply'
    })
  })

  it('maps a non-Error value to internal and carries it as details', () => {
    expect(mapError('kaputt')).toEqual({
      code: 'internal',
      message: 'Unknown error',
      details: 'kaputt'
    })
  })
})
