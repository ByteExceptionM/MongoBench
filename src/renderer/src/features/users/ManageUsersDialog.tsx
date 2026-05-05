import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, KeyRound, Loader2, Plus, ServerCrash, Trash2, UserCog } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import type { DatabaseUser, DatabaseUserRole } from '@shared/types'

type Props = {
  open: boolean
  connectionId: string
  db: string
  onClose: () => void
}

type FormMode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; user: DatabaseUser }

const COMMON_DB_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'] as const

const ROLE_LABEL: Record<string, string> = {
  read: 'Read',
  readWrite: 'Read & write',
  dbAdmin: 'DB admin',
  dbOwner: 'DB owner',
  userAdmin: 'User admin'
}

export function ManageUsersDialog({ open, connectionId, db, onClose }: Props) {
  const [mode, setMode] = useState<FormMode>({ kind: 'list' })
  const [pendingDelete, setPendingDelete] = useState<DatabaseUser | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (open) setMode({ kind: 'list' })
  }, [open])

  const usersQuery = useQuery({
    queryKey: queryKeys.users(connectionId, db),
    queryFn: () => api.users.list({ connectionId, db }),
    enabled: open
  })

  const dropMutation = useMutation({
    mutationFn: (username: string) => api.users.drop({ connectionId, db, username }),
    onSuccess: (_, username) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users(connectionId, db) })
      toast.success(`Dropped user ${username}`)
      setPendingDelete(null)
    },
    onError: (e: unknown) => {
      const message = e instanceof ApiError ? e.message : String(e)
      toast.error(`Drop failed: ${message}`)
      setPendingDelete(null)
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode.kind !== 'list' && (
              <Button
                size="icon"
                variant="ghost"
                className="-ml-2 h-7 w-7"
                onClick={() => setMode({ kind: 'list' })}
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {mode.kind === 'list' && <>Manage users</>}
            {mode.kind === 'create' && <>New user</>}
            {mode.kind === 'edit' && <>Edit user — {mode.user.user}</>}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{db}</DialogDescription>
        </DialogHeader>

        {mode.kind === 'list' && (
          <UsersListView
            db={db}
            isLoading={usersQuery.isLoading}
            error={usersQuery.error}
            users={usersQuery.data ?? []}
            onCreate={() => setMode({ kind: 'create' })}
            onEdit={(user) => setMode({ kind: 'edit', user })}
            onDelete={(user) => setPendingDelete(user)}
          />
        )}

        {mode.kind === 'create' && (
          <UserForm
            mode="create"
            connectionId={connectionId}
            db={db}
            onDone={() => setMode({ kind: 'list' })}
          />
        )}

        {mode.kind === 'edit' && (
          <UserForm
            mode="edit"
            connectionId={connectionId}
            db={db}
            existing={mode.user}
            onDone={() => setMode({ kind: 'list' })}
          />
        )}
      </DialogContent>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && !dropMutation.isPending && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop user?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">{pendingDelete?.user}</span> on{' '}
              <span className="font-mono text-foreground">{db}</span> will be removed and lose all
              roles.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={dropMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (pendingDelete) dropMutation.mutate(pendingDelete.user)
              }}
            >
              {dropMutation.isPending && <Loader2 className="animate-spin" />}
              Drop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

function UsersListView({
  db,
  isLoading,
  error,
  users,
  onCreate,
  onEdit,
  onDelete
}: {
  db: string
  isLoading: boolean
  error: unknown
  users: DatabaseUser[]
  onCreate: () => void
  onEdit: (u: DatabaseUser) => void
  onDelete: (u: DatabaseUser) => void
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading users…
      </div>
    )
  }
  if (error instanceof ApiError) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <ServerCrash className="mt-0.5 h-4 w-4" />
        <div>
          <div className="font-medium">Could not list users</div>
          <div className="text-xs opacity-80">{error.message}</div>
          <div className="mt-2 text-xs opacity-80">
            Listing users requires the <span className="font-mono">userAdmin</span> role on{' '}
            <span className="font-mono">{db}</span> (or a superset).
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {users.length} user{users.length === 1 ? '' : 's'}
        </div>
        <Button size="sm" onClick={onCreate}>
          <Plus className="h-4 w-4" /> New user
        </Button>
      </div>
      {users.length === 0 ? (
        <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
          No users defined in {db}.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Roles</th>
                <th className="w-px px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.user} className="border-t hover:bg-accent/30">
                  <td className="px-3 py-2 font-mono">{u.user}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r, i) => (
                        <span
                          key={`${r.role}-${r.db}-${i}`}
                          className="rounded-sm border bg-background px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {r.role}
                          <span className="text-muted-foreground">@{r.db}</span>
                        </span>
                      ))}
                      {u.roles.length === 0 && (
                        <span className="text-[10px] italic text-muted-foreground">no roles</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => onEdit(u)}
                        aria-label="Edit"
                      >
                        <UserCog className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onDelete(u)}
                        aria-label="Drop"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function UserForm({
  mode,
  connectionId,
  db,
  existing,
  onDone
}: {
  mode: 'create' | 'edit'
  connectionId: string
  db: string
  existing?: DatabaseUser
  onDone: () => void
}) {
  const initial = useMemo(() => {
    if (mode === 'edit' && existing) {
      const selected = new Set<string>()
      const others: DatabaseUserRole[] = []
      for (const r of existing.roles) {
        if (r.db === db && (COMMON_DB_ROLES as readonly string[]).includes(r.role)) {
          selected.add(r.role)
        } else {
          others.push(r)
        }
      }
      return {
        username: existing.user,
        selectedRoles: selected,
        customRoles: others.length ? JSON.stringify(others, null, 2) : ''
      }
    }
    return { username: '', selectedRoles: new Set<string>(), customRoles: '' }
  }, [mode, existing, db])

  const [username, setUsername] = useState(initial.username)
  const [password, setPassword] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set(initial.selectedRoles))
  const [customRoles, setCustomRoles] = useState(initial.customRoles)
  const [serverError, setServerError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const customRolesParse = useMemo(() => {
    if (customRoles.trim().length === 0)
      return { ok: true as const, roles: [] as DatabaseUserRole[] }
    try {
      const parsed = JSON.parse(customRoles)
      if (!Array.isArray(parsed)) return { ok: false as const, error: 'Must be a JSON array' }
      const roles: DatabaseUserRole[] = []
      for (const r of parsed) {
        if (typeof r !== 'object' || r === null || Array.isArray(r)) {
          return { ok: false as const, error: 'Each entry must be an object' }
        }
        const role = (r as Record<string, unknown>)['role']
        const roleDb = (r as Record<string, unknown>)['db']
        if (typeof role !== 'string' || typeof roleDb !== 'string') {
          return { ok: false as const, error: 'Each entry needs `role` and `db` strings' }
        }
        roles.push({ role, db: roleDb })
      }
      return { ok: true as const, roles }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : 'Invalid JSON' }
    }
  }, [customRoles])

  const validation = useMemo(() => {
    if (username.trim().length === 0) return 'Username is required'
    if (mode === 'create' && password.length === 0) return 'Password is required'
    if (!customRolesParse.ok) return `Custom roles: ${customRolesParse.error}`
    return null
  }, [username, password, mode, customRolesParse])

  const allRoles = (): DatabaseUserRole[] => {
    if (!customRolesParse.ok) return []
    const own = Array.from(selectedRoles).map((role) => ({ role, db }))
    return [...own, ...customRolesParse.roles]
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.users.create({
        connectionId,
        db,
        username: username.trim(),
        password,
        roles: allRoles()
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users(connectionId, db) })
      toast.success(`User ${username.trim()} created`)
      onDone()
    },
    onError: (e: unknown) => {
      setServerError(e instanceof ApiError ? e.message : String(e))
    }
  })

  const updateMutation = useMutation({
    mutationFn: () =>
      api.users.update({
        connectionId,
        db,
        username: username.trim(),
        password: password.length > 0 ? password : null,
        roles: allRoles()
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users(connectionId, db) })
      toast.success(`User ${username.trim()} updated`)
      onDone()
    },
    onError: (e: unknown) => {
      setServerError(e instanceof ApiError ? e.message : String(e))
    }
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (validation) return
    setServerError(null)
    if (mode === 'create') createMutation.mutate()
    else updateMutation.mutate()
  }

  const busy = createMutation.isPending || updateMutation.isPending

  const toggleRole = (role: string) =>
    setSelectedRoles((prev) => {
      const next = new Set(prev)
      if (next.has(role)) next.delete(role)
      else next.add(role)
      return next
    })

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="user-name">Username</Label>
          <Input
            id="user-name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={mode === 'edit'}
            spellCheck={false}
            className="font-mono"
            autoFocus={mode === 'create'}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="user-pwd" className="flex items-center gap-1">
            <KeyRound className="h-3 w-3" />
            {mode === 'edit' ? 'New password (optional)' : 'Password'}
          </Label>
          <Input
            id="user-pwd"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={mode === 'edit' ? 'Leave blank to keep current' : ''}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label className="text-[10px] uppercase tracking-wider">
          Roles on <span className="font-mono normal-case text-foreground">{db}</span>
        </Label>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-card p-3 sm:grid-cols-3">
          {COMMON_DB_ROLES.map((role) => (
            <label
              key={role}
              className={cn(
                'flex cursor-pointer items-center gap-2 text-xs',
                selectedRoles.has(role) ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              <input
                type="checkbox"
                checked={selectedRoles.has(role)}
                onChange={() => toggleRole(role)}
                className="accent-primary"
              />
              <span className="font-medium">{ROLE_LABEL[role] ?? role}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{role}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="user-customroles" className="text-[10px] uppercase tracking-wider">
          Additional roles (JSON)
        </Label>
        <textarea
          id="user-customroles"
          value={customRoles}
          onChange={(e) => setCustomRoles(e.target.value)}
          spellCheck={false}
          rows={3}
          placeholder='[{"role": "clusterMonitor", "db": "admin"}]'
          className="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <p className="text-[10px] text-muted-foreground">
          For roles outside <span className="font-mono">{db}</span> or non-standard roles. Each
          entry: <span className="font-mono">{`{ role, db }`}</span>.
        </p>
        {!customRolesParse.ok && (
          <p className="text-xs text-destructive">{customRolesParse.error}</p>
        )}
      </div>

      {serverError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {serverError}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={validation !== null || busy}>
          {busy && <Loader2 className="animate-spin" />}
          {mode === 'edit' ? 'Save changes' : 'Create user'}
        </Button>
      </DialogFooter>
    </form>
  )
}
