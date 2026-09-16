import { useCallback, useEffect, useState } from 'react'
import type { AuthMethod, AuthProviderInfo, AuthStatus } from '@shared/auth-types'
import type { RpcModelInfo } from '@shared/rpc-types'
import ProviderList from './ProviderList'
import { CheckIcon, PiMark } from './icons'

interface Props {
  providers: AuthProviderInfo[]
  status: AuthStatus[]
  statusFor: (providerId: string) => AuthStatus | undefined
  onLogin: (providerId: string, method: AuthMethod) => void
  vmReady: boolean
  onComplete: () => void
}

type Step = 'welcome' | 'connect' | 'model'

/**
 * First-run setup: welcome → connect a provider → pick a default model. Shown
 * once (or until skipped); the choices are persisted to `.pi/settings.json`.
 */
export default function Onboarding({ providers, status, statusFor, onLogin, vmReady, onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [models, setModels] = useState<RpcModelInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const connected = status.length > 0

  const loadModels = useCallback(async () => {
    if (!vmReady) return
    try {
      setModels(await window.pibox.rpc.getAvailableModels())
    } catch {
      setModels([])
    }
  }, [vmReady])

  useEffect(() => {
    if (step === 'model') void loadModels()
  }, [step, loadModels])

  const finish = useCallback(async () => {
    setSaving(true)
    try {
      if (selected) {
        const slash = selected.indexOf('/')
        if (slash > 0) {
          await window.pibox.rpc.setModel(selected.slice(0, slash), selected.slice(slash + 1))
        }
      }
    } catch {
      // Non-fatal: the user can pick a model later.
    } finally {
      setSaving(false)
      onComplete()
    }
  }, [selected, onComplete])

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        {step === 'welcome' ? (
          <div className="onboarding-step">
            <div className="onboarding-mark">
              <PiMark size={30} />
            </div>
            <h1 className="onboarding-title">Welcome to pi-box</h1>
            <p className="onboarding-text">
              pi runs inside an isolated VM with your workspace mounted. Connect a provider to give
              it a model, then start chatting, running tools, and using the terminal.
            </p>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={onComplete}>
                Skip setup
              </button>
              <button className="btn primary" onClick={() => setStep('connect')}>
                Get started
              </button>
            </div>
          </div>
        ) : null}

        {step === 'connect' ? (
          <div className="onboarding-step wide">
            <h1 className="onboarding-title">Connect a provider</h1>
            <p className="onboarding-text">
              Sign in with a subscription, or paste an API key. You can add more later in Settings.
            </p>
            <div className="onboarding-providers">
              <ProviderList
                providers={providers}
                statusFor={statusFor}
                onLogin={onLogin}
                searchable
                compact
              />
            </div>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep('welcome')}>
                Back
              </button>
              <button className="btn primary" onClick={() => setStep('model')}>
                {connected ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          </div>
        ) : null}

        {step === 'model' ? (
          <div className="onboarding-step wide">
            <h1 className="onboarding-title">Choose a model</h1>
            <p className="onboarding-text">
              {connected
                ? 'This becomes the default model for new sessions.'
                : 'No provider is connected yet — you can pick a model later.'}
            </p>
            <div className="onboarding-models">
              {models.length === 0 ? (
                <div className="settings-empty">
                  {vmReady ? 'No models are available yet.' : 'Waiting for the VM…'}
                </div>
              ) : (
                models.map((model) => {
                  const id = `${model.provider}/${model.id}`
                  return (
                    <button
                      key={id}
                      className="onboarding-model"
                      data-active={selected === id ? 'true' : 'false'}
                      onClick={() => setSelected(id)}
                    >
                      <span className="onboarding-model-name">{model.name ?? model.id}</span>
                      <span className="onboarding-model-provider">{model.provider}</span>
                      {selected === id ? (
                        <span className="onboarding-model-check">
                          <CheckIcon size={14} />
                        </span>
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep('connect')}>
                Back
              </button>
              <button className="btn primary" onClick={() => void finish()} disabled={saving}>
                {saving ? 'Saving…' : 'Start chatting'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
