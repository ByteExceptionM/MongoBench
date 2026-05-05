import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { registerIpcHandlers } from './ipc/router'
import { ConnectionService } from './services/ConnectionService'
import { DatabaseService } from './services/DatabaseService'
import { QueryService } from './services/QueryService'
import { UserService } from './services/UserService'
import { ConnectionsRepository } from './stores/ConnectionsRepository'
import { SecretsStore } from './stores/SecretsStore'

log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

const services = {
  repo: null as ConnectionsRepository | null,
  connections: null as ConnectionService | null
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // Ctrl + / - / 0 keyboard zoom (parity with Chrome / VS Code).
  const ZOOM_STEP = 0.5
  const ZOOM_MIN = -3
  const ZOOM_MAX = 5
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (!input.control || input.alt || input.meta) return
    const wc = window.webContents
    if (input.key === '+' || input.key === '=') {
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + ZOOM_STEP, ZOOM_MAX))
      event.preventDefault()
    } else if (input.key === '-') {
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - ZOOM_STEP, ZOOM_MIN))
      event.preventDefault()
    } else if (input.key === '0') {
      wc.setZoomLevel(0)
      event.preventDefault()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const secrets = new SecretsStore()
  const repo = new ConnectionsRepository(secrets)
  const connections = new ConnectionService(repo)
  const databases = new DatabaseService(connections)
  const queries = new QueryService(connections)
  const users = new UserService(connections)
  services.repo = repo
  services.connections = connections

  registerIpcHandlers({ repo, connections, databases, queries, users })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  log.info(`MongoBench ${app.getVersion()} ready`)
})

app.on('before-quit', async (event) => {
  if (!services.connections) return
  event.preventDefault()
  try {
    await services.connections.closeAll()
  } catch (error) {
    log.error('Error closing connections during quit', error)
  } finally {
    services.connections = null
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
