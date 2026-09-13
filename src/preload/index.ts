import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, FileNode, OpenResult } from '../shared/types'

export interface PiBoxApi {
  getState(): Promise<AppState>
  restart(): Promise<AppState>
  addWorkspace(): Promise<AppState>
  removeWorkspace(id: string): Promise<AppState>
  setActiveWorkspace(id: string): Promise<AppState>
  openFolder(id: string): Promise<OpenResult>
  readTree(id: string, dirPath?: string): Promise<FileNode[]>
  termInput(data: string): void
  termResize(cols: number, rows: number): void
  onState(cb: (state: AppState) => void): () => void
  onOutput(cb: (data: string) => void): () => void
}

const api: PiBoxApi = {
  getState: () => ipcRenderer.invoke('pibox:getState'),
  restart: () => ipcRenderer.invoke('pibox:restartVm'),
  addWorkspace: () => ipcRenderer.invoke('pibox:addWorkspace'),
  removeWorkspace: (id) => ipcRenderer.invoke('pibox:removeWorkspace', id),
  setActiveWorkspace: (id) => ipcRenderer.invoke('pibox:setActiveWorkspace', id),
  openFolder: (id) => ipcRenderer.invoke('pibox:openFolder', id),
  readTree: (id, dirPath) => ipcRenderer.invoke('pibox:readTree', id, dirPath),
  termInput: (data) => ipcRenderer.send('pibox:termInput', data),
  termResize: (cols, rows) => ipcRenderer.send('pibox:termResize', cols, rows),

  onState: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => cb(state)
    ipcRenderer.on('pibox:state', listener)
    return () => ipcRenderer.removeListener('pibox:state', listener)
  },

  onOutput: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, data: string): void => cb(data)
    ipcRenderer.on('pibox:output', listener)
    return () => ipcRenderer.removeListener('pibox:output', listener)
  }
}

contextBridge.exposeInMainWorld('pibox', api)
