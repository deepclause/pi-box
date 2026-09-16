import type { AppState } from '@shared/types'
import { PiMark, PlusIcon, PanelIcon, RefreshIcon, GearIcon } from './icons'

export type AppView = 'chat' | 'terminal'

interface Props {
  state: AppState | null
  view: AppView
  onSetView: (view: AppView) => void
  sidebarVisible: boolean
  onToggleSidebar: () => void
  onRestart: () => void
  onToggleNetwork: () => void
  onOpenNetworkSettings: () => void
}

export default function AppHeader({
  state,
  view,
  onSetView,
  sidebarVisible,
  onToggleSidebar,
  onRestart,
  onToggleNetwork,
  onOpenNetworkSettings
}: Props) {
  const newShell = (): void => {
    window.pibox.termInput('\x02c')
  }

  return (
    <header className="terminal-header">
      <div className="terminal-header-left">
        <button
          className="icon-btn"
          title={sidebarVisible ? 'Hide workspaces bar' : 'Show workspaces bar'}
          onClick={onToggleSidebar}
        >
          <PanelIcon size={15} />
        </button>
        <PiMark size={16} className="pi-mark" />
        <span className="terminal-title">pi-box</span>
        <div className="view-switch" role="tablist" aria-label="View">
          <button
            className="view-switch-btn"
            data-active={view === 'chat' ? 'true' : 'false'}
            onClick={() => onSetView('chat')}
          >
            Chat
          </button>
          <button
            className="view-switch-btn"
            data-active={view === 'terminal' ? 'true' : 'false'}
            onClick={() => onSetView('terminal')}
          >
            Terminal
          </button>
        </div>
        <span className="status-pill" data-status={state?.status ?? 'loading'}>
          <span className="status-dot" data-status={state?.status ?? 'loading'} />
          {state?.status === 'ready'
            ? 'ready'
            : state?.status === 'error'
              ? 'error'
              : state?.status === 'stopped'
                ? 'stopped'
                : 'starting'}
        </span>
        <button
          className="network-btn"
          data-up={state?.networkEnabled ? 'true' : 'false'}
          title={state?.networkEnabled ? 'Network is up — click to disable' : 'Network is down — click to enable'}
          onClick={onToggleNetwork}
          disabled={state?.status !== 'ready'}
        >
          <span className="network-dot" data-up={state?.networkEnabled ? 'true' : 'false'} />
          {state?.networkEnabled ? 'online' : 'offline'}
        </button>
        <button className="icon-btn" title="Network settings" onClick={onOpenNetworkSettings}>
          <GearIcon size={14} />
        </button>
      </div>
      <span className="mount-label" title={state?.activeMountPath ?? undefined}>
        <button
          className="icon-btn"
          title="Open the pi TUI in a terminal window"
          onClick={() => window.pibox.startPiTui()}
          disabled={state?.status !== 'ready'}
        >
          <PiMark size={14} />
        </button>
        <button className="icon-btn accent" title="New shell window (Ctrl+B c)" onClick={newShell}>
          <PlusIcon size={14} />
        </button>
        <button className="icon-btn" title="Restart VM" onClick={onRestart}>
          <RefreshIcon size={14} />
        </button>
        {state?.activeMountPath ?? 'no workspace'}
        <span className="mount-arrow">→</span>
        <span className="mount-point">{state?.mountPoint ?? '/workspace'}</span>
      </span>
    </header>
  )
}
