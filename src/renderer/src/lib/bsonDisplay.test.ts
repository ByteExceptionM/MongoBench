import { describe, expect, it } from 'vitest'
import type { DocumentEnvelope } from '@shared/types'
import { extractColumns } from './bsonDisplay'

const envelope = (data: Record<string, unknown>): DocumentEnvelope => ({
  id: null,
  data,
  canonical: JSON.stringify(data),
  hash: 'h'
})

describe('extractColumns', () => {
  it('leads with _id when a document has it', () => {
    const columns = extractColumns([
      envelope({ name: 'a', _id: { $oid: '0123456789abcdef01234567' } }),
      envelope({ age: 3 })
    ])
    expect(columns).toEqual(['_id', 'name', 'age'])
  })

  it('leaves _id out when no document has it', () => {
    expect(extractColumns([envelope({ n: 5 }), envelope({ total: 1, n: 2 })])).toEqual([
      'n',
      'total'
    ])
  })

  it('returns no columns for no documents', () => {
    expect(extractColumns([])).toEqual([])
  })
})
