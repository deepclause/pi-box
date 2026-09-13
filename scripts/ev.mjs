import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// On Linux containers (and CI) the Chromium SUID sandbox helper is usually not
// configured (chrome-sandbox is not root:root with mode 4755). electron-vite
// appends `--no-sandbox` to the Electron process when NO_SANDBOX=1, so we set
// that only on Linux. macOS and Windows keep their normal sandbox.
if (process.platform === 'linux') {
  process.env.NO_SANDBOX = '1'
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', cwd: root })

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
