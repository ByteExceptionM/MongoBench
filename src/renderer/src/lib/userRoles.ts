import type { DatabaseInfo, DatabaseRoleInfo, DatabaseUser, DatabaseUserRole } from '@shared/types'

/** Built-in roles that exist on every database. */
export const COMMON_DB_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'] as const

// Orders like a default localeCompare, without resolving the locale on every comparison.
const collator = new Intl.Collator()

/** Identity of a role assignment; NUL is valid in neither a role nor a database name. */
export function roleKey(role: DatabaseUserRole): string {
  return `${role.db}\u0000${role.role}`
}

/** Display form `role@db`. */
export function roleLabel(role: DatabaseUserRole): string {
  return `${role.role}@${role.db}`
}

/** Whether `role` is assigned on exactly its db. */
export function hasRole(roles: readonly DatabaseUserRole[], role: DatabaseUserRole): boolean {
  const key = roleKey(role)
  return roles.some((r) => roleKey(r) === key)
}

/** Copy of `roles` with `role` appended unless it is already assigned. */
export function addRole(
  roles: readonly DatabaseUserRole[],
  role: DatabaseUserRole
): DatabaseUserRole[] {
  return hasRole(roles, role) ? [...roles] : [...roles, role]
}

/** Copy of `roles` without `role` on its db; the same role on other dbs stays. */
export function removeRole(
  roles: readonly DatabaseUserRole[],
  role: DatabaseUserRole
): DatabaseUserRole[] {
  const key = roleKey(role)
  return roles.filter((r) => roleKey(r) !== key)
}

/** Roles only in `current` (added) and only in `initial` (removed); order is ignored. */
export function diffRoles(
  initial: readonly DatabaseUserRole[],
  current: readonly DatabaseUserRole[]
): { added: DatabaseUserRole[]; removed: DatabaseUserRole[] } {
  const before = new Set(initial.map(roleKey))
  const after = new Set(current.map(roleKey))
  return {
    added: current.filter((r) => !before.has(roleKey(r))),
    removed: initial.filter((r) => !after.has(roleKey(r)))
  }
}

function compareRoles(currentDb: string): (a: DatabaseUserRole, b: DatabaseUserRole) => number {
  return (a, b) =>
    Number(b.db === currentDb) - Number(a.db === currentDb) ||
    collator.compare(a.db, b.db) ||
    collator.compare(a.role, b.role)
}

/** Sorted copy: roles on `currentDb` first, then by db, then by role. */
export function orderRoles(
  roles: readonly DatabaseUserRole[],
  currentDb: string
): DatabaseUserRole[] {
  return [...roles].sort(compareRoles(currentDb))
}

/** Case-insensitive substring match against `role@db`; a blank filter matches everything. */
export function matchesRoleFilter(role: DatabaseUserRole, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  return needle === '' || roleLabel(role).toLowerCase().includes(needle)
}

export type RoleStatus = 'kept' | 'added' | 'removed'

export type RoleEntry = { role: DatabaseUserRole; status: RoleStatus }

export type RoleGroup = { db: string; roles: RoleEntry[] }

/** Current roles plus removed initial ones, each with its status, in `orderRoles` order. */
export function roleEntries(
  initial: readonly DatabaseUserRole[],
  current: readonly DatabaseUserRole[],
  currentDb: string
): RoleEntry[] {
  const before = new Set(initial.map(roleKey))
  const entries = new Map<string, RoleEntry>()
  for (const role of current) {
    const key = roleKey(role)
    entries.set(key, { role, status: before.has(key) ? 'kept' : 'added' })
  }
  for (const role of initial) {
    const key = roleKey(role)
    if (!entries.has(key)) entries.set(key, { role, status: 'removed' })
  }
  const compare = compareRoles(currentDb)
  return [...entries.values()].sort((a, b) => compare(a.role, b.role))
}

/** `roleEntries` output matching `filter`, grouped by db in its order. */
export function groupRoles(entries: readonly RoleEntry[], filter: string): RoleGroup[] {
  const groups = new Map<string, RoleGroup>()
  for (const entry of entries) {
    if (!matchesRoleFilter(entry.role, filter)) continue
    const group = groups.get(entry.role.db) ?? { db: entry.role.db, roles: [] }
    group.roles.push(entry)
    groups.set(entry.role.db, group)
  }
  return [...groups.values()]
}

/** Assignable role names on `targetDb` that the user does not hold there yet, sorted. */
export function roleSuggestions(
  targetDb: string,
  sources: {
    serverRoles?: readonly DatabaseRoleInfo[]
    users: readonly DatabaseUser[]
    assigned: readonly DatabaseUserRole[]
  }
): string[] {
  const names = new Set<string>(COMMON_DB_ROLES)
  for (const r of sources.serverRoles ?? []) if (r.db === targetDb) names.add(r.role)
  for (const u of sources.users) for (const r of u.roles) if (r.db === targetDb) names.add(r.role)
  for (const r of sources.assigned) if (r.db === targetDb) names.delete(r.role)
  // MongoDB documents __system and other __-prefixed roles as internal, never to be assigned.
  return [...names].filter((name) => !name.startsWith('__')).sort(collator.compare)
}

/** Known database names (listed dbs, admin, the current db, dbs of listed roles), sorted. */
export function databaseSuggestions(
  currentDb: string,
  sources: { databases?: readonly DatabaseInfo[]; users: readonly DatabaseUser[] }
): string[] {
  const names = new Set<string>(['admin', currentDb])
  for (const d of sources.databases ?? []) names.add(d.name)
  for (const u of sources.users) for (const r of u.roles) names.add(r.db)
  return [...names].sort(collator.compare)
}
