import { useState } from 'react'
import type { AppState, FirewallRule } from '@shared/types'
import { CloseIcon } from './icons'

interface Props {
  state: AppState | null
  onClose: () => void
  onToggleNetwork: () => void
  onAddPortForward: (hostPort: number, guestPort: number) => void
  onRemovePortForward: (hostPort: number) => void
  onAddFirewallRule: (rule: FirewallRule) => void
  onRemoveFirewallRule: (id: string) => void
  onClearFirewall: () => void
}

export default function NetworkSettings({
  state,
  onClose,
  onToggleNetwork,
  onAddPortForward,
  onRemovePortForward,
  onAddFirewallRule,
  onRemoveFirewallRule,
  onClearFirewall
}: Props) {
  const [hostPort, setHostPort] = useState('')
  const [guestPort, setGuestPort] = useState('')
  const [fwRemote, setFwRemote] = useState('')
  const [fwPort, setFwPort] = useState('')
  const [fwProtocol, setFwProtocol] = useState<'tcp' | 'udp'>('tcp')
  const [fwAction, setFwAction] = useState<'allow' | 'deny'>('deny')

  const addForward = (): void => {
    const h = Number(hostPort)
    const g = Number(guestPort)
    if (h > 0 && g > 0) {
      onAddPortForward(h, g)
      setHostPort('')
      setGuestPort('')
    }
  }

  const addRule = (): void => {
    const remote = fwRemote.trim()
    if (!remote) return
    onAddFirewallRule({
      id: `fw-${Date.now()}`,
      direction: 'out',
      protocol: fwProtocol,
      remote,
      port: fwPort.trim() || '*',
      action: fwAction
    })
    setFwRemote('')
    setFwPort('')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">Network settings</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </header>

        <section className="modal-section">
          <div className="modal-section-title">Status</div>
          <button className="switch-row" onClick={onToggleNetwork}>
            <span className="switch-row-label">Guest networking</span>
            <span className={`switch ${state?.networkEnabled ? 'on' : ''}`}>
              <span className="switch-knob" />
            </span>
            <span className="switch-state">{state?.networkEnabled ? 'online' : 'offline'}</span>
          </button>
        </section>

        <section className="modal-section">
          <div className="modal-section-title">Port forwarding</div>
          <div className="settings-list">
            {state?.portForwards.map((pf) => (
              <div key={pf.hostPort} className="settings-row">
                <span className="settings-row-text">
                  <span className="mono">127.0.0.1:{pf.hostPort}</span> → <span className="mono">:{pf.guestPort}</span>
                </span>
                <button className="icon-btn danger" title="Remove forward" onClick={() => onRemovePortForward(pf.hostPort)}>
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
            {(!state || state.portForwards.length === 0) && (
              <div className="settings-empty">No port forwards</div>
            )}
          </div>
          <div className="form-row">
            <input className="field" placeholder="Host port" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
            <input className="field" placeholder="Guest port" value={guestPort} onChange={(e) => setGuestPort(e.target.value)} />
            <button className="btn primary" onClick={addForward}>Add</button>
          </div>
        </section>

        <section className="modal-section">
          <div className="modal-section-title">Firewall rules</div>
          <div className="settings-list">
            {state?.firewallRules.map((rule) => (
              <div key={rule.id} className="settings-row">
                <span className="settings-row-text">
                  <span className={`badge ${rule.action}`}>{rule.action}</span>{' '}
                  {rule.direction} {rule.protocol}{' '}
                  <span className="mono">{rule.remote}:{rule.port}</span>
                </span>
                <button className="icon-btn danger" title="Remove rule" onClick={() => onRemoveFirewallRule(rule.id)}>
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
            {(!state || state.firewallRules.length === 0) && (
              <div className="settings-empty">No rules — all traffic allowed</div>
            )}
          </div>
          <div className="form-row">
            <input className="field grow" placeholder="Host / IP / CIDR" value={fwRemote} onChange={(e) => setFwRemote(e.target.value)} />
            <input className="field port" placeholder="Port" value={fwPort} onChange={(e) => setFwPort(e.target.value)} />
            <select className="field auto" value={fwProtocol} onChange={(e) => setFwProtocol(e.target.value as 'tcp' | 'udp')}>
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
            <select className="field auto" value={fwAction} onChange={(e) => setFwAction(e.target.value as 'allow' | 'deny')}>
              <option value="deny">deny</option>
              <option value="allow">allow</option>
            </select>
            <button className="btn primary" onClick={addRule}>Add</button>
          </div>
          <button className="btn" onClick={onClearFirewall}>Clear all rules</button>
        </section>
      </div>
    </div>
  )
}
