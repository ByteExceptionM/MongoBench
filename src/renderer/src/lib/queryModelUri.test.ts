import { describe, expect, it } from 'vitest'
import { queryModelTabId, queryModelUri, type QueryEditorSlot } from './queryModelUri'

// Monaco's Uri exposes the same scheme / authority / path split as WHATWG URL for these URIs.
const parts = (uri: string) => {
  const url = new URL(uri)
  return { scheme: url.protocol.replace(/:$/, ''), authority: url.host, path: url.pathname }
}

describe('queryModelUri', () => {
  it('puts the tab id and slot in the path', () => {
    expect(queryModelUri('t3', 'filter')).toBe('mongobench://query/t3/filter')
  })

  it.each<QueryEditorSlot>(['filter', 'projection', 'sort', 'pipeline', 'shell'])(
    'round-trips the %s slot',
    (slot) => {
      expect(queryModelTabId(parts(queryModelUri('t12', slot)))).toBe('t12')
    }
  )
})

describe('queryModelTabId', () => {
  it.each([
    'inmemory://model/1',
    'mongobench://other/t1/filter',
    'mongobench://query/t1/limit',
    'mongobench://query/t1/filter/extra',
    'mongobench://query//filter',
    'mongobench://query/t1',
    'file:///query/t1/filter'
  ])('returns null for %s', (uri) => {
    expect(queryModelTabId(parts(uri))).toBeNull()
  })
})
