import { SSEEvent } from '../hooks/useSSE';
import styles from './EventLog.module.css';

interface EventLogProps {
  events: SSEEvent[];
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function getEventColor(type: string): string {
  switch (type) {
    case 'connected':
      return styles.green;
    case 'disconnected':
      return styles.red;
    case 'notification':
      return styles.blue;
    case 'heartbeat':
      return styles.gray;
    case 'error':
      return styles.red;
    default:
      return styles.gray;
  }
}

export function EventLog({ events }: EventLogProps) {
  return (
    <div className={styles.container}>
      <h3 className={styles.title}>
        <span className={styles.titleIcon}>📜</span>
        Event Log
        <span className={styles.count}>{events.length}</span>
      </h3>

      <div className={styles.log}>
        {events.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>⏳</span>
            <span>Waiting for events...</span>
          </div>
        ) : (
          events.map((event, index) => (
            <div key={index} className={styles.entry}>
              <span className={styles.time}>{formatTime(event.timestamp)}</span>
              <span className={`${styles.type} ${getEventColor(event.type)}`}>
                [{event.type}]
              </span>
              <span className={styles.data}>
                {JSON.stringify(event.data)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}



