import { useMemo, useState } from 'react'
import type { AuthMethod, AuthProviderInfo, AuthStatus } from '@shared/auth-types'

interface Props {
  providers: AuthProviderInfo[]
  statusFor: (providerId: string) => AuthStatus | undefined
  onLogin: (providerId: string, method: AuthMethod) => void
  onLogout?: (providerId: string) => void
  searchable?: boolean
  /** Hide the search box and section headings (used inside the onboarding card). */
  compact?: boolean
  activeProviderId?: string | null
}

type Group = 'subscription' | 'oauth' | 'api_key'

function groupOf(provider: AuthProviderInfo): Group {
  if (provider.subscription) return 'subscription'
  if (provider.methods.includes('oauth')) return 'oauth'
  return 'api_key'
}

const GROUP_LABEL: Record<Group, string> = {
  subscription: 'Subscriptions',
  oauth: 'OAuth',
  api_key: 'API keys'
}

const GROUP_ORDER: Group[] = ['subscription', 'oauth', 'api_key']

/** Reusable provider list for onboarding and the providers settings panel. */
export default function ProviderList({
  providers,
  statusFor,
  onLogin,
  onLogout,
  searchable = true,
  compact = false,
  activeProviderId
}: Props) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return providers
    return providers.filter(
      (provider) =>
        provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)
    )
  }, [providers, query])

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        group,
        items: filtered.filter((provider) => groupOf(provider) === group)
      })).filter((entry) => entry.items.length > 0),
    [filtered]
  )

  return (
    <div className="provider-list">
      {searchable ? (
        <input
          className="field provider-search"
          placeholder="Search providers…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}

      {groups.length === 0 ? <div className="settings-empty">No providers match “{query}”.</div> : null}

      {groups.map(({ group, items }) => (
        <div className="provider-group" key={group}>
          {!compact ? <div className="provider-group-title">{GROUP_LABEL[group]}</div> : null}
          {items.map((provider) => {
            const status = statusFor(provider.id)
            const activeBadge = activeProviderId === provider.id
            return (
              <div className="provider-row" key={provider.id} data-active={activeBadge ? 'true' : undefined}>
                <div className="provider-main">
                  <span className="provider-name">{provider.name}</span>
                  <span className="provider-methods">
                    {provider.subscription ? <span className="chip solid">Subscription</span> : null}
                    {!provider.subscription && provider.methods.includes('oauth') ? (
                      <span className="chip">OAuth</span>
                    ) : null}
                    {provider.methods.includes('api_key') ? <span className="chip">API key</span> : null}
                  </span>
                </div>
                <div className="provider-actions">
                  {status ? (
                    <span className="provider-status" data-kind={status.kind} title={status.source}>
                      <span className="status-dot" data-status="ready" />
                      {status.kind === 'env' ? 'Environment' : 'Connected'}
                    </span>
                  ) : null}
                  {provider.methods.includes('oauth') ? (
                    <button className="btn primary small" onClick={() => onLogin(provider.id, 'oauth')}>
                      {status && status.kind === 'oauth'
                        ? 'Re-authenticate'
                        : provider.subscription
                          ? 'Sign in'
                          : 'Connect'}
                    </button>
                  ) : null}
                  {provider.methods.includes('api_key') ? (
                    <button className="btn small" onClick={() => onLogin(provider.id, 'api_key')}>
                      {status && status.kind === 'api_key' ? 'Replace key' : 'Use API key'}
                    </button>
                  ) : null}
                  {onLogout && status && status.kind !== 'env' ? (
                    <button className="btn small ghost" onClick={() => onLogout(provider.id)}>
                      Log out
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
