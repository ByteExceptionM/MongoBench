import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download } from 'lucide-react'
import { toast } from 'sonner'
import type { UpdateSeverity } from '@shared/events'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api'

const TOAST_ID = 'app-update'

type Available = {
  version: string
  currentVersion: string
  severity: UpdateSeverity
}

type Phase = { kind: 'available' } | { kind: 'downloading'; percent: number } | { kind: 'ready' }

/**
 * Mounted once at the app root. Checks for an update and drives a single
 * toast through install → progress → restart. Renders nothing itself.
 */
export function UpdateNotifier(): null {
  const [available, setAvailable] = useState<Available | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'available' })
  const checkedRef = useRef(false)

  useEffect(() => {
    // StrictMode runs effects twice in dev.
    if (checkedRef.current) return
    checkedRef.current = true

    void (async () => {
      try {
        const result = await api.updater.check()
        if (!result.available) return
        setAvailable({
          version: result.version,
          currentVersion: result.currentVersion,
          severity: result.severity
        })
      } catch {
        // Offline, rate-limited, or a build without an update feed (AUR).
        // Not worth interrupting anyone over.
      }
    })()
  }, [])

  useEffect(() => {
    return api.updater.onProgress((progress) => {
      setPhase((current) =>
        current.kind === 'downloading'
          ? { kind: 'downloading', percent: progress.percent }
          : current
      )
    })
  }, [])

  const install = useCallback(() => {
    setPhase({ kind: 'downloading', percent: 0 })
    void (async () => {
      try {
        await api.updater.download()
        setPhase({ kind: 'ready' })
      } catch (error) {
        const message = error instanceof ApiError ? error.message : String(error)
        toast.dismiss(TOAST_ID)
        toast.error(`Update download failed: ${message}`)
        setAvailable(null)
        setPhase({ kind: 'available' })
      }
    })()
  }, [])

  const restart = useCallback(() => {
    void api.updater.install().catch((error: unknown) => {
      const message = error instanceof ApiError ? error.message : String(error)
      toast.error(`Could not start the installer: ${message}`)
    })
  }, [])

  useEffect(() => {
    if (available === null) return
    toast.custom(
      () => <UpdateCard update={available} phase={phase} onInstall={install} onRestart={restart} />,
      {
        id: TOAST_ID,
        duration: Infinity,
        // Closing mid-download would leave it running with no way back.
        dismissible: phase.kind !== 'downloading'
      }
    )
  }, [available, phase, install, restart])

  return null
}

function severityIcon(severity: UpdateSeverity) {
  if (severity === 'major') return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
  if (severity === 'minor') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
  return <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
}

function UpdateCard({
  update,
  phase,
  onInstall,
  onRestart
}: {
  update: Available
  phase: Phase
  onInstall: () => void
  onRestart: () => void
}) {
  return (
    <div className="flex w-[356px] flex-col gap-3 rounded-md border border-border bg-background p-4 shadow-lg">
      <div className="flex items-start gap-2">
        {phase.kind === 'ready' ? (
          <Download className="h-4 w-4 shrink-0 text-success" />
        ) : (
          severityIcon(update.severity)
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {phase.kind === 'ready'
              ? `MongoBench ${update.version} is ready`
              : `MongoBench ${update.version} is available`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {phase.kind === 'ready'
              ? 'Restart to apply it, or it will be installed the next time you start MongoBench.'
              : update.severity === 'major'
                ? `You are on ${update.currentVersion} — a full version behind.`
                : `You are on ${update.currentVersion}.`}
          </p>
        </div>
      </div>

      {phase.kind === 'downloading' && (
        <div className="flex flex-col gap-1.5">
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={phase.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Update download progress"
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${phase.percent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">Downloading — {phase.percent}%</p>
        </div>
      )}

      {phase.kind === 'available' && (
        <Button size="sm" className="self-start" onClick={onInstall}>
          Install update
        </Button>
      )}

      {phase.kind === 'ready' && (
        <Button size="sm" className="self-start" onClick={onRestart}>
          Restart now
        </Button>
      )}
    </div>
  )
}
