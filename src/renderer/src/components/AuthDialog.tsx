import { useEffect, useState } from 'react'
import type { AuthEvent } from '@shared/auth-types'
import type { AuthSessionState } from '../lib/useAuth'
import { CheckIcon, CloseIcon, CopyIcon, ExternalLinkIcon } from './icons'

interface Props {
  session: AuthSessionState | null
  providerName: (providerId: string) => string
  onRespond: (value: string) => void
  onCancel: () => void
  onDismiss: () => void
}

function lastOfType<T extends AuthEvent['type']>(
  events: AuthEvent[],
  type: T
): Extract<AuthEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === type) return events[index] as Extract<AuthEvent, { type: T }>
  }
  return undefined
}

/** Modal that drives a pi-ai login flow (prompts + progress + OAuth/device code). */
export default function AuthDialog({ session, providerName, onRespond, onCancel, onDismiss }: Props) {
  const [value, setValue] = useState('')
  const promptId = session?.prompt?.id ?? null

  useEffect(() => {
    setValue('')
  }, [promptId])

  if (!session) return null

  const name = providerName(session.providerId)
  const authUrl = lastOfType(session.events, 'auth_url')
  const device = lastOfType(session.events, 'device_code')
  const progress = lastOfType(session.events, 'progress')
  const info = lastOfType(session.events, 'info')
  const prompt = session.prompt?.prompt

  const openExternal = (url: string): void => window.pibox.openExternal(url)
  const copy = (text: string): void => void window.pibox.clipboardWriteText(text)

  return (
    <div className="ui-dialog-overlay">
      <div className="ui-dialog auth-dialog">
        {session.phase === 'success' ? (
          <>
            <div className="auth-dialog-icon success">
              <CheckIcon size={22} />
            </div>
            <div className="ui-dialog-title">Connected to {name}</div>
            <div className="ui-dialog-message">
              Credentials are saved for this workspace and new ones.
            </div>
            <div className="ui-dialog-actions">
              <button className="btn primary" onClick={onDismiss}>
                Done
              </button>
            </div>
          </>
        ) : session.phase === 'error' || session.phase === 'cancelled' ? (
          <>
            <div className="ui-dialog-title">
              {session.phase === 'cancelled' ? 'Sign-in cancelled' : `Could not connect to ${name}`}
            </div>
            {session.error ? <div className="auth-dialog-error">{session.error}</div> : null}
            <div className="ui-dialog-actions">
              <button className="btn primary" onClick={onDismiss}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="ui-dialog-title">
              Connecting to <span className="auth-dialog-provider">{name}</span>
            </div>

            {info && !authUrl && !device ? (
              <div className="ui-dialog-message">{info.message}</div>
            ) : null}

            {authUrl ? (
              <div className="auth-dialog-block">
                <div className="auth-dialog-block-text">
                  {authUrl.instructions ?? 'Authorize pi-box in your browser to continue.'}
                </div>
                <button className="btn primary" onClick={() => openExternal(authUrl.url)}>
                  <ExternalLinkIcon size={13} /> Open authorization page
                </button>
                <div className="auth-dialog-url mono">{authUrl.url}</div>
              </div>
            ) : null}

            {device ? (
              <div className="auth-dialog-block">
                <div className="auth-dialog-block-text">
                  Enter this code on the verification page:
                </div>
                <div className="auth-dialog-code">
                  <span className="mono">{device.userCode}</span>
                  <button className="btn small" onClick={() => copy(device.userCode)}>
                    <CopyIcon size={12} /> Copy
                  </button>
                </div>
                <button className="btn primary" onClick={() => openExternal(device.verificationUri)}>
                  <ExternalLinkIcon size={13} /> Open verification page
                </button>
              </div>
            ) : null}

            {prompt?.type === 'select' ? (
              <div className="auth-dialog-options">
                <div className="ui-dialog-message">{prompt.message}</div>
                {prompt.options.map((option) => (
                  <button key={option.id} className="btn auth-dialog-option" onClick={() => onRespond(option.id)}>
                    <span className="auth-dialog-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="auth-dialog-option-desc">{option.description}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}

            {prompt && prompt.type !== 'select' ? (
              <div className="auth-dialog-options">
                <div className="ui-dialog-message">{prompt.message}</div>
                <input
                  className="ui-dialog-input"
                  autoFocus
                  type={prompt.type === 'secret' ? 'password' : 'text'}
                  value={value}
                  placeholder={prompt.placeholder}
                  onChange={(event) => setValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRespond(value)
                    if (event.key === 'Escape') onCancel()
                  }}
                />
              </div>
            ) : null}

            {!prompt && progress ? <div className="auth-dialog-progress">{progress.message}</div> : null}
            {!prompt && !progress && (authUrl || device) ? (
              <div className="auth-dialog-progress">Waiting for authorization…</div>
            ) : null}

            <div className="ui-dialog-actions">
              <button className="btn" onClick={onCancel}>
                Cancel
              </button>
              {prompt && prompt.type !== 'select' ? (
                <button className="btn primary" onClick={() => onRespond(value)}>
                  {prompt.type === 'manual_code' ? 'Submit code' : 'Continue'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
