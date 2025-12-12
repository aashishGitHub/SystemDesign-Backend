import { useState } from 'react'
import { useLongPolling } from './hooks/useLongPolling'
import { ConnectionStatus } from './components/ConnectionStatus'
import { NotificationList } from './components/NotificationList'
import { SendNotification } from './components/SendNotification'
import styles from './App.module.css'

export interface Notification {
  id: number
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
  timestamp: string
}

const API_URL = 'http://localhost:4000'

function App() {
  const [notifications, setNotifications] = useState<Notification[]>([])

  const { connectionStatus, pollCount } = useLongPolling(
    `${API_URL}/poll`,
    (newNotifications) => {
      setNotifications(prev => [...newNotifications, ...prev])
    }
  )

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1>🔄 Long Polling Demo - Node.js</h1>
        <p className={styles.subtitle}>
          Client continuously polls server, server holds connection until data arrives
        </p>
      </header>

      <ConnectionStatus 
        status={connectionStatus} 
        pollCount={pollCount}
        serverUrl={API_URL}
      />

      <div className={styles.grid}>
        <SendNotification apiUrl={API_URL} />
        <NotificationList 
          notifications={notifications}
          onClear={() => setNotifications([])}
        />
      </div>

      <div className={styles.infoBox}>
        <h3>📚 How Long Polling Works:</h3>
        <ol>
          <li><strong>Client sends request</strong> to <code>/poll</code></li>
          <li><strong>Server holds connection</strong> (doesn't respond immediately)</li>
          <li><strong>Server waits</strong> for new data or 30-second timeout</li>
          <li><strong>Server responds</strong> when data arrives OR timeout occurs</li>
          <li><strong>Client immediately</strong> sends new poll request</li>
          <li><strong>Repeat forever</strong> (continuous cycle)</li>
        </ol>
        
        <div className={styles.comparison}>
          <div>
            <h4>⚡ Advantages:</h4>
            <ul>
              <li>Near real-time updates</li>
              <li>Works through firewalls/proxies</li>
              <li>Universal browser support</li>
              <li>More efficient than short polling</li>
            </ul>
          </div>
          <div>
            <h4>⚠️ Trade-offs:</h4>
            <ul>
              <li>Server holds connections (memory)</li>
              <li>More complex than short polling</li>
              <li>Not as efficient as SSE/WebSocket</li>
              <li>Requires timeout handling</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App

