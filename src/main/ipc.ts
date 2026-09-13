import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { AppState, OpenResult } from '../shared/types'
import type { VmManager } from './vm'
import type { WorkspaceStore } from './workspaces'

export const MOUNT_POINT = '/workspace'

export interface IpcContext {
  vm: VmManager
  store: WorkspaceStore
  buildState: () => AppState
  broadcast: () => void
  restartVm: () => Promise<void>
  getWindow: () => BrowserWindow | null
}

export function registerIpc(ctx: IpcContext): void {
  const { vm, store } = ctx

  ipcMain.handle('pibox:getState', () => ctx.buildState())

  ipcMain.handle('pibox:restartVm', async () => {
    await ctx.restartVm()
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
