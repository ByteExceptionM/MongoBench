import { describe, expect, it } from 'vitest'
import { BSON, BSONRegExp, Binary, Decimal128, Double, EJSON, Int32, Long, ObjectId } from 'bson'
import {
  canonicalHash,
  decodeDocument,
  hashCanonicalString,
  parseFilter,
  parseRelaxed,
  toCanonical,
  toCanonicalString,
  toRelaxed
} from './ejson'

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

  it('wraps small Longs as { $numberLong }', () => {
    const out = toRelaxed({ n: Long.fromNumber(42) }) as { n: unknown }
    expect(out.n).toEqual({ $numberLong: '42' })
  })

  it('keeps Longs beyond 2^53 exact', () => {
    const out = toRelaxed({
      big: Long.fromString('9007199254740993'),
      neg: Long.fromString('-1234567890123456789')
    })
    expect(out).toEqual({
      big: { $numberLong: '9007199254740993' },
      neg: { $numberLong: '-1234567890123456789' }
    })
  })

  it('wraps Longs nested in arrays and subdocuments', () => {
    const big = Long.fromString('9007199254740993')
    const out = toRelaxed({ list: [big, { inner: [big] }], sub: { deeper: { n: big } } })
    expect(out).toEqual({
      list: [{ $numberLong: '9007199254740993' }, { inner: [{ $numberLong: '9007199254740993' }] }],
      sub: { deeper: { n: { $numberLong: '9007199254740993' } } }
    })
  })

  it('leaves other BSON values next to a Long unchanged', () => {
    const out = toRelaxed({
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      at: new Date('2026-01-15T10:30:00.123Z'),
      price: Decimal128.fromString('1.5'),
      n: Long.fromNumber(7)
    })
    expect(out).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      at: { $date: '2026-01-15T10:30:00.123Z' },
      price: { $numberDecimal: '1.5' },
      n: { $numberLong: '7' }
    })
  })

  it('keeps a __proto__ field as an own field', () => {
    const doc = Object.defineProperty({}, '__proto__', {
      value: { n: Long.fromNumber(1) },
      enumerable: true,
      writable: true,
      configurable: true
    })
    const out = toRelaxed(doc)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({
      n: { $numberLong: '1' }
    })
  })

  it('shows Int32 and finite Double read without promotion as plain numbers', () => {
    const out = toRelaxed({ i: new Int32(7), d: new Double(2.5) })
    expect(out).toEqual({ i: 7, d: 2.5 })
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

describe('decodeDocument', () => {
  const stored = {
    l: Long.fromNumber(5),
    d: new Double(5),
    z: new Double(-0),
    i: new Int32(7),
    n: new Double(NaN)
  }

  function readBack(): Record<string, unknown> {
    return decodeDocument(BSON.serialize(stored))
  }

  it('keeps the stored numeric type of every field in canonical EJSON', () => {
    expect(JSON.parse(toCanonicalString(readBack()))).toEqual({
      l: { $numberLong: '5' },
      d: { $numberDouble: '5.0' },
      z: { $numberDouble: '-0.0' },
      i: { $numberInt: '7' },
      n: { $numberDouble: 'NaN' }
    })
  })

  it('writes back the same BSON types after a canonical round trip', () => {
    const reparsed = EJSON.parse(toCanonicalString(readBack()), { relaxed: false }) as object
    const written = decodeDocument(BSON.serialize(reparsed))
    const types = Object.fromEntries(
      Object.entries(written).map(([k, v]) => [k, (v as { _bsontype: string })._bsontype])
    )
    expect(types).toEqual({ l: 'Long', d: 'Double', z: 'Double', i: 'Int32', n: 'Double' })
  })

  it('differs from the driver default, which collapses them to the smallest integer type', () => {
    const promoted = BSON.deserialize(BSON.serialize(stored))
    expect(JSON.parse(toCanonicalString(promoted))).toMatchObject({
      l: { $numberInt: '5' },
      d: { $numberInt: '5' }
    })
  })

  // A JS RegExp would map 's' to 'g', drop x/u, and rewrite '/', line terminators and ''.
  const REGEXES: Array<[string, string]> = [
    ['dot.all', 's'],
    ['(?i)abc', ''],
    ['a/b', ''],
    ['^https://x', ''],
    ['a\nb', ''],
    ['', ''],
    ['a b', 'x'],
    ['x', 'u'],
    ['^abc$', 'imsux']
  ]

  it.each(REGEXES)('keeps the stored regex /%s/%s exactly', (pattern, options) => {
    const doc = decodeDocument(BSON.serialize({ re: new BSONRegExp(pattern, options) }))
    expect(JSON.parse(toCanonicalString(doc))).toEqual({
      re: { $regularExpression: { pattern, options } }
    })
  })

  it.each(REGEXES)('writes the regex /%s/%s back unchanged', (pattern, options) => {
    const read = decodeDocument(BSON.serialize({ re: new BSONRegExp(pattern, options) }))
    const reparsed = EJSON.parse(toCanonicalString(read), { relaxed: false }) as object
    const written = decodeDocument(BSON.serialize(reparsed))['re'] as BSONRegExp
    expect([written.pattern, written.options]).toEqual([pattern, options])
  })
})

describe('toCanonical', () => {
  it('wraps every BSON type, plain numbers included', () => {
    const out = toCanonical({
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      n: 1,
      l: Long.fromNumber(2),
      d: new Double(3),
      at: new Date(0),
      tags: ['a']
    })
    expect(out).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      n: { $numberInt: '1' },
      l: { $numberLong: '2' },
      d: { $numberDouble: '3.0' },
      at: { $date: { $numberLong: '0' } },
      tags: ['a']
    })
  })

  it('returns a plain object that JSON-stringifies to the canonical string', () => {
    const doc = { a: Long.fromString('9007199254740993'), b: [new Int32(1)] }
    expect(JSON.stringify(toCanonical(doc))).toBe(toCanonicalString(doc))
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

  it('keeps Int64 values beyond 2^53 exact in the BSON sent to the server', () => {
    const parsed = parseFilter(
      '{ "uid": { "$numberLong": "9007199254740993" }, "max": { "$numberLong": "9223372036854775807" } }'
    )
    const sent = BSON.deserialize(BSON.serialize(parsed), { promoteLongs: false })
    expect([String(sent['uid']), String(sent['max'])]).toEqual([
      '9007199254740993',
      '9223372036854775807'
    ])
    expect([sent['uid']._bsontype, sent['max']._bsontype]).toEqual(['Long', 'Long'])
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

describe('parseRelaxed', () => {
  it('reads $numberLong as an exact bigint and plain numbers as numbers', () => {
    expect(parseRelaxed('{ "big": { "$numberLong": "9007199254740993" }, "n": 1 }')).toEqual({
      big: 9007199254740993n,
      n: 1
    })
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

  it('equals the hash of the canonical string', () => {
    const doc = { _id: new ObjectId('507f1f77bcf86cd799439011'), n: Long.fromNumber(5) }
    expect(hashCanonicalString(toCanonicalString(doc))).toBe(canonicalHash(doc))
  })
})
