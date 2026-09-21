import { contextBridge, ipcRenderer } from 'electron'

/**
 * Minimal bridge for the hidden wllama host page. Only message passing is
 * exposed; the page has no access to Node or arbitrary IPC channels.
 */
const api = {
  send: (msg: unknown): void => {
    ipcRenderer.send('pibox:llm:host:out', msg)
  },
  onMessage: (cb: (msg: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, msg: unknown): void => cb(msg)
    ipcRenderer.on('pibox:llm:host:in', listener)
    return () => ipcRenderer.removeListener('pibox:llm:host:in', listener)
  }
}

contextBridge.exposeInMainWorld('llmHost', api)

export type LlmHostApi = typeof api
