import type { VmStatus } from '@shared/types'
import { RefreshIcon } from './icons'

interface Props {
  status?: VmStatus
  message?: string
  onRestart?: () => void
}

export default function LoadingScreen({ status, message, onRestart }: Props) {
  const failed = status === 'error' || status === 'stopped'
  const label = failed ? (status === 'error' ? 'Startup failed' : 'Session ended') : (message ?? 'Starting pi-box…')

  return (
    <div className="loading-screen">
      <div className="loading-brand">
        <img className="loading-logo" src="./logo.png" alt="DeepClause" draggable={false} />
      </div>

      {!failed ? (
        <>
          <div className="loading-text">{label}</div>
          <div className="loading-dots">
            <span />
            <span />
            <span />
          </div>
        </>
      ) : (
        <>
          <div className="loading-text loading-text-error">{label}</div>
          {message && <div className="loading-subtext">{message}</div>}
          {onRestart && (
            <button className="restart-btn" onClick={onRestart}>
              <RefreshIcon size={14} />
              Restart
            </button>
          )}
        </>
      )}
    </div>
  )
}
