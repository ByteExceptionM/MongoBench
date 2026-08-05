import { describe, expect, it } from 'vitest'
import { affectsWholeCollection, isWriteOp, parseShellCommand } from './shellParser'

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
    const r = parseShellCommand('db.x.distinct("name")')
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

describe('parseShellCommand write operations', () => {
  it('parses insertOne', () => {
    const r = parseShellCommand('db.users.insertOne({ name: "ada", age: NumberInt(36) })')
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'insertOne') return
    expect(JSON.parse(r.op.document)).toEqual({ name: 'ada', age: { $numberInt: '36' } })
    expect(isWriteOp(r.op)).toBe(true)
  })

  it('parses insertMany into separate documents', () => {
    const r = parseShellCommand('db.users.insertMany([{ a: 1 }, { b: 2 }])')
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'insertMany') return
    expect(r.op.documents).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('rejects insertMany with a non object entry', () => {
    expect(parseShellCommand('db.users.insertMany([1])').ok).toBe(false)
    expect(parseShellCommand('db.users.insertMany([])').ok).toBe(false)
  })

  it('parses updateOne and updateMany', () => {
    const one = parseShellCommand('db.users.updateOne({ _id: 1 }, { $set: { active: true } })')
    expect(one.ok).toBe(true)
    if (!one.ok || one.op.kind !== 'updateOne') return
    expect(JSON.parse(one.op.filter)).toEqual({ _id: 1 })
    expect(JSON.parse(one.op.update)).toEqual({ $set: { active: true } })
    expect(one.op.upsert).toBe(false)

    const many = parseShellCommand('db.users.updateMany({}, { $unset: { tmp: "" } })')
    expect(many.ok && many.op.kind === 'updateMany').toBe(true)
  })

  it('reads the upsert option', () => {
    const r = parseShellCommand(
      'db.users.updateOne({ a: 1 }, { $set: { b: 2 } }, { upsert: true })'
    )
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'updateOne') return
    expect(r.op.upsert).toBe(true)
  })

  it('rejects unsupported options', () => {
    const r = parseShellCommand('db.users.updateOne({}, { $set: { a: 1 } }, { arrayFilters: [] })')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/arrayFilters/)
  })

  it('requires update operators in an update document', () => {
    const r = parseShellCommand('db.users.updateOne({ a: 1 }, { b: 2 })')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/update operators/)
  })

  it('accepts an aggregation pipeline as update', () => {
    const r = parseShellCommand('db.users.updateMany({}, [{ $set: { n: { $add: ["$n", 1] } } }])')
    expect(r.ok).toBe(true)
  })

  it('parses replaceOne', () => {
    const r = parseShellCommand('db.users.replaceOne({ _id: 1 }, { name: "ada" })')
    expect(r.ok).toBe(true)
    if (!r.ok || r.op.kind !== 'replaceOne') return
    expect(JSON.parse(r.op.replacement)).toEqual({ name: 'ada' })
  })

  it('parses deleteOne and deleteMany', () => {
    const one = parseShellCommand('db.users.deleteOne({ _id: 1 })')
    expect(one.ok && one.op.kind === 'deleteOne').toBe(true)
    const many = parseShellCommand('db.users.deleteMany({ archived: true })')
    expect(many.ok && many.op.kind === 'deleteMany').toBe(true)
  })

  it('requires an explicit filter for deletes and updates', () => {
    expect(parseShellCommand('db.users.deleteMany()').ok).toBe(false)
    expect(parseShellCommand('db.users.updateOne({})').ok).toBe(false)
  })

  it('flags commands that hit the whole collection', () => {
    const wide = parseShellCommand('db.users.deleteMany({})')
    expect(wide.ok && affectsWholeCollection(wide.op)).toBe(true)
    const narrow = parseShellCommand('db.users.deleteMany({ a: 1 })')
    expect(narrow.ok && affectsWholeCollection(narrow.op)).toBe(false)
    const read = parseShellCommand('db.users.find({})')
    expect(read.ok && affectsWholeCollection(read.op)).toBe(false)
  })

  it('rejects chained calls on write operations', () => {
    expect(parseShellCommand('db.users.deleteMany({}).limit(1)').ok).toBe(false)
  })

  it('separates reads from writes', () => {
    const read = parseShellCommand('db.users.find({})')
    expect(read.ok && isWriteOp(read.op)).toBe(false)
  })
})
