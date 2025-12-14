import { Notification } from '../hooks/useSSE';
import styles from './NotificationList.module.css';

interface NotificationListProps {
  notifications: Notification[];
  onClear: () => void;
}

function getNotificationIcon(type: string): string {
  switch (type) {
    case 'success':
      return '✓';
    case 'error':
      return '✕';
    case 'warning':
      return '⚠';
    case 'auto':
      return '⚡';
    default:
      return '●';
  }
}

function getNotificationTypeClass(type: string): string {
  switch (type) {
    case 'success':
      return styles.success;
    case 'error':
      return styles.error;
    case 'warning':
      return styles.warning;
    case 'auto':
      return styles.auto;
    default:
      return styles.info;
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function NotificationList({ notifications, onClear }: NotificationListProps) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <span className={styles.titleIcon}>🔔</span>
          Notifications
          {notifications.length > 0 && (
            <span className={styles.badge}>{notifications.length}</span>
          )}
        </h2>
        {notifications.length > 0 && (
          <button onClick={onClear} className={styles.clearButton}>
            Clear All
          </button>
        )}
      </div>

      <div className={styles.list}>
        {notifications.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>📭</div>
            <p className={styles.emptyText}>No notifications yet</p>
            <p className={styles.emptySubtext}>
              Waiting for events from the server...
            </p>
          </div>
        ) : (
          notifications.map((notification, index) => (
            <div
              key={`${notification.id}-${index}`}
              className={`${styles.notification} ${getNotificationTypeClass(notification.type)}`}
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className={styles.iconWrapper}>
                <span className={styles.icon}>
                  {getNotificationIcon(notification.type)}
                </span>
              </div>
              <div className={styles.content}>
                <p className={styles.message}>{notification.message}</p>
                <div className={styles.meta}>
                  <span className={styles.type}>{notification.type}</span>
                  <span className={styles.separator}>•</span>
                  <span className={styles.time}>
                    {formatTimestamp(notification.timestamp)}
                  </span>
                  <span className={styles.separator}>•</span>
                  <span className={styles.id}>#{notification.id}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}




