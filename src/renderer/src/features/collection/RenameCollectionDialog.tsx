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
import { useTabsStore } from '@/store/tabs'

type Props = {
  open: boolean
  connectionId: string
  db: string
  coll: string
  onClose: () => void
}

const validate = (name: string, current: string): string | null => {
  if (name.length === 0) return 'Name is required'
  if (name.length > 255) return 'Name is too long'
  if (name === current) return 'Name has not changed'
  if (name.startsWith('system.')) return 'Reserved prefix "system." is not allowed'
  if (name.includes('$')) return 'Name must not contain $'
  if (name.includes('\0')) return 'Name must not contain null bytes'
  return null
}

export function RenameCollectionDialog({ open, connectionId, db, coll, onClose }: Props) {
  const [name, setName] = useState(coll)
  const [serverError, setServerError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const renameTab = useTabsStore((s) => s.renameCollection)

  useEffect(() => {
    if (open) {
      setName(coll)
      setServerError(null)
    }
  }, [open, coll])

  const validation = validate(name.trim(), coll)

  const mutation = useMutation({
    mutationFn: () => api.collections.rename({ connectionId, db, coll, newName: name.trim() }),
    onSuccess: () => {
      renameTab(connectionId, db, coll, name.trim())
      void queryClient.invalidateQueries({ queryKey: queryKeys.collections(connectionId, db) })
      toast.success(`Renamed to ${name.trim()}`)
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
            <DialogTitle>Rename collection</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {db}.{coll}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="rename-input">New name</Label>
            <Input
              id="rename-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              className="font-mono"
            />
            {validation && name !== coll && (
              <p className="text-xs text-muted-foreground">{validation}</p>
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
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
