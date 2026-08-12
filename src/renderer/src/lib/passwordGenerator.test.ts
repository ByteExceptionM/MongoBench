import { describe, expect, it } from 'vitest'
import {
  CHARSETS,
  DEFAULT_OPTIONS,
  generatePassword,
  MAX_LENGTH,
  MIN_LENGTH,
  type CharsetKey,
  type PasswordOptions
} from './passwordGenerator'

const allOff: Record<CharsetKey, boolean> = {
  lowercase: false,
  uppercase: false,
  digits: false,
  symbols: false
}

describe('generatePassword', () => {
  it('produces the requested length', () => {
    for (const length of [MIN_LENGTH, 16, 24, 64, MAX_LENGTH]) {
      expect(generatePassword({ ...DEFAULT_OPTIONS, length })).toHaveLength(length)
    }
  })

  it('clamps length to the allowed range', () => {
    expect(generatePassword({ ...DEFAULT_OPTIONS, length: 1 })).toHaveLength(MIN_LENGTH)
    expect(generatePassword({ ...DEFAULT_OPTIONS, length: 10_000 })).toHaveLength(MAX_LENGTH)
  })

  it('only uses characters from the enabled charsets', () => {
    const options: PasswordOptions = {
      length: 64,
      charsets: { ...allOff, lowercase: true, digits: true }
    }
    const allowed = new Set((CHARSETS.lowercase + CHARSETS.digits).split(''))
    for (let i = 0; i < 20; i++) {
      for (const ch of generatePassword(options)) {
        expect(allowed.has(ch)).toBe(true)
      }
    }
  })

  it('includes at least one character from every enabled charset', () => {
    for (let i = 0; i < 50; i++) {
      const pwd = generatePassword({ ...DEFAULT_OPTIONS, length: MIN_LENGTH })
      for (const key of Object.keys(CHARSETS) as CharsetKey[]) {
        const set = new Set(CHARSETS[key].split(''))
        expect(pwd.split('').some((ch) => set.has(ch))).toBe(true)
      }
    }
  })

  it('works with a single charset enabled', () => {
    const pwd = generatePassword({ length: 12, charsets: { ...allOff, digits: true } })
    expect(pwd).toMatch(/^[0-9]{12}$/)
  })

  it('throws when no charset is enabled', () => {
    expect(() => generatePassword({ length: 16, charsets: allOff })).toThrow()
  })

  it('does not repeat passwords', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      seen.add(generatePassword(DEFAULT_OPTIONS))
    }
    expect(seen.size).toBe(100)
  })
})
