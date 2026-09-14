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
  }
}
