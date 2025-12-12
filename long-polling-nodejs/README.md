# Long Polling Demo - Node.js

A demonstration of **Long Polling** for real-time notifications using:
- **Backend:** Node.js + Express
- **Frontend:** React + TypeScript + Vite

## What is Long Polling?

Long polling is a technique where the client makes an HTTP request to the server, and the server **holds the request open** until new data is available or a timeout occurs. Once data is sent or timeout happens, the client immediately makes another request.

## Short Polling vs Long Polling

### Short Polling
```
Client                          Server
  |                               |
  |-------- Request ----------->  |
  |<------- Response (empty) ---  | (immediate)
  |                               |
  | (wait 5 seconds)              |
  |                               |
  |-------- Request ----------->  |
  |<------- Response (empty) ---  | (immediate)
  |                               |
```

**Characteristics:**
- Client sends requests at **regular intervals** (e.g., every 5 seconds)
- Server responds **immediately**, even if no new data
- Simple to implement
- **Inefficient**: Lots of unnecessary requests
- Higher latency (up to polling interval)

### Long Polling
```
Client                          Server
  |                               |
  |-------- Request ----------->  |
  |                               | (holds connection)
  |                               | (waits for data or timeout)
  |                               | (data available!)
  |<------- Response (data) ----  |
  |                               |
  |-------- Request ----------->  | (immediately)
  |                               | (holds connection)
```

**Characteristics:**
- Server **holds the request** until data is available
- Client immediately reconnects after receiving response
- **More efficient** than short polling
- Near real-time updates
- Better battery life on mobile devices
- Timeout mechanism to prevent indefinite hanging

## Architecture

```
┌─────────────────┐     Long Poll Connection      ┌─────────────────┐
│   React Client  │ ◄────────────────────────────►│  Node.js Server │
│   (Port 3000)   │                                │   (Port 4000)   │
│                 │ ────── POST /send ───────────►│                 │
└─────────────────┘                                └─────────────────┘
```

### How Long Polling Works in This Demo

1. **Client** sends GET request to `/poll`
2. **Server** adds request to pending queue
3. **Server waits** (up to 30 seconds) for new data
4. When data arrives OR timeout:
   - Server responds with data (or empty)
   - Client immediately sends new poll request
5. Repeat indefinitely

## Quick Start

### 1. Start the Node.js Server

```bash
cd server
npm install
npm start
```

Server will start at `http://localhost:4000`

### 2. Start the React Client

```bash
cd client
npm install
npm run dev
```

Client will start at `http://localhost:3000`

## API Endpoints

### Long Poll Endpoint
```
GET http://localhost:4000/poll
```

Holds the connection until:
- New data is available (returns immediately)
- Timeout occurs (30 seconds, returns empty)

**Response:**
```json
{
  "notifications": [
    {
      "id": 1,
      "message": "Hello World!",
      "type": "info",
      "timestamp": "2024-01-01T12:00:00.000Z"
    }
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### Send Notification
```bash
POST http://localhost:4000/send
Content-Type: application/json

{
  "message": "Hello World!",
  "type": "info"  // info, success, warning, error
}
```

### Health Check
```
GET http://localhost:4000/health
```

Returns server status and pending connection count.

## Project Structure

```
long-polling-nodejs/
├── server/
│   ├── package.json
│   └── server.js        # Express server with long polling
├── client/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── hooks/
│   │   │   └── useLongPolling.ts  # Long polling hook
│   │   └── components/
│   │       ├── ConnectionStatus.tsx
│   │       ├── NotificationList.tsx
│   │       └── SendNotification.tsx
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## Key Implementation Details

### Server-Side (Node.js)
```javascript
// Store pending requests
const pendingRequests = [];

app.get('/poll', (req, res) => {
  // Set timeout
  const timeoutId = setTimeout(() => {
    // Remove from pending and send empty response
    res.json({ notifications: [], timestamp: new Date() });
  }, 30000);

  // Store the response object
  pendingRequests.push({ res, timeoutId });

  // Handle client disconnect
  req.on('close', () => {
    clearTimeout(timeoutId);
    // Remove from pending
  });
});

// When new data arrives
function broadcast(notification) {
  pendingRequests.forEach(({ res, timeoutId }) => {
    clearTimeout(timeoutId);
    res.json({ notifications: [notification], timestamp: new Date() });
  });
  pendingRequests.length = 0; // Clear all
}
```

### Client-Side (React)
```typescript
function useLongPolling(url: string) {
  const poll = async () => {
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.notifications.length > 0) {
        // Handle notifications
      }
      
      // Immediately poll again
      poll();
    } catch (error) {
      // Retry with backoff
      setTimeout(poll, 3000);
    }
  };

  useEffect(() => {
    poll();
  }, []);
}
```

## Testing with curl

```bash
# Start long poll (will wait up to 30s)
curl http://localhost:4000/poll

# In another terminal, send a notification
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Test notification", "type": "success"}'
```

## Comparison: Long Polling vs SSE vs WebSocket

| Feature | Long Polling | SSE | WebSocket |
|---------|-------------|-----|-----------|
| Direction | Client → Server (pull) | Server → Client (push) | Bidirectional |
| Connection | Request per message | Persistent | Persistent |
| Reconnection | Automatic | Built-in | Manual |
| Overhead | Medium | Low | Very Low |
| Browser Support | Universal | Modern browsers | Modern browsers |
| Proxy/Firewall | Friendly | Friendly | Sometimes blocked |
| Best for | Legacy compatibility | Notifications | Chat, gaming |

## Pros and Cons

### Long Polling Pros ✅
- Works with **all browsers** (even old IE)
- Works through **proxies and firewalls**
- No special protocol needed (just HTTP)
- More efficient than short polling
- Good fallback for SSE/WebSocket

### Long Polling Cons ❌
- Higher overhead than SSE/WebSocket
- More server resources (one connection per poll)
- Not truly real-time (small delay between requests)
- More complex state management on server
- Can cause issues with load balancers

## When to Use Long Polling?

✅ **Use Long Polling When:**
- Need to support **older browsers**
- Behind strict **corporate firewalls**
- Need HTTP-compatible solution
- Can't use WebSocket/SSE

❌ **Don't Use Long Polling When:**
- Modern browsers only → Use **SSE**
- Need bidirectional communication → Use **WebSocket**
- High-frequency updates → Use **WebSocket**

## Next Steps

1. Add authentication (JWT tokens)
2. Implement request deduplication
3. Add Redis for multi-server support
4. Implement rate limiting
5. Add user-specific channels

