import fs from 'node:fs'
import path from 'node:path'

/** AgentVM translates this guest-visible gateway IP to host 127.0.0.1. */
export const GUEST_GATEWAY_IP = '192.168.127.1'

export const LOCAL_PROVIDER_ID = 'pi-box-local'

const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStore: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: false,
  maxTokensField: 'max_tokens'
} as const

export interface LocalProviderModel {
  id: string
  name: string
  contextWindow: number
}

export interface LocalProviderConfig {
  port: number
  token: string
  models: LocalProviderModel[]
}

/** Build the `pi-box-local` provider block written to `.pi/models.json`. */
export function buildProviderBlock(config: LocalProviderConfig): Record<string, unknown> {
  return {
    name: 'pi-box local (WebGPU/CPU)',
    baseUrl: `http://${GUEST_GATEWAY_IP}:${config.port}/v1`,
    api: 'openai-completions',
    apiKey: config.token,
    compat: COMPAT,
    models: config.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ['text'],
      contextWindow: model.contextWindow,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
  }
}

function modelsPath(workspacePath: string): string {
  return path.join(workspacePath, '.pi', 'models.json')
}

function readExisting(file: string): { providers: Record<string, unknown>; isAppOnly: boolean } {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> }
    const providers = parsed?.providers && typeof parsed.providers === 'object' ? parsed.providers : {}
    const keys = Object.keys(providers)
    const isAppOnly = keys.every((key) => key === LOCAL_PROVIDER_ID)
    return { providers, isAppOnly }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { providers: {}, isAppOnly: true }
    }
    // Malformed file: back it up and start over, so we never destroy user data.
    try {
      fs.copyFileSync(file, `${file}.bak`)
    } catch {
      // ignore
    }
    return { providers: {}, isAppOnly: true }
  }
}

/**
 * Upsert (or, when `config` is null, remove) the local provider block in the
 * workspace's `.pi/models.json`. Never clobbers unrelated user providers.
 */
export function writeLocalProvider(workspacePath: string, config: LocalProviderConfig | null): void {
  const dir = path.join(workspacePath, '.pi')
  const file = modelsPath(workspacePath)
  const existing = readExisting(file)
  const providers = { ...existing.providers }

  if (config && config.models.length > 0) {
    providers[LOCAL_PROVIDER_ID] = buildProviderBlock(config)
  } else {
    delete providers[LOCAL_PROVIDER_ID]
  }

  // If we only ever wrote our own provider and it is now gone, remove the file.
  if (Object.keys(providers).length === 0 && existing.isAppOnly) {
    fs.rmSync(file, { force: true })
    return
  }

  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ providers }, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // best effort (Windows)
  }
}
