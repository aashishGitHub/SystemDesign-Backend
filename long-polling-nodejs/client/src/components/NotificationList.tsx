import { Notification } from '../App'
import styles from './NotificationList.module.css'

interface Props {
  notifications: Notification[]
  onClear: () => void
}

export function NotificationList({ notifications, onClear }: Props) {
  const getTypeStyle = (type: string) => {
    const styles = {
      info: { bg: '#3b82f6', icon: 'ℹ️' },
      success: { bg: '#10b981', icon: '✅' },
      warning: { bg: '#f59e0b', icon: '⚠️' },
      error: { bg: '#ef4444', icon: '❌' },
    }
    return styles[type as keyof typeof styles] || styles.info
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2>📬 Notifications ({notifications.length})</h2>
        {notifications.length > 0 && (
          <button onClick={onClear} className={styles.clearButton}>
            Clear All
          </button>
        )}
      </div>

      <div className={styles.list}>
        {notifications.length === 0 ? (
          <div className={styles.empty}>
            <p>No notifications yet</p>
            <p className={styles.emptyHint}>
              Send a notification to see it appear here instantly via long polling!
            </p>
          </div>
        ) : (
          notifications.map((notification) => {
            const style = getTypeStyle(notification.type)
            return (
              <div
                key={notification.id}
                className={styles.notification}
                style={{ borderLeftColor: style.bg }}
              >
                <div className={styles.notificationIcon}>{style.icon}</div>
                <div className={styles.notificationContent}>
                  <p className={styles.message}>{notification.message}</p>
                  <div className={styles.meta}>
                    <span className={styles.type} style={{ color: style.bg }}>
                      {notification.type}
                    </span>
                    <span className={styles.timestamp}>
                      {new Date(notification.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}



