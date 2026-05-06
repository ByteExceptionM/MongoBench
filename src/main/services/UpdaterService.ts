import { app } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'

// electron-updater needs a real packaged app + a published `latest.yml`
// on GitHub Releases to do anything. In dev it would require a
// `dev-app-update.yml`; we just skip instead.
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    log.info('Updater: dev mode, skipping')
    return
  }

  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('Updater: checking for update')
  })
  autoUpdater.on('update-available', (info) => {
    log.info(`Updater: update available — ${info.version}`)
  })
  autoUpdater.on('update-not-available', () => {
    log.info('Updater: up to date')
  })
  autoUpdater.on('download-progress', (p) => {
    log.info(`Updater: downloading ${Math.round(p.percent)}%`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`Updater: downloaded ${info.version} — will install on quit`)
  })
  autoUpdater.on('error', (err) => {
    log.error('Updater error', err)
  })

  void autoUpdater.checkForUpdates().catch((err) => {
    log.error('Updater: initial check failed', err)
  })
}
