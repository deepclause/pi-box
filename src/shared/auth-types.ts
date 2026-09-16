/**
 * Types shared between the main process and the renderer for native provider
 * authentication (login/logout/status). The heavy lifting (provider catalog,
 * login flows, OAuth) is done by `@earendil-works/pi-ai` on the host; see
 * `src/main/auth.ts`. The wire shapes here mirror pi-ai's `AuthPrompt` /
 * `AuthEvent` contract so the renderer can render them without importing pi.
 */

export type AuthMethod = 'api_key' | 'oauth'

/** A provider the user can connect. */
export interface AuthProviderInfo {
  id: string
  name: string
  /** Interactive login methods this provider supports. */
  methods: AuthMethod[]
  /** OAuth is a subscription plan (Claude Pro/Max, GitHub Copilot, …). */
  subscription: boolean
  /** Provider can also be configured through environment/ambient credentials. */
  ambient: boolean
}

/** A provider that currently has usable credentials. */
export interface AuthStatus {
  providerId: string
  kind: AuthMethod | 'env'
  /** Human-readable label, e.g. "ANTHROPIC_API_KEY", "stored credential". */
  source?: string
  /** OAuth access-token expiry (ms since epoch). */
  expires?: number
}

export type AuthPrompt =
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: { id: string; label: string; description?: string }[]
    }
  | { type: 'manual_code'; message: string; placeholder?: string }

export type AuthEvent =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

/** Main → renderer: a login flow needs user input. */
export interface AuthPromptRequest {
  sessionId: string
  promptId: string
  providerId: string
  prompt: AuthPrompt
}

/** Main → renderer: progress/notification for an active login. */
export interface AuthEventMessage {
  sessionId: string
  providerId: string
  event: AuthEvent
}

/** Renderer → main: answer to a prompt. */
export interface AuthPromptResponse {
  sessionId: string
  promptId: string
  value?: string
  cancelled?: boolean
}

/** Result of a login flow. */
export interface AuthLoginResult {
  sessionId: string
  providerId: string
  ok: boolean
  cancelled?: boolean
  error?: string
}

export interface AuthSessionHandle {
  sessionId: string
}
