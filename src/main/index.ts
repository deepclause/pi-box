import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { VmManager } from './vm'
import { WorkspaceStore } from './workspaces'
import { RpcSessionManager } from './rpc'
import { AuthService } from './auth'
import { MOUNT_POINT, registerIpc } from './ipc'
import { LocalLlmService } from './local-llm/service'
import { registerLocalLlmScheme } from './local-llm/asset-protocol'
import type { AppState, AudioChunk, FbFrame } from '../shared/types'
import type { RpcEvent, RpcState } from '../shared/rpc-types'
import type { LocalLlmState } from '../shared/local-llm-types'

// WebGPU is not exposed on some GPU/driver combinations (e.g. older NVIDIA
// laptops on Linux). Force it on so the local model can use the GPU; wllama
// still falls back to CPU when no adapter exists.
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// The local LLM serves model/engine assets over a privileged scheme; this must
// run before `app.whenReady()`.
registerLocalLlmScheme()

let mainWindow: BrowserWindow | null = null

const vm = new VmManager()
const store = new WorkspaceStore()
const rpc = new RpcSessionManager(vm, store)
const localLlm = new LocalLlmService({
  userDataDir: app.getPath('userData'),
  onChange: (state) => broadcastLocalLlm(state)
})
const auth = new AuthService(store, {
  publish: (channel, payload) => broadcastAuth(channel, payload),
  onCredentialsChanged: () => {
    // Reload the running pi session so it picks up the new credentials.
    if (vm.status !== 'ready') return
    void (async () => {
      await rpc.teardown()
      await rpc.ensureSession()
    })().catch(() => undefined)
  }
})

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
    firewallRules: vm.firewallRules,
    onboardingDone: store.getOnboardingDone(),
    localLlm: localLlm.getState()
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

function broadcastAuth(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function broadcastLocalLlm(state: LocalLlmState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:localLlm:state', state)
  }
}

function broadcastFramebuffer(frame: FbFrame): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:fb:frame', frame)
  }
}

function broadcastAudio(chunk: AudioChunk): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pibox:audio:frame', chunk)
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
  auth.reset()
  clearRpcReadyMarker()
  // Make sure pi sees the local provider (if enabled) before it boots.
  localLlm.onWorkspace(active.path)
  await vm.start({ [MOUNT_POINT]: active.path })
  broadcast()
  void auth.publishStatus()
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e21',
    title: 'pi-box',
    autoHideMenuBar: true,
    // Native macOS chrome: overlay the traffic lights on our own header and
    // blur the desktop behind the translucent sidebars. Other platforms keep
    // the normal frame.
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 17 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const
        }
      : {}),
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
  await localLlm.start()

  registerIpc({
    vm,
    store,
    rpc,
    auth,
    localLlm,
    buildState,
    broadcast,
    restartVm,
    getWindow: () => mainWindow
  })

  vm.on('status', () => broadcast())
  vm.on('output', broadcastOutput)
  vm.on('framebuffer', broadcastFramebuffer)
  vm.on('audio', broadcastAudio)
  rpc.on('event', broadcastRpcEvent)
  rpc.on('state', broadcastRpcState)

  createWindow()

  // Boot the VM with the last used workspace mounted at MOUNT_POINT.
  const active = store.getActive()
  if (active) {
    clearRpcReadyMarker()
    localLlm.onWorkspace(active.path)
    await vm.start({ [MOUNT_POINT]: active.path })
    broadcast()
  }

  void auth.publishStatus()
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
      await localLlm.stop()
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
