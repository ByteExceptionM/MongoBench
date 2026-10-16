import { describe, expect, it } from 'vitest'
import { reorderIds } from './reorder'

const ids = ['A', 'B', 'C', 'D']

describe('reorderIds', () => {
  it.each<[string, string, 'before' | 'after', string[]]>([
    ['A', 'C', 'before', ['B', 'A', 'C', 'D']],
    ['A', 'C', 'after', ['B', 'C', 'A', 'D']],
    ['A', 'D', 'after', ['B', 'C', 'D', 'A']],
    ['D', 'B', 'before', ['A', 'D', 'B', 'C']],
    ['D', 'B', 'after', ['A', 'B', 'D', 'C']],
    ['D', 'A', 'before', ['D', 'A', 'B', 'C']]
  ])('moves %s %s → %s %s', (drag, over, pos, expected) => {
    expect(reorderIds(ids, drag, over, pos)).toEqual(expected)
  })

  it.each<[string, string, 'before' | 'after']>([
    ['A', 'B', 'before'],
    ['B', 'A', 'after'],
    ['B', 'B', 'before'],
    ['X', 'B', 'before'],
    ['A', 'X', 'after']
  ])('returns null when dropping %s on %s (%s) keeps the order', (drag, over, pos) => {
    expect(reorderIds(ids, drag, over, pos)).toBeNull()
  })

  it('leaves the input untouched', () => {
    const input = [...ids]
    reorderIds(input, 'A', 'D', 'after')
    expect(input).toEqual(ids)
  })
})
