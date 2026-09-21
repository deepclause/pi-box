import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import type { HostToMain, MainToHost } from '../../shared/local-llm-ipc'

export const HOST_IN_CHANNEL = 'pibox:llm:host:in'
export const HOST_OUT_CHANNEL = 'pibox:llm:host:out'

/**
 * Owns the hidden renderer that runs wllama. The page is a trusted, minimal
 * document; the main process never loads models itself (WebGPU lives in a
 * renderer).
 */
export class LocalLlmHostWindow {
  private win: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null

  constructor(
    private readonly onMessage: (msg: HostToMain) => void,
    private readonly onGone: () => void = () => undefined
  ) {
    ipcMain.on(HOST_OUT_CHANNEL, (event, msg: HostToMain) => {
      if (this.win && !this.win.isDestroyed() && event.sender === this.win.webContents) {
        this.onMessage(msg)
      }
    })
  }

  isAlive(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  async ensure(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      await this.loadPromise
      return
    }

    this.win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: path.join(__dirname, '../preload/llm-host.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    this.win.on('closed', () => {
      this.win = null
      this.loadPromise = null
      this.onGone()
    })
    this.win.webContents.on('render-process-gone', () => {
      this.win = null
      this.loadPromise = null
      this.onGone()
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    this.loadPromise = new Promise<void>((resolve) => {
      this.win?.webContents.once('did-finish-load', () => resolve())
    })

    if (devUrl) {
      await this.win.loadURL(`${devUrl}/llm-host.html`)
    } else {
      await this.win.loadFile(path.join(__dirname, '../renderer/llm-host.html'))
    }
    await this.loadPromise
  }

  send(msg: MainToHost): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(HOST_IN_CHANNEL, msg)
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
    }
    this.win = null
    this.loadPromise = null
  }
}
