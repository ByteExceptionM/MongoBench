import { describe, expect, it } from 'vitest'
import { lex, scan, toStages, type Frame } from './scanner'

/** Scans `marked` at its `|` marker. */
const at = (marked: string, root: 'value' | 'documents' | 'shell' = 'value') => {
  const offset = marked.indexOf('|')
  return scan(marked.slice(0, offset) + marked.slice(offset + 1), offset, root)
}

const shape = (frames: Frame[]) =>
  frames.map((frame) => {
    switch (frame.f) {
      case 'object':
        return `object:${frame.slot}${frame.key === null ? '' : `:${frame.key}`}`
      case 'array':
        return `array:${frame.slot}:${frame.index}`
      case 'call':
        return `call:${frame.callee}:${frame.argIndex}`
      case 'chain':
        return `chain:${frame.segments.join('.')}${frame.afterDot ? '.' : ''}`
    }
  })

describe('lex', () => {
  it.each(['{ a: "abc', "{ a: 'abc", '{ a: /ab', '{ a: 1 /* note', '"\\', '{ a: "x\\'])(
    'never throws on %j',
    (text) => {
      expect(() => lex(text)).not.toThrow()
    }
  )

  it('marks unterminated strings, regexes and comments as open', () => {
    expect(lex('"abc')[0]).toMatchObject({ t: 'string', closed: false, value: 'abc' })
    expect(lex('/ab')[0]).toMatchObject({ t: 'regex', closed: false })
    expect(lex('/* x')[0]).toMatchObject({ t: 'comment', closed: false })
  })

  it('stops an unterminated string at the newline', () => {
    const tokens = lex('"ab\n}')
    expect(tokens[0]).toMatchObject({ t: 'string', closed: false, end: 3 })
    expect(tokens[1]).toMatchObject({ t: 'punct', v: '}' })
  })

  it('reads / as a regex after ":" but not after a value', () => {
    expect(lex('{ a: /x/i }')[3]).toMatchObject({ t: 'regex', closed: true, start: 5, end: 9 })
    expect(lex('{ a: 1 /x/ }').map((t) => t.t)).not.toContain('regex')
  })

  it('decodes escapes in strings', () => {
    expect(lex('"a\\"b\\u0041\\n"')[0]).toMatchObject({ value: 'a"bA\n', closed: true })
  })

  it('tokenizes shell chains with dots and keeps .5 a number', () => {
    expect(lex('db.users.find({}).limit(.5);').map((t) => (t.t === 'punct' ? t.v : t.t))).toEqual([
      'ident',
      '.',
      'ident',
      '.',
      'ident',
      '(',
      '{',
      '}',
      ')',
      '.',
      'ident',
      '(',
      'number',
      ')',
      ';'
    ])
  })
})

describe('scan: dead positions', () => {
  it.each([
    ['{ a: 1 // co|mment', 'line comment'],
    ['{ a: 1 // comment|', 'end of a line comment'],
    ['{ a: /* x| */ 1 }', 'block comment'],
    ['{ a: /ab|c/ }', 'regex'],
    ['{ a: /abc/|', 'right after a regex'],
    ['{ a: 12|', 'number'],
    ['{ a: "x"|', 'right after a string'],
    ['{ a: {}|', 'right after a closing brace'],
    ['{} |', 'after the root value'],
    ['db.c.find()|', 'right after a call']
  ])('%s (%s)', (marked) => {
    expect(at(marked, marked.startsWith('db') ? 'shell' : 'value').dead).toBe(true)
  })

  it('is alive right after a closed block comment', () => {
    expect(at('{ /* x */| }').dead).toBe(false)
  })

  it('treats a huge offset as dead', () => {
    const text = `{ a: "${'x'.repeat(1_000_100)}" }`
    expect(scan(text, 1_000_050, 'value').dead).toBe(true)
  })
})

describe('scan: token span', () => {
  it('starts after the opening quote and records the closing quote', () => {
    const { token } = at('{ "na|" }')
    expect(token).toMatchObject({ start: 3, cursor: 5, quote: '"', closeQuoteEnd: 6, prefix: 'na' })
    expect(token.charBefore).toBe(' ')
  })

  it('has no closing quote for an unterminated string', () => {
    expect(at('{ "na|').token).toMatchObject({ quote: '"', closeQuoteEnd: null, prefix: 'na' })
  })

  it('starts an unquoted dotted key at its first segment', () => {
    const result = at('{ address.ci|')
    expect(result.token).toMatchObject({ start: 2, prefix: 'address.ci' })
    expect(shape(result.frames)).toEqual(['object:key'])
  })

  it('starts a dotted key that ends with a dot', () => {
    expect(at('{ a.b.|').token.prefix).toBe('a.b.')
  })

  it('extends the word after the cursor and detects a following colon', () => {
    const { token } = at('{ na|me: 1 }')
    expect(token).toMatchObject({
      start: 2,
      wordEnd: 6,
      prefix: 'na',
      colonFollows: true,
      nextChar: ':'
    })
  })

  it('extends a key over the dotted segments after the cursor', () => {
    const { token } = at('{ addr|ess.city: 1 }')
    expect(token).toMatchObject({ wordEnd: 9, dottedEnd: 14, colonFollows: true, nextChar: '.' })
  })

  it('looks past the closing quote for the colon', () => {
    expect(at('{ "na|me"  : 1 }').token).toMatchObject({ closeQuoteEnd: 8, colonFollows: true })
  })

  it('reports the char before the cursor and the last non-blank char', () => {
    expect(at('{ "_id":|').token).toMatchObject({ charBefore: ':', prevNonBlank: ':', prefix: '' })
    expect(at('{ "_id": |').token).toMatchObject({ charBefore: ' ', prevNonBlank: ':' })
  })

  it('takes a lone minus as the start of a word', () => {
    expect(at('{ a: -|').token).toMatchObject({ start: 5, prefix: '-' })
  })
})

describe('scan: frames', () => {
  it('describes a pipeline stage key after a completed stage', () => {
    const result = at('[{ $match: { x: 1 } }, { $gr|')
    expect(shape(result.frames)).toEqual(['array:element:1', 'object:key'])
    expect(result.token.prefix).toBe('$gr')
    const pipeline = result.frames[0]
    expect(pipeline?.f === 'array' && toStages(pipeline.node.items).map((s) => s.name)).toEqual([
      '$match'
    ])
  })

  it('describes a shell call argument', () => {
    const result = at('db.c.find({}, { na|', 'shell')
    expect(shape(result.frames)).toEqual(['chain:db.c', 'call:find:1', 'object:key'])
    const call = result.frames[1]
    expect(call?.f === 'call' && call.receiver).toEqual(['db', 'c'])
  })

  it('describes a constructor call', () => {
    expect(shape(at('new Date(|').frames)).toEqual(['call:Date:0'])
    expect(shape(at('{ _id: ObjectId("ab|').frames)).toEqual([
      'object:value:_id',
      'call:ObjectId:0'
    ])
    expect(at('{ _id: ObjectId("ab|').token).toMatchObject({ quote: '"', prefix: 'ab' })
  })

  it('accepts trailing commas', () => {
    const result = at('{ a: 1, b: [1, 2,], |')
    expect(shape(result.frames)).toEqual(['object:key'])
    const root = result.frames[0]
    expect(root?.f === 'object' && root.node.entries.map((e) => e.key)).toEqual(['a', 'b'])
  })

  it('handles CRLF line endings', () => {
    const result = at('{\r\n  a: 1,\r\n  "b": {\r\n    c|')
    expect(shape(result.frames)).toEqual(['object:value:b', 'object:key'])
    expect(result.token.prefix).toBe('c')
    expect(at('{ a: 1,\r\n  |\r\n}').token.nextChar).toBe('')
  })

  it('reaches the root slot of an empty or whitespace input', () => {
    expect(at('|')).toMatchObject({ frames: [], dead: false })
    expect(at('  tr|')).toMatchObject({ frames: [], dead: false })
  })

  it('continues a document sequence', () => {
    expect(shape(at('{ a: 1 }, { |', 'documents').frames)).toEqual(['object:key'])
    expect(at('{ a: 1 } |', 'documents')).toMatchObject({ frames: [], dead: false })
  })

  it('closes a mismatched bracket at the enclosing container', () => {
    const result = at('{ a: { b: [1, 2 }, c: { |')
    expect(shape(result.frames)).toEqual(['object:value:c', 'object:key'])
  })

  it('keeps the value slot after "new"', () => {
    expect(shape(at('{ a: new |').frames)).toEqual(['object:value:a'])
  })

  it('tracks object keys while the cursor is in a later value', () => {
    const result = at('[{ $lookup: { from: "orders", foreignField: "|')
    const body = result.frames[2]
    expect(
      body?.f === 'object' && body.node.entries.map((e) => [e.key, e.value?.n ?? null])
    ).toEqual([
      ['from', 'string'],
      ['foreignField', null]
    ])
  })
})

describe('scan: entries after the cursor', () => {
  const keysOf = (frame: Frame | undefined) =>
    frame?.f === 'object' ? frame.node.entries.map((e) => e.key) : null

  it('adds the keys that follow the cursor to its object', () => {
    expect(keysOf(at('{ a: 1, |, name: "x", "age": 2 }').frames[0])).toEqual(['a', 'name', 'age'])
  })

  it('finds following keys without a separating comma', () => {
    const result = at('{ "|"\n  "_id": ObjectId("x"), "address": { "city": "B" } }', 'documents')
    expect(keysOf(result.frames[0])).toEqual(['_id', 'address'])
  })

  it('completes every open object on the way out', () => {
    const result = at(
      '[{ $lookup: { pipeline: [{ $match: { | } }], from: "orders", let: { pid: "$uuid" } } }]'
    )
    const body = result.frames[2]
    expect(keysOf(body)).toEqual(['pipeline', 'from', 'let'])
    const from = body?.f === 'object' ? body.node.entries[1]?.value : null
    expect(from).toMatchObject({ n: 'string', value: 'orders' })
    const vars = body?.f === 'object' ? body.node.entries[2]?.value : null
    expect(vars?.n === 'object' && vars.entries.map((e) => e.key)).toEqual(['pid'])
  })

  it('notes whether another element follows the cursor in an array', () => {
    const more = (marked: string) => {
      const frame = at(marked).frames[0]
      return frame?.f === 'array' && frame.more
    }
    expect(more('[{ a: 1 }, { | }, { b: 2 }]')).toBe(true)
    expect(more('[|, 2]')).toBe(true)
    expect(more('[{ a: 1 }, { | }]')).toBe(false)
    expect(more('[1, |, ]')).toBe(false)
    expect(more('[{ x: [1, 2] }, { $| }')).toBe(false)
  })

  it('leaves the word at the cursor and values after it out', () => {
    expect(keysOf(at('{ na|me: 1, other: "x" }').frames[0])).toEqual(['other'])
    expect(keysOf(at('{ addr|ess.city: 1, other: 2 }').frames[0])).toEqual(['other'])
    expect(keysOf(at('{ items|.0.name: 1, other: 2 }').frames[0])).toEqual(['other'])
    expect(keysOf(at('{ a: Obj|ectId("x"), b: [1, 2], c: 3 }').frames[0])).toEqual(['a', 'b', 'c'])
  })
})

describe('scan: shell chains', () => {
  it.each([
    ['|', ['chain:']],
    ['d|', ['chain:']],
    ['db.|', ['chain:db.']],
    ['db.us|', ['chain:db.']],
    ['db.users.|', ['chain:db.users.']],
    ['db.a.b.|', ['chain:db.a.b.']],
    ['db.users.find({}).|', ['chain:db.users.']],
    ['db["my coll"].|', ['chain:db.my coll.']],
    ['db.getCollection("x").|', ['chain:db.x.']],
    ['db.getCollection("|', ['chain:db', 'call:getCollection:0']],
    ['db["|', ['chain:db', 'call:getCollection:0']]
  ])('%s', (marked, expected) => {
    expect(shape(at(marked, 'shell').frames)).toEqual(expected)
  })

  it('records completed calls in order', () => {
    const chain = at('db.users.find({}).limit(5).|', 'shell').frames[0]
    expect(chain?.f === 'chain' && chain.calls.map((c) => c.name)).toEqual(['find', 'limit'])
  })

  it('is dead after a terminating semicolon', () => {
    expect(at('db.users.find({}); |', 'shell').dead).toBe(true)
  })
})

describe('scan: key styles', () => {
  it('detects quoted and unquoted keys across the whole text', () => {
    expect(at('{ "a": 1, | }')).toMatchObject({ quotedKeys: true, unquotedKeys: false })
    expect(at('{ |, b: 1 }')).toMatchObject({ quotedKeys: false, unquotedKeys: true })
    expect(at('{ "a": { $gt: 1 }, | }')).toMatchObject({ quotedKeys: true, unquotedKeys: true })
  })

  it('ignores the key being typed', () => {
    expect(at('{ "a": 1, na|: 2 }')).toMatchObject({ quotedKeys: true, unquotedKeys: false })
  })
})
