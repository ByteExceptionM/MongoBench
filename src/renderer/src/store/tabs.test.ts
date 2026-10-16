import { beforeEach, describe, expect, it } from 'vitest'
import type { CollectionRef } from '@shared/types'
import {
  activeCollectionKey,
  collectionKey,
  isDraftDirty,
  ordinalLabel,
  useTabsStore,
  type AppliedQueries,
  type QueryDraft
} from './tabs'

const users: CollectionRef = { connectionId: 'c1', db: 'app', coll: 'users' }
const orders: CollectionRef = { connectionId: 'c1', db: 'app', coll: 'orders' }
const logs: CollectionRef = { connectionId: 'c1', db: 'audit', coll: 'logs' }
const remote: CollectionRef = { connectionId: 'c2', db: 'app', coll: 'users' }

const store = () => useTabsStore.getState()
const tab = (id: string) => {
  const found = store().tabs.find((t) => t.id === id)
  if (!found) throw new Error(`no tab ${id}`)
  return found
}
const draft = (id: string): QueryDraft => {
  const found = store().drafts[id]
  if (!found) throw new Error(`no draft ${id}`)
  return found
}
const activeId = (): string => {
  const id = store().activeTabId
  if (id === null) throw new Error('no active tab')
  return id
}
const openNewId = (target: CollectionRef): string => {
  store().openNew(target)
  return activeId()
}

function assertInvariants(): void {
  const s = store()
  expect(Object.keys(s.drafts).sort()).toEqual(s.tabs.map((t) => t.id).sort())
  if (s.activeTabId === null) {
    expect(s.tabs).toHaveLength(0)
  } else {
    const active = tab(s.activeTabId)
    for (const t of s.tabs) expect(t.lastActive).toBeLessThanOrEqual(active.lastActive)
  }
  const seen = new Set<string>()
  for (const t of s.tabs) {
    const key = `${t.connectionId}|${t.db}|${t.coll}|${t.ordinal}`
    expect(seen.has(key)).toBe(false)
    seen.add(key)
  }
}

beforeEach(() => {
  useTabsStore.setState(useTabsStore.getInitialState(), true)
})

describe('open', () => {
  it('creates an active tab with the default draft and an already applied simple query', () => {
    store().open(users)
    const id = activeId()
    expect(tab(id)).toMatchObject({ ...users, ordinal: 1 })
    expect(draft(id)).toEqual({
      mode: 'simple',
      filter: '{}',
      projection: '{}',
      sort: '{}',
      pipeline: '',
      shell: '',
      limit: '100'
    })
    expect(tab(id).applied).toEqual({
      simple: {
        filter: '{}',
        projection: '{}',
        sort: '{}',
        skip: 0,
        limit: 100,
        epoch: expect.any(Number)
      },
      aggregation: null,
      shell: null
    })
    expect(isDraftDirty(draft(id), tab(id).applied)).toBe(false)
    assertInvariants()
  })

  it('focuses the existing tab instead of adding one', () => {
    store().open(users)
    const first = activeId()
    store().open(orders)
    store().open(users)
    expect(store().tabs).toHaveLength(2)
    expect(activeId()).toBe(first)
    assertInvariants()
  })

  it('gives a reopened collection a fresh epoch, so it never shows an older cached result', () => {
    store().open(users)
    const firstEpoch = tab(activeId()).applied.simple.epoch
    store().close(activeId())
    store().open(users)
    expect(tab(activeId()).applied.simple.epoch).toBeGreaterThan(firstEpoch)
  })

  it('copies the target fields instead of keeping the caller object', () => {
    store().open({ ...users, extra: 'x' } as CollectionRef)
    expect(Object.keys(tab(activeId())).sort()).toEqual(
      ['applied', 'coll', 'connectionId', 'db', 'id', 'lastActive', 'ordinal'].sort()
    )
  })
})

describe('openNew', () => {
  it('always adds a tab with the next ordinal and a distinct id', () => {
    store().open(users)
    const first = activeId()
    const second = openNewId(users)
    expect(second).not.toBe(first)
    expect(tab(second).ordinal).toBe(2)
    expect(store().tabs).toHaveLength(2)
    assertInvariants()
  })

  it('uses URI-safe sequential ids', () => {
    const a = openNewId(users)
    const b = openNewId(orders)
    expect(a).toMatch(/^t\d+$/)
    expect(b).toMatch(/^t\d+$/)
  })
})

describe('most recently active tab', () => {
  it('open focuses the tab of the collection that was active last', () => {
    const u1 = openNewId(users)
    const u2 = openNewId(users)
    const o = openNewId(orders)

    store().activate(u2)
    store().activate(o)
    store().open(users)
    expect(activeId()).toBe(u2)

    store().activate(u1)
    store().activate(o)
    store().open(users)
    expect(activeId()).toBe(u1)
    assertInvariants()
  })
})

describe('ordinals', () => {
  it('reuses the smallest free number and never renumbers open tabs', () => {
    const a = openNewId(users)
    const b = openNewId(users)
    const c = openNewId(users)
    store().close(b)
    const d = openNewId(users)
    expect(tab(a).ordinal).toBe(1)
    expect(tab(c).ordinal).toBe(3)
    expect(tab(d).ordinal).toBe(2)
    assertInvariants()
  })

  it('counts per collection and connection', () => {
    openNewId(users)
    expect(tab(openNewId(orders)).ordinal).toBe(1)
    expect(tab(openNewId(remote)).ordinal).toBe(1)
  })

  it('ordinalLabel is null for a single tab and the ordinal when several share the collection', () => {
    const a = openNewId(users)
    openNewId(orders)
    expect(ordinalLabel(store().tabs, tab(a))).toBeNull()
    const b = openNewId(users)
    expect(ordinalLabel(store().tabs, tab(a))).toBe(1)
    expect(ordinalLabel(store().tabs, tab(b))).toBe(2)
  })
})

describe('setDraft', () => {
  it('changes only that draft and keeps the tabs array reference', () => {
    const a = openNewId(users)
    const b = openNewId(orders)
    const tabsBefore = store().tabs
    const otherBefore = draft(b)
    store().setDraft(a, { filter: '{ a: 1 }' })
    expect(draft(a).filter).toBe('{ a: 1 }')
    expect(draft(b)).toBe(otherBefore)
    expect(store().tabs).toBe(tabsBefore)
    assertInvariants()
  })

  it('leaves the state identical for an unknown id', () => {
    openNewId(users)
    const before = store()
    store().setDraft('t999', { filter: '{}' })
    expect(store()).toBe(before)
  })
})

describe('run', () => {
  it('commits the simple draft and resets skip', () => {
    const id = openNewId(users)
    store().setSkip(id, 200)
    store().setDraft(id, {
      filter: '{ a: 1 }',
      projection: '{ a: 1 }',
      sort: '{ b: -1 }',
      limit: '25'
    })
    store().run(id)
    expect(tab(id).applied.simple).toMatchObject({
      filter: '{ a: 1 }',
      projection: '{ a: 1 }',
      sort: '{ b: -1 }',
      skip: 0,
      limit: 25
    })
    expect(isDraftDirty(draft(id), tab(id).applied)).toBe(false)
  })

  it('commits only the visible mode', () => {
    const id = openNewId(users)
    const simpleBefore = tab(id).applied.simple
    store().setDraft(id, {
      mode: 'aggregation',
      pipeline: '[{ $match: {} }]',
      shell: 'db.x.find()'
    })
    store().run(id)
    expect(tab(id).applied.simple).toBe(simpleBefore)
    expect(tab(id).applied.aggregation).toEqual({
      source: '[{ $match: {} }]',
      epoch: expect.any(Number)
    })
    expect(tab(id).applied.shell).toBeNull()

    store().setDraft(id, { mode: 'shell' })
    store().run(id)
    expect(tab(id).applied.shell?.source).toBe('db.x.find()')
  })

  it('issues strictly increasing epochs that are unique across tabs', () => {
    const a = openNewId(users)
    const b = openNewId(users)
    const epochs = [tab(a).applied.simple.epoch, tab(b).applied.simple.epoch]
    store().run(a)
    epochs.push(tab(a).applied.simple.epoch)
    store().run(b)
    epochs.push(tab(b).applied.simple.epoch)
    store().setDraft(a, { mode: 'aggregation' })
    store().run(a)
    epochs.push(tab(a).applied.aggregation?.epoch ?? -1)
    for (let i = 1; i < epochs.length; i++) {
      expect(epochs[i]).toBeGreaterThan(epochs[i - 1] ?? Infinity)
    }
  })

  it.each<[string, number]>([
    ['', 0],
    ['0', 0],
    ['25', 25],
    ['abc', 0],
    ['-5', 0]
  ])('parses limit %j as %i', (limit, expected) => {
    const id = openNewId(users)
    store().setDraft(id, { limit })
    store().run(id)
    expect(tab(id).applied.simple.limit).toBe(expected)
  })

  it('returns the run it committed', () => {
    const id = openNewId(users)
    expect(store().run(id)).toBe(tab(id).applied.simple)
    store().setDraft(id, { mode: 'shell', shell: 'db.users.deleteMany({})' })
    const committed = store().run(id)
    expect(committed).toEqual({ source: 'db.users.deleteMany({})', epoch: expect.any(Number) })
    expect(committed).toBe(tab(id).applied.shell)
  })

  it('ignores an unknown id', () => {
    openNewId(users)
    const before = store()
    expect(store().run('t999')).toBeNull()
    expect(store()).toBe(before)
  })
})

describe('mode switch', () => {
  it('never changes the applied queries', () => {
    const id = openNewId(users)
    const appliedBefore = tab(id).applied
    store().setDraft(id, { mode: 'aggregation' })
    store().setDraft(id, { mode: 'shell' })
    expect(tab(id).applied).toBe(appliedBefore)
  })

  it('is dirty only when the visible mode differs from its own last run', () => {
    const id = openNewId(users)
    store().setDraft(id, { mode: 'aggregation' })
    expect(isDraftDirty(draft(id), tab(id).applied)).toBe(false)
    store().setDraft(id, { pipeline: '[]' })
    expect(isDraftDirty(draft(id), tab(id).applied)).toBe(true)
    store().run(id)
    expect(isDraftDirty(draft(id), tab(id).applied)).toBe(false)
  })
})

describe('isDraftDirty', () => {
  const applied: AppliedQueries = {
    simple: { filter: '{}', projection: '{}', sort: '{}', skip: 40, limit: 100, epoch: 7 },
    aggregation: { source: '[{ $limit: 1 }]', epoch: 8 },
    shell: null
  }
  const clean: QueryDraft = {
    mode: 'simple',
    filter: '{}',
    projection: '{}',
    sort: '{}',
    pipeline: '[{ $limit: 1 }]',
    shell: '',
    limit: '100'
  }

  it('compares the limit by its parsed value and ignores skip and epoch', () => {
    expect(isDraftDirty(clean, applied)).toBe(false)
    expect(isDraftDirty({ ...clean, limit: '0100' }, applied)).toBe(false)
  })

  it.each(['filter', 'projection', 'sort'] as const)('simple: %s text makes it dirty', (field) => {
    expect(isDraftDirty({ ...clean, [field]: '{ a: 1 }' }, applied)).toBe(true)
  })

  it('simple: a different limit makes it dirty', () => {
    expect(isDraftDirty({ ...clean, limit: '' }, applied)).toBe(true)
  })

  it('ignores the drafts of hidden modes', () => {
    expect(isDraftDirty({ ...clean, pipeline: '[]', shell: 'db.a.find()' }, applied)).toBe(false)
  })

  it('aggregation and shell compare their source, an unrun mode against empty text', () => {
    expect(isDraftDirty({ ...clean, mode: 'aggregation' }, applied)).toBe(false)
    expect(isDraftDirty({ ...clean, mode: 'aggregation', pipeline: '[]' }, applied)).toBe(true)
    expect(isDraftDirty({ ...clean, mode: 'shell' }, applied)).toBe(false)
    expect(isDraftDirty({ ...clean, mode: 'shell', shell: 'db.a.find()' }, applied)).toBe(true)
  })
})

describe('setSkip', () => {
  it('pages the simple query and keeps its epoch', () => {
    const id = openNewId(users)
    const before = tab(id).applied.simple
    store().setSkip(id, 300)
    expect(tab(id).applied.simple).toEqual({ ...before, skip: 300 })
  })

  it('leaves aggregation and shell runs untouched', () => {
    const id = openNewId(users)
    store().setDraft(id, { mode: 'aggregation', pipeline: '[]' })
    store().run(id)
    const aggregation = tab(id).applied.aggregation
    store().setSkip(id, 100)
    expect(tab(id).applied.aggregation).toBe(aggregation)
  })

  it('ignores an unknown id', () => {
    openNewId(users)
    const before = store()
    store().setSkip('t999', 100)
    expect(store()).toBe(before)
  })
})

describe('duplicate', () => {
  it('inserts an active copy right after the source', () => {
    const a = openNewId(users)
    const b = openNewId(orders)
    store().duplicate(a)
    const copy = activeId()
    expect(store().tabs.map((t) => t.id)).toEqual([a, copy, b])
    expect(tab(copy)).toMatchObject({ ...users, ordinal: 2 })
    assertInvariants()
  })

  it('copies the draft and the simple query, sharing its epoch', () => {
    const a = openNewId(users)
    store().setDraft(a, { filter: '{ a: 1 }', limit: '5' })
    store().run(a)
    store().setDraft(a, { filter: '{ a: 2 }' })
    const sourceDraft = draft(a)
    const sourceApplied = tab(a).applied
    store().duplicate(a)
    const copy = activeId()
    expect(draft(copy)).toEqual(sourceDraft)
    expect(draft(copy)).not.toBe(sourceDraft)
    expect(tab(copy).applied.simple).toEqual(sourceApplied.simple)
    expect(draft(a)).toBe(sourceDraft)
    expect(tab(a).applied).toBe(sourceApplied)
  })

  it('does not copy aggregation or shell runs', () => {
    const a = openNewId(users)
    store().setDraft(a, { mode: 'aggregation', pipeline: '[{ $count: "n" }]' })
    store().run(a)
    store().setDraft(a, { mode: 'shell', shell: 'db.users.find()' })
    store().run(a)
    store().duplicate(a)
    const copy = activeId()
    expect(tab(copy).applied.aggregation).toBeNull()
    expect(tab(copy).applied.shell).toBeNull()
    expect(draft(copy).shell).toBe('db.users.find()')
  })

  it('ignores an unknown id', () => {
    openNewId(users)
    const before = store()
    store().duplicate('t999')
    expect(store()).toBe(before)
  })
})

describe('openWithFilter', () => {
  const lookup = '{ _id: ObjectId("65a1b2c3d4e5f60718293a4b") }'

  it('opens a new applied simple tab instead of touching a dirty tab', () => {
    const a = openNewId(users)
    store().setDraft(a, { filter: '{ name: "x" }' })
    const aDraft = draft(a)
    const aApplied = tab(a).applied
    store().openWithFilter(users, lookup)
    const b = activeId()
    expect(b).not.toBe(a)
    expect(draft(b)).toMatchObject({ mode: 'simple', filter: lookup, projection: '{}', sort: '{}' })
    expect(tab(b).applied.simple).toMatchObject({ filter: lookup, projection: '{}', skip: 0 })
    expect(isDraftDirty(draft(b), tab(b).applied)).toBe(false)
    expect(draft(a)).toBe(aDraft)
    expect(tab(a).applied).toBe(aApplied)
    assertInvariants()
  })

  it('never reuses a tab that shows another mode', () => {
    const a = openNewId(users)
    store().setDraft(a, { mode: 'aggregation' })
    store().openWithFilter(users, '{}')
    expect(activeId()).not.toBe(a)
    expect(draft(a).mode).toBe('aggregation')
  })

  it('reuses the lookup tab with a fresh epoch on a repeated lookup', () => {
    store().openWithFilter(users, lookup)
    const b = activeId()
    const epoch = tab(b).applied.simple.epoch
    openNewId(orders)
    store().openWithFilter(users, lookup)
    expect(activeId()).toBe(b)
    expect(store().tabs).toHaveLength(2)
    expect(tab(b).applied.simple.epoch).toBeGreaterThan(epoch)
    assertInvariants()
  })

  it('opens another tab once the lookup tab was edited', () => {
    store().openWithFilter(users, lookup)
    const b = activeId()
    store().setDraft(b, { sort: '{ a: 1 }' })
    store().openWithFilter(users, lookup)
    expect(activeId()).not.toBe(b)
    expect(store().tabs).toHaveLength(2)
  })
})

describe('close', () => {
  it('removes the draft and moves to the right neighbour, stamped as active', () => {
    const a = openNewId(users)
    const b = openNewId(orders)
    const c = openNewId(logs)
    store().activate(b)
    store().close(b)
    expect(activeId()).toBe(c)
    expect(store().drafts[b]).toBeUndefined()
    assertInvariants()
    store().close(c)
    expect(activeId()).toBe(a)
    assertInvariants()
  })

  it('keeps the active tab when closing another one', () => {
    const a = openNewId(users)
    const b = openNewId(orders)
    store().close(a)
    expect(activeId()).toBe(b)
    assertInvariants()
  })

  it('leaves no active tab after the last one closes', () => {
    const a = openNewId(users)
    store().close(a)
    expect(store().activeTabId).toBeNull()
    assertInvariants()
  })

  it('ignores an unknown id', () => {
    openNewId(users)
    const before = store()
    store().close('t999')
    expect(store()).toBe(before)
  })
})

describe('closeFor*', () => {
  it('closeForCollection removes every tab of the collection and falls back to the first tab', () => {
    const o = openNewId(orders)
    openNewId(users)
    openNewId(users)
    store().closeForCollection(users.connectionId, users.db, users.coll)
    expect(store().tabs.map((t) => t.id)).toEqual([o])
    expect(activeId()).toBe(o)
    assertInvariants()
  })

  it('closeForDatabase removes the tabs of that database only', () => {
    const l = openNewId(logs)
    openNewId(users)
    openNewId(orders)
    const r = openNewId(remote)
    store().closeForDatabase('c1', 'app')
    expect(store().tabs.map((t) => t.id)).toEqual([l, r])
    expect(activeId()).toBe(r)
    assertInvariants()
  })

  it('closeForConnection removes the tabs of that connection only', () => {
    openNewId(users)
    const r = openNewId(remote)
    openNewId(logs)
    store().closeForConnection('c1')
    expect(store().tabs.map((t) => t.id)).toEqual([r])
    expect(activeId()).toBe(r)
    assertInvariants()
  })

  it('returns the identical state when nothing matches', () => {
    openNewId(users)
    const before = store()
    store().closeForConnection('c9')
    store().closeForDatabase('c1', 'nope')
    store().closeForCollection('c1', 'app', 'nope')
    expect(store()).toBe(before)
  })
})

describe('renameCollection', () => {
  it('keeps ids, drafts, ordinals and the active tab', () => {
    const a = openNewId(users)
    const b = openNewId(users)
    store().setDraft(a, { filter: '{ a: 1 }' })
    const drafts = store().drafts
    store().renameCollection('c1', 'app', 'users', 'members')
    expect(tab(a)).toMatchObject({ coll: 'members', ordinal: 1 })
    expect(tab(b)).toMatchObject({ coll: 'members', ordinal: 2 })
    expect(store().drafts).toBe(drafts)
    expect(activeId()).toBe(b)
    assertInvariants()
  })

  it('renumbers only on a collision with a stale tab of the new name', () => {
    const stale = openNewId({ ...users, coll: 'members' })
    const a = openNewId(users)
    const b = openNewId(users)
    store().renameCollection('c1', 'app', 'users', 'members')
    expect(tab(stale).ordinal).toBe(1)
    expect(tab(a).ordinal).toBe(3)
    expect(tab(b).ordinal).toBe(2)
    assertInvariants()
  })

  it('leaves other connections and databases alone', () => {
    const r = openNewId(remote)
    store().renameCollection('c1', 'app', 'users', 'members')
    expect(tab(r).coll).toBe('users')
  })

  it('leaves the applied pipeline idle and keeps the draft, so only Run executes it again', () => {
    const a = openNewId(users)
    store().setDraft(a, { mode: 'shell', shell: 'db.users.find()' })
    store().run(a)
    store().setDraft(a, { mode: 'aggregation', pipeline: '[{ $count: "n" }]' })
    store().run(a)
    const { simple, shell } = tab(a).applied
    store().renameCollection('c1', 'app', 'users', 'members')
    expect(tab(a).applied).toEqual({ simple, aggregation: null, shell })
    expect(draft(a).pipeline).toBe('[{ $count: "n" }]')
    expect(isDraftDirty(draft(a), tab(a).applied)).toBe(true)
  })

  it('also leaves the pipeline of a renumbered tab idle', () => {
    openNewId({ ...users, coll: 'members' })
    const a = openNewId(users)
    store().setDraft(a, { mode: 'aggregation', pipeline: '[]' })
    store().run(a)
    store().renameCollection('c1', 'app', 'users', 'members')
    expect(tab(a)).toMatchObject({ ordinal: 2, applied: { aggregation: null } })
  })
})

describe('activate', () => {
  it('stamps the tab as most recently active', () => {
    const a = openNewId(users)
    openNewId(orders)
    store().activate(a)
    expect(activeId()).toBe(a)
    assertInvariants()
  })

  it('returns the identical state for an unknown or already active tab', () => {
    const a = openNewId(users)
    const before = store()
    store().activate('t999')
    store().activate(a)
    expect(store()).toBe(before)
  })
})

describe('activeCollectionKey', () => {
  it('is the key of the active tab collection only', () => {
    expect(activeCollectionKey(store())).toBeNull()
    const a = openNewId(users)
    openNewId(orders)
    expect(activeCollectionKey(store())).toBe(collectionKey(orders))
    expect(activeCollectionKey(store())).not.toBe(collectionKey(users))
    expect(activeCollectionKey(store())).not.toBe(collectionKey({ ...orders, connectionId: 'c2' }))
    store().activate(a)
    expect(activeCollectionKey(store())).toBe(collectionKey(users))
    store().closeForConnection('c1')
    expect(activeCollectionKey(store())).toBeNull()
  })

  it('keeps names with separators apart', () => {
    expect(collectionKey({ connectionId: 'c1', db: 'a', coll: 'b.c' })).not.toBe(
      collectionKey({ connectionId: 'c1', db: 'a.b', coll: 'c' })
    )
  })
})
