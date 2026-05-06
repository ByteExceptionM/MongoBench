import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Braces, Download, FileText, Loader2, Sheet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { api, ApiError } from '@/lib/api'
import { exportToString, extensionFor, mimeTypeFor, type ExportFormat } from '@/lib/exportDocuments'
import type { UuidEncoding } from '@shared/types'

type Props = {
  connectionId: string
  db: string
  coll: string
  /** Canonical EJSON strings, pre-validated. `null` = invalid / not supplied. */
  filter: string | null
  projection: string | null
  sort: string | null
  /** Used for the disabled state and to seed the doc-count input. */
  currentDocCount: number
  uuidEncoding: UuidEncoding
  timezone: string
  /** Disables the trigger while the parent's find query is in flight. */
  disabled?: boolean
}

const DEFAULT_EXPORT_LIMIT = 1000
const MAX_EXPORT_LIMIT = 1_000_000

/**
 * Download-as-file menu. Triggers a *fresh* `find` call with the current
 * filter/projection/sort so the user can pull more documents than the
 * paged view currently shows. The doc count is user-editable inside the
 * popover.
 */
export function ExportButton({
  connectionId,
  db,
  coll,
  filter,
  projection,
  sort,
  currentDocCount,
  uuidEncoding,
  timezone,
  disabled
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [count, setCount] = useState<string>(
    String(Math.max(currentDocCount, DEFAULT_EXPORT_LIMIT))
  )
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Re-seed the count when the visible page size changes — only while the
  // popover is closed so we don't fight the user mid-edit.
  useEffect(() => {
    if (open) return
    setCount(String(Math.max(currentDocCount, DEFAULT_EXPORT_LIMIT)))
  }, [currentDocCount, open])

  useEffect(() => {
    if (!open) return
    const onMouse = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const parsedCount = Number.parseInt(count, 10)
  const validCount =
    Number.isFinite(parsedCount) && parsedCount >= 1 && parsedCount <= MAX_EXPORT_LIMIT
  const limit = validCount ? parsedCount : 0

  const triggerDisabled = disabled === true

  const doExport = async (format: ExportFormat): Promise<void> => {
    if (triggerDisabled || !validCount) return
    setBusy(format)
    try {
      const documents = await api.query
        .find({
          connectionId,
          db,
          coll,
          ...(filter ? { filter } : {}),
          ...(projection ? { projection } : {}),
          ...(sort ? { sort } : {}),
          skip: 0,
          limit
        })
        .then((res) => res.documents)

      if (documents.length === 0) {
        toast.warning('No documents matched — nothing to export')
        setBusy(null)
        return
      }

      const content = exportToString(format, documents, { uuidEncoding, timezone })
      const blob = new Blob([content], { type: mimeTypeFor(format) })
      const url = URL.createObjectURL(blob)
      const stamp = isoStamp(new Date())
      const filename = `${db}.${coll}_${stamp}.${extensionFor(format)}`
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(
        `Exported ${documents.length} document${documents.length === 1 ? '' : 's'} as ${format.toUpperCase()}`
      )
      setOpen(false)
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
      toast.error(`Export failed: ${message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <Tooltip content="Export results">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          onClick={() => !triggerDisabled && setOpen((v) => !v)}
          disabled={triggerDisabled}
          aria-label="Export"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-56 overflow-hidden rounded-md border bg-popover p-1 shadow-lg"
          role="menu"
        >
          <FormatItem
            icon={<Braces className="h-3.5 w-3.5" />}
            label="JSON"
            disabled={busy !== null || !validCount}
            running={busy === 'json'}
            onClick={() => void doExport('json')}
          />
          <FormatItem
            icon={<Sheet className="h-3.5 w-3.5" />}
            label="CSV"
            disabled={busy !== null || !validCount}
            running={busy === 'csv'}
            onClick={() => void doExport('csv')}
          />
          <FormatItem
            icon={<FileText className="h-3.5 w-3.5" />}
            label="TSV"
            disabled={busy !== null || !validCount}
            running={busy === 'tsv'}
            onClick={() => void doExport('tsv')}
          />

          <div className="mt-1 border-t px-2 py-2">
            <label className="grid gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Documents
              </span>
              <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background">
                <input
                  type="number"
                  min={1}
                  max={MAX_EXPORT_LIMIT}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  className="w-full bg-transparent px-2 py-1 font-mono text-xs outline-none"
                />
              </div>
              {!validCount && (
                <span className="text-[10px] text-destructive">
                  Enter a number between 1 and {MAX_EXPORT_LIMIT.toLocaleString()}
                </span>
              )}
              <span className="text-[10px] leading-snug text-muted-foreground">
                Fetches fresh with the current filter, sort, and projection.
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

function FormatItem({
  icon,
  label,
  onClick,
  disabled,
  running
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled: boolean
  running: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors',
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-medium">{label}</span>
      {running && <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />}
    </button>
  )
}

function isoStamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  )
}
