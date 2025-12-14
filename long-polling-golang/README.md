# Long Polling Demo - Golang

A demonstration of **Long Polling** for real-time notifications using:
- **Backend:** Go (Golang) with standard library
- **Frontend:** React + TypeScript + Vite

## What is Long Polling?

Long polling is a technique where the client makes an HTTP request to the server, and the server **holds the request open** until new data is available or a timeout occurs.

## Architecture

```
┌─────────────────┐     Long Poll Connection      ┌─────────────────┐
│   React Client  │ ◄────────────────────────────►│   Go Server     │
│   (Port 3000)   │                                │   (Port 4001)   │
│                 │ ────── POST /send ───────────►│                 │
└─────────────────┘                                └─────────────────┘
```

## Quick Start

### 1. Start the Go Server

```bash
cd server
go run main.go
```

Server will start at `http://localhost:4001`

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
GET http://localhost:4001/poll
```

Holds the connection until data is available or timeout (30 seconds).

### Send Notification
```bash
POST http://localhost:4001/send
Content-Type: application/json

{
  "message": "Hello World!",
  "type": "info"
}
```

### Health Check
```
GET http://localhost:4001/health
```

## Key Implementation Details

### Go Implementation Features

1. **Channel-based Communication**
   - Uses Go channels for efficient message passing
   - Non-blocking select statements for timeout handling

2. **Goroutine per Request**
   - Each long poll runs in its own goroutine
   - Efficient concurrent handling of multiple clients

3. **Graceful Timeout**
   - Uses `time.After()` for timeout
   - Proper cleanup on client disconnect

4. **Broadcast Pattern**
   - Notification hub broadcasts to all waiting clients
   - Thread-safe with mutex locks

### Go vs Node.js Comparison

| Aspect | Go | Node.js |
|--------|----|---------| 
| Concurrency | Goroutines (lightweight threads) | Single-threaded event loop |
| Memory | More efficient, lower memory | Higher memory per connection |
| Performance | Faster, compiled | Good, but interpreted |
| Code Complexity | Medium (channels, goroutines) | Easier (promises, callbacks) |
| Best for | High-concurrency, performance | I/O-bound, rapid development |

## Testing with curl

```bash
# Start long poll
curl http://localhost:4001/poll

# Send notification
curl -X POST http://localhost:4001/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Test from Go!", "type": "success"}'
```

## Go-Specific Advantages

✅ **Why Go for Long Polling:**
- **Goroutines** are extremely lightweight (2KB stack vs 2MB thread)
- Can handle **100,000+ concurrent connections** easily
- Built-in **concurrency primitives** (channels, select)
- **No callback hell** - clean, sequential code
- **Better CPU utilization** on multi-core systems
- **Lower memory footprint**

## Code Walkthrough

### Main Components

```go
// Pending request with timeout
type PendingRequest struct {
    ResponseWriter http.ResponseWriter
    Done           chan bool
}

// Global hub for managing requests
var (
    pendingRequests = make([]*PendingRequest, 0)
    mutex          = &sync.Mutex{}
)

// Long poll handler
func pollHandler(w http.ResponseWriter, r *http.Request) {
    done := make(chan bool)
    
    // Add to pending
    mutex.Lock()
    pendingRequests = append(pendingRequests, &PendingRequest{w, done})
    mutex.Unlock()
    
    // Wait for data or timeout
    select {
    case <-done:
        // Data sent, exit
    case <-time.After(30 * time.Second):
        // Timeout, send empty response
        json.NewEncoder(w).Encode(EmptyResponse{})
    case <-r.Context().Done():
        // Client disconnected
    }
}
```

## Performance Characteristics

### Go Long Polling Performance
- **Memory per connection**: ~4-8 KB
- **Max concurrent connections**: 100,000+ (on 8GB RAM)
- **CPU usage**: Very low (efficient scheduler)
- **Response time**: Sub-millisecond when data available

### Node.js Long Polling Performance
- **Memory per connection**: ~20-40 KB
- **Max concurrent connections**: 10,000-20,000 (on 8GB RAM)
- **CPU usage**: Low (event loop)
- **Response time**: Few milliseconds

## When to Choose Go vs Node.js

### Choose Go When:
- Need to handle **massive concurrent connections**
- Performance is **critical**
- Building **microservices** at scale
- Team knows Go
- Want compiled binary (easy deployment)

### Choose Node.js When:
- Team expertise is in **JavaScript**
- Rapid **prototyping** needed
- Integration with **JavaScript ecosystem**
- Full-stack JavaScript development
- Smaller scale applications




