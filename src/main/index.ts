import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { VmManager } from './vm'
import { WorkspaceStore } from './workspaces'
import { RpcSessionManager } from './rpc'
import { MOUNT_POINT, registerIpc } from './ipc'
import type { AppState } from '../shared/types'
import type { RpcEvent, RpcState } from '../shared/rpc-types'

let mainWindow: BrowserWindow | null = null

const vm = new VmManager()
const store = new WorkspaceStore()
const rpc = new RpcSessionManager(vm, store)

function buildState(): AppState {
  const active = store.getActive()
  return {
    status: vm.status,
    statusMessage: vm.statusMessage,
    workspaces: store.list(),
    activeWorkspaceId: active?.id ?? null,
    activeMountPath: active?.path ?? null,
    mountPoint: MOUNT_POINT,
    networkEnabled: vm.networkEnabled,
    portForwards: vm.portForwards,
    firewallRules: vm.firewallRules
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

function broadcastRpcEvent(event: RpcEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:rpc:event', event)
  }
}

function broadcastRpcState(state: RpcState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:rpc:state', state)
  }
}

/**
 * Remove the guest bridge's readiness marker before booting the VM. The marker
 * lives on the workspace mount, so it survives restarts; a stale marker would
 * let the RPC session connect before the new guest bridge is listening.
 */
function clearRpcReadyMarker(): void {
  const active = store.getActive()
  if (!active) return
  try {
    fs.rmSync(path.join(active.path, '.pi-box', 'rpc-bridge.log.ready'), { force: true })
  } catch {
    // ignore
  }
}

async function restartVm(): Promise<void> {
  const active = store.getActive()
  if (!active) {
    broadcast()
    return
  }
  // The VM (and its port forwards) is about to disappear; drop the RPC session.
  await rpc.teardown()
  clearRpcReadyMarker()
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
    rpc,
    buildState,
    broadcast,
    restartVm,
    getWindow: () => mainWindow
  })

  vm.on('status', () => broadcast())
  vm.on('output', broadcastOutput)
  rpc.on('event', broadcastRpcEvent)
  rpc.on('state', broadcastRpcState)

  createWindow()

  // Boot the VM with the last used workspace mounted at MOUNT_POINT.
  const active = store.getActive()
  if (active) {
    clearRpcReadyMarker()
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

let quitting = false

app.on('before-quit', (event) => {
  if (quitting) return
  // Close the RPC session, then wait for the VM to stop (which flushes the
  // persistent-root ext4/overlay page cache via sync) before actually quitting.
  event.preventDefault()
  quitting = true
  void (async () => {
    try {
      await rpc.teardown()
    } catch {
      // ignore
    }
    try {
      await vm.stop()
    } finally {
      app.quit()
    }
  })()
})
