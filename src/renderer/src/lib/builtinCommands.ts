import type { RpcCommand } from '@shared/rpc-types'

/**
 * pi implements its built-in slash commands only in its interactive TUI; they
 * are never exposed over RPC, so `get_commands` cannot return them. pi-box
 * lists here the ones with no native control and runs them in the terminal,
 * which hosts the pi TUI. Authentication (`/login`, `/logout`) is handled
 * natively instead — see `src/main/auth.ts`.
 */
export const BUILTIN_COMMANDS: RpcCommand[] = [
  { name: 'compact', description: 'Compact the session context', source: 'builtin' }
]
