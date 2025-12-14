import { ConnectionStatus as Status } from '../hooks/useLongPolling'
import styles from './ConnectionStatus.module.css'

interface Props {
  status: Status
  pollCount: number
  serverUrl: string
}

export function ConnectionStatus({ status, pollCount, serverUrl }: Props) {
  const getStatusInfo = () => {
    switch (status) {
      case 'connecting':
        return {
          icon: '🔄',
          label: 'Polling...',
          color: '#f59e0b',
          description: 'Waiting for server response'
        }
      case 'connected':
        return {
          icon: '✅',
          label: 'Connected',
          color: '#10b981',
          description: 'Long poll active'
        }
      case 'disconnected':
        return {
          icon: '❌',
          label: 'Disconnected',
          color: '#6b7280',
          description: 'Not polling'
        }
      case 'error':
        return {
          icon: '⚠️',
          label: 'Error',
          color: '#ef4444',
          description: 'Connection error, retrying...'
        }
    }
  }

  const info = getStatusInfo()

  return (
    <div className={styles.container}>
      <div className={styles.statusCard}>
        <div className={styles.statusIndicator}>
          <span className={styles.icon}>{info.icon}</span>
          <div>
            <h3 style={{ color: info.color }}>{info.label}</h3>
            <p className={styles.description}>{info.description}</p>
          </div>
        </div>

        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Poll Requests:</span>
            <span className={styles.statValue}>{pollCount}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Server:</span>
            <span className={styles.statValue}>{serverUrl}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Method:</span>
            <span className={styles.statValue}>Long Polling</span>
          </div>
        </div>
      </div>
    </div>
  )
}



