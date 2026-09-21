import type { AppState } from '@shared/types'
import {
  PiMark,
  PlusIcon,
  PanelIcon,
  RefreshIcon,
  GearIcon,
  ListIcon,
  MoonIcon,
  SpeakerIcon,
  SunIcon,
  UserIcon,
  CpuIcon
} from './icons'

export type AppView = 'chat' | 'terminal' | 'screen'

interface Props {
  state: AppState | null
  view: AppView
  onSetView: (view: AppView) => void
  sidebarVisible: boolean
  onToggleSidebar: () => void
  sessionsVisible: boolean
  onToggleSessions: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onRestart: () => void
  onToggleNetwork: () => void
  onOpenNetworkSettings: () => void
  hasCredentials: boolean
  onOpenProviders: () => void
  onOpenLocalModels: () => void
  audioEnabled: boolean
  audioAvailable: boolean
  onToggleAudio: () => void
}

export default function AppHeader({
  state,
  view,
  onSetView,
  sidebarVisible,
  onToggleSidebar,
  sessionsVisible,
  onToggleSessions,
  theme,
  onToggleTheme,
  onRestart,
  onToggleNetwork,
  onOpenNetworkSettings,
  hasCredentials,
  onOpenProviders,
  onOpenLocalModels,
  audioEnabled,
  audioAvailable,
  onToggleAudio
}: Props) {
  const newShell = (): void => {
    window.pibox.termInput('\x02c')
  }

  return (
    <header className="terminal-header">
      <div className="terminal-header-left">
        <button
          className="icon-btn"
          title={sidebarVisible ? 'Hide workspaces' : 'Show workspaces'}
          data-active={sidebarVisible ? 'true' : 'false'}
          onClick={onToggleSidebar}
        >
          <PanelIcon size={15} />
        </button>
        {view === 'chat' ? (
          <button
            className="icon-btn"
            title={sessionsVisible ? 'Hide sessions' : 'Show sessions'}
            data-active={sessionsVisible ? 'true' : 'false'}
            onClick={onToggleSessions}
          >
            <ListIcon size={15} />
          </button>
        ) : null}
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
          <button
            className="view-switch-btn"
            data-active={view === 'screen' ? 'true' : 'false'}
            onClick={() => onSetView('screen')}
          >
            Screen
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
        <button
          className="icon-btn"
          title={
            audioAvailable
              ? audioEnabled
                ? 'Mute VM audio'
                : 'Unmute VM audio'
              : 'VM audio unavailable'
          }
          data-active={audioEnabled && audioAvailable ? 'true' : 'false'}
          onClick={onToggleAudio}
        >
          <SpeakerIcon size={15} muted={!audioEnabled} />
        </button>
        <button
          className="icon-btn"
          title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          onClick={onToggleTheme}
        >
          {theme === 'light' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
        </button>
        <button className="icon-btn" title="Network settings" onClick={onOpenNetworkSettings}>
          <GearIcon size={14} />
        </button>
        <button
          className="icon-btn"
          title="Local models (WebGPU/CPU)"
          data-active={state?.localLlm?.enabled ? 'true' : 'false'}
          onClick={onOpenLocalModels}
        >
          <CpuIcon size={15} />
        </button>
        <button
          className="account-btn"
          data-connected={hasCredentials ? 'true' : 'false'}
          title={hasCredentials ? 'Providers' : 'Sign in to a provider'}
          onClick={onOpenProviders}
        >
          <UserIcon size={14} />
          {hasCredentials ? null : <span className="account-btn-label">Sign in</span>}
          <span className="account-dot" data-connected={hasCredentials ? 'true' : 'false'} />
        </button>
      </div>
      <span className="mount-label" title={state?.activeMountPath ?? undefined}>
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
