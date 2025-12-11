Syllabus

polling - short and long
how do we implement short and long polling ? whats is the difference? 



# SSE Notification Demo

A demonstration of **Server-Sent Events (SSE)** for real-time notifications using:
- **Backend:** Go (Golang) with standard library
- **Frontend:** React + TypeScript + Vite

## Architecture

```
┌─────────────────┐         SSE Connection         ┌─────────────────┐
│   React Client  │ ◄──────────────────────────────│   Go Server     │
│   (Port 3000)   │                                │   (Port 8080)   │
│                 │ ────── POST /send ────────────►│                 │
└─────────────────┘                                └─────────────────┘
```

### How SSE Works

1. Client opens a long-lived HTTP connection to `/events`
2. Server sets `Content-Type: text/event-stream`
3. Server pushes events in the format:
   ```
   event: notification
   data: {"id": 1, "message": "Hello"}

   ```
4. Client receives events via `EventSource` API
5. Connection stays open until client disconnects

## Quick Start

### 1. Start the Go Server

```bash
cd server
go run main.go
```

Server will start at `http://localhost:8080`

### 2. Start the React Client

```bash
cd client
npm install
npm run dev
```

Client will start at `http://localhost:3000`

## API Endpoints

### SSE Events Endpoint
```
GET http://localhost:8080/events
```

Establishes an SSE connection. Returns events:
- `connected` - Initial connection confirmation
- `notification` - Notification data
- `heartbeat` - Keep-alive ping (every 15s)

### Send Notification
```bash
POST http://localhost:8080/send
Content-Type: application/json

{
  "message": "Hello World!",
  "type": "info"  // info, success, warning, error
}
```

### Health Check
```
GET http://localhost:8080/health
```

Returns server status and connected client count.

## Project Structure

```
notification-demo/
├── server/
│   ├── main.go          # Go SSE server implementation
│   └── go.mod           # Go module file
├── client/
│   ├── src/
│   │   ├── App.tsx      # Main React component
│   │   ├── hooks/
│   │   │   └── useSSE.ts    # SSE connection hook
│   │   └── components/
│   │       ├── ConnectionStatus.tsx
│   │       ├── NotificationList.tsx
│   │       ├── SendNotification.tsx
│   │       └── EventLog.tsx
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## Key Concepts Demonstrated

### Go Server Features
- **Client Hub Pattern:** Manages multiple SSE connections
- **Graceful Disconnection:** Detects when clients disconnect
- **Heartbeat:** Keeps connections alive
- **Broadcast:** Sends messages to all connected clients
- **CORS Support:** Allows cross-origin requests

### React Client Features
- **useSSE Hook:** Encapsulates EventSource logic
- **Auto-reconnect:** Exponential backoff on disconnection
- **Connection Status:** Real-time connection state display
- **Event Logging:** Shows all SSE events for debugging

## Testing with curl

```bash
# Connect to SSE stream
curl -N http://localhost:8080/events

# Send a notification
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Test notification", "type": "success"}'

# Check health
curl http://localhost:8080/health
```

## SSE vs Long Polling vs WebSocket

| Feature | SSE | Long Polling | WebSocket |
|---------|-----|--------------|-----------|
| Direction | Server → Client | Client → Server (pull) | Bidirectional |
| Protocol | HTTP | HTTP | WS/WSS |
| Connection | Persistent | Request per message | Persistent |
| Reconnection | Built-in | Manual | Manual |
| Binary data | No | Yes | Yes |
| Complexity | Low | Medium | High |
| Efficiency | High | Medium | Very High |
| Best for | Notifications, feeds | Legacy compatibility | Chat, gaming |

## When to Use SSE?

✅ **Use SSE When:**
- Need **server → client** push only
- Building **notifications**, **live feeds**, **dashboards**
- Want **built-in reconnection**
- Using **modern browsers**
- Want **simpler** than WebSocket

❌ **Don't Use SSE When:**
- Need **bidirectional** communication → Use **WebSocket**
- Need to support **old browsers** → Use **Long Polling**
- Need **binary data** → Use **WebSocket**

## Next Steps

1. Add authentication (JWT in SSE query params)
2. Add room/channel support for targeted notifications
3. Integrate with AWS SQS/SNS for backend events
4. Add Service Worker for Web Push notifications
5. Deploy to AWS (API Gateway, Lambda, or ECS)


