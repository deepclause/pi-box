import type { RpcCommand } from '@shared/rpc-types'

/**
 * pi implements its built-in slash commands (`/login`, `/logout`, `/compact`, …)
 * only in its interactive TUI. They are never exposed over RPC, so
 * `get_commands` cannot return them. pi-box lists the ones that have no native
 * control here and runs them in the terminal, which hosts the pi TUI, so they
 * behave exactly as they do inside pi.
 */
export const BUILTIN_COMMANDS: RpcCommand[] = [
  { name: 'login', description: 'Configure provider authentication', source: 'builtin' },
  { name: 'logout', description: 'Remove provider authentication', source: 'builtin' },
  { name: 'compact', description: 'Compact the session context', source: 'builtin' }
]
