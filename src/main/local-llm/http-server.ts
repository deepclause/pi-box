import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const HEARTBEAT_MS = 15_000

export interface ChatEngine {
  /** Ensure the requested model is loaded (no-op when it already is). */
  ensureModel(modelId: string): Promise<void>
  /** Stream OpenAI-shaped chunks for a chat completion. */
  streamChat(
    requestId: string,
    body: Record<string, unknown>,
    signal: AbortSignal
  ): AsyncIterable<Record<string, unknown>>
  /** Model id currently loaded, if any. */
  currentModelId(): string | null
  isReady(): boolean
}

export interface LocalLlmHttpServerOptions {
  getToken: () => string
  getEngine: () => ChatEngine
  listModels: () => Array<{ id: string; created?: number }>
  onLog?: (message: string) => void
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request entity too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function sendError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
  code?: string
): void {
  sendJson(res, status, { error: { message, type, code: code ?? null } })
}

function writeWithBackpressure(res: http.ServerResponse, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (res.write(text)) resolve()
    else res.once('drain', () => resolve())
  })
}

/** Merge streaming OpenAI chunks into a single non-streaming response. */
function accumulate(
  chunks: Array<Record<string, unknown>>,
  model: string
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: '' }
  const toolCalls: Array<Record<string, unknown>> = []
  let finishReason: unknown = 'stop'
  let usage: unknown = null
  let created = Math.floor(Date.now() / 1000)
  let id = `chatcmpl-${randomUUID()}`

  for (const chunk of chunks) {
    if (typeof chunk.id === 'string') id = chunk.id
    if (typeof chunk.created === 'number') created = chunk.created
    if (chunk.usage) usage = chunk.usage
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta as Record<string, unknown> | undefined
    if (!delta) continue
    if (typeof delta.content === 'string') {
      message.content = `${message.content ?? ''}${delta.content}`
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = typeof tc.index === 'number' ? tc.index : toolCalls.length
        const existing = (toolCalls[index] ??= {
          id: tc.id,
          type: 'function',
          function: { name: '', arguments: '' }
        })
        if (tc.id) existing.id = tc.id
        const fn = tc.function as Record<string, unknown> | undefined
        const existingFn = existing.function as Record<string, unknown>
        if (fn?.name) existingFn.name = `${existingFn.name ?? ''}${fn.name}`
        if (fn?.arguments) existingFn.arguments = `${existingFn.arguments ?? ''}${fn.arguments}`
      }
    }
  }

  if (toolCalls.length > 0) message.tool_calls = toolCalls
  if (message.content === '') delete message.content

  const response: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }]
  }
  if (usage) response.usage = usage
  return response
}

/**
 * A loopback-only OpenAI-compatible server backed by a WebGPU/CPU engine.
 * The guest's pi reaches it through AgentVM's gateway→127.0.0.1 translation.
 */
export class LocalLlmHttpServer {
  private server: http.Server | null = null
  private port: number | null = null

  constructor(private readonly options: LocalLlmHttpServerOptions) {}

  get boundPort(): number | null {
    return this.port
  }

  get running(): boolean {
    return this.server !== null
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch((error) => {
          this.options.onLog?.(`http error: ${String(error)}`)
          if (!res.headersSent) sendError(res, 500, 'internal_error', String(error))
          else res.end()
        })
      })
      server.requestTimeout = 0
      server.headersTimeout = 0
      server.keepAliveTimeout = 120_000
      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        this.port = (server.address() as AddressInfo).port
        resolve(this.port)
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server
      this.server = null
      this.port = null
      if (!server) return resolve()
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization']
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return false
    return safeEqual(match[1], this.options.getToken())
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      const engine = this.options.getEngine()
      return sendJson(res, 200, {
        ok: true,
        status: engine.isReady() ? 'ready' : 'idle',
        model: engine.currentModelId()
      })
    }

    if (!this.authorized(req)) {
      return sendError(res, 401, 'invalid_request_error', 'Missing or invalid bearer token')
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const created = Math.floor(Date.now() / 1000)
      return sendJson(res, 200, {
        object: 'list',
        data: this.options.listModels().map((model) => ({
          id: model.id,
          object: 'model',
          created: model.created ?? created,
          owned_by: 'pi-box'
        }))
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return this.handleChat(req, res)
    }

    return sendError(res, 404, 'invalid_request_error', `Unknown route ${req.method} ${url.pathname}`)
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES)) as Record<string, unknown>
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Malformed JSON body')
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, 'invalid_request_error', '"messages" must be a non-empty array')
    }

    const engine = this.options.getEngine()
    const requested = typeof body.model === 'string' ? body.model : engine.currentModelId()
    if (!requested) {
      return sendError(res, 400, 'model_not_found', 'No model specified and none loaded')
    }

    const known = this.options.listModels().some((model) => model.id === requested)
    if (!known && requested !== engine.currentModelId()) {
      return sendError(res, 404, 'model_not_found', `Unknown model: ${requested}`)
    }

    try {
      await engine.ensureModel(requested)
    } catch (error) {
      return sendError(
        res,
        502,
        'model_load_error',
        error instanceof Error ? error.message : String(error)
      )
    }

    const controller = new AbortController()
    req.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    const requestId = randomUUID()
    const stream = body.stream === true
    const chunks: Array<Record<string, unknown>> = []

    try {
      const iterator = engine.streamChat(requestId, body, controller.signal)
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        })
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': ping\n\n')
        }, HEARTBEAT_MS)
        try {
          for await (const chunk of iterator) {
            await writeWithBackpressure(res, `data: ${JSON.stringify(chunk)}\n\n`)
          }
          if (!res.writableEnded) {
            await writeWithBackpressure(res, 'data: [DONE]\n\n')
            res.end()
          }
        } finally {
          clearInterval(heartbeat)
        }
      } else {
        for await (const chunk of iterator) chunks.push(chunk)
        sendJson(res, 200, accumulate(chunks, requested))
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      if (res.headersSent) {
        if (!aborted && !res.writableEnded) {
          await writeWithBackpressure(
            res,
            `data: ${JSON.stringify({ error: { message, type: 'inference_error' } })}\n\n`
          )
          await writeWithBackpressure(res, 'data: [DONE]\n\n')
          res.end()
        }
      } else if (!aborted) {
        sendError(res, 500, 'inference_error', message)
      } else {
        res.end()
      }
    }
  }
}
