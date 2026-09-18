declare module 'deepclause-agentvm' {
  export interface AgentVMOptions {
    wasmPath?: string
    mounts?: Record<string, string>
    network?: boolean
    mac?: string
    debug?: boolean
    interactive?: boolean
    networkRateLimit?: number
    persistentRoot?: boolean
    persistentRootDir?: string
  }

  export interface ExecResult {
    stdout: string
    stderr: string
    exitCode: number
  }

  export interface PortForward {
    hostPort: number
    guestPort: number
    guestHost?: string
    protocol?: 'tcp'
    bind?: string
  }

  export interface FramebufferRect {
    x: number
    y: number
    w: number
    h: number
    data: Uint8Array
  }

  export interface FramebufferFrame {
    width: number
    height: number
    stride: number
    data: Uint8Array
    rects: FramebufferRect[] | null
  }

  export interface FramebufferSnapshot {
    width: number
    height: number
    stride: number
    data: Uint8Array
  }

  export interface AudioChunk {
    sampleRate: number
    channels: number
    format: string
    data: Uint8Array
  }

  export class AgentVM {
    constructor(options?: AgentVMOptions)
    onStdout: ((data: Uint8Array) => void) | null
    onStderr: ((data: Uint8Array) => void) | null
    onExit: ((error?: string) => void) | null
    networkEnabled: boolean
    rootPersistenceMode: string
    start(): Promise<void>
    stop(): Promise<void>
    exec(command: string): Promise<ExecResult>
    writeToStdin(data: string | Uint8Array): Promise<void>
    setupNetwork(): Promise<{ ip: string | null; gateway: string | null }>
    setNetworkEnabled(enabled: boolean): void
    setFirewall(config: { default?: 'allow' | 'deny'; rules: unknown[] }): void
    clearFirewall(): void
    addPortForward(config: PortForward): Promise<PortForward>
    removePortForward(hostPort: number): boolean
    listPortForwards(): PortForward[]
    snapshotRoot(): Promise<ExecResult>
    /** Subscribe to virtual-framebuffer frames (simplefb). Returns an unsubscribe. */
    onFramebuffer(callback: (frame: FramebufferFrame) => void): () => void
    /** Latest full frame, or null if the image has no framebuffer / no frame yet. */
    getFramebuffer(): FramebufferSnapshot | null
    /** Keyboard event (key name such as 'ArrowLeft', or a raw evdev keycode). */
    sendKey(code: string | number, down?: boolean): void
    /** Pointer event in framebuffer pixels (1=left, 2=right, 4=middle). */
    sendMouse(x: number, y: number, buttons?: number): void
    /** Subscribe to PCM produced by the guest's virtio-snd device. */
    onAudio(callback: (audio: AudioChunk) => void): () => void
    /** Negotiated audio format, or null before the guest opens the device. */
    getAudioFormat(): { sampleRate: number; channels: number; format: string } | null
  }
}
