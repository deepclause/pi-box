import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// Note: StrictMode is intentionally not used here because it double-mounts in
// development, which would create two xterm instances and duplicate IPC
// subscriptions for a short moment.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
