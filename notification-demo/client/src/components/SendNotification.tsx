import { useState } from 'react';
import styles from './SendNotification.module.css';

interface SendNotificationProps {
  serverUrl: string;
}

export function SendNotification({ serverUrl }: SendNotificationProps) {
  const [message, setMessage] = useState('');
  const [type, setType] = useState('info');
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;

    setSending(true);
    setLastResult(null);

    try {
      const response = await fetch(`${serverUrl}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, type }),
      });

      if (response.ok) {
        setLastResult('✓ Notification sent!');
        setMessage('');
      } else {
        setLastResult('✕ Failed to send');
      }
    } catch (error) {
      console.error('Error sending notification:', error);
      setLastResult('✕ Network error');
    } finally {
      setSending(false);
      // Clear result after 3 seconds
      setTimeout(() => setLastResult(null), 3000);
    }
  };

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>
        <span className={styles.titleIcon}>📤</span>
        Send Test Notification
      </h3>

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.inputGroup}>
          <label htmlFor="message" className={styles.label}>
            Message
          </label>
          <input
            id="message"
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter notification message..."
            className={styles.input}
          />
        </div>

        <div className={styles.inputGroup}>
          <label htmlFor="type" className={styles.label}>
            Type
          </label>
          <select
            id="type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={styles.select}
          >
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>

        <div className={styles.actions}>
          <button
            type="submit"
            disabled={sending || !message.trim()}
            className={styles.sendButton}
          >
            {sending ? 'Sending...' : 'Send Notification'}
          </button>

          {lastResult && (
            <span
              className={`${styles.result} ${
                lastResult.startsWith('✓') ? styles.success : styles.error
              }`}
            >
              {lastResult}
            </span>
          )}
        </div>
      </form>

      <p className={styles.hint}>
        This sends a POST request to the server, which broadcasts it to all connected clients via SSE.
      </p>
    </div>
  );
}




