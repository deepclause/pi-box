export type VmStatus = 'loading' | 'ready' | 'error' | 'stopped'

export interface Workspace {
  id: string
  name: string
  path: string
  isDefault: boolean
  createdAt: number
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  /** Present once the directory has been expanded/loaded. */
  children?: FileNode[] | null
}

export interface AppState {
  status: VmStatus
  statusMessage?: string
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeMountPath: string | null
  mountPoint: string
  networkEnabled: boolean
  portForwards: PortForward[]
  firewallRules: FirewallRule[]
}

export interface PortForward {
  hostPort: number
  guestPort: number
  guestHost?: string
}

export interface FirewallRule {
  id: string
  direction: 'in' | 'out'
  protocol: 'tcp' | 'udp'
  remote: string
  port: string
  action: 'allow' | 'deny'
}

export interface OpenResult {
  ok: boolean
  error?: string
}
