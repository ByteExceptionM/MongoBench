import { type FormEvent, useEffect, useState } from 'react'
import { Loader2, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CollectionTab, QueryPatch } from '@/store/tabs'

export function QueryToolbar({
  tab,
  onApply,
  onRefresh,
  loading
}: {
  tab: CollectionTab
  onApply: (patch: QueryPatch) => void
  onRefresh: () => void
  loading: boolean
}) {
  const [filter, setFilter] = useState(tab.filter)
  const [limit, setLimit] = useState(tab.limit > 0 ? String(tab.limit) : '')

  useEffect(() => {
    setFilter(tab.filter)
    setLimit(tab.limit > 0 ? String(tab.limit) : '')
  }, [tab.id, tab.filter, tab.limit])

  const apply = (e?: FormEvent) => {
    e?.preventDefault()
    const limitNum = Number.parseInt(limit, 10)
    const nextLimit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 0
    onApply({ filter, skip: 0, limit: nextLimit })
  }

  return (
    <form onSubmit={apply} className="flex items-end gap-2 border-b bg-card/30 px-4 py-2.5">
      <div className="grid min-w-0 flex-1 gap-1">
        <Label htmlFor="q-filter" className="text-[10px] uppercase tracking-wider">
          Query
        </Label>
        <Input
          id="q-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder='{ "field": "value", "$and": [ … ] }'
          spellCheck={false}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="q-limit" className="text-[10px] uppercase tracking-wider">
          Limit
        </Label>
        <Input
          id="q-limit"
          type="number"
          min={0}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="all"
          className="h-8 w-24 font-mono text-xs"
          title="Empty or 0 = fetch all matching documents"
        />
      </div>
      <Button type="submit" size="sm" disabled={loading} className="h-8">
        {loading ? <Loader2 className="animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        Run
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </form>
  )
}
