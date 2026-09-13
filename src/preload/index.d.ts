import type { PiBoxApi } from './index'

declare global {
  interface Window {
    pibox: PiBoxApi
  }
}

export {}
