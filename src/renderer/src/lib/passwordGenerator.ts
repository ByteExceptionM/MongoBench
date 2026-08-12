export type CharsetKey = 'lowercase' | 'uppercase' | 'digits' | 'symbols'

export type PasswordOptions = {
  length: number
  charsets: Record<CharsetKey, boolean>
}

export const CHARSETS: Record<CharsetKey, string> = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}:,.?~'
}

export const MIN_LENGTH = 8
export const MAX_LENGTH = 128

export const DEFAULT_OPTIONS: PasswordOptions = {
  length: 24,
  charsets: { lowercase: true, uppercase: true, digits: true, symbols: true }
}

/**
 * Uniform random integer in [0, maxExclusive) from the platform CSPRNG.
 * Rejection sampling avoids the modulo bias a plain `x % max` would introduce.
 */
function secureRandomInt(maxExclusive: number): number {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
  let value: number
  do {
    crypto.getRandomValues(buf)
    value = buf[0] as number
  } while (value >= limit)
  return value % maxExclusive
}

/**
 * Generates a password from the enabled charsets, guaranteeing at least one
 * character from each. All randomness comes from `crypto.getRandomValues`.
 */
export function generatePassword(options: PasswordOptions): string {
  const enabled = (Object.keys(CHARSETS) as CharsetKey[]).filter((k) => options.charsets[k])
  if (enabled.length === 0) throw new Error('At least one character set must be enabled')

  const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(options.length)))
  const pool = enabled.map((k) => CHARSETS[k]).join('')

  const chars: string[] = []
  for (const key of enabled) {
    const set = CHARSETS[key]
    chars.push(set.charAt(secureRandomInt(set.length)))
  }
  while (chars.length < length) {
    chars.push(pool.charAt(secureRandomInt(pool.length)))
  }

  // Fisher-Yates so the guaranteed per-set characters don't sit at fixed positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1)
    const tmp = chars[i] as string
    chars[i] = chars[j] as string
    chars[j] = tmp
  }
  return chars.join('')
}
