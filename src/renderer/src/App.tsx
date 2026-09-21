import { useCallback, useEffect, useState } from 'react'
import type { AppState, FirewallRule } from '@shared/types'
import LoadingScreen from './components/LoadingScreen'
import NetworkSettings from './components/NetworkSettings'
import WorkspaceSidebar from './components/WorkspaceSidebar'
import TerminalView from './components/TerminalView'
import FramebufferView from './components/FramebufferView'
import ChatView from './components/ChatView'
import AppHeader, { type AppView } from './components/AppHeader'
import AuthDialog from './components/AuthDialog'
import ProvidersSettings from './components/ProvidersSettings'
import LocalModelsSettings from './components/LocalModelsSettings'
import Onboarding from './components/Onboarding'
import { useAuth } from './lib/useAuth'
import { useGuestAudio } from './lib/useGuestAudio'

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  // Always land on the chat; the terminal is one click away. (The view is
  // intentionally not persisted — the chat is the primary interface.)
  const [view, setView] = useState<AppView>('chat')
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pibox.sidebar') !== 'hidden'
    } catch {
      return true
    }
  })
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('pibox.theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  const [sessionsVisible, setSessionsVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pibox.sessions') !== 'hidden'
    } catch {
      return true
    }
  })
  const [networkOpen, setNetworkOpen] = useState(false)
  const [providersOpen, setProvidersOpen] = useState(false)
  const [localModelsOpen, setLocalModelsOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const auth = useAuth()
  // Plays the guest's virtio-snd PCM (audio from games and other guest apps).
  const guestAudio = useGuestAudio()

  useEffect(() => {
    let mounted = true

    const unsubscribe = window.pibox.onState((next) => {
      if (mounted) setState(next)
    })

    window.pibox
      .getState()
      .then((initial) => {
        if (mounted) setState(initial)
      })
      .catch((err) => console.error('Failed to load initial state', err))

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const addWorkspace = useCallback(() => {
    window.pibox.addWorkspace().catch((err) => console.error(err))
  }, [])

  const removeWorkspace = useCallback((id: string) => {
    window.pibox.removeWorkspace(id).catch((err) => console.error(err))
  }, [])

  const setActiveWorkspace = useCallback((id: string) => {
    window.pibox.setActiveWorkspace(id).catch((err) => console.error(err))
  }, [])

  const openFolder = useCallback((id: string) => {
    window.pibox.openFolder(id).catch((err) => console.error(err))
  }, [])

  const restart = useCallback(() => {
    window.pibox.restart().catch((err) => console.error(err))
  }, [])

  const toggleNetwork = useCallback(() => {
    window.pibox.toggleNetwork().catch((err) => console.error(err))
  }, [])

  const addPortForward = useCallback((hostPort: number, guestPort: number) => {
    window.pibox.addPortForward({ hostPort, guestPort }).catch((err) => console.error(err))
  }, [])

  const removePortForward = useCallback((hostPort: number) => {
    window.pibox.removePortForward(hostPort).catch((err) => console.error(err))
  }, [])

  const addFirewallRule = useCallback((rule: FirewallRule) => {
    window.pibox.addFirewallRule(rule).catch((err) => console.error(err))
  }, [])

  const removeFirewallRule = useCallback((id: string) => {
    window.pibox.removeFirewallRule(id).catch((err) => console.error(err))
  }, [])

  const clearFirewall = useCallback(() => {
    window.pibox.clearFirewall().catch((err) => console.error(err))
  }, [])

  const setActiveView = useCallback((next: AppView) => {
    setView(next)
  }, [])

  const openProviders = useCallback(() => setProvidersOpen(true), [])
  const openLocalModels = useCallback(() => setLocalModelsOpen(true), [])

  const completeOnboarding = useCallback(() => {
    setOnboardingDismissed(true)
    setSetupOpen(false)
    window.pibox.setOnboardingDone(true).catch((err) => console.error(err))
  }, [])

  const openSetup = useCallback(() => {
    setProvidersOpen(false)
    setSetupOpen(true)
  }, [])

  const openTerminal = useCallback(() => setActiveView('terminal'), [setActiveView])

  // Open a file in vi inside a new tmux window, then reveal the terminal so the
  // user actually sees it.
  const editFile = useCallback(
    (workspaceId: string, hostPath: string) => {
      window.pibox.editFile(workspaceId, hostPath).catch((err) => console.error(err))
      setActiveView('terminal')
    },
    [setActiveView]
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('pibox.theme', theme)
    } catch {
      // ignore storage errors
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((value) => (value === 'light' ? 'dark' : 'light'))
  }, [])

  const toggleSessions = useCallback(() => {
    setSessionsVisible((prev) => {
      const next = !prev
      try {
        localStorage.setItem('pibox.sessions', next ? 'visible' : 'hidden')
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => {
      const next = !prev
      try {
        localStorage.setItem('pibox.sidebar', next ? 'visible' : 'hidden')
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  const ready = state?.status === 'ready'
  const hasCredentials = auth.status.length > 0
  const showOnboarding =
    setupOpen ||
    (!onboardingDismissed &&
      auth.loaded &&
      !!state &&
      state.status === 'ready' &&
      !state.onboardingDone &&
      !hasCredentials)

  // Anyone who already has credentials has effectively completed setup.
  useEffect(() => {
    if (hasCredentials && state && !state.onboardingDone) {
      window.pibox.setOnboardingDone(true).catch((err) => console.error(err))
    }
  }, [hasCredentials, state])

  return (
    <div className="app">
      <div className="main-layout">
        <WorkspaceSidebar
          state={state}
          visible={sidebarVisible}
          onAdd={addWorkspace}
          onRemove={removeWorkspace}
          onSelect={setActiveWorkspace}
          onOpenFolder={openFolder}
          onEditFile={editFile}
        />
        <section className="workspace-pane">
          <AppHeader
            state={state}
            view={view}
            onSetView={setActiveView}
            sidebarVisible={sidebarVisible}
            onToggleSidebar={toggleSidebar}
            sessionsVisible={sessionsVisible}
            onToggleSessions={toggleSessions}
            theme={theme}
            onToggleTheme={toggleTheme}
            onRestart={restart}
            onToggleNetwork={toggleNetwork}
            onOpenNetworkSettings={() => setNetworkOpen(true)}
            hasCredentials={hasCredentials}
            onOpenProviders={openProviders}
            onOpenLocalModels={openLocalModels}
            audioEnabled={guestAudio.enabled}
            audioAvailable={guestAudio.available}
            onToggleAudio={guestAudio.toggle}
          />
          {/* All views stay mounted so the terminal keeps receiving console
              output (and its scrollback) and the screen keeps its framebuffer
              while another view is on top. */}
          <div className="view-container">
            <div className="view-slot" data-hidden={view !== 'chat'}>
              <ChatView
                state={state}
                sessionsVisible={sessionsVisible}
                onOpenTerminal={openTerminal}
                onOpenProviders={openProviders}
              />
            </div>
            <div className="view-slot" data-hidden={view !== 'terminal'}>
              <TerminalView state={state} theme={theme} visible={view === 'terminal'} />
            </div>
            <div className="view-slot" data-hidden={view !== 'screen'}>
              <FramebufferView state={state} visible={view === 'screen'} />
            </div>
          </div>
        </section>
      </div>

      {!ready && <LoadingScreen status={state?.status} message={state?.statusMessage} onRestart={restart} />}

      {showOnboarding ? (
        <Onboarding
          providers={auth.providers}
          status={auth.status}
          statusFor={auth.statusFor}
          onLogin={auth.start}
          vmReady={ready}
          onComplete={completeOnboarding}
        />
      ) : null}

      {providersOpen ? (
        <ProvidersSettings
          providers={auth.providers}
          status={auth.status}
          statusFor={auth.statusFor}
          onLogin={auth.start}
          onLogout={(providerId) => void auth.logout(providerId)}
          onRerunSetup={openSetup}
          onClose={() => setProvidersOpen(false)}
        />
      ) : null}

      {localModelsOpen ? <LocalModelsSettings onClose={() => setLocalModelsOpen(false)} /> : null}

      <AuthDialog
        session={auth.session}
        providerName={auth.providerName}
        onRespond={auth.respond}
        onCancel={auth.cancel}
        onDismiss={auth.dismiss}
      />

      {networkOpen && (
        <NetworkSettings
          state={state}
          onClose={() => setNetworkOpen(false)}
          onToggleNetwork={toggleNetwork}
          onAddPortForward={addPortForward}
          onRemovePortForward={removePortForward}
          onAddFirewallRule={addFirewallRule}
          onRemoveFirewallRule={removeFirewallRule}
          onClearFirewall={clearFirewall}
        />
      )}
    </div>
  )
}
