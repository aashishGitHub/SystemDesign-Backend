import { useState } from 'react'
import styles from './SendNotification.module.css'

interface Props {
  apiUrl: string
}

type NotificationType = 'info' | 'success' | 'warning' | 'error'

export function SendNotification({ apiUrl }: Props) {
  const [message, setMessage] = useState('')
  const [type, setType] = useState<NotificationType>('info')
  const [sending, setSending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!message.trim()) return

    setSending(true)

    try {
      const response = await fetch(`${apiUrl}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, type }),
      })

      if (response.ok) {
        setMessage('')
        console.log('✅ Notification sent successfully')
      }
    } catch (error) {
      console.error('❌ Failed to send notification:', error)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.container}>
      <h2>📤 Send Notification</h2>
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter your notification message..."
            rows={4}
            className={styles.textarea}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="type">Type</label>
          <select
            id="type"
            value={type}
            onChange={(e) => setType(e.target.value as NotificationType)}
            className={styles.select}
          >
            <option value="info">ℹ️ Info</option>
            <option value="success">✅ Success</option>
            <option value="warning">⚠️ Warning</option>
            <option value="error">❌ Error</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={!message.trim() || sending}
          className={styles.button}
        >
          {sending ? 'Sending...' : 'Send Notification'}
        </button>
      </form>

      <div className={styles.info}>
        <p>⚡ <strong>Go Powered:</strong> Lightning-fast delivery with goroutines and channels!</p>
      </div>
    </div>
  )
}


