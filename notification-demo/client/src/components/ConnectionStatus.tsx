import { ConnectionStatus as Status } from '../hooks/useSSE';
import styles from './ConnectionStatus.module.css';

interface ConnectionStatusProps {
  status: Status;
  clientId: string | null;
  reconnectAttempts: number;
  onConnect: () => void;
  onDisconnect: () => void;
}

function getStatusLabel(status: Status): string {
  switch (status) {
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}

export function ConnectionStatus({
  status,
  clientId,
  reconnectAttempts,
  onConnect,
  onDisconnect,
}: ConnectionStatusProps) {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  return (
    <div className={styles.container}>
      <div className={styles.statusSection}>
        <div className={`${styles.indicator} ${styles[status]}`}>
          <span className={styles.dot} />
        </div>
        <div className={styles.info}>
          <span className={styles.label}>{getStatusLabel(status)}</span>
          {clientId && (
            <span className={styles.clientId}>{clientId}</span>
          )}
          {reconnectAttempts > 0 && status !== 'connected' && (
            <span className={styles.attempts}>
              Retry attempt: {reconnectAttempts}
            </span>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {isConnected ? (
          <button onClick={onDisconnect} className={styles.disconnectButton}>
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            className={styles.connectButton}
            disabled={isConnecting}
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
        )}
      </div>
    </div>
  );
}





