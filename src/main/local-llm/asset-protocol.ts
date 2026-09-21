import { app, net, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LocalModelStore } from './model-store'

export const LOCAL_LLM_SCHEME = 'pibox-asset'

/**
 * Must be called before `app.whenReady()`. The scheme is privileged so it can
 * be fetched from a renderer/worker with CORS.
 */
export function registerLocalLlmScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_LLM_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

function resolveWllamaWasmPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'wllama.wasm')
  }
  const candidates = [
    path.join(app.getAppPath(), 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'),
    path.join(process.cwd(), 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

async function serveFile(filePath: string, contentType: string): Promise<Response> {
  try {
    if (!fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 })
    }
    const res = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    const length = res.headers.get('content-length')
    if (length) headers.set('Content-Length', length)
    return new Response(res.body, { status: 200, headers })
  } catch (error) {
    return new Response(String(error), { status: 500 })
  }
}

/**
 * Register the `pibox-asset://` handler. Must be called after app ready.
 *
 *   pibox-asset://wasm/wllama.wasm   -> the wllama engine wasm
 *   pibox-asset://model/<file>.gguf  -> a file inside the models directory
 */
export function installLocalLlmProtocol(store: LocalModelStore): void {
  protocol.handle(LOCAL_LLM_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (url.host === 'wasm' && (url.pathname === '/wllama.wasm' || url.pathname === '/')) {
      return serveFile(resolveWllamaWasmPath(), 'application/wasm')
    }

    if (url.host === 'model') {
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const filePath = store.pathForFile(file)
      if (!filePath) return new Response('Forbidden', { status: 403 })
      return serveFile(filePath, 'application/octet-stream')
    }

    return new Response('Not found', { status: 404 })
  })
}
