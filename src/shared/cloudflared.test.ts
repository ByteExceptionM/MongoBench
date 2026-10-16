import { describe, expect, it } from 'vitest'
import {
  canReuseServiceTokenSecret,
  cloudflaredTunnelProblems,
  INVALID_CLOUDFLARED_PATH_MESSAGE,
  isAccessHostname,
  isCloudflaredExecutable
} from './cloudflared'

describe('isAccessHostname', () => {
  it.each([
    'mongo.example.com',
    'a-b.c.example.co.uk',
    'xn--bcher-kva.example.com',
    'Mongo.EXAMPLE.com'
  ])('accepts %s', (hostname) => {
    expect(isAccessHostname(hostname)).toBe(true)
  })

  it.each([
    ['a scheme', 'https://x.com'],
    ['a port', 'x.com:443'],
    ['a path', 'x.com/db'],
    ['a leading dash that cloudflared would read as a flag', '-x.example.com'],
    ['a label ending in a dash', 'x-.example.com'],
    ['a single label', 'localhost'],
    ['a wildcard', '*.example.com'],
    ['a space', 'a b.com'],
    ['an empty string', ''],
    ['a 64-character label', `${'a'.repeat(64)}.example.com`]
  ])('rejects %s', (_case, hostname) => {
    expect(isAccessHostname(hostname)).toBe(false)
  })

  it('accepts a 253-character name and rejects a 254-character one', () => {
    const labels = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.`
    expect(isAccessHostname(`${labels}${'d'.repeat(61)}`)).toBe(true)
    expect(isAccessHostname(`${labels}${'d'.repeat(62)}`)).toBe(false)
  })
})

describe('isCloudflaredExecutable', () => {
  it.each([
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\dl\\cloudflared-windows-amd64.exe',
    'C:/tools/cloudflared.exe',
    'D:\\Tools\\Cloudflared.EXE',
    '/usr/local/bin/cloudflared',
    '/opt/cloudflared-linux-amd64'
  ])('accepts %s', (path) => {
    expect(isCloudflaredExecutable(path)).toBe(true)
  })

  it.each([
    ['a bare file name', 'cloudflared.exe'],
    ['a relative path', '.\\bin\\cloudflared.exe'],
    ['a drive-relative path', 'C:cloudflared.exe'],
    ['another executable', 'C:\\Windows\\System32\\calc.exe'],
    ['another executable inside a cloudflared folder', 'C:\\cloudflared\\calc.exe'],
    ['a name that only contains cloudflared', 'C:\\tools\\not-cloudflared.exe'],
    ['a directory', '/usr/bin/cloudflared/'],
    ['an empty string', ''],
    ['a UNC path', '\\\\fileserver\\tools\\cloudflared.exe'],
    ['a WebDAV UNC path', '\\\\attacker.invalid@SSL@443\\DavWWWRoot\\cloudflared.exe'],
    ['a forward-slash UNC path', '//attacker.invalid/share/cloudflared.exe'],
    ['a POSIX path that starts like a UNC path', '/\\attacker.invalid\\share\\cloudflared'],
    ['an extended-length UNC path', '\\\\?\\UNC\\attacker.invalid\\share\\cloudflared.exe'],
    ['an extended-length drive path', '\\\\?\\C:\\tools\\cloudflared.exe'],
    ['a device path', '\\\\.\\C:\\tools\\cloudflared.exe'],
    ['an alternate data stream', 'C:\\tools\\cloudflared.exe:payload'],
    ['a screensaver named after cloudflared', 'C:\\Users\\Public\\cloudflared-anything.scr'],
    ['a batch file', 'C:\\tools\\cloudflared.cmd'],
    ['a second extension', 'C:\\tools\\cloudflared.exe.bat'],
    ['a NUL character', 'C:\\tools\0\\cloudflared.exe'],
    ['a stream path in a folder name', 'C:\\tools:x\\cloudflared.exe']
  ])('rejects %s', (_case, path) => {
    expect(isCloudflaredExecutable(path)).toBe(false)
  })
})

describe('cloudflaredTunnelProblems', () => {
  const uri = 'mongodb://localhost'
  const access = { enabled: true, hostname: 'mongo.example.com', authMethod: 'browser' as const }

  it('finds nothing for a complete tunnel or one that is off', () => {
    expect(cloudflaredTunnelProblems({ uri, cloudflared: access })).toEqual([])
    expect(cloudflaredTunnelProblems({ uri: 'mongodb+srv://x.example.com' })).toEqual([])
    expect(
      cloudflaredTunnelProblems({
        uri: 'mongodb+srv://x.example.com',
        cloudflared: { ...access, enabled: false, hostname: '' }
      })
    ).toEqual([])
  })

  it('lists every broken rule in form field order', () => {
    const problems = cloudflaredTunnelProblems({
      uri: 'mongodb+srv://x.example.com',
      cloudflared: {
        enabled: true,
        hostname: 'localhost',
        authMethod: 'serviceToken',
        binaryPath: 'C:\\Windows\\System32\\calc.exe'
      }
    })
    expect(problems.map((p) => p.path)).toEqual([
      ['uri'],
      ['cloudflared', 'hostname'],
      ['cloudflared', 'serviceTokenId'],
      ['cloudflared', 'binaryPath']
    ])
    expect(problems[3]?.message).toBe(INVALID_CLOUDFLARED_PATH_MESSAGE)
  })

  it('needs a client ID only for the service token method', () => {
    const cloudflared = { ...access, serviceTokenId: '' }
    expect(cloudflaredTunnelProblems({ uri, cloudflared })).toEqual([])
    expect(
      cloudflaredTunnelProblems({
        uri,
        cloudflared: { ...cloudflared, authMethod: 'serviceToken' }
      })
    ).toEqual([
      { path: ['cloudflared', 'serviceTokenId'], message: 'Service token client ID is required' }
    ])
  })
})

describe('canReuseServiceTokenSecret', () => {
  const saved = { hostname: 'mongo.example.com', serviceTokenId: 'abc.access' }

  it('reuses the saved secret for the hostname and client ID it was saved with', () => {
    expect(canReuseServiceTokenSecret(saved, { ...saved })).toBe(true)
  })

  it.each([
    ['another hostname', { ...saved, hostname: 'other-app.example.com' }],
    ['another client ID', { ...saved, serviceTokenId: 'other.access' }],
    ['no client ID', { hostname: saved.hostname }]
  ])('never sends it to %s', (_case, next) => {
    expect(canReuseServiceTokenSecret(saved, next)).toBe(false)
  })

  it('has nothing to reuse without a saved tunnel', () => {
    expect(canReuseServiceTokenSecret(undefined, saved)).toBe(false)
  })
})
