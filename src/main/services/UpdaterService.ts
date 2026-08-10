import { app } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckResult, UpdateProgress } from '@shared/events'
import { updateSeverity } from '../lib/updateSeverity'

/**
 * User-driven update flow. Builds are unsigned, and a silent installer
 * terminates the running app mid-session to replace its binary — so nothing
 * here happens without a click.
 *
 * electron-updater needs a packaged app plus a published `latest.yml`; in dev
 * there is neither, so every method is a no-op.
 */
export class UpdaterService {
  private downloading = false

  constructor(private readonly emitProgress: (progress: UpdateProgress) => void) {
    autoUpdater.logger = log
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('download-progress', (p) => {
      this.emitProgress({ percent: Math.min(100, Math.max(0, Math.round(p.percent))) })
    })
    autoUpdater.on('error', (error) => {
      log.error('Updater error', error)
    })
  }

  async check(): Promise<UpdateCheckResult> {
    if (!app.isPackaged) return { available: false }

    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo.version
    if (latest === undefined) return { available: false }

    const current = app.getVersion()
    const severity = updateSeverity(current, latest)
    if (severity === null) {
      log.info(`Updater: up to date (${current})`)
      return { available: false }
    }

    log.info(`Updater: ${latest} available (${severity}), current ${current}`)
    return { available: true, version: latest, currentVersion: current, severity }
  }

  async download(): Promise<void> {
    if (!app.isPackaged || this.downloading) return
    this.downloading = true
    try {
      await autoUpdater.downloadUpdate()
    } finally {
      this.downloading = false
    }
  }

  install(): void {
    if (!app.isPackaged) return
    autoUpdater.quitAndInstall()
  }
}
