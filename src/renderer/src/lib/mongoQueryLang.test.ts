import { describe, expect, it } from 'vitest'
import { parseMongoQuery } from './mongoQueryLang'

describe('parseMongoQuery', () => {
  it('returns empty ejson for blank input', () => {
    const r = parseMongoQuery('   ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ejson).toBe('')
  })

  it('accepts plain JSON', () => {
    const r = parseMongoQuery('{"name": "ada"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ name: 'ada' })
  })

  it('quotes unquoted keys', () => {
    const r = parseMongoQuery('{ name: "ada", age: 42 }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ name: 'ada', age: 42 })
  })

  it('rewrites ObjectId(...) to $oid', () => {
    const r = parseMongoQuery('{ _id: ObjectId("507f1f77bcf86cd799439011") }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({
        _id: { $oid: '507f1f77bcf86cd799439011' }
      })
    }
  })

  it('rewrites ISODate(...) and Date(...) to $date', () => {
    const r = parseMongoQuery('{ at: ISODate("2024-01-01T00:00:00Z") }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ at: { $date: '2024-01-01T00:00:00Z' } })
  })

  it('handles new Date(...) shell syntax', () => {
    const r = parseMongoQuery('{ at: new Date("2024-01-01") }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ at: { $date: '2024-01-01' } })
  })

  it('rewrites NumberLong / NumberDecimal / NumberInt', () => {
    const r = parseMongoQuery(
      '{ a: NumberLong("9999999999"), b: NumberDecimal("1.5"), c: NumberInt(42) }'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({
        a: { $numberLong: '9999999999' },
        b: { $numberDecimal: '1.5' },
        c: { $numberInt: '42' }
      })
    }
  })

  it('handles regex literals', () => {
    const r = parseMongoQuery('{ name: /^ada/i }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({
        name: { $regularExpression: { pattern: '^ada', options: 'i' } }
      })
    }
  })

  it('does NOT treat division as regex when in expression position is irrelevant (no expr)', () => {
    // Object key + value containing slash inside a string should not become regex
    const r = parseMongoQuery('{ url: "https://example.com/foo" }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson).url).toBe('https://example.com/foo')
  })

  it('accepts trailing commas', () => {
    const r = parseMongoQuery('{ a: 1, b: 2, }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ a: 1, b: 2 })
  })

  it('strips comments', () => {
    const r = parseMongoQuery(`
      {
        // this is a comment
        name: "ada", /* inline */ age: 42
      }
    `)
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ name: 'ada', age: 42 })
  })

  it('keeps nested operators with $ keys', () => {
    const r = parseMongoQuery('{ age: { $gt: 18, $lt: 65 } }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.ejson)).toEqual({ age: { $gt: 18, $lt: 65 } })
  })

  it('reports a parse error with offset on garbage input', () => {
    const r = parseMongoQuery('{ name: }')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  it('rejects bare unknown identifiers', () => {
    const r = parseMongoQuery('{ a: notAHelper }')
    expect(r.ok).toBe(false)
  })

  it('handles MinKey / MaxKey both with and without parens', () => {
    const a = parseMongoQuery('{ x: MinKey, y: MaxKey() }')
    expect(a.ok).toBe(true)
    if (a.ok) expect(JSON.parse(a.ejson)).toEqual({ x: { $minKey: 1 }, y: { $maxKey: 1 } })
  })

  it('handles arrays and nested helpers', () => {
    const r = parseMongoQuery(
      '{ ids: [ObjectId("507f1f77bcf86cd799439011"), ObjectId("aabbccddeeff001122334455")] }'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({
        ids: [{ $oid: '507f1f77bcf86cd799439011' }, { $oid: 'aabbccddeeff001122334455' }]
      })
    }
  })

  it('accepts UUID literal', () => {
    const r = parseMongoQuery('{ id: UUID("550e8400-e29b-41d4-a716-446655440000") }')
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(JSON.parse(r.ejson)).toEqual({
        id: { $uuid: '550e8400-e29b-41d4-a716-446655440000' }
      })
  })

  it('accepts BinData', () => {
    const r = parseMongoQuery('{ payload: BinData(0, "AQID") }')
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(JSON.parse(r.ejson)).toEqual({
        payload: { $binary: { base64: 'AQID', subType: '00' } }
      })
  })
})
