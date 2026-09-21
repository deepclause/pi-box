import { useCallback, useEffect, useState } from 'react'
import type { LocalLlmState, LocalModelCatalogEntry } from '@shared/local-llm-types'
import { CloseIcon, RefreshIcon } from './icons'

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const mb = bytes / 1e6
  if (mb < 1000) return `${Math.round(mb)} MB`
  return `${(mb / 1000).toFixed(2)} GB`
}

interface Props {
  onClose: () => void
}

/**
 * Settings panel for the optional local (WebGPU/CPU) LLM provider that pi can
 * use as an OpenAI-compatible model.
 */
export default function LocalModelsSettings({ onClose }: Props) {
  const [llm, setLlm] = useState<LocalLlmState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void window.pibox.localLlm
      .getState()
      .then((state) => mounted && setLlm(state))
      .catch(() => undefined)
    // Probing capabilities lazily creates the hidden host window.
    void window.pibox.localLlm
      .getCapabilities()
      .then((state) => mounted && setLlm(state))
      .catch(() => undefined)
    const unsubscribe = window.pibox.localLlm.onState((state) => {
      if (mounted) setLlm(state)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const run = useCallback(async (action: () => Promise<LocalLlmState>) => {
    setBusy(true)
    setError(null)
    try {
      setLlm(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const caps = llm?.capabilities
  const installed = llm?.models.filter((model) => model.installed) ?? []
  const downloadFor = (id: string): { received: number; total: number } | undefined =>
    llm?.downloads.find((entry) => entry.modelId === id)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal account-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">Local models</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </header>

        <p className="account-intro">
          Run a small model on this machine (WebGPU, or CPU as a fallback) and let the pi agent
          use it as an OpenAI-compatible provider. Nothing is uploaded; weights are downloaded
          only when you ask. Requires the VM network to be enabled.
        </p>

        <div className="account-scroll">
          <section className="modal-section">
            <div className="modal-section-title">Hardware</div>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-text">
                  <strong>
                    {!caps
                      ? 'Checking…'
                      : caps.webgpu && caps.shaderF16
                        ? 'WebGPU (GPU)'
                        : 'CPU only'}
                  </strong>
                  <span>
                    {!caps
                      ? 'Probing the GPU…'
                      : caps.webgpu && caps.shaderF16
                        ? `${caps.adapter?.description || caps.adapter?.vendor || 'GPU'}${caps.adapter?.architecture ? ` (${caps.adapter.architecture})` : ''} · f16`
                        : caps.webgpu
                          ? `A GPU was found (${caps.adapter?.vendor || 'unknown'}), but it lacks the shader-f16 feature that llama.cpp’s WebGPU backend requires, so inference runs on the CPU (slow).`
                          : 'WebGPU was not detected; inference runs on the CPU (slow).'}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="modal-section">
            <div className="modal-section-title">pi integration</div>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-text">
                  <strong>Use local model in pi</strong>
                  <span>
                    Writes a <span className="mono">pi-box-local</span> provider to this workspace’s{' '}
                    <span className="mono">.pi/models.json</span>. Select it in pi’s model picker.
                  </span>
                </div>
                <button
                  className="btn small"
                  disabled={busy || installed.length === 0}
                  onClick={() =>
                    void run(() => window.pibox.localLlm.setEnabled(!llm?.enabled))
                  }
                >
                  {llm?.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <strong>Server</strong>
                  <span>
                    {llm?.serverRunning
                      ? `listening on 127.0.0.1:${llm.port} (pi → 192.168.127.1:${llm.port})`
                      : 'not running'}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  title="Refresh"
                  disabled={busy}
                  onClick={() => void run(() => window.pibox.localLlm.refresh())}
                >
                  <RefreshIcon size={14} />
                </button>
              </div>
            </div>
          </section>

          <section className="modal-section">
            <div className="modal-section-title">Installed</div>
            {installed.length === 0 ? (
              <div className="settings-empty">No models installed yet. Download one below.</div>
            ) : (
              <div className="settings-list">
                {installed.map((model) => (
                  <div className="settings-row" key={model.id}>
                    <div className="settings-row-text">
                      <strong>{model.name}</strong>
                      <span>
                        {model.quant} · {formatBytes(model.bytes)} · ctx {llm?.activeModelId === model.id ? 'selected' : `${model.defaultContext}`}
                      </span>
                    </div>
                    <div className="local-model-actions">
                      <button
                        className="btn ghost small"
                        disabled={busy || llm?.activeModelId === model.id}
                        onClick={() =>
                          void run(() => window.pibox.localLlm.setActiveModel(model.id))
                        }
                      >
                        {llm?.activeModelId === model.id ? 'Active' : 'Use'}
                      </button>
                      <button
                        className="btn ghost small"
                        disabled={busy}
                        onClick={() => void run(() => window.pibox.localLlm.remove(model.id))}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="modal-section">
            <div className="modal-section-title">Catalog</div>
            <div className="settings-list">
              {llm?.catalog.map((entry: LocalModelCatalogEntry) => {
                const info = llm.models.find((model) => model.id === entry.id)
                const progress = downloadFor(entry.id)
                const percent = progress ? Math.min(100, Math.round((progress.received / Math.max(1, progress.total)) * 100)) : 0
                return (
                  <div className="settings-row" key={entry.id}>
                    <div className="settings-row-text">
                      <strong>{entry.name}</strong>
                      <span>
                        {entry.quant} · {formatBytes(entry.approxBytes)} · ~{Math.round(entry.minVramMb / 1024 * 10) / 10} GB VRAM
                        {entry.note ? ` · ${entry.note}` : ''}
                      </span>
                      {progress ? (
                        <div className="local-progress" title={`${percent}%`}>
                          <div className="local-progress-bar" style={{ width: `${percent}%` }} />
                        </div>
                      ) : null}
                    </div>
                    {info?.installed ? (
                      <span className="local-badge">installed</span>
                    ) : progress ? (
                      <button
                        className="btn ghost small"
                        onClick={() => void run(() => window.pibox.localLlm.cancelDownload(entry.id))}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        className="btn ghost small"
                        disabled={busy}
                        onClick={() => void run(() => window.pibox.localLlm.download(entry.id))}
                      >
                        Download
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <section className="modal-section">
            <div className="modal-section-title">Advanced</div>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-text">
                  <strong>Context size (n_ctx)</strong>
                  <span>Bigger uses more memory. Applied on the next model load.</span>
                </div>
                <input
                  className="local-input"
                  type="number"
                  min={512}
                  max={32768}
                  step={512}
                  defaultValue={llm?.models.find((m) => m.id === llm.activeModelId)?.defaultContext ?? 8192}
                  onBlur={(event) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value)) void run(() => window.pibox.localLlm.setNctx(value))
                  }}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <strong>GPU layers</strong>
                  <span>Offload all layers when WebGPU is available, or run on the CPU.</span>
                </div>
                <select
                  className="local-input"
                  defaultValue="-1"
                  onChange={(event) =>
                    void run(() => window.pibox.localLlm.setGpuLayers(Number(event.target.value)))
                  }
                >
                  <option value="-1">All (GPU)</option>
                  <option value="0">CPU only</option>
                </select>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <strong>Models folder</strong>
                  <span className="mono">{llm?.modelsDir || '—'}</span>
                </div>
                <button
                  className="btn ghost small"
                  onClick={() => void window.pibox.localLlm.openModelsDir()}
                >
                  Open
                </button>
              </div>
            </div>
          </section>

          {error || llm?.lastError ? (
            <p className="local-error">{error || llm?.lastError}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
