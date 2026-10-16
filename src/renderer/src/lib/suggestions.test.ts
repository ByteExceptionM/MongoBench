import { describe, expect, it } from 'vitest'
import { rankSuggestions } from './suggestions'

describe('rankSuggestions', () => {
  it('returns the pool in its original order for an empty input', () => {
    expect(rankSuggestions('', ['zeta', 'alpha', 'mid'])).toEqual(['zeta', 'alpha', 'mid'])
    expect(rankSuggestions('   ', ['zeta', 'alpha'])).toEqual(['zeta', 'alpha'])
  })

  it('caps an empty-input result at the limit', () => {
    const pool = Array.from({ length: 80 }, (_, i) => `f${i}`)
    expect(rankSuggestions('', pool)).toEqual(pool.slice(0, 50))
    expect(rankSuggestions('', pool, 3)).toEqual(['f0', 'f1', 'f2'])
  })

  it('matches substrings case-insensitively', () => {
    expect(rankSuggestions('WRITE', ['read', 'readWrite', 'writer', 'dbOwner'])).toEqual([
      'writer',
      'readWrite'
    ])
  })

  it('puts prefix matches before infix matches, each group alphabetical', () => {
    expect(rankSuggestions('ad', ['readAnyDatabase', 'admin', 'dbAdmin', 'adHoc'])).toEqual([
      'adHoc',
      'admin',
      'dbAdmin',
      'readAnyDatabase'
    ])
  })

  it('trims the input before matching', () => {
    expect(rankSuggestions('  user ', ['userAdmin', 'name'])).toEqual(['userAdmin'])
  })

  it('returns nothing once the value equals the only match', () => {
    expect(rankSuggestions('dbOwner', ['dbOwner', 'read'])).toEqual([])
    expect(rankSuggestions(' dbOwner ', ['dbOwner', 'read'])).toEqual([])
  })

  it('keeps an exact match while other candidates remain', () => {
    expect(rankSuggestions('read', ['read', 'readWrite'])).toEqual(['read', 'readWrite'])
  })

  it('caps a filtered result at the limit', () => {
    const pool = Array.from({ length: 60 }, (_, i) => `role${String(i).padStart(2, '0')}`)
    expect(rankSuggestions('role', pool)).toHaveLength(50)
    expect(rankSuggestions('role', pool, 2)).toEqual(['role00', 'role01'])
  })

  it('does not mutate the pool', () => {
    const pool = ['b', 'ab', 'a']
    rankSuggestions('a', pool)
    expect(pool).toEqual(['b', 'ab', 'a'])
  })
})
