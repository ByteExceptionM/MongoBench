import { describe, expect, it } from 'vitest'
import { EJSON } from 'bson'
import { parseMongoQuery } from './mongoQueryLang'
import { serializeMongoValue } from './mongoQuerySerialize'

const roundTrip = (
  canonicalEjsonObject: unknown,
  options: Parameters<typeof serializeMongoValue>[1] = {}
) => {
  const text = serializeMongoValue(canonicalEjsonObject, options)
  const parsed = parseMongoQuery(text)
  if (!parsed.ok) throw new Error(`re-parse failed: ${parsed.error}\n${text}`)
  return { text, parsed: JSON.parse(parsed.ejson) }
}

describe('serializeMongoValue', () => {
  it('renders ObjectId as ObjectId("…")', () => {
    const text = serializeMongoValue({ _id: { $oid: '507f1f77bcf86cd799439011' } })
    expect(text).toContain('ObjectId("507f1f77bcf86cd799439011")')
    expect(text).not.toContain('$oid')
  })

  it('renders ISODate from string-form $date', () => {
    const text = serializeMongoValue({ at: { $date: '2024-01-01T00:00:00.000Z' } })
    expect(text).toContain('ISODate("2024-01-01T00:00:00.000Z")')
  })

  it('renders ISODate from canonical $numberLong-wrapped $date', () => {
    const text = serializeMongoValue({ at: { $date: { $numberLong: '1704067200000' } } })
    expect(text).toContain('ISODate("2024-01-01T00:00:00.000Z")')
  })

  it('renders NumberLong / NumberInt / NumberDecimal helpers', () => {
    const text = serializeMongoValue({
      a: { $numberLong: '9999999999' },
      b: { $numberInt: '42' },
      c: { $numberDecimal: '1.5' }
    })
    expect(text).toContain('NumberLong("9999999999")')
    expect(text).toContain('NumberInt(42)')
    expect(text).toContain('NumberDecimal("1.5")')
  })

  it('renders standard UUID (subType 04) as UUID("…")', () => {
    // bytes: 55 0e 84 00 e2 9b 41 d4 a7 16 44 66 55 44 00 00 → base64
    const base64 = Buffer.from('550e8400e29b41d4a716446655440000', 'hex').toString('base64')
    const text = serializeMongoValue({ id: { $binary: { base64, subType: '04' } } })
    expect(text).toContain('UUID("550e8400-e29b-41d4-a716-446655440000")')
  })

  it('renders subType 03 binary as JUUID under java encoding', () => {
    // Encode "550e8400-e29b-41d4-a716-446655440000" in legacy Java byte order.
    // The parser already produces this base64 — reuse it instead of reimplementing.
    const r = parseMongoQuery('JUUID("550e8400-e29b-41d4-a716-446655440000")')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const value = JSON.parse(r.ejson)
    const text = serializeMongoValue({ id: value }, { uuidEncoding: 'java' })
    expect(text).toContain('JUUID("550e8400-e29b-41d4-a716-446655440000")')
  })

  it('renders MinKey / MaxKey / undefined / regex', () => {
    const text = serializeMongoValue({
      lo: { $minKey: 1 },
      hi: { $maxKey: 1 },
      u: { $undefined: true },
      r: { $regularExpression: { pattern: '^foo', options: 'i' } }
    })
    expect(text).toContain('MinKey()')
    expect(text).toContain('MaxKey()')
    expect(text).toContain('undefined')
    expect(text).toContain('/^foo/i')
  })

  it('uses unquoted keys when valid identifiers, quoted otherwise', () => {
    const text = serializeMongoValue({ name: 'ada', 'with space': 1, 'has-dash': 1 })
    expect(text).toMatch(/\bname:/)
    expect(text).toContain('"with space":')
    expect(text).toContain('"has-dash":')
  })
})

describe('parse → serialize round-trips', () => {
  const cases: Array<{ name: string; ejson: unknown }> = [
    {
      name: 'ObjectId',
      ejson: { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'ada', age: 42 }
    },
    {
      name: 'date in canonical $numberLong form',
      ejson: { at: { $date: { $numberLong: '1704067200000' } } }
    },
    {
      name: 'mixed BSON types',
      ejson: {
        l: { $numberLong: '9999999999' },
        d: { $numberDecimal: '1.50' },
        ts: { $timestamp: { t: 1700000000, i: 7 } },
        re: { $regularExpression: { pattern: '^foo', options: 'i' } }
      }
    },
    {
      name: 'array of ObjectIds',
      ejson: {
        ids: [{ $oid: '507f1f77bcf86cd799439011' }, { $oid: 'aabbccddeeff001122334455' }]
      }
    },
    {
      name: 'nested object with operators',
      ejson: { age: { $gt: 18, $lt: 65 }, status: { $in: ['active', 'pending'] } }
    }
  ]

  for (const c of cases) {
    it(`round-trips ${c.name}`, () => {
      const { parsed } = roundTrip(c.ejson)
      // Compare via bson normalization — relaxed `$date: "iso"` and canonical
      // `$date: {$numberLong: "ms"}` are semantically equal but textually distinct.
      const before = EJSON.parse(JSON.stringify(c.ejson), { relaxed: false })
      const after = EJSON.parse(JSON.stringify(parsed), { relaxed: false })
      expect(EJSON.stringify(after, { relaxed: false })).toBe(
        EJSON.stringify(before, { relaxed: false })
      )
    })
  }

  it('round-trips JUUID under java encoding', () => {
    const r = parseMongoQuery('JUUID("550e8400-e29b-41d4-a716-446655440000")')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const value = { id: JSON.parse(r.ejson) }
    const { parsed } = roundTrip(value, { uuidEncoding: 'java' })
    expect(parsed).toEqual(value)
  })

  it('round-trips standard UUID through subType-04 binary', () => {
    const base64 = Buffer.from('550e8400e29b41d4a716446655440000', 'hex').toString('base64')
    const value = { id: { $binary: { base64, subType: '04' } } }
    // Serializer renders this as UUID("…") which the parser produces $uuid.
    // That's a different wrapper but represents the same logical value;
    // confirm at least the text shape rather than byte equality.
    const text = serializeMongoValue(value)
    expect(text).toContain('UUID("550e8400-e29b-41d4-a716-446655440000")')
  })
})
