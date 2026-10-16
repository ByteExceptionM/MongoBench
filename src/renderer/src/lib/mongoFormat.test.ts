import { describe, expect, it } from 'vitest'
import { formatMongoSource } from './mongoFormat'
import { parseMongoQuery } from './mongoQueryLang'

const options = { timezone: 'UTC', uuidEncoding: 'default' as const, indent: 2, printWidth: 80 }

describe('formatMongoSource', () => {
  it('re-prints a short filter on one line', () => {
    expect(formatMongoSource('{status:"A",n:{$gt:1}}', options)).toBe(
      '{ status: "A", n: { $gt: 1 } }'
    )
  })

  it('breaks a pipeline that does not fit and keeps short stages inline', () => {
    const source = '[{$match:{status:"A",n:{$gte:10}}},{$group:{_id:"$cust",n:{$sum:1}}}]'
    expect(formatMongoSource(source, options)).toBe(
      [
        '[',
        '  { $match: { status: "A", n: { $gte: 10 } } },',
        '  { $group: { _id: "$cust", n: { $sum: 1 } } }',
        ']'
      ].join('\n')
    )
  })

  it('keeps shell helpers instead of EJSON wrappers', () => {
    const source = `{
      _id: ObjectId("507f1f77bcf86cd799439011"), n: NumberLong("5"), d: 5.0,
      re: /^a/i, u: JUUID("550e8400-e29b-41d4-a716-446655440000"), m: MinKey
    }`
    const text = formatMongoSource(source, { ...options, uuidEncoding: 'java' })
    expect(text).toContain('ObjectId("507f1f77bcf86cd799439011")')
    expect(text).toContain('NumberLong("5")')
    expect(text).toContain('d: 5.0')
    expect(text).toContain('/^a/i')
    expect(text).toContain('JUUID("550e8400-e29b-41d4-a716-446655440000")')
    expect(text).toContain('MinKey()')
    expect(text).not.toContain('$oid')
  })

  it('drops comments', () => {
    expect(formatMongoSource('{ a: 1 /* why */ } // note', options)).toBe('{ a: 1 }')
  })

  it('round-trips to the same value', () => {
    for (const source of [
      '{ a: { $in: [1, 2.5, 3.0, -0.0] }, b: /x\\/y/, c: NumberDecimal("1.50") }',
      '[{ $match: { at: { $lt: ISODate("2024-01-01T00:00:00.000Z") } } }, { $sort: { at: -1 } }]',
      '{ u: UUID("550e8400-e29b-41d4-a716-446655440000"), t: Timestamp(1700000000, 7), x: NumberDouble("NaN") }'
    ]) {
      const formatted = formatMongoSource(source, options)
      expect(formatted, source).not.toBeNull()
      expect(parseMongoQuery(formatted!), source).toEqual(parseMongoQuery(source))
    }
  })

  it('returns null for blank or invalid source', () => {
    expect(formatMongoSource('', options)).toBeNull()
    expect(formatMongoSource('  \n ', options)).toBeNull()
    expect(formatMongoSource('{ a: }', options)).toBeNull()
  })
})
