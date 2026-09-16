import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(process.cwd(), 'src/shared'),
      '@renderer': resolve(process.cwd(), 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
