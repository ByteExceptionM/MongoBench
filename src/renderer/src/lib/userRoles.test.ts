import { describe, expect, it } from 'vitest'
import type { DatabaseRoleInfo, DatabaseUser, DatabaseUserRole } from '@shared/types'
import {
  addRole,
  COMMON_DB_ROLES,
  databaseSuggestions,
  diffRoles,
  groupRoles,
  hasRole,
  matchesRoleFilter,
  orderRoles,
  removeRole,
  roleEntries,
  roleKey,
  roleLabel,
  roleSuggestions
} from './userRoles'

const r = (role: string, db: string): DatabaseUserRole => ({ role, db })

const user = (name: string, roles: DatabaseUserRole[]): DatabaseUser => ({
  user: name,
  db: 'admin',
  roles
})

describe('roleKey', () => {
  it('keeps role and db apart even when dots could make them collide', () => {
    expect(roleKey(r('b.c', 'a'))).not.toBe(roleKey(r('c', 'a.b')))
  })

  it('is the same for equal roles', () => {
    expect(roleKey(r('read', 'shop'))).toBe(roleKey({ db: 'shop', role: 'read' }))
  })
})

describe('roleLabel', () => {
  it('reads role@db', () => {
    expect(roleLabel(r('readWrite', 'shop'))).toBe('readWrite@shop')
  })
})

describe('hasRole', () => {
  it('needs both role and db to match', () => {
    const roles = [r('read', 'shop')]
    expect(hasRole(roles, r('read', 'shop'))).toBe(true)
    expect(hasRole(roles, r('read', 'admin'))).toBe(false)
    expect(hasRole(roles, r('readWrite', 'shop'))).toBe(false)
  })
})

describe('addRole', () => {
  it('appends a role that is not assigned yet', () => {
    expect(addRole([r('read', 'shop')], r('dbOwner', 'shop'))).toEqual([
      r('read', 'shop'),
      r('dbOwner', 'shop')
    ])
  })

  it('never adds a duplicate', () => {
    const roles = [r('read', 'shop')]
    const next = addRole(roles, r('read', 'shop'))
    expect(next).toEqual([r('read', 'shop')])
    expect(next).not.toBe(roles)
  })
})

describe('removeRole', () => {
  it('removes only the exact role on that db', () => {
    const roles = [r('read', 'shop'), r('read', 'logs'), r('dbOwner', 'shop')]
    expect(removeRole(roles, r('read', 'shop'))).toEqual([r('read', 'logs'), r('dbOwner', 'shop')])
    expect(roles).toHaveLength(3)
  })
})

describe('diffRoles', () => {
  it('reports nothing when only the order differs', () => {
    const initial = [r('read', 'a'), r('readWrite', 'b')]
    expect(diffRoles(initial, [r('readWrite', 'b'), r('read', 'a')])).toEqual({
      added: [],
      removed: []
    })
  })

  it('reports added and removed roles', () => {
    const initial = [r('read', 'a'), r('readWrite', 'b')]
    const current = [r('readWrite', 'b'), r('dbOwner', 'a')]
    expect(diffRoles(initial, current)).toEqual({
      added: [r('dbOwner', 'a')],
      removed: [r('read', 'a')]
    })
  })

  it('treats the same role on another db as a different role', () => {
    expect(diffRoles([r('read', 'a')], [r('read', 'b')])).toEqual({
      added: [r('read', 'b')],
      removed: [r('read', 'a')]
    })
  })
})

describe('orderRoles', () => {
  it('puts the current db first, then sorts by db and role', () => {
    const roles = [r('read', 'zoo'), r('readWrite', 'app'), r('read', 'app'), r('dbOwner', 'shop')]
    expect(orderRoles(roles, 'shop')).toEqual([
      r('dbOwner', 'shop'),
      r('read', 'app'),
      r('readWrite', 'app'),
      r('read', 'zoo')
    ])
  })

  it('does not change its input', () => {
    const roles = [r('read', 'b'), r('read', 'a')]
    orderRoles(roles, 'x')
    expect(roles).toEqual([r('read', 'b'), r('read', 'a')])
  })
})

describe('matchesRoleFilter', () => {
  it('matches everything for an empty or blank filter', () => {
    expect(matchesRoleFilter(r('read', 'shop'), '')).toBe(true)
    expect(matchesRoleFilter(r('read', 'shop'), '   ')).toBe(true)
  })

  it('matches the role name case-insensitively', () => {
    expect(matchesRoleFilter(r('readWrite', 'shop'), 'WRITE')).toBe(true)
  })

  it('matches the db name', () => {
    expect(matchesRoleFilter(r('read', 'tenant_42'), 'tenant')).toBe(true)
  })

  it('matches the role@db form', () => {
    expect(matchesRoleFilter(r('readWrite', 'sh'), ' readwrite@sh ')).toBe(true)
    expect(matchesRoleFilter(r('readWrite', 'sh'), 'te@s')).toBe(true)
  })

  it('rejects roles that match nowhere', () => {
    expect(matchesRoleFilter(r('read', 'shop'), 'owner')).toBe(false)
  })
})

describe('groupRoles', () => {
  it('marks kept, added and removed roles and keeps removed ones visible', () => {
    const initial = [r('read', 'shop'), r('dbOwner', 'shop')]
    const current = [r('read', 'shop'), r('readWrite', 'shop')]
    expect(groupRoles(roleEntries(initial, current, 'shop'), '')).toEqual([
      {
        db: 'shop',
        roles: [
          { role: r('dbOwner', 'shop'), status: 'removed' },
          { role: r('read', 'shop'), status: 'kept' },
          { role: r('readWrite', 'shop'), status: 'added' }
        ]
      }
    ])
  })

  it('puts the current db group first and sorts the rest by db', () => {
    const current = [r('read', 'zoo'), r('read', 'app'), r('read', 'shop')]
    expect(groupRoles(roleEntries([], current, 'shop'), '').map((g) => g.db)).toEqual([
      'shop',
      'app',
      'zoo'
    ])
  })

  it('drops groups the filter leaves empty', () => {
    const current = [r('read', 'shop'), r('dbOwner', 'logs')]
    expect(groupRoles(roleEntries([], current, 'shop'), 'owner')).toEqual([
      { db: 'logs', roles: [{ role: r('dbOwner', 'logs'), status: 'added' }] }
    ])
  })

  it('returns no groups without roles', () => {
    expect(groupRoles(roleEntries([], [], 'shop'), '')).toEqual([])
  })
})

describe('roleSuggestions', () => {
  const serverRoles: DatabaseRoleInfo[] = [
    { role: 'read', db: 'shop', isBuiltin: true },
    { role: 'orderClerk', db: 'shop', isBuiltin: false },
    { role: '__system', db: 'shop', isBuiltin: true },
    { role: 'reportViewer', db: 'logs', isBuiltin: false }
  ]

  it('takes only the target db roles from the server and skips internal ones', () => {
    const out = roleSuggestions('shop', { serverRoles, users: [], assigned: [] })
    expect(out).toContain('orderClerk')
    expect(out).not.toContain('reportViewer')
    expect(out).not.toContain('__system')
  })

  it('includes roles seen on other users for that db', () => {
    const users = [user('a', [r('auditor', 'shop'), r('archiver', 'logs')])]
    const out = roleSuggestions('shop', { users, assigned: [] })
    expect(out).toContain('auditor')
    expect(out).not.toContain('archiver')
  })

  it('always offers the common roles, also without server roles', () => {
    const out = roleSuggestions('shop', { users: [], assigned: [] })
    expect(out).toEqual([...COMMON_DB_ROLES].sort((a, b) => a.localeCompare(b)))
  })

  it('leaves out roles already assigned on the target db only', () => {
    const assigned = [r('read', 'shop'), r('dbOwner', 'logs')]
    const out = roleSuggestions('shop', { serverRoles, users: [], assigned })
    expect(out).not.toContain('read')
    expect(out).toContain('dbOwner')
  })

  it('dedupes and sorts', () => {
    const users = [user('a', [r('orderClerk', 'shop')]), user('b', [r('readWrite', 'shop')])]
    expect(roleSuggestions('shop', { serverRoles, users, assigned: [] })).toEqual([
      'dbAdmin',
      'dbOwner',
      'orderClerk',
      'read',
      'readWrite',
      'userAdmin'
    ])
  })
})

describe('databaseSuggestions', () => {
  it('unites listed databases, admin, the current db and role dbs, deduped and sorted', () => {
    const users = [user('a', [r('read', 'logs'), r('read', 'shop'), r('read', 'legacy')])]
    expect(
      databaseSuggestions('shop', {
        databases: [{ name: 'shop' }, { name: 'logs' }, { name: 'config' }],
        users
      })
    ).toEqual(['admin', 'config', 'legacy', 'logs', 'shop'])
  })

  it('works before the database list has loaded', () => {
    expect(databaseSuggestions('shop', { users: [] })).toEqual(['admin', 'shop'])
  })
})
