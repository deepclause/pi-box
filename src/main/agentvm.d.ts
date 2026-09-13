declare module 'deepclause-agentvm' {
  export interface AgentVMOptions {
    wasmPath?: string
    mounts?: Record<string, string>
    network?: boolean
    mac?: string
    debug?: boolean
    interactive?: boolean
    networkRateLimit?: number
  }

  export interface ExecResult {
    stdout: string
    stderr: string
    exitCode: number
  }

  export class AgentVM {
    constructor(options?: AgentVMOptions)
    onStdout: ((data: Uint8Array) => void) | null
    onStderr: ((data: Uint8Array) => void) | null
    onExit: ((error?: string) => void) | null
    start(): Promise<void>
    stop(): Promise<void>
    exec(command: string): Promise<ExecResult>
    writeToStdin(data: string | Uint8Array): Promise<void>
    setupNetwork(): Promise<{ ip: string | null; gateway: string | null }>
  }
}
