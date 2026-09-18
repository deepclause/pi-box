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
  /** Whether the first-run provider/model setup has been completed or skipped. */
  onboardingDone: boolean
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

/** A damaged rectangle of the VM framebuffer (BGRA bytes, `w*h*4`). */
export interface FbRect {
  x: number
  y: number
  w: number
  h: number
  data: Uint8Array
}

/** Incremental framebuffer update: dimensions plus the damaged rectangles. */
export interface FbFrame {
  width: number
  height: number
  stride: number
  rects: FbRect[]
}

/** A full framebuffer snapshot (BGRA bytes, `stride*height`). */
export interface FbSnapshot {
  width: number
  height: number
  stride: number
  data: Uint8Array
}

/** A chunk of guest audio (virtio-snd): S16_LE interleaved PCM. */
export interface AudioChunk {
  sampleRate: number
  channels: number
  format: string
  data: Uint8Array
}

/** Result of copying an attached file into the active workspace. */
export interface AttachFileResult {
  ok: boolean
  /** Original file name. */
  name?: string
  /** Size in bytes. */
  size?: number
  /** Guest path of the copy (inside the VM), e.g. `/workspace/.pi-box/attachments/…`. */
  path?: string
  error?: string
}
