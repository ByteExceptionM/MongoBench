import { describe, expect, it } from 'vitest'
import { InvalidUriError } from './connectionUri'
import { applyTunnelRoute, preferTunnelFailure, type Tunnel, type TunnelRoute } from './tunnel'

const SOCKS: TunnelRoute = {
  kind: 'socks5',
  proxy: { proxyHost: '127.0.0.1', proxyPort: 1080, proxyUsername: 'u', proxyPassword: 'p' }
}
const LOCAL_PORT: TunnelRoute = { kind: 'localPort', host: '127.0.0.1', port: 5001 }

function driverError(name: string): Error {
  return Object.assign(new Error('driver says no'), { name })
}

function tunnelWith(failure: Error | null): Tunnel {
  return {
    route: LOCAL_PORT,
    pinnedHostKey: null,
    failure: () => failure,
    close: () => Promise.resolve()
  }
}

describe('applyTunnelRoute', () => {
  it('keeps the URI and adds the proxy options for a SOCKS5 route', () => {
    const uri = 'mongodb://alice:pw@mongo1.internal:27017,mongo2.internal:27017/db'
    expect(applyTunnelRoute(uri, { appName: 'MongoBench' }, SOCKS)).toEqual({
      uri,
      options: {
        appName: 'MongoBench',
        proxyHost: '127.0.0.1',
        proxyPort: 1080,
        proxyUsername: 'u',
        proxyPassword: 'p'
      }
    })
  })

  it('points the URI at the local port and names the server for TLS', () => {
    const target = applyTunnelRoute(
      'mongodb://alice:pw@Mongo.Example.com:27017/db?authSource=admin',
      { appName: 'MongoBench', tls: true },
      LOCAL_PORT
    )
    expect(target.uri).toBe('mongodb://alice:pw@127.0.0.1:5001/db?authSource=admin')
    expect(target.options).toEqual({
      appName: 'MongoBench',
      tls: true,
      directConnection: true,
      servername: 'mongo.example.com'
    })
  })

  it('forces a direct connection even when the options asked for discovery', () => {
    const target = applyTunnelRoute(
      'mongodb://a.example.com,b.example.com/db',
      { directConnection: false },
      LOCAL_PORT
    )
    expect(target.uri).toBe('mongodb://127.0.0.1:5001/db')
    expect(target.options.directConnection).toBe(true)
  })

  it('sets no servername for an IP host', () => {
    const target = applyTunnelRoute('mongodb://10.0.0.5:27017/db', {}, LOCAL_PORT)
    expect(target.options).toEqual({ directConnection: true })
  })

  it('rejects mongodb+srv:// on a local-port route', () => {
    expect(() => applyTunnelRoute('mongodb+srv://cluster.example.com/db', {}, LOCAL_PORT)).toThrow(
      InvalidUriError
    )
  })
})

describe('preferTunnelFailure', () => {
  const reason = new Error(
    'Cloudflare tunnel to mongo.example.com failed: websocket: bad handshake!'
  )

  it.each(['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError'])(
    'reports the tunnel reason instead of a %s',
    (name) => {
      expect(preferTunnelFailure(driverError(name), tunnelWith(reason))).toBe(reason)
    }
  )

  it('never masks a MongoDB authentication error', () => {
    const error = driverError('MongoAuthenticationError')
    expect(preferTunnelFailure(error, tunnelWith(reason))).toBe(error)
  })

  it('keeps the driver error without a tunnel', () => {
    const error = driverError('MongoServerSelectionError')
    expect(preferTunnelFailure(error, null)).toBe(error)
  })

  it('keeps the driver error when the tunnel knows of no failure', () => {
    const error = driverError('MongoServerSelectionError')
    expect(preferTunnelFailure(error, tunnelWith(null))).toBe(error)
  })
})
