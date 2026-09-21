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

/** Settings for the optional local LLM provider that pi can use. */
export default function LocalModelsSettings({ onClose }: Props) {
  const [llm, setLlm] = useState<LocalLlmState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.pibox.localLlm
      .getState()
      .then((state) => mounted && setLlm(state))
      .catch(() => undefined)
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

  const engine = llm?.engine ?? 'wllama'
  const caps = llm?.capabilities
  const installed = llm?.models.filter((model) => model.installed) ?? []
  const downloadFor = (id: string): { received: number; total: number } | undefined =>
    llm?.downloads.find((entry) => entry.modelId === id)

  const gpuReady = !!caps?.webgpu && !!caps?.shaderF16

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal account-modal local-models-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">Local models</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </header>

        <p className="account-intro">
          Run a small model on this machine and let the pi agent use it as an OpenAI-compatible
          provider. Nothing is uploaded; weights are downloaded only when you ask.
        </p>

        <div className="account-scroll">
          {/* ---- provider ---- */}
          <section className="local-group">
            <div className="modal-section-title">Provider</div>
            <div className="local-item">
              <div className="local-item-main">
                <span className="local-item-title">Use in pi</span>
                <span className="local-item-desc">
                  Writes a <span className="mono">pi-box-local</span> provider to{' '}
                  <span className="mono">.pi/models.json</span> in the active workspace.
                </span>
              </div>
              <div className="local-item-actions">
                <button
                  className="btn small"
                  disabled={busy || installed.length === 0}
                  onClick={() => void run(() => window.pibox.localLlm.setEnabled(!llm?.enabled))}
                >
                  {llm?.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
            <div className="local-note">
              <span>
                <strong>Restart pi for changes to take effect.</strong> Open the{' '}
                <span className="mono">⋯</span> menu in Chat and click <strong>Reconnect</strong>,
                or{' '}
                <button
                  className="link-btn"
                  onClick={() => void window.pibox.rpc.reconnect().catch(() => undefined)}
                >
                  reconnect now
                </button>
                .
              </span>
            </div>
          </section>

          {/* ---- engine ---- */}
          <section className="local-group">
            <div className="modal-section-title">Engine</div>
            <div className="segmented" role="tablist">
              <button
                data-active={engine === 'wllama'}
                disabled={busy}
                onClick={() => void run(() => window.pibox.localLlm.setEngine('wllama'))}
              >
                Built-in (WebGPU/CPU)
              </button>
              <button
                data-active={engine === 'llama-server'}
                disabled={busy}
                onClick={() => void run(() => window.pibox.localLlm.setEngine('llama-server'))}
              >
                Native llama-server
              </button>
            </div>

            {engine === 'wllama' ? (
              <div className="local-item">
                <div className="local-item-main">
                  <span className="local-item-title">
                    {!caps ? 'Checking hardware…' : gpuReady ? 'WebGPU (GPU)' : 'CPU only'}
                  </span>
                  <span className="local-item-desc">
                    {!caps
                      ? 'Probing the GPU…'
                      : gpuReady
                        ? `${caps.adapter?.description || caps.adapter?.vendor || 'GPU'}${caps.adapter?.architecture ? ` (${caps.adapter.architecture})` : ''} · shader-f16`
                        : caps.webgpu
                          ? `A GPU was found (${caps.adapter?.vendor || 'unknown'}), but llama.cpp's WebGPU backend needs the shader-f16 feature, which it lacks — inference runs on the CPU.`
                          : 'WebGPU was not detected — inference runs on the CPU.'}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="local-item">
                  <div className="local-item-main">
                    <span className="local-item-title">llama-server binary</span>
                    <span className="local-item-desc local-path">
                      {llm?.llamaServerPath || 'Not configured — point at a llama-server build'}
                    </span>
                  </div>
                  <div className="local-item-actions">
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => void run(() => window.pibox.localLlm.detectLlamaServer())}
                    >
                      Detect
                    </button>
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => void run(() => window.pibox.localLlm.pickLlamaServer())}
                    >
                      Browse…
                    </button>
                  </div>
                </div>
                <div className="local-item">
                  <div className="local-item-main">
                    <span className="local-item-title">
                      {llm?.llamaServerRunning ? 'Running' : 'Stopped'}
                      {llm?.llamaServerVersion ? ` · ${llm.llamaServerVersion}` : ''}
                    </span>
                    <span className="local-item-desc">
                      {llm?.llamaServerRunning
                        ? `127.0.0.1:${llm.llamaServerPort} (pi → 192.168.127.1:${llm.llamaServerPort})`
                        : 'Start it by enabling the provider with a model selected.'}
                    </span>
                  </div>
                  <div className="local-item-actions">
                    <button
                      className="icon-btn"
                      title="Restart llama-server"
                      disabled={busy || !llm?.llamaServerPath}
                      onClick={() => void run(() => window.pibox.localLlm.restartLlamaServer())}
                    >
                      <RefreshIcon size={14} />
                    </button>
                    {llm?.llamaServerLog ? (
                      <button className="btn ghost small" onClick={() => setShowLog((v) => !v)}>
                        {showLog ? 'Hide log' : 'Log'}
                      </button>
                    ) : null}
                  </div>
                </div>
                {showLog && llm?.llamaServerLog ? (
                  <pre className="local-log">{llm.llamaServerLog}</pre>
                ) : null}
                <div className="local-note">
                  <span>
                    Native inference gives GPU acceleration on GPUs WebGPU cannot use, and tool
                    calling via the model's chat template. Get a build from the{' '}
                    <button
                      className="link-btn"
                      onClick={() =>
                        window.pibox.openExternal('https://github.com/ggml-org/llama.cpp/releases')
                      }
                    >
                      llama.cpp releases
                    </button>{' '}
                    and select the <span className="mono">llama-server</span> binary.
                  </span>
                </div>
              </>
            )}
          </section>

          {/* ---- installed ---- */}
          <section className="local-group">
            <div className="modal-section-title">Installed</div>
            {installed.length === 0 ? (
              <div className="settings-empty">No models installed yet.</div>
            ) : (
              installed.map((model) => (
                <div className="local-item" key={model.id}>
                  <div className="local-item-main">
                    <span className="local-item-title">{model.name}</span>
                    <span className="local-item-desc">
                      {model.quant} · {formatBytes(model.bytes)}
                      {engine === 'llama-server' ? '' : ` · ctx ${model.defaultContext}`}
                    </span>
                  </div>
                  <div className="local-item-actions">
                    <button
                      className="btn ghost small"
                      disabled={busy || llm?.activeModelId === model.id}
                      onClick={() => void run(() => window.pibox.localLlm.setActiveModel(model.id))}
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
              ))
            )}
          </section>

          {/* ---- catalog ---- */}
          <section className="local-group">
            <div className="modal-section-title">Download</div>
            {llm?.catalog.map((entry: LocalModelCatalogEntry) => {
              const info = llm.models.find((model) => model.id === entry.id)
              const progress = downloadFor(entry.id)
              const percent = progress
                ? Math.min(100, Math.round((progress.received / Math.max(1, progress.total)) * 100))
                : 0
              return (
                <div className="local-item" key={entry.id}>
                  <div className="local-item-main">
                    <span className="local-item-title">{entry.name}</span>
                    <span className="local-item-desc">
                      {entry.quant} · {formatBytes(entry.approxBytes)} · ~
                      {Math.round((entry.minVramMb / 1024) * 10) / 10} GB VRAM
                      {entry.note ? ` · ${entry.note}` : ''}
                    </span>
                    {progress ? (
                      <div className="local-progress" title={`${percent}%`}>
                        <div className="local-progress-bar" style={{ width: `${percent}%` }} />
                      </div>
                    ) : null}
                  </div>
                  <div className="local-item-actions">
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
                </div>
              )
            })}
          </section>

          {/* ---- advanced ---- */}
          <section className="local-group">
            <div className="modal-section-title">Advanced</div>
            <div className="local-item">
              <div className="local-item-main">
                <span className="local-item-title">Context size (n_ctx)</span>
                <span className="local-item-desc">Bigger uses more memory. Applied on next load.</span>
              </div>
              <div className="local-item-actions">
                <input
                  className="local-input"
                  type="number"
                  min={512}
                  max={32768}
                  step={512}
                  key={llm?.activeModelId ?? 'none'}
                  defaultValue={llm?.nCtx ?? 8192}
                  onBlur={(event) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value)) void run(() => window.pibox.localLlm.setNctx(value))
                  }}
                />
              </div>
            </div>
            <div className="local-item">
              <div className="local-item-main">
                <span className="local-item-title">GPU layers</span>
                <span className="local-item-desc">
                  {engine === 'llama-server'
                    ? 'Offload all layers to the GPU, or run on the CPU.'
                    : 'Offload to WebGPU when available, or run on the CPU.'}
                </span>
              </div>
              <div className="local-item-actions">
                <select
                  className="local-input"
                  value={String(llm?.nGpuLayers ?? -1)}
                  onChange={(event) =>
                    void run(() => window.pibox.localLlm.setGpuLayers(Number(event.target.value)))
                  }
                >
                  <option value="-1">All (GPU)</option>
                  <option value="0">CPU only</option>
                </select>
              </div>
            </div>
            <div className="local-item">
              <div className="local-item-main">
                <span className="local-item-title">Models folder</span>
                <span className="local-item-desc local-path">{llm?.modelsDir || '—'}</span>
              </div>
              <div className="local-item-actions">
                <button
                  className="btn ghost small"
                  onClick={() => void window.pibox.localLlm.openModelsDir()}
                >
                  Open
                </button>
              </div>
            </div>
          </section>

          {error || llm?.lastError ? <p className="local-error">{error || llm?.lastError}</p> : null}
        </div>
      </div>
    </div>
  )
}
