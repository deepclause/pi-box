import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import type { AppState, AttachFileResult, FirewallRule, OpenResult } from '../shared/types'
import { MAX_ATTACHMENT_BYTES, saveAttachment } from './attachments'
import type { AuthMethod, AuthPromptResponse } from '../shared/auth-types'
import type { RpcExtensionUIResponse, RpcImage, RpcStreamingBehavior } from '../shared/rpc-types'
import type { AuthService } from './auth'
import type { RpcSessionManager } from './rpc'
import type { VmManager } from './vm'
import type { WorkspaceStore } from './workspaces'
import type { LocalLlmService } from './local-llm/service'

export const MOUNT_POINT = '/workspace'

export interface IpcContext {
  vm: VmManager
  store: WorkspaceStore
  rpc: RpcSessionManager
  auth: AuthService
  localLlm: LocalLlmService
  buildState: () => AppState
  broadcast: () => void
  restartVm: () => Promise<void>
  getWindow: () => BrowserWindow | null
}

export function registerIpc(ctx: IpcContext): void {
  const { vm, store, rpc, auth, localLlm } = ctx

  ipcMain.handle('pibox:getState', () => ctx.buildState())

  ipcMain.handle('pibox:restartVm', async () => {
    await ctx.restartVm()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:editFile', async (_event, workspaceId: string, hostPath: string) => {
    const ws = store.get(workspaceId)
    if (!ws) return { ok: false, error: 'Workspace not found' }

    const active = store.getActive()
    if (!active || active.id !== workspaceId) {
      return { ok: false, error: 'Workspace is not mounted' }
    }

    const base = path.resolve(ws.path)
    const target = path.resolve(hostPath)
    const rel = path.relative(base, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: 'File is outside the workspace' }
    }

    const guestRel = rel.split(path.sep).join('/')
    await vm.openFileInVi(`${MOUNT_POINT}/${guestRel}`)
    return { ok: true }
  })

  ipcMain.handle(
    'pibox:attachFile',
    (_event, name: string, bytes: Uint8Array): AttachFileResult => {
      const active = store.getActive()
      if (!active) return { ok: false, error: 'No active workspace' }

      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        return { ok: false, error: `File is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB` }
      }

      try {
        const saved = saveAttachment(active.path, name, buffer)
        return {
          ok: true,
          name,
          size: saved.size,
          path: `${MOUNT_POINT}/${saved.relative}`
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('pibox:clipboardWriteText', (_event, text: string) => {
    return clipboard.writeText(text)
  })

  ipcMain.handle('pibox:clipboardReadText', () => {
    return clipboard.readText()
  })

  ipcMain.handle('pibox:toggleNetwork', async () => {
    await vm.toggleNetwork()
    ctx.broadcast()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:addFirewallRule', (_event, rule: FirewallRule) => {
    vm.addFirewallRule(rule)
    ctx.broadcast()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:removeFirewallRule', (_event, id: string) => {
    vm.removeFirewallRule(id)
    ctx.broadcast()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:clearFirewall', () => {
    vm.clearFirewall()
    ctx.broadcast()
    return ctx.buildState()
  })

  // --- pi RPC chat (Phase 1: one live session) ---

  ipcMain.handle('pibox:rpc:state', () => rpc.state)

  ipcMain.handle('pibox:rpc:open', async () => {
    await rpc.ensureSession()
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:getEntries', async () => rpc.getEntries())

  ipcMain.handle('pibox:rpc:prompt', async (_event, message: string, behavior?: RpcStreamingBehavior, images?: RpcImage[]) => {
    await rpc.prompt(message, behavior, images)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:steer', async (_event, message: string, images?: RpcImage[]) => {
    await rpc.steer(message, images)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:followUp', async (_event, message: string, images?: RpcImage[]) => {
    await rpc.followUp(message, images)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:getForkMessages', async () => rpc.getForkMessages())

  ipcMain.handle('pibox:rpc:getTree', async () => rpc.getTree())

  ipcMain.handle('pibox:rpc:reconnect', async () => {
    await rpc.teardown()
    await rpc.ensureSession()
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:fork', async (_event, entryId: string) => {
    const text = await rpc.fork(entryId)
    return { state: rpc.state, text }
  })

  ipcMain.handle('pibox:rpc:clone', async () => {
    await rpc.clone()
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:abort', async () => {
    await rpc.abort()
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:clearQueue', async () => rpc.clearQueue())

  ipcMain.handle('pibox:rpc:getAvailableModels', async () => rpc.getAvailableModels())

  ipcMain.handle('pibox:rpc:setModel', async (_event, provider: string, modelId: string) => {
    await rpc.setModel(provider, modelId)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:setThinkingLevel', async (_event, level: string) => {
    await rpc.setThinkingLevel(level)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:getSessionStats', async () => rpc.getSessionStats())

  ipcMain.handle('pibox:rpc:getAvailableThinkingLevels', async () => rpc.getAvailableThinkingLevels())

  ipcMain.handle('pibox:rpc:getCommands', async () => rpc.getCommands())

  ipcMain.handle('pibox:rpc:setSessionName', async (_event, name: string) => {
    await rpc.setSessionName(name)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:cycleModel', async () => {
    await rpc.cycleModel()
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:cycleThinkingLevel', async () => {
    await rpc.cycleThinkingLevel()
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:listSessions', async () => rpc.listSessions())

  ipcMain.handle('pibox:rpc:newSession', async () => rpc.newSession())

  ipcMain.handle('pibox:rpc:switchSession', async (_event, file: string) => rpc.switchSession(file))

  ipcMain.handle('pibox:rpc:deleteSession', async (_event, file: string) => {
    await rpc.deleteSession(file)
    return rpc.state
  })

  ipcMain.handle('pibox:rpc:exportHtml', async (_event, outputPath?: string) => rpc.exportHtml(outputPath))

  ipcMain.on('pibox:rpc:extensionUi', (_event, response: RpcExtensionUIResponse) => {
    rpc.respondExtensionUi(response)
  })

  // --- native provider authentication (pi-ai on the host) ---

  ipcMain.handle('pibox:auth:providers', async () => auth.providers())

  ipcMain.handle('pibox:auth:status', async () => auth.status())

  ipcMain.handle('pibox:auth:login', async (_event, providerId: string, method: AuthMethod) =>
    auth.login(providerId, method)
  )

  ipcMain.handle('pibox:auth:logout', async (_event, providerId: string) => auth.logout(providerId))

  ipcMain.on('pibox:auth:respond', (_event, response: AuthPromptResponse) => {
    auth.respond(response)
  })

  ipcMain.on('pibox:auth:cancel', (_event, sessionId: string) => {
    auth.cancel(sessionId)
  })

  ipcMain.handle('pibox:setOnboardingDone', (_event, done: boolean) => {
    store.setOnboardingDone(done)
    ctx.broadcast()
    return ctx.buildState()
  })

  // --- local (WebGPU/CPU) LLM provider ---

  ipcMain.handle('pibox:localLlm:state', () => localLlm.getState())

  ipcMain.handle('pibox:localLlm:getCapabilities', async () => {
    await localLlm.getCapabilities()
    return localLlm.getState()
  })

  ipcMain.handle('pibox:localLlm:download', async (_event, id: string) => {
    await localLlm.download(id)
    ctx.broadcast()
    return localLlm.getState()
  })

  ipcMain.handle('pibox:localLlm:cancelDownload', (_event, id: string) => {
    const state = localLlm.cancelDownload(id)
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:remove', async (_event, id: string) => {
    const state = await localLlm.remove(id)
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:setActiveModel', (_event, id: string | null) => {
    const state = localLlm.setActiveModel(id)
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:setEnabled', (_event, enabled: boolean) => {
    const state = localLlm.setEnabled(enabled)
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:setNctx', (_event, nCtx: number) => {
    const state = localLlm.setNctx(nCtx)
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:setGpuLayers', (_event, layers: number) => {
    const state = localLlm.setGpuLayers(layers)
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:refresh', () => {
    const state = localLlm.refreshModels()
    ctx.broadcast()
    return state
  })

  ipcMain.handle('pibox:localLlm:openModelsDir', async () => {
    const dir = localLlm.getState().modelsDir
    if (!dir) return { ok: false, error: 'No models directory' }
    const error = await shell.openPath(dir)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('pibox:addPortForward', async (_event, config: { hostPort: number; guestPort: number; guestHost?: string }) => {
    await vm.addPortForward(config)
    ctx.broadcast()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:removePortForward', (_event, hostPort: number) => {
    vm.removePortForward(hostPort)
    ctx.broadcast()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:addWorkspace', async () => {
    const win = ctx.getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Add workspace folder',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Add workspace folder',
          properties: ['openDirectory', 'createDirectory']
        })

    if (result.canceled || result.filePaths.length === 0) {
      return ctx.buildState()
    }

    const ws = store.add(result.filePaths[0])
    if (ws) await ctx.restartVm()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:removeWorkspace', async (_event, id: string) => {
    const removedActive = ctx.buildState().activeWorkspaceId === id
    const ok = store.remove(id)
    if (ok && removedActive) await ctx.restartVm()
    else ctx.broadcast()
    return ctx.buildState()
  })

  ipcMain.handle('pibox:setActiveWorkspace', async (_event, id: string) => {
    if (store.setActive(id)) {
      await ctx.restartVm()
    }
    return ctx.buildState()
  })

  ipcMain.handle('pibox:openFolder', async (_event, id: string): Promise<OpenResult> => {
    const ws = store.get(id)
    if (!ws) return { ok: false, error: 'Workspace not found' }
    const error = await shell.openPath(ws.path)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('pibox:readTree', (_event, id: string, dirPath?: string) => {
    return store.readTree(id, dirPath)
  })

  // --- virtual framebuffer (games / fbdev apps) ---

  ipcMain.handle('pibox:fb:get', () => vm.getFramebuffer())

  ipcMain.handle('pibox:fb:run', async (_event, command: string) => {
    await vm.runProgram(command)
    return true
  })

  ipcMain.handle('pibox:fb:stop', async () => {
    await vm.stopProgram()
    return true
  })

  ipcMain.on('pibox:fb:key', (_event, code: string | number, down: boolean) => {
    try {
      vm.sendKey(code, down)
    } catch {
      // unknown key / VM not ready
    }
  })

  ipcMain.on('pibox:fb:mouse', (_event, x: number, y: number, buttons: number) => {
    try {
      vm.sendMouse(x, y, buttons)
    } catch {
      // VM not ready
    }
  })

  // --- guest audio (virtio-snd) ---

  ipcMain.handle('pibox:audio:format', () => vm.getAudioFormat())

  ipcMain.on('pibox:termInput', (_event, data: string) => {
    void vm.write(data)
  })

  ipcMain.on('pibox:termResize', (_event, cols: number, rows: number) => {
    // The VM console is resized by the guest-side resize daemon, which watches
    // the host-written `.pi/tty-size` file and applies TIOCSWINSZ; tmux then
    // propagates the new size to pi. This avoids typing `stty` into pi's stdin.
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    const active = store.getActive()
    if (active) {
      store.writeTtySize(active.id, Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
    }
  })
}
