import { describe, expect, it } from 'vitest'
import { opensInBrowser } from './externalUrl'

describe('opensInBrowser', () => {
  it('lets an https URL go to the browser', () => {
    expect(
      opensInBrowser('https://mongo.example.com/cdn-cgi/access/cli?aud=abc&redirect_url=x')
    ).toBe(true)
  })

  it.each([
    ['plain http', 'http://example.com/'],
    ['a file URL', 'file:///C:/Windows/System32/calc.exe'],
    ['a UNC file URL', 'file://attacker.invalid/share/payload.exe'],
    ['a protocol handler', 'ms-msdt:/id PCWDiagnostic'],
    ['a search handler', 'search-ms:query=x&crumb=location:\\\\attacker.invalid\\share'],
    ['script', 'javascript:alert(1)'],
    ['a bare UNC path', '\\\\attacker.invalid\\share\\payload.exe'],
    ['an unparseable string', 'not a url']
  ])('keeps %s away from the operating system', (_case, url) => {
    expect(opensInBrowser(url)).toBe(false)
  })
})
