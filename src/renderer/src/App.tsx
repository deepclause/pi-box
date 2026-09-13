import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '@shared/types'
import LoadingScreen from './components/LoadingScreen'
import WorkspaceSidebar from './components/WorkspaceSidebar'
import TerminalView from './components/TerminalView'

export default function App() {
  const [state, setState] = useState<AppState | null>(null)

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

  const ready = state?.status === 'ready'

  return (
    <div className="app">
      <div className="main-layout">
        <WorkspaceSidebar
          state={state}
          onAdd={addWorkspace}
          onRemove={removeWorkspace}
          onSelect={setActiveWorkspace}
          onOpenFolder={openFolder}
        />
        <TerminalView state={state} />
      </div>

      {!ready && <LoadingScreen status={state?.status} message={state?.statusMessage} onRestart={restart} />}
    </div>
  )
}
