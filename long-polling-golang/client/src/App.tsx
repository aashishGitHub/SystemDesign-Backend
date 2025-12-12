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

const API_URL = 'http://localhost:4001'

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
        <h1>🚀 Long Polling Demo - Golang</h1>
        <p className={styles.subtitle}>
          High-performance long polling with Go goroutines and channels
        </p>
      </header>

      <ConnectionStatus 
        status={connectionStatus} 
        pollCount={pollCount}
        serverUrl={API_URL}
        backend="Golang"
      />

      <div className={styles.grid}>
        <SendNotification apiUrl={API_URL} />
        <NotificationList 
          notifications={notifications}
          onClear={() => setNotifications([])}
        />
      </div>

      <div className={styles.infoBox}>
        <h3>🔥 Go Long Polling Advantages:</h3>
        <div className={styles.goFeatures}>
          <div className={styles.feature}>
            <h4>⚡ Goroutines</h4>
            <p>Each poll runs in a lightweight goroutine (~2KB stack). Can handle 100,000+ concurrent connections!</p>
          </div>
          <div className={styles.feature}>
            <h4>📡 Channels</h4>
            <p>Built-in channel communication for safe, efficient data passing between goroutines.</p>
          </div>
          <div className={styles.feature}>
            <h4>🎯 Select Statement</h4>
            <p>Non-blocking timeout handling using Go's select - clean, readable code without callbacks.</p>
          </div>
          <div className={styles.feature}>
            <h4>🚀 Performance</h4>
            <p>Compiled to native code. Lower memory footprint and faster execution than Node.js.</p>
          </div>
        </div>

        <div className={styles.comparison}>
          <h4>⚖️ Go vs Node.js for Long Polling:</h4>
          <table className={styles.comparisonTable}>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Golang</th>
                <th>Node.js</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Memory per connection</td>
                <td>4-8 KB</td>
                <td>20-40 KB</td>
              </tr>
              <tr>
                <td>Max concurrent connections</td>
                <td>100,000+</td>
                <td>10,000-20,000</td>
              </tr>
              <tr>
                <td>Concurrency model</td>
                <td>Goroutines (true parallel)</td>
                <td>Event loop (single thread)</td>
              </tr>
              <tr>
                <td>Response time</td>
                <td>Sub-millisecond</td>
                <td>Few milliseconds</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default App


