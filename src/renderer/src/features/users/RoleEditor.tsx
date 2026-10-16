import { type KeyboardEvent, memo, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, RotateCcw, Search, X } from 'lucide-react'
import { AutocompleteInput } from '@/components/ui/autocomplete-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import {
  addRole,
  COMMON_DB_ROLES,
  databaseSuggestions,
  diffRoles,
  groupRoles,
  matchesRoleFilter,
  removeRole,
  roleEntries,
  roleKey,
  roleLabel,
  roleSuggestions,
  type RoleGroup
} from '@/lib/userRoles'
import { cn } from '@/lib/utils'
import type { DatabaseUser, DatabaseUserRole } from '@shared/types'

type Props = {
  connectionId: string
  /** Dialog database: default add target, first group and quick toggles. */
  db: string
  roles: DatabaseUserRole[]
  /** Roles before editing; empty in create mode. */
  initialRoles: DatabaseUserRole[]
  /** Mark added and removed roles against `initialRoles`. */
  showDiff: boolean
  /** Listed users of the dialog database; their roles feed the suggestions. */
  users: DatabaseUser[]
  onChange: (roles: DatabaseUserRole[]) => void
}

const ROLE_LABEL: Record<(typeof COMMON_DB_ROLES)[number], string> = {
  read: 'Read',
  readWrite: 'Read & write',
  dbAdmin: 'DB admin',
  dbOwner: 'DB owner',
  userAdmin: 'User admin'
}

/** Edits a user's role list: any role on any database, grouped by database. */
export function RoleEditor({
  connectionId,
  db,
  roles,
  initialRoles,
  showDiff,
  users,
  onChange
}: Props) {
  const [filter, setFilter] = useState('')
  const [newRole, setNewRole] = useState('')
  const [newDb, setNewDb] = useState(db)
  const roleInputRef = useRef<HTMLInputElement>(null)
  const labelId = useId()

  const databasesQuery = useQuery({
    queryKey: queryKeys.databases(connectionId),
    queryFn: () => api.databases.list(connectionId)
  })
  const dbOptions = useMemo(
    () => databaseSuggestions(db, { databases: databasesQuery.data, users }),
    [db, databasesQuery.data, users]
  )

  const target = newDb.trim()
  // Only exact known names, so typing a database name does not fire one request per keystroke.
  const rolesQuery = useQuery({
    queryKey: queryKeys.roles(connectionId, target),
    queryFn: () => api.roles.list({ connectionId, db: target }),
    enabled: dbOptions.includes(target)
  })
  const roleOptions = useMemo(
    () => roleSuggestions(target, { serverRoles: rolesQuery.data, users, assigned: roles }),
    [target, rolesQuery.data, users, roles]
  )

  const diff = useMemo(() => diffRoles(initialRoles, roles), [initialRoles, roles])
  const entries = useMemo(() => roleEntries(initialRoles, roles, db), [initialRoles, roles, db])
  const groups = useMemo(() => groupRoles(entries, filter), [entries, filter])
  const assignedKeys = useMemo(() => new Set(roles.map(roleKey)), [roles])
  const listed = roles.length + diff.removed.length

  const candidate: DatabaseUserRole = { role: newRole.trim(), db: target }
  const complete = candidate.role !== '' && candidate.db !== ''
  const duplicate = complete && assignedKeys.has(roleKey(candidate))
  const canAdd = complete && !duplicate

  const add = () => {
    if (!canAdd) return
    onChange(addRole(roles, candidate))
    setNewRole('')
    // Never add a role the active filter would hide.
    if (!matchesRoleFilter(candidate, filter)) setFilter('')
    roleInputRef.current?.focus()
  }

  // Enter adds the role instead of submitting the surrounding user form.
  const onAddKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    add()
  }

  const summary = [
    `${roles.length} role${roles.length === 1 ? '' : 's'}`,
    ...(showDiff && diff.added.length > 0 ? [`${diff.added.length} added`] : []),
    ...(showDiff && diff.removed.length > 0 ? [`${diff.removed.length} removed`] : [])
  ].join(' · ')

  return (
    <section aria-labelledby={labelId} className="grid gap-2">
      <div className="sticky top-0 z-10 grid gap-2 bg-background pb-1">
        <div className="flex items-center gap-2">
          <Label id={labelId} className="text-[10px] uppercase tracking-wider">
            Roles
          </Label>
          <span aria-live="polite" className="text-[10px] text-muted-foreground">
            {summary}
          </span>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
              disabled={listed === 0}
              aria-label="Filter roles"
              placeholder="Filter roles…"
              spellCheck={false}
              className="h-8 w-48 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <AutocompleteInput
            ref={roleInputRef}
            wrapperClassName="flex-1"
            className="h-8 text-xs"
            value={newRole}
            onValueChange={setNewRole}
            suggestions={roleOptions}
            onKeyDown={onAddKeyDown}
            aria-label="Role name"
            placeholder="Add role…"
            maxLength={120}
            spellCheck={false}
          />
          <span className="text-xs text-muted-foreground">on</span>
          <AutocompleteInput
            wrapperClassName="w-44"
            className="h-8 text-xs"
            value={newDb}
            onValueChange={setNewDb}
            suggestions={dbOptions}
            onKeyDown={onAddKeyDown}
            aria-label="Database"
            maxLength={64}
            spellCheck={false}
          />
          <Button type="button" size="sm" variant="outline" onClick={add} disabled={!canAdd}>
            <Plus /> Add
          </Button>
        </div>
        {duplicate && <p className="text-[10px] text-muted-foreground">Already assigned.</p>}

        <div role="group" aria-label={`Common roles on ${db}`} className="flex flex-wrap gap-1.5">
          {COMMON_DB_ROLES.map((role) => {
            const entry = { role, db }
            const pressed = assignedKeys.has(roleKey(entry))
            return (
              <button
                key={role}
                type="button"
                aria-pressed={pressed}
                title={roleLabel(entry)}
                onClick={() => onChange(pressed ? removeRole(roles, entry) : addRole(roles, entry))}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  pressed
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'text-muted-foreground'
                )}
              >
                {ROLE_LABEL[role]}
              </button>
            )
          })}
        </div>
      </div>

      <RoleGroupList
        groups={groups}
        listed={listed}
        filter={filter}
        roles={roles}
        showDiff={showDiff}
        onChange={onChange}
      />
    </section>
  )
}

// Memoized so typing in the add inputs does not re-render up to 10 000 role chips.
const RoleGroupList = memo(function RoleGroupList({
  groups,
  listed,
  filter,
  roles,
  showDiff,
  onChange
}: {
  groups: RoleGroup[]
  /** Assigned plus removed roles, before filtering. */
  listed: number
  filter: string
  roles: DatabaseUserRole[]
  showDiff: boolean
  onChange: (roles: DatabaseUserRole[]) => void
}) {
  return (
    <div className="grid gap-3 rounded-md border bg-card p-3">
      {groups.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">
          {listed === 0 ? 'No roles assigned.' : `No roles match "${filter.trim()}".`}
        </p>
      ) : (
        groups.map((group) => {
          const assigned = group.roles.filter((entry) => entry.status !== 'removed').length
          return (
            <div key={group.db} className="grid gap-1.5">
              <div className="flex h-6 items-center gap-2">
                <span className="truncate font-mono text-[11px]">{group.db}</span>
                <span className="text-[10px] text-muted-foreground">{assigned}</span>
                {assigned >= 2 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[10px]"
                    aria-label={`Remove all ${filter.trim() ? 'matching ' : ''}roles on ${group.db}`}
                    // Only what the filter shows; hidden roles stay assigned.
                    onClick={() =>
                      onChange(
                        roles.filter((r) => r.db !== group.db || !matchesRoleFilter(r, filter))
                      )
                    }
                  >
                    Remove all
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.roles.map(({ role, status }) => {
                  const removed = status === 'removed'
                  const label = `${removed ? 'Restore' : 'Remove'} ${role.role} on ${role.db}`
                  return (
                    <span
                      key={roleKey(role)}
                      className={cn(
                        'inline-flex max-w-full items-center gap-0.5 rounded-sm border bg-background py-0.5 pl-1.5 pr-0.5 font-mono text-[10px]',
                        showDiff && status === 'added' && 'border-success/40 bg-success/5',
                        showDiff && removed && 'border-dashed text-muted-foreground'
                      )}
                    >
                      <span
                        className={cn('truncate', showDiff && removed && 'line-through')}
                        title={roleLabel(role)}
                      >
                        {role.role}
                      </span>
                      <button
                        type="button"
                        aria-label={label}
                        title={label}
                        onClick={() =>
                          onChange(removed ? addRole(roles, role) : removeRole(roles, role))
                        }
                        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {removed ? (
                          <RotateCcw className="h-2.5 w-2.5" />
                        ) : (
                          <X className="h-2.5 w-2.5" />
                        )}
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
})
