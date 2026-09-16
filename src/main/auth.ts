import { randomUUID } from 'node:crypto'
import type {
  AuthCheck,
  AuthEvent as PiAuthEvent,
  AuthInteraction,
  AuthPrompt as PiAuthPrompt,
  AuthType,
  Credential,
  MutableModels
} from '@earendil-works/pi-ai'
import type {
  AuthEvent,
  AuthLoginResult,
  AuthMethod,
  AuthPrompt,
  AuthPromptResponse,
  AuthProviderInfo,
  AuthStatus
} from '../shared/auth-types'
import { FileCredentialStore } from './credential-store'
import type { WorkspaceStore } from './workspaces'

type PiAi = typeof import('@earendil-works/pi-ai')
type PiAiProviders = typeof import('@earendil-works/pi-ai/providers/all')

/**
 * pi-ai is ESM-only and its exports map has no `require` condition, so the
 * CJS main process must load it with a dynamic `import()`. Load once and share.
 */
let piAiPromise: Promise<{ ai: PiAi; providers: PiAiProviders }> | null = null
function loadPiAi(): Promise<{ ai: PiAi; providers: PiAiProviders }> {
  if (!piAiPromise) {
    piAiPromise = (async () => ({
      ai: await import('@earendil-works/pi-ai'),
      providers: await import('@earendil-works/pi-ai/providers/all')
    }))()
  }
  return piAiPromise
}

interface PendingPrompt {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

interface LoginSession {
  id: string
  providerId: string
  method: AuthMethod
  abort: AbortController
  pending: Map<string, PendingPrompt>
}

export interface AuthServiceHooks {
  /** Push an IPC event to the renderer. */
  publish: (channel: string, payload: unknown) => void
  /** Called after credentials change so the RPC session can reload them. */
  onCredentialsChanged?: () => void
}

/**
 * Native provider authentication for pi-box.
 *
 * pi implements `/login` only in its interactive TUI, but the auth engine it
 * uses (`@earendil-works/pi-ai`) is UI-agnostic: it exposes `Models.login()`
 * with an `AuthInteraction` (prompt + notify) callback contract. We run that
 * engine on the host and drive it from a native modal, writing credentials to
 * the workspace's `.pi/auth.json` so the VM's pi picks them up.
 */
export class AuthService {
  private sessions = new Map<string, LoginSession>()
  private providerCache: AuthProviderInfo[] | null = null
  private models: MutableModels | null = null
  private credentials: FileCredentialStore | null = null
  private modelsKey: string | null = null

  constructor(
    private readonly store: WorkspaceStore,
    private readonly hooks: AuthServiceHooks
  ) {}

  private authPath(): string | null {
    const active = this.store.getActive()
    return active ? this.store.authPath(active.id) : null
  }

  private async engine(): Promise<{ models: MutableModels; credentials: FileCredentialStore }> {
    const authPath = this.authPath()
    if (!authPath) throw new Error('No active workspace')
    if (this.models && this.credentials && this.modelsKey === authPath) {
      return { models: this.models, credentials: this.credentials }
    }

    const { ai, providers } = await loadPiAi()
    const credentials = new FileCredentialStore(authPath, this.store.sharedAuthPath())
    const models = ai.createModels({ credentials })
    for (const provider of providers.builtinProviders()) models.setProvider(provider)

    this.models = models
    this.credentials = credentials
    this.modelsKey = authPath
    return { models, credentials }
  }

  /** Provider catalog for the onboarding/settings UI. */
  async providers(): Promise<AuthProviderInfo[]> {
    if (this.providerCache) return this.providerCache
    const { providers } = await loadPiAi()
    this.providerCache = providers
      .builtinProviders()
      .map((provider) => {
        const methods: AuthMethod[] = []
        if (provider.auth.apiKey?.login) methods.push('api_key')
        if (provider.auth.oauth?.login) methods.push('oauth')
        const oauth = provider.auth.oauth as { isSubscription?: boolean } | undefined
        return {
          id: provider.id,
          name: provider.name ?? provider.id,
          methods,
          subscription: oauth?.isSubscription === true,
          ambient: Boolean(provider.auth.apiKey)
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    return this.providerCache
  }

  /** Providers that currently have usable credentials. */
  async status(): Promise<AuthStatus[]> {
    const { models, credentials } = await this.engine()
    const providers = await this.providers()
    const found: AuthStatus[] = []

    await Promise.all(
      providers.map(async (info) => {
        let check: AuthCheck | undefined
        try {
          check = await models.checkAuth(info.id)
        } catch {
          return
        }
        if (!check) return

        let expires: number | undefined
        try {
          const stored: Credential | undefined = await credentials.read(info.id)
          if (stored?.type === 'oauth') expires = stored.expires
        } catch {
          // ignore
        }
        found.push({ providerId: info.id, kind: check.type, source: check.source, expires })
      })
    )

    return found.sort((a, b) => a.providerId.localeCompare(b.providerId))
  }

  async publishStatus(): Promise<void> {
    try {
      this.hooks.publish('pibox:auth:status', await this.status())
    } catch {
      // No active workspace yet; nothing to publish.
      this.hooks.publish('pibox:auth:status', [])
    }
  }

  /** Begin a login flow. Prompts/events stream to the renderer via IPC. */
  async login(providerId: string, method: AuthMethod): Promise<{ sessionId: string }> {
    const { models } = await this.engine()
    const session: LoginSession = {
      id: randomUUID(),
      providerId,
      method,
      abort: new AbortController(),
      pending: new Map()
    }
    this.sessions.set(session.id, session)
    void this.runLogin(session, models)
    return { sessionId: session.id }
  }

  private async runLogin(session: LoginSession, models: MutableModels): Promise<void> {
    const interaction: AuthInteraction = {
      signal: session.abort.signal,
      prompt: (prompt) => this.prompt(session, prompt),
      notify: (event) => {
        this.hooks.publish('pibox:auth:event', {
          sessionId: session.id,
          providerId: session.providerId,
          event: toSharedEvent(event)
        })
      }
    }

    let result: AuthLoginResult
    try {
      await models.login(session.providerId, session.method as AuthType, interaction)
      result = { sessionId: session.id, providerId: session.providerId, ok: true }
    } catch (error) {
      const cancelled = session.abort.signal.aborted
      result = {
        sessionId: session.id,
        providerId: session.providerId,
        ok: false,
        cancelled,
        error: cancelled ? undefined : error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.sessions.delete(session.id)
    }

    this.hooks.publish('pibox:auth:done', result)
    if (result.ok) {
      this.hooks.onCredentialsChanged?.()
      void this.publishStatus()
    }
  }

  private prompt(session: LoginSession, prompt: PiAuthPrompt): Promise<string> {
    const promptId = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const settleReject = (): void => {
        if (session.pending.delete(promptId)) reject(new Error('cancelled'))
      }
      session.abort.signal.addEventListener('abort', settleReject, { once: true })
      session.pending.set(promptId, {
        resolve: (value) => {
          session.abort.signal.removeEventListener('abort', settleReject)
          resolve(value)
        },
        reject: (error) => {
          session.abort.signal.removeEventListener('abort', settleReject)
          reject(error)
        }
      })
      this.hooks.publish('pibox:auth:prompt', {
        sessionId: session.id,
        promptId,
        providerId: session.providerId,
        prompt: toSharedPrompt(prompt)
      })
    })
  }

  respond(response: AuthPromptResponse): void {
    const session = this.sessions.get(response.sessionId)
    const pending = session?.pending.get(response.promptId)
    if (!session || !pending) return
    session.pending.delete(response.promptId)
    if (response.cancelled) pending.reject(new Error('cancelled'))
    else pending.resolve(response.value ?? '')
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.abort.abort()
  }

  async logout(providerId: string): Promise<AuthStatus[]> {
    const { models } = await this.engine()
    await models.logout(providerId)
    this.hooks.onCredentialsChanged?.()
    const status = await this.status()
    this.hooks.publish('pibox:auth:status', status)
    return status
  }

  /** Drop cached engine state (e.g. after the active workspace changes). */
  reset(): void {
    this.models = null
    this.credentials = null
    this.modelsKey = null
  }
}

function toSharedPrompt(prompt: PiAuthPrompt): AuthPrompt {
  if (prompt.type === 'select') {
    return {
      type: 'select',
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description
      }))
    }
  }
  return { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder }
}

function toSharedEvent(event: PiAuthEvent): AuthEvent {
  if (event.type === 'info') {
    return {
      type: 'info',
      message: event.message,
      links: event.links?.map((link) => ({ url: link.url, label: link.label }))
    }
  }
  return event
}
