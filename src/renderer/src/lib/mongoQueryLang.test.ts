import { describe, expect, it } from 'vitest'
import { EJSON } from 'bson'
import { ParseError, parseMongoDocuments, parseMongoQuery, tokenize } from './mongoQueryLang'

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

  it('keeps integral number literals with a dot or exponent as doubles', () => {
    const r = parseMongoQuery('{ a: 5.0, b: -0.0, c: 1e3, d: 1E+21, e: 7 }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({
        a: { $numberDouble: '5.0' },
        b: { $numberDouble: '-0.0' },
        c: { $numberDouble: '1e3' },
        d: { $numberDouble: '1E+21' },
        e: 7
      })
    }
  })

  it('leaves fractional literals as plain JSON numbers', () => {
    const r = parseMongoQuery('{a: 1.5}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ejson).toBe('{"a":1.5}')
  })

  it('stores integral doubles as BSON Double on the main side', () => {
    const r = parseMongoQuery('{ a: 100.0 }')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const doc = EJSON.parse(r.ejson, { relaxed: false }) as { a: { _bsontype: string } }
    expect(doc.a._bsontype).toBe('Double')
  })

  it('passes integral doubles to helpers as plain numbers', () => {
    const r = parseMongoQuery('{ a: NumberLong(5.0), b: ISODate(1.7e12), c: NumberInt(2.0) }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({
        a: { $numberLong: '5' },
        b: { $date: { $numberLong: '1700000000000' } },
        c: { $numberInt: '2' }
      })
    }
  })

  it('keeps an integral double as the id of a DBRef', () => {
    const r = parseMongoQuery('{ r: DBRef("users", 5.0) }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual({ r: { $ref: 'users', $id: { $numberDouble: '5.0' } } })
    }
  })

  it('accepts Double / NumberDouble with numbers and numeric strings', () => {
    const r = parseMongoQuery(
      '[Double(5), NumberDouble(2.5), Double(-0.0), NumberDouble("NaN"), Double("Infinity"), Double("-Infinity"), Double("-0.0"), Double("1e+21")]'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.ejson)).toEqual([
        { $numberDouble: '5' },
        { $numberDouble: '2.5' },
        { $numberDouble: '-0.0' },
        { $numberDouble: 'NaN' },
        { $numberDouble: 'Infinity' },
        { $numberDouble: '-Infinity' },
        { $numberDouble: '-0.0' },
        { $numberDouble: '1e+21' }
      ])
    }
  })

  it('rejects Double with a non-numeric argument', () => {
    for (const input of [
      'Double("abc")',
      'Double("")',
      'Double("0x10")',
      'Double()',
      'Double({})'
    ]) {
      const r = parseMongoQuery(input)
      expect(r.ok, input).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/Double\(\) argument must be a number or numeric string/)
    }
  })

  it('mints a fresh ObjectId for ObjectId() without arguments', () => {
    const a = parseMongoQuery('ObjectId()')
    const b = parseMongoQuery('ObjectId()')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const idA = (a.value as { $oid: string }).$oid
    const idB = (b.value as { $oid: string }).$oid
    expect(idA).toMatch(/^[0-9a-f]{24}$/)
    expect(idB).toMatch(/^[0-9a-f]{24}$/)
    expect(idA).not.toBe(idB)
    expect(idA).not.toBe('000000000000000000000000')
    const seconds = parseInt(idA.slice(0, 8), 16)
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThanOrEqual(5)
  })

  it('rejects ISODate with an unparseable string', () => {
    for (const input of [
      'ISODate("1-01-01T00:00:00+00:53:28")',
      'ISODate("1850-06-01T00:53:28.000+00:53:28")',
      'new Date("not a date")'
    ]) {
      const r = parseMongoQuery(input)
      expect(r.ok, input).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^Invalid date "/)
    }
  })

  it('keeps "__proto__" keys as own properties', () => {
    const r = parseMongoQuery('{ a: 1, __proto__: { x: NumberInt(1) }, b: { "__proto__": "s" } }')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ejson).toBe('{"a":1,"__proto__":{"x":{"$numberInt":"1"}},"b":{"__proto__":"s"}}')
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype)
  })
})

describe('tokenize', () => {
  it('emits "." and ";" as punctuation in shell mode', () => {
    const tokens = tokenize('db.users.find();', { shell: true })
    expect(
      tokens.map((t) => (t.type === 'punct' || t.type === 'ident' ? t.value : t.type))
    ).toEqual(['db', '.', 'users', '.', 'find', '(', ')', ';'])
  })

  it('rejects a lone "." without the shell option', () => {
    expect(() => tokenize('a.b')).toThrow(ParseError)
  })

  it('still reads ".5" as a number in shell mode', () => {
    const tokens = tokenize('.5', { shell: true })
    expect(tokens).toEqual([{ type: 'number', value: '.5', offset: 0 }])
  })

  it('reads a regex containing ")" and a quote after "(" in shell mode', () => {
    const tokens = tokenize("find(/a)'/)", { shell: true })
    expect(tokens[2]).toEqual({ type: 'regex', pattern: "a)'", flags: '', offset: 5 })
  })
})

describe('parseMongoDocuments', () => {
  it('returns no documents for blank input', () => {
    const r = parseMongoDocuments('   ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.documents).toEqual([])
  })

  it('parses a single document', () => {
    const r = parseMongoDocuments('{ name: "ada" }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.documents.map((d) => JSON.parse(d))).toEqual([{ name: 'ada' }])
  })

  it('parses newline-separated documents without an array', () => {
    const r = parseMongoDocuments('{ a: 1 }\n{ b: 2 }\n{ c: 3 }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.documents.map((d) => JSON.parse(d))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('tolerates comma separators between documents', () => {
    const r = parseMongoDocuments('{ a: 1 },\n{ b: 2 },')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.documents.map((d) => JSON.parse(d))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('treats commas as fully optional separators in any position', () => {
    const inputs = [
      '{ a: 1 }\n{ b: 2 }',
      '{ a: 1 },\n{ b: 2 },',
      '{ a: 1 },\n{ b: 2 }',
      ',{ a: 1 },,{ b: 2 },,'
    ]
    for (const input of inputs) {
      const r = parseMongoDocuments(input)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.documents.map((d) => JSON.parse(d))).toEqual([{ a: 1 }, { b: 2 }])
    }
  })

  it('rewrites shell helpers inside each document', () => {
    const r = parseMongoDocuments(
      '{ _id: ObjectId("507f1f77bcf86cd799439011") }\n{ at: ISODate("2024-01-01T00:00:00Z") }'
    )
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.documents.map((d) => JSON.parse(d))).toEqual([
        { _id: { $oid: '507f1f77bcf86cd799439011' } },
        { at: { $date: '2024-01-01T00:00:00Z' } }
      ])
  })

  it('flattens a top-level array of documents', () => {
    const r = parseMongoDocuments('[{ a: 1 }, { b: 2 }]')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.documents.map((d) => JSON.parse(d))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('mixes bare documents and arrays', () => {
    const r = parseMongoDocuments('{ a: 1 }\n[{ b: 2 }, { c: 3 }]\n{ d: 4 }')
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.documents.map((d) => JSON.parse(d))).toEqual([
        { a: 1 },
        { b: 2 },
        { c: 3 },
        { d: 4 }
      ])
  })

  it('rejects a non-object element inside an array', () => {
    const r = parseMongoDocuments('[{ a: 1 }, 42]')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/must be an object/)
  })

  it('rejects a non-object document in the sequence', () => {
    const r = parseMongoDocuments('{ a: 1 }\n42')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/must be an object/)
  })

  it('keeps "__proto__" keys of each document', () => {
    const r = parseMongoDocuments('{ __proto__: { x: 1 } }\n{ "__proto__": "s" }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.documents).toEqual(['{"__proto__":{"x":1}}', '{"__proto__":"s"}'])
  })
})
