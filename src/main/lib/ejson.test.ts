import { describe, expect, it } from 'vitest'
import { Binary, Decimal128, Long, ObjectId } from 'bson'
import { canonicalHash, parseFilter, toCanonicalString, toRelaxed } from './ejson'

describe('toRelaxed', () => {
  it('wraps ObjectId as { $oid }', () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011')
    const out = toRelaxed({ _id: oid }) as { _id: { $oid: string } }
    expect(out._id).toEqual({ $oid: '507f1f77bcf86cd799439011' })
  })

  it('wraps Date in { $date }', () => {
    const d = new Date('2026-01-15T10:30:00.123Z')
    const out = toRelaxed({ at: d }) as { at: { $date: string } }
    expect(out.at.$date).toBe('2026-01-15T10:30:00.123Z')
  })

  it('wraps Decimal128 as { $numberDecimal }', () => {
    const dec = Decimal128.fromString('12345.6789')
    const out = toRelaxed({ price: dec }) as { price: { $numberDecimal: string } }
    expect(out.price).toEqual({ $numberDecimal: '12345.6789' })
  })

  it('keeps small Longs as plain numbers', () => {
    const out = toRelaxed({ n: Long.fromNumber(42) }) as { n: number }
    expect(out.n).toBe(42)
  })

  it('wraps Binary as { $binary }', () => {
    const bin = new Binary(Buffer.from('hello', 'utf8'))
    const out = toRelaxed({ blob: bin }) as {
      blob: { $binary: { base64: string; subType: string } }
    }
    expect(out.blob.$binary.base64).toBe(Buffer.from('hello', 'utf8').toString('base64'))
  })

  it('passes through plain JSON values untouched', () => {
    const out = toRelaxed({ s: 'hi', n: 1, b: true, x: null }) as Record<string, unknown>
    expect(out).toEqual({ s: 'hi', n: 1, b: true, x: null })
  })
})

describe('toCanonicalString', () => {
  it('round-trips an ObjectId stably', () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011')
    expect(toCanonicalString(oid)).toBe('{"$oid":"507f1f77bcf86cd799439011"}')
  })

  it('uses canonical (typed) form for numbers', () => {
    expect(toCanonicalString(42)).toBe('{"$numberInt":"42"}')
  })
})

describe('parseFilter', () => {
  it('returns {} for empty / whitespace input', () => {
    expect(parseFilter(undefined)).toEqual({})
    expect(parseFilter('')).toEqual({})
    expect(parseFilter('   ')).toEqual({})
  })

  it('parses plain JSON', () => {
    expect(parseFilter('{ "a": 1 }')).toEqual({ a: 1 })
  })

  it('parses EJSON shorthand for ObjectId', () => {
    const parsed = parseFilter('{ "_id": { "$oid": "507f1f77bcf86cd799439011" } }')
    expect(parsed['_id']).toBeInstanceOf(ObjectId)
  })

  it('throws on non-object input', () => {
    expect(() => parseFilter('123')).toThrow()
    expect(() => parseFilter('[1,2]')).toThrow()
  })
})

describe('canonicalHash', () => {
  it('produces a 64-char hex digest', () => {
    const hash = canonicalHash({ a: 1 })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across equal documents', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ a: 1, b: 2 }))
  })

  it('changes with different content', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }))
  })
})
