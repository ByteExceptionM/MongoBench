import { type FormEvent, useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
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
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'

const FORBIDDEN_DB = /[\s/\\."$*<>:|?\0]/

const validateDb = (name: string): string | null => {
  if (name.length === 0) return 'Name is required'
  if (name.length > 64) return 'Database name must be ≤ 64 characters'
  if (FORBIDDEN_DB.test(name)) return 'Name contains invalid characters'
  return null
}

const validateColl = (name: string): string | null => {
  if (name.length === 0) return 'Name is required'
  if (name.length > 255) return 'Name is too long'
  if (name.startsWith('system.')) return 'Reserved prefix "system." is not allowed'
  if (name.includes('$')) return 'Name must not contain $'
  if (name.includes('\0')) return 'Name must not contain null bytes'
  return null
}

type Props = {
  open: boolean
  connectionId: string
  onClose: () => void
}

export function CreateDatabaseDialog({ open, connectionId, onClose }: Props) {
  const [db, setDb] = useState('')
  const [coll, setColl] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (open) {
      setDb('')
      setColl('')
      setServerError(null)
    }
  }, [open])

  const dbValidation = validateDb(db.trim())
  const collValidation = validateColl(coll.trim())
  const validation = dbValidation ?? collValidation

  const mutation = useMutation({
    mutationFn: () => api.databases.create({ connectionId, db: db.trim(), firstColl: coll.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.databases(connectionId) })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.collections(connectionId, db.trim())
      })
      toast.success(`Created ${db.trim()}.${coll.trim()}`)
      onClose()
    },
    onError: (e: unknown) => {
      setServerError(e instanceof ApiError ? e.message : String(e))
    }
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (validation) return
    setServerError(null)
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !mutation.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New database</DialogTitle>
            <DialogDescription>
              MongoDB creates a database when its first collection is written. Provide both names
              below.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="new-db-name">Database name</Label>
            <Input
              id="new-db-name"
              value={db}
              onChange={(e) => setDb(e.target.value)}
              autoFocus
              spellCheck={false}
              className="font-mono"
              placeholder="shop"
            />
            {dbValidation && db.length > 0 && (
              <p className="text-xs text-muted-foreground">{dbValidation}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-db-coll">First collection</Label>
            <Input
              id="new-db-coll"
              value={coll}
              onChange={(e) => setColl(e.target.value)}
              spellCheck={false}
              className="font-mono"
              placeholder="orders"
            />
            {collValidation && coll.length > 0 && (
              <p className="text-xs text-muted-foreground">{collValidation}</p>
            )}
          </div>

          {serverError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
              {serverError}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={validation !== null || mutation.isPending}>
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
