import { describe, expect, it } from 'vitest'
import { parseShellCommand } from './shellParser'

describe('parseShellCommand', () => {
  it('parses a bare find()', () => {
    const r = parseShellCommand('db.users.find()')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.coll).toBe('users')
    expect(r.op).toEqual({
      kind: 'find',
      filter: '{}',
      projection: null,
      sort: null,
      skip: null,
      limit: null
    })
  })

  it('parses find with filter and projection', () => {
    const r = parseShellCommand('db.orders.find({ status: "active" }, { _id: 0, total: 1 })')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.op.kind).toBe('find')
    if (r.op.kind !== 'find') return
    expect(JSON.parse(r.op.filter)).toEqual({ status: 'active' })
    expect(r.op.projection && JSON.parse(r.op.projection)).toEqual({ _id: 0, total: 1 })
  })

  it('parses find with chained .sort.skip.limit', () => {
    const r = parseShellCommand('db.users.find({}).sort({ createdAt: -1 }).skip(20).limit(10)')
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'find') return
    expect(JSON.parse(r.op.sort!)).toEqual({ createdAt: -1 })
    expect(r.op.skip).toBe(20)
    expect(r.op.limit).toBe(10)
  })

  it('parses aggregate with a pipeline', () => {
    const r = parseShellCommand(
      'db.events.aggregate([{ $match: { type: "click" } }, { $count: "n" }])'
    )
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'aggregate') return
    expect(JSON.parse(r.op.pipeline)).toEqual([{ $match: { type: 'click' } }, { $count: 'n' }])
  })

  it('parses findOne and countDocuments', () => {
    const a = parseShellCommand('db.x.findOne({ id: 1 })')
    expect(a.ok && a.op.kind === 'findOne').toBe(true)
    const b = parseShellCommand('db.x.countDocuments({ active: true })')
    expect(b.ok && b.op.kind === 'countDocuments').toBe(true)
    const c = parseShellCommand('db.x.count()')
    expect(c.ok && c.op.kind === 'countDocuments').toBe(true)
  })

  it('handles ObjectId() and ISODate() inside args', () => {
    const r = parseShellCommand('db.users.find({ _id: ObjectId("507f1f77bcf86cd799439011") })')
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'find') return
    expect(JSON.parse(r.op.filter)).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' }
    })
  })

  it('respects parens / braces inside string literals', () => {
    const r = parseShellCommand('db.x.find({ msg: "a) ) (" })')
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'find') return
    expect(JSON.parse(r.op.filter)).toEqual({ msg: 'a) ) (' })
  })

  it('rejects unsupported methods', () => {
    const r = parseShellCommand('db.x.insertOne({})')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/Unsupported method/)
  })

  it('rejects malformed input', () => {
    expect(parseShellCommand('foo bar').ok).toBe(false)
    expect(parseShellCommand('db.x.find(').ok).toBe(false)
    expect(parseShellCommand('db.x.find()garbage').ok).toBe(false)
  })

  it('rejects skip / limit with non-integer', () => {
    expect(parseShellCommand('db.x.find().limit(1.5)').ok).toBe(false)
    expect(parseShellCommand('db.x.find().skip(-1)').ok).toBe(false)
  })

  it('accepts whitespace and newlines anywhere', () => {
    const r = parseShellCommand(`
      db
        .users
        .find({
          status: "active"
        })
        .limit(5)
    `)
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'find') return
    expect(r.coll).toBe('users')
    expect(r.op.limit).toBe(5)
  })

  it('rejects more than 2 args to find', () => {
    const r = parseShellCommand('db.x.find({}, {}, {})')
    expect(r.ok).toBe(false)
  })
})
