import { describe, expect, it, afterEach } from 'vitest'
import { LocalLlmHttpServer, type ChatEngine } from './http-server'

const TOKEN = 'test-token'
const MODEL = 'local/test'

function makeEngine(): ChatEngine {
  let loaded: string | null = MODEL
  return {
    async ensureModel(modelId) {
      loaded = modelId
    },
    streamChat(_requestId, body) {
      const model = String(body.model ?? MODEL)
      async function* generate(): AsyncGenerator<Record<string, unknown>> {
        yield {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        }
        yield {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]
        }
        yield {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        }
      }
      return generate()
    },
    currentModelId: () => loaded,
    isReady: () => true
  }
}

const servers: LocalLlmHttpServer[] = []

async function start(): Promise<{ server: LocalLlmHttpServer; base: string }> {
  const server = new LocalLlmHttpServer({
    getToken: () => TOKEN,
    getEngine: () => makeEngine(),
    listModels: () => [{ id: MODEL }]
  })
  servers.push(server)
  const port = await server.start(0)
  return { server, base: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('LocalLlmHttpServer', () => {
  it('rejects unauthenticated requests', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/models`)
    expect(res.status).toBe(401)
  })

  it('lists models', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual([MODEL])
  })

  it('streams SSE chunks terminated by [DONE]', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('data: ')
    expect(text).toContain('"content":"Hello"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('accumulates a non-streaming response', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>
    }
    expect(body.choices[0].message.content).toBe('Hello')
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  it('404s an unknown model', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(404)
  })

  it('400s a malformed body', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{'
    })
    expect(res.status).toBe(400)
  })
})
