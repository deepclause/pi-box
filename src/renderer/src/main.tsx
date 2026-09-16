import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// Used by the stylesheet for platform-specific chrome (e.g. traffic-light inset on macOS).
document.documentElement.dataset.platform = window.pibox?.platform ?? 'unknown'

// Default to the light theme; dark is opt-in and persisted.
let storedTheme: string | null = null
try {
  storedTheme = localStorage.getItem('pibox.theme')
} catch {
  storedTheme = null
}
document.documentElement.dataset.theme = storedTheme === 'dark' ? 'dark' : 'light'

// Note: StrictMode is intentionally not used here because it double-mounts in
// development, which would create two xterm instances and duplicate IPC
// subscriptions for a short moment.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
