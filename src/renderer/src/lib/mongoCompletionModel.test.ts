import { describe, expect, it } from 'vitest'
import {
  describeSymbol,
  resolveCompletions,
  resolveSignature,
  PIPELINE_COMPLETION_CONTEXT,
  PROJECTION_COMPLETION_CONTEXT,
  QUERY_COMPLETION_CONTEXT,
  SORT_COMPLETION_CONTEXT,
  type CompletionGroup,
  type CompletionItemData,
  type EditorCompletionContext
} from './mongoCompletionModel'
import { parseMongoQuery } from './mongoQueryLang'
import { parseShellCommand } from './shellParser'

const SHELL_CONTEXT: EditorCompletionContext = {
  kind: 'shell',
  coll: 'users',
  collections: ['orders', 'users']
}

function complete(
  text: string,
  context: EditorCompletionContext,
  options?: { fieldNames?: string[]; charAfterCursor?: string }
): CompletionGroup[] {
  const lines = text.split('\n')
  return resolveCompletions({
    context,
    textUpToCursor: text,
    lineUpToCursor: lines[lines.length - 1] ?? '',
    charAfterCursor: options?.charAfterCursor ?? '',
    fieldNames: options?.fieldNames ?? []
  })
}

function labels(groups: CompletionGroup[]): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.label))
}

function insertTextOf(groups: CompletionGroup[], label: string): string | undefined {
  return groups.flatMap((group) => group.items).find((item) => item.label === label)?.insertText
}

describe('shell completions', () => {
  it('offers db on an empty command', () => {
    const groups = complete('', SHELL_CONTEXT)
    expect(labels(groups)).toContain('db')
    expect(groups[0]?.prefixLength).toBe(0)
  })

  it('replaces the typed prefix of db', () => {
    const groups = complete('d', SHELL_CONTEXT)
    expect(labels(groups)).toContain('db')
    expect(groups[0]?.prefixLength).toBe(1)
  })

  it('offers every collection of the database after db.', () => {
    const groups = complete('db.', SHELL_CONTEXT)
    expect(labels(groups)).toEqual(['orders', 'users'])
    expect(insertTextOf(groups, 'users')).toBe('users.')
  })

  it('sorts the tab collection to the top', () => {
    const groups = complete('db.', SHELL_CONTEXT)
    const items = groups.flatMap((entry) => entry.items)
    expect(items.find((item) => item.label === 'users')?.sortText).toBe('0_users')
    expect(items.find((item) => item.label === 'orders')?.sortText).toBe('1_orders')
  })

  it('keeps the tab collection even when the list has not loaded', () => {
    const groups = complete('db.', { kind: 'shell', coll: 'users', collections: [] })
    expect(labels(groups)).toEqual(['users'])
  })

  it('offers read and write methods after db.users.', () => {
    const groups = complete('db.users.', SHELL_CONTEXT)
    expect(labels(groups)).toEqual([
      'find',
      'findOne',
      'aggregate',
      'countDocuments',
      'count',
      'insertOne',
      'insertMany',
      'updateOne',
      'updateMany',
      'replaceOne',
      'deleteOne',
      'deleteMany'
    ])
  })

  it('offers no chained methods after a write', () => {
    expect(labels(complete('db.users.deleteMany({}).', SHELL_CONTEXT))).toEqual([])
  })

  it('offers update operators in the update argument', () => {
    const groups = complete('db.users.updateOne({ a: 1 }, { $', SHELL_CONTEXT)
    expect(labels(groups)).toContain('$set')
    expect(labels(groups)).toContain('$inc')
    expect(labels(groups)).not.toContain('$gte')
  })

  it('offers query operators in the update filter argument', () => {
    const groups = complete('db.users.updateOne({ a: { $', SHELL_CONTEXT)
    expect(labels(groups)).toContain('$gte')
    expect(labels(groups)).not.toContain('$inc')
  })

  it('offers sort directions inside .sort()', () => {
    const groups = complete('db.users.find({}).sort({ createdAt: ', SHELL_CONTEXT)
    expect(labels(groups)).toEqual(['1', '-1'])
  })

  it('offers projection values in the second find argument', () => {
    const groups = complete('db.users.find({}, { name: ', SHELL_CONTEXT)
    expect(labels(groups)).toEqual(['1', '0'])
  })

  it('offers no values in a filter position', () => {
    const groups = complete('db.users.find({ age: ', SHELL_CONTEXT)
    expect(labels(groups)).not.toContain('-1')
  })

  it('keeps the typed method prefix', () => {
    const groups = complete('db.users.fi', SHELL_CONTEXT)
    expect(groups[0]?.prefixLength).toBe(2)
  })

  it('offers cursor methods after find(...)', () => {
    const groups = complete('db.users.find({}).', SHELL_CONTEXT)
    expect(labels(groups)).toEqual(['sort', 'skip', 'limit', 'toArray', 'pretty'])
  })

  it('offers chained methods after a chained call', () => {
    const groups = complete('db.users.find({}).sort({ a: 1 }).', SHELL_CONTEXT)
    expect(labels(groups)).toContain('limit')
  })

  it('restricts the chain of non cursor methods', () => {
    const groups = complete('db.users.aggregate([]).', SHELL_CONTEXT)
    expect(labels(groups)).toEqual(['toArray', 'pretty'])
  })

  it('offers query operators inside find arguments', () => {
    const groups = complete('db.users.find({ $', SHELL_CONTEXT)
    expect(labels(groups)).toContain('$gt')
    expect(labels(groups)).not.toContain('$group')
  })

  it('offers pipeline stages inside aggregate arguments', () => {
    const groups = complete('db.users.aggregate([{ $', SHELL_CONTEXT)
    expect(labels(groups)).toContain('$match')
    expect(labels(groups)).toContain('$group')
  })

  it('does not offer structure suggestions inside arguments', () => {
    const groups = complete('db.users.find({ na', SHELL_CONTEXT, { fieldNames: ['name'] })
    expect(labels(groups)).toContain('name')
    expect(labels(groups)).not.toContain('db')
  })
})

describe('aggregation completions', () => {
  it('offers stages at the stage key position', () => {
    const groups = complete('[{ $', PIPELINE_COMPLETION_CONTEXT)
    expect(labels(groups)).toContain('$match')
    expect(insertTextOf(groups, '$match')).toBe('"$match": { $0 }')
  })

  it('wraps a stage in an object when typed directly inside the array', () => {
    const groups = complete('[$', PIPELINE_COMPLETION_CONTEXT)
    expect(insertTextOf(groups, '$group')).toMatch(/^\{ "\$group": /)
    expect(insertTextOf(groups, '$group')).toMatch(/ \}$/)
  })

  it('offers query operators inside $match', () => {
    const groups = complete('[{ $match: { age: { $', PIPELINE_COMPLETION_CONTEXT)
    expect(labels(groups)).toContain('$gte')
    expect(insertTextOf(groups, '$gte')).toBe('"$gte": ${1:value}')
    expect(labels(groups)).not.toContain('$toUpper')
  })

  it('offers aggregation expressions inside $group', () => {
    const groups = complete('[{ $group: { _id: { $', PIPELINE_COMPLETION_CONTEXT)
    expect(labels(groups)).toContain('$toUpper')
    expect(labels(groups)).toContain('$sum')
  })

  it('offers aggregation expressions inside $expr', () => {
    const groups = complete('[{ $match: { $expr: { $', PIPELINE_COMPLETION_CONTEXT)
    expect(insertTextOf(groups, '$eq')).toBe('"$eq": [${1:expression}, ${2:expression}]')
  })

  it('offers field paths in a value position', () => {
    const groups = complete('[{ $group: { _id: "$', PIPELINE_COMPLETION_CONTEXT, {
      fieldNames: ['status']
    })
    expect(insertTextOf(groups, '$status')).toBe('"$status"')
  })
})

describe('simple mode roles', () => {
  it('offers sort directions in the sort editor', () => {
    const groups = complete('{ createdAt: ', SORT_COMPLETION_CONTEXT)
    expect(labels(groups)).toEqual(['1', '-1'])
  })

  it('offers include and exclude in the projection editor', () => {
    const groups = complete('{ name: ', PROJECTION_COMPLETION_CONTEXT)
    expect(labels(groups)).toEqual(['1', '0'])
  })

  it('leaves the filter editor to operators and helpers', () => {
    const groups = complete('{ age: ', QUERY_COMPLETION_CONTEXT)
    expect(labels(groups)).not.toContain('-1')
  })
})

describe('quoting', () => {
  it('inserts operators without a stray trailing quote', () => {
    const groups = complete('{ $', QUERY_COMPLETION_CONTEXT)
    expect(insertTextOf(groups, '$eq')).toBe('"$eq": ${1:value}')
    expect(insertTextOf(groups, '$oid')).toBe('"$oid": "${1:507f1f77bcf86cd799439011}"')
  })

  it('replaces an auto closed quote around the operator', () => {
    const groups = complete('{ "$g', QUERY_COMPLETION_CONTEXT, { charAfterCursor: '"' })
    expect(groups[0]?.prefixLength).toBe(3)
    expect(groups[0]?.consumeTrailingQuote).toBe(true)
    expect(groups[0]?.items.find((item) => item.label === '$gt')?.filterText).toBe('"$gt')
  })

  it('keeps the trailing quote when the cursor is not followed by one', () => {
    const groups = complete('{ "$g', QUERY_COMPLETION_CONTEXT, { charAfterCursor: '}' })
    expect(groups[0]?.consumeTrailingQuote).toBe(false)
  })

  it('completes document fields at a key position', () => {
    const groups = complete('{ ', QUERY_COMPLETION_CONTEXT, { fieldNames: ['createdAt'] })
    expect(insertTextOf(groups, 'createdAt')).toBe('"createdAt"')
    expect(groups[0]?.prefixLength).toBe(0)
  })

  it('completes shell helpers in a value position', () => {
    const groups = complete('{ _id: Obj', QUERY_COMPLETION_CONTEXT)
    expect(labels(groups)).toContain('ObjectId')
    expect(groups[groups.length - 1]?.prefixLength).toBe(3)
  })
})

describe('signature help', () => {
  it('describes the call the cursor sits in', () => {
    const info = resolveSignature('db.users.find({ a: 1 }, ')
    expect(info?.label).toBe('find(filter, projection)')
    expect(info?.activeParameter).toBe(1)
  })

  it('tracks the argument index of updates', () => {
    expect(resolveSignature('db.users.updateOne(')?.activeParameter).toBe(0)
    expect(resolveSignature('db.users.updateOne({}, ')?.activeParameter).toBe(1)
    expect(resolveSignature('db.users.updateOne({}, {}, ')?.activeParameter).toBe(2)
  })

  it('ignores commas inside nested values', () => {
    const info = resolveSignature('db.users.find({ a: [1, 2, 3] ')
    expect(info?.activeParameter).toBe(0)
  })

  it('describes helper calls too', () => {
    expect(resolveSignature('{ _id: ObjectId(')?.label).toBe('ObjectId(hex)')
  })

  it('returns nothing outside a call', () => {
    expect(resolveSignature('db.users.find({}) ')).toBeNull()
    expect(resolveSignature('[{ $match: { ')).toBeNull()
  })
})

describe('hover documentation', () => {
  it('documents query operators', () => {
    expect(describeSymbol('$gte')?.entries[0]?.detail).toBe('MongoDB query operator')
  })

  it('collects every meaning of an overloaded operator', () => {
    const details = describeSymbol('$eq')?.entries.map((entry) => entry.detail)
    expect(details).toContain('MongoDB query operator')
    expect(details).toContain('Aggregation expression')
  })

  it('documents stages, update operators, helpers and methods', () => {
    expect(describeSymbol('$lookup')?.entries[0]?.detail).toBe('Aggregation stage')
    expect(describeSymbol('$inc')?.entries[0]?.detail).toBe('Update operator')
    expect(describeSymbol('ObjectId')?.entries[0]?.detail).toBe('mongo shell helper')
    expect(describeSymbol('deleteMany')?.entries[0]?.detail).toBe('Collection method')
  })

  it('returns nothing for unknown words', () => {
    expect(describeSymbol('somethingElse')).toBeNull()
  })
})

describe('inserted snippets stay parseable', () => {
  const itemsOf = (groups: CompletionGroup[]): CompletionItemData[] =>
    groups.flatMap((group) => group.items)

  const expectQueryParses = (source: string): void => {
    const result = parseMongoQuery(source)
    expect(result.ok, `${source}: ${result.ok ? '' : result.error}`).toBe(true)
  }

  const expectShellParses = (source: string): void => {
    const result = parseShellCommand(source)
    expect(result.ok, `${source}: ${result.ok ? '' : result.error}`).toBe(true)
  }

  it('accepts every stage as a pipeline entry', () => {
    for (const item of itemsOf(complete('[{ $', PIPELINE_COMPLETION_CONTEXT))) {
      expectQueryParses('[{ ' + fillSnippet(item.insertText) + ' }]')
    }
  })

  it('accepts every stage typed directly inside the array', () => {
    for (const item of itemsOf(complete('[$', PIPELINE_COMPLETION_CONTEXT))) {
      expectQueryParses('[' + fillSnippet(item.insertText) + ']')
    }
  })

  it('accepts every query operator', () => {
    for (const item of itemsOf(complete('{ $', QUERY_COMPLETION_CONTEXT))) {
      expectQueryParses('{ ' + fillSnippet(item.insertText) + ' }')
    }
  })

  it('accepts every aggregation expression', () => {
    for (const item of itemsOf(complete('[{ $group: { _id: { $', PIPELINE_COMPLETION_CONTEXT))) {
      expectQueryParses('{ ' + fillSnippet(item.insertText) + ' }')
    }
  })

  it('accepts every collection method', () => {
    for (const item of itemsOf(complete('db.users.', SHELL_CONTEXT))) {
      expectShellParses('db.users.' + fillSnippet(item.insertText))
    }
  })

  it('accepts every chained cursor method', () => {
    for (const item of itemsOf(complete('db.users.find({}).', SHELL_CONTEXT))) {
      expectShellParses('db.users.find({}).' + fillSnippet(item.insertText))
    }
  })

  it('accepts the root level command snippets', () => {
    for (const item of itemsOf(complete('', SHELL_CONTEXT))) {
      if (item.kind !== 'command') continue
      expectShellParses(fillSnippet(item.insertText))
    }
  })
})

function fillSnippet(snippet: string): string {
  let out = ''
  let i = 0
  while (i < snippet.length) {
    const char = snippet.charAt(i)
    if (char !== '$') {
      out += char
      i++
      continue
    }
    const next = snippet.charAt(i + 1)
    if (next === '{') {
      const end = matchingBrace(snippet, i + 1)
      if (end < 0) {
        out += char
        i++
        continue
      }
      out += '1'
      i = end + 1
      continue
    }
    if (next >= '0' && next <= '9') {
      i += 2
      while (snippet.charAt(i) >= '0' && snippet.charAt(i) <= '9') i++
      continue
    }
    out += char
    i++
  }
  return out
}

function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text.charAt(i)
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
