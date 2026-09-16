import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthEvent,
  AuthLoginResult,
  AuthMethod,
  AuthPrompt,
  AuthProviderInfo,
  AuthStatus
} from '@shared/auth-types'

export interface AuthSessionState {
  sessionId: string
  providerId: string
  method: AuthMethod
  /** Prompt currently awaiting an answer, if any. */
  prompt: { id: string; prompt: AuthPrompt } | null
  events: AuthEvent[]
  phase: 'running' | 'success' | 'error' | 'cancelled'
  error?: string
}

export interface UseAuth {
  session: AuthSessionState | null
  status: AuthStatus[]
  /** True once the initial provider/status fetch has completed. */
  loaded: boolean
  providers: AuthProviderInfo[]
  statusFor: (providerId: string) => AuthStatus | undefined
  providerName: (providerId: string) => string
  start: (providerId: string, method: AuthMethod) => Promise<void>
  respond: (value: string) => void
  cancel: () => void
  dismiss: () => void
  logout: (providerId: string) => Promise<void>
}

interface BufferedSession {
  prompt?: { id: string; prompt: AuthPrompt }
  events: AuthEvent[]
  done?: AuthLoginResult
}

function phaseOf(result: AuthLoginResult): AuthSessionState['phase'] {
  return result.ok ? 'success' : result.cancelled ? 'cancelled' : 'error'
}

/**
 * Drives pi-ai's provider auth from the renderer. Login flows run in the main
 * process; prompts and progress stream back as events. Events can arrive before
 * the `login()` promise resolves, so they are buffered per session id until the
 * session is committed.
 */
export function useAuth(): UseAuth {
  const [session, setSession] = useState<AuthSessionState | null>(null)
  const [status, setStatus] = useState<AuthStatus[]>([])
  const [providers, setProviders] = useState<AuthProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  const sessionRef = useRef<AuthSessionState | null>(null)
  const bufferRef = useRef(new Map<string, BufferedSession>())

  const commit = useCallback((next: AuthSessionState | null) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  const buffered = useCallback((sessionId: string): BufferedSession => {
    let entry = bufferRef.current.get(sessionId)
    if (!entry) {
      entry = { events: [] }
      bufferRef.current.set(sessionId, entry)
    }
    return entry
  }, [])

  useEffect(() => {
    const offPrompt = window.pibox.auth.onPrompt((request) => {
      const current = sessionRef.current
      if (current?.sessionId === request.sessionId) {
        commit({ ...current, prompt: { id: request.promptId, prompt: request.prompt } })
      } else {
        buffered(request.sessionId).prompt = { id: request.promptId, prompt: request.prompt }
      }
    })
    const offEvent = window.pibox.auth.onEvent((message) => {
      const current = sessionRef.current
      if (current?.sessionId === message.sessionId) {
        commit({ ...current, events: [...current.events, message.event] })
      } else {
        buffered(message.sessionId).events.push(message.event)
      }
    })
    const offDone = window.pibox.auth.onDone((result) => {
      const current = sessionRef.current
      if (current?.sessionId === result.sessionId) {
        commit({ ...current, prompt: null, phase: phaseOf(result), error: result.error })
      } else {
        buffered(result.sessionId).done = result
      }
    })
    const offStatus = window.pibox.auth.onStatus((next) => setStatus(next))

    window.pibox.auth.providers().then(setProviders).catch(() => undefined)
    window.pibox.auth
      .status()
      .then((next) => {
        setStatus(next)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))

    return () => {
      offPrompt()
      offEvent()
      offDone()
      offStatus()
    }
  }, [commit, buffered])

  const start = useCallback(
    async (providerId: string, method: AuthMethod) => {
      try {
        const { sessionId } = await window.pibox.auth.login(providerId, method)
        const entry = bufferRef.current.get(sessionId)
        bufferRef.current.delete(sessionId)
        const done = entry?.done
        commit({
          sessionId,
          providerId,
          method,
          prompt: entry?.prompt ?? null,
          events: entry?.events ?? [],
          phase: done ? phaseOf(done) : 'running',
          error: done?.error
        })
      } catch (error) {
        commit({
          sessionId: `local-${Date.now()}`,
          providerId,
          method,
          prompt: null,
          events: [],
          phase: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    },
    [commit]
  )

  const respond = useCallback(
    (value: string) => {
      const current = sessionRef.current
      if (!current?.prompt) return
      window.pibox.auth.respond({
        sessionId: current.sessionId,
        promptId: current.prompt.id,
        value
      })
      commit({ ...current, prompt: null })
    },
    [commit]
  )

  const cancel = useCallback(() => {
    const current = sessionRef.current
    if (current?.phase === 'running') window.pibox.auth.cancel(current.sessionId)
  }, [])

  const dismiss = useCallback(() => commit(null), [commit])

  const logout = useCallback(async (providerId: string) => {
    setStatus(await window.pibox.auth.logout(providerId))
  }, [])

  const statusFor = useCallback(
    (providerId: string) => status.find((entry) => entry.providerId === providerId),
    [status]
  )

  const providerName = useCallback(
    (providerId: string) => providers.find((entry) => entry.id === providerId)?.name ?? providerId,
    [providers]
  )

  return {
    session,
    status,
    loaded,
    providers,
    statusFor,
    providerName,
    start,
    respond,
    cancel,
    dismiss,
    logout
  }
}
