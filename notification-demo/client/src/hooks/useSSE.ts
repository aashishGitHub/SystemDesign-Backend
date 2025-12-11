import { useState, useEffect, useCallback, useRef } from 'react';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface Notification {
  id: number;
  type: string;
  message: string;
  timestamp: string;
}

export interface SSEEvent {
  type: string;
  data: unknown;
  timestamp: Date;
}

interface UseSSEOptions {
  url: string;
  onNotification?: (notification: Notification) => void;
  onConnected?: (clientId: string) => void;
  onError?: (error: Event) => void;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface UseSSEReturn {
  status: ConnectionStatus;
  clientId: string | null;
  notifications: Notification[];
  events: SSEEvent[];
  connect: () => void;
  disconnect: () => void;
  clearNotifications: () => void;
  reconnectAttempts: number;
}

export function useSSE({
  url,
  onNotification,
  onConnected,
  onError,
  autoReconnect = true,
  reconnectInterval = 3000,
  maxReconnectAttempts = 10,
}: UseSSEOptions): UseSSEReturn {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [clientId, setClientId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const addEvent = useCallback((type: string, data: unknown) => {
    setEvents((prev) => [
      { type, data, timestamp: new Date() },
      ...prev.slice(0, 49), // Keep last 50 events
    ]);
  }, []);

  const connect = useCallback(() => {
    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('connecting');
    console.log('[SSE] Connecting to:', url);

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    // Handle successful connection
    eventSource.onopen = () => {
      console.log('[SSE] Connection opened');
      setReconnectAttempts(0);
    };

    // Handle 'connected' event from server
    eventSource.addEventListener('connected', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[SSE] Connected event:', data);
        setStatus('connected');
        setClientId(data.clientId);
        addEvent('connected', data);
        onConnected?.(data.clientId);
      } catch (err) {
        console.error('[SSE] Error parsing connected event:', err);
      }
    });

    // Handle 'notification' events
    eventSource.addEventListener('notification', (event: MessageEvent) => {
      try {
        const notification: Notification = JSON.parse(event.data);
        console.log('[SSE] Notification received:', notification);
        setNotifications((prev) => [notification, ...prev]);
        addEvent('notification', notification);
        onNotification?.(notification);
      } catch (err) {
        console.error('[SSE] Error parsing notification:', err);
      }
    });

    // Handle 'heartbeat' events
    eventSource.addEventListener('heartbeat', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[SSE] Heartbeat:', data);
        addEvent('heartbeat', data);
      } catch (err) {
        console.error('[SSE] Error parsing heartbeat:', err);
      }
    });

    // Handle errors
    eventSource.onerror = (error) => {
      console.error('[SSE] Error:', error);
      setStatus('error');
      addEvent('error', { message: 'Connection error' });
      onError?.(error);

      // Close the connection
      eventSource.close();
      eventSourceRef.current = null;

      // Attempt to reconnect
      if (autoReconnect && reconnectAttempts < maxReconnectAttempts) {
        setStatus('disconnected');
        const timeout = reconnectInterval * Math.pow(1.5, reconnectAttempts); // Exponential backoff
        console.log(`[SSE] Reconnecting in ${timeout}ms (attempt ${reconnectAttempts + 1})`);
        
        reconnectTimeoutRef.current = window.setTimeout(() => {
          setReconnectAttempts((prev) => prev + 1);
          connect();
        }, timeout);
      }
    };
  }, [url, autoReconnect, reconnectInterval, maxReconnectAttempts, reconnectAttempts, onNotification, onConnected, onError, addEvent]);

  const disconnect = useCallback(() => {
    console.log('[SSE] Disconnecting');
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setStatus('disconnected');
    setClientId(null);
    setReconnectAttempts(0);
    addEvent('disconnected', { manual: true });
  }, [addEvent]);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return {
    status,
    clientId,
    notifications,
    events,
    connect,
    disconnect,
    clearNotifications,
    reconnectAttempts,
  };
}

