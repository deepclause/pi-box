import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { VmManager } from './vm'
import { WorkspaceStore } from './workspaces'
import { MOUNT_POINT, registerIpc } from './ipc'
import type { AppState } from '../shared/types'

let mainWindow: BrowserWindow | null = null

const vm = new VmManager()
const store = new WorkspaceStore()

function buildState(): AppState {
  const active = store.getActive()
  return {
    status: vm.status,
    statusMessage: vm.statusMessage,
    workspaces: store.list(),
    activeWorkspaceId: active?.id ?? null,
    activeMountPath: active?.path ?? null,
    mountPoint: MOUNT_POINT
  }
}

function broadcast(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:state', buildState())
  }
}

function broadcastOutput(text: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:output', text)
  }
}

async function restartVm(): Promise<void> {
  const active = store.getActive()
  if (!active) {
    broadcast()
    return
  }
  await vm.start({ [MOUNT_POINT]: active.path })
  broadcast()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'pi-box',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('did-finish-load', () => {
    broadcast()
  })

  // electron-vite injects this URL in development; otherwise load the built file.
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  store.init()

  registerIpc({
    vm,
    store,
    buildState,
    broadcast,
    restartVm,
    getWindow: () => mainWindow
  })

  vm.on('status', () => broadcast())
  vm.on('output', broadcastOutput)

  createWindow()

  // Boot the VM with the last used workspace mounted at MOUNT_POINT.
  const active = store.getActive()
  if (active) {
    await vm.start({ [MOUNT_POINT]: active.path })
    broadcast()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  void vm.stop()
})
