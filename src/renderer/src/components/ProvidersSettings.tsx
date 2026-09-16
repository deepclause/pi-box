import type { AuthMethod, AuthProviderInfo, AuthStatus } from '@shared/auth-types'
import ProviderList from './ProviderList'
import { CloseIcon } from './icons'

interface Props {
  providers: AuthProviderInfo[]
  status: AuthStatus[]
  statusFor: (providerId: string) => AuthStatus | undefined
  onLogin: (providerId: string, method: AuthMethod) => void
  onLogout: (providerId: string) => void
  onClose: () => void
}

/** Settings panel for managing provider credentials (login / logout / status). */
export default function ProvidersSettings({
  providers,
  status,
  statusFor,
  onLogin,
  onLogout,
  onClose
}: Props) {
  const connected = status.filter((entry) => entry.kind !== 'env').length

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal account-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">Providers</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </header>

        <p className="account-intro">
          Sign in to the providers you want to use. {connected > 0 ? `${connected} connected. ` : ''}
          Credentials are written to this workspace’s <span className="mono">.pi/auth.json</span> and
          reused when you add new workspaces.
        </p>

        <div className="account-scroll">
          <ProviderList
            providers={providers}
            statusFor={statusFor}
            onLogin={onLogin}
            onLogout={onLogout}
          />
        </div>
      </div>
    </div>
  )
}
