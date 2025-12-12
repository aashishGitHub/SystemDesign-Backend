import { useSSE } from './hooks/useSSE';
import { ConnectionStatus } from './components/ConnectionStatus';
import { NotificationList } from './components/NotificationList';
import { SendNotification } from './components/SendNotification';
import { EventLog } from './components/EventLog';
import styles from './App.module.css';

const SSE_SERVER_URL = 'http://localhost:8080';

function App() {
  const {
    status,
    clientId,
    notifications,
    events,
    connect,
    disconnect,
    clearNotifications,
    reconnectAttempts,
  } = useSSE({
    url: `${SSE_SERVER_URL}/events`,
    onNotification: (notification) => {
      console.log('New notification:', notification);
    },
    onConnected: (id) => {
      console.log('Connected with ID:', id);
    },
  });

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>⚡</span>
            <h1 className={styles.title}>SSE Notification Demo</h1>
          </div>
          <p className={styles.subtitle}>
            Real-time Server-Sent Events with Go & React
          </p>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.statusBar}>
          <ConnectionStatus
            status={status}
            clientId={clientId}
            reconnectAttempts={reconnectAttempts}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        </div>

        <div className={styles.grid}>
          <div className={styles.leftColumn}>
            <div className={styles.sendSection}>
              <SendNotification serverUrl={SSE_SERVER_URL} />
            </div>
            <div className={styles.eventLogSection}>
              <EventLog events={events} />
            </div>
          </div>

          <div className={styles.rightColumn}>
            <NotificationList
              notifications={notifications}
              onClear={clearNotifications}
            />
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerContent}>
          <p>
            Server: <code>{SSE_SERVER_URL}</code>
          </p>
          <p className={styles.footerHint}>
            The server sends automatic notifications every 10 seconds. You can
            also send custom notifications using the form above.
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;



