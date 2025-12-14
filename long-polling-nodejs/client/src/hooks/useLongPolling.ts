import { useEffect, useRef, useState } from 'react'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface Notification {
  id: number
  message: string
  type: string
  timestamp: string
}

interface PollResponse {
  notifications: Notification[]
  timestamp: string
}

/**
 * Custom hook for long polling
 * 
 * Long Polling Flow:
 * 1. Send request to server
 * 2. Server holds the connection
 * 3. Server responds when data is available OR timeout occurs
 * 4. Client receives response
 * 5. Client immediately sends new request (step 1)
 */
export function useLongPolling(
  url: string,
  onNotifications: (notifications: Notification[]) => void
) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [pollCount, setPollCount] = useState(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isPollingRef = useRef(false)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const retryDelayRef = useRef(1000)

  const poll = async () => {
    // Prevent multiple simultaneous polls
    if (isPollingRef.current) {
      return
    }

    isPollingRef.current = true
    abortControllerRef.current = new AbortController()

    try {
      setConnectionStatus('connecting')
      
      console.log('[Long Poll] Sending poll request...')
      const startTime = Date.now()

      // Send long poll request
      const response = await fetch(url, {
        signal: abortControllerRef.current.signal,
        headers: {
          'Accept': 'application/json',
        },
      })

      const duration = Date.now() - startTime
      console.log(`[Long Poll] Response received after ${duration}ms`)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data: PollResponse = await response.json()
      
      setConnectionStatus('connected')
      setPollCount(prev => prev + 1)

      // Handle notifications if any
      if (data.notifications && data.notifications.length > 0) {
        console.log(`[Long Poll] Received ${data.notifications.length} notification(s)`)
        onNotifications(data.notifications)
      } else {
        console.log('[Long Poll] No new notifications (timeout)')
      }

      // Reset retry delay on success
      retryDelayRef.current = 1000

      // Immediately poll again (long polling cycle)
      isPollingRef.current = false
      poll()

    } catch (error: any) {
      isPollingRef.current = false

      // Ignore abort errors (user navigated away)
      if (error.name === 'AbortError') {
        console.log('[Long Poll] Request aborted')
        return
      }

      console.error('[Long Poll] Error:', error)
      setConnectionStatus('error')

      // Exponential backoff retry
      const delay = Math.min(retryDelayRef.current, 30000)
      console.log(`[Long Poll] Retrying in ${delay}ms...`)

      retryTimeoutRef.current = setTimeout(() => {
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000)
        poll()
      }, delay)
    }
  }

  useEffect(() => {
    // Start polling
    poll()

    // Cleanup on unmount
    return () => {
      console.log('[Long Poll] Cleaning up...')
      isPollingRef.current = false
      
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      
      setConnectionStatus('disconnected')
    }
  }, [url])

  return {
    connectionStatus,
    pollCount,
  }
}



