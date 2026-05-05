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

const validate = (name: string): string | null => {
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
  db: string
  onClose: () => void
}

export function CreateCollectionDialog({ open, connectionId, db, onClose }: Props) {
  const [name, setName] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (open) {
      setName('')
      setServerError(null)
    }
  }, [open])

  const validation = validate(name.trim())

  const mutation = useMutation({
    mutationFn: () => api.collections.create({ connectionId, db, name: name.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.collections(connectionId, db) })
      toast.success(`Created ${db}.${name.trim()}`)
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
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>
              Create a new collection in <span className="font-mono text-foreground">{db}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="new-coll-name">Collection name</Label>
            <Input
              id="new-coll-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              className="font-mono"
              placeholder="orders"
            />
            {validation && name.length > 0 && (
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
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
