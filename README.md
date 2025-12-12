# System Design Backend - Real-Time Communication Demos

A comprehensive collection of real-time communication implementations demonstrating different approaches to server-client communication.

## 📚 Table of Contents

- [Overview](#overview)
- [Demos](#demos)
- [Quick Comparison](#quick-comparison)
- [Getting Started](#getting-started)
- [Learning Path](#learning-path)

---

## 🎯 Overview

This repository contains working implementations of various real-time communication patterns:

1. **Short Polling** (Documentation)
2. **Long Polling** (Node.js + Go implementations)
3. **Server-Sent Events (SSE)** (Go implementation)

Each demo includes:
- ✅ Complete server implementation
- ✅ React + TypeScript client
- ✅ Comprehensive documentation
- ✅ Ready-to-run examples

---

## 🚀 Demos

### 1. Long Polling - Node.js
📁 **Folder:** `long-polling-nodejs/`

**What it demonstrates:**
- Long polling implementation with Node.js + Express
- Request queuing and timeout handling
- Real-time notifications with HTTP

**Tech Stack:**
- Backend: Node.js, Express
- Frontend: React, TypeScript, Vite
- Ports: Server (4000), Client (3000)

**Start:**
```bash
# Terminal 1 - Server
cd long-polling-nodejs/server
npm install && npm start

# Terminal 2 - Client
cd long-polling-nodejs/client
npm install && npm run dev
```

---

### 2. Long Polling - Golang
📁 **Folder:** `long-polling-golang/`

**What it demonstrates:**
- High-performance long polling with Go
- Goroutines for concurrent connection handling
- Channel-based message passing
- Production-ready implementation

**Tech Stack:**
- Backend: Go (standard library)
- Frontend: React, TypeScript, Vite
- Ports: Server (4001), Client (3001)

**Start:**
```bash
# Terminal 1 - Server
cd long-polling-golang/server
go run main.go

# Terminal 2 - Client
cd long-polling-golang/client
npm install && npm run dev
```

---

### 3. Server-Sent Events (SSE)
📁 **Folder:** `notification-demo/`

**What it demonstrates:**
- SSE for server-to-client push notifications
- Persistent HTTP connection
- Automatic reconnection
- Heartbeat mechanism

**Tech Stack:**
- Backend: Go (standard library)
- Frontend: React, TypeScript, Vite
- Ports: Server (8080), Client (3000)

**Start:**
```bash
# Terminal 1 - Server
cd notification-demo/server
go run main.go

# Terminal 2 - Client
cd notification-demo/client
npm install && npm run dev
```

---

## ⚖️ Quick Comparison

### Short Polling vs Long Polling

| Aspect | Short Polling | Long Polling |
|--------|--------------|--------------|
| **How it works** | Client polls every N seconds | Server holds connection until data |
| **Request frequency** | High (every 5-30s) | Low (only when needed) |
| **Latency** | High (0-30s) | Low (<1s) |
| **Efficiency** | Very low (~5%) | Medium (~60%) |
| **Complexity** | Very simple | Medium |
| **Best for** | Infrequent updates | Near real-time |

### Visual Timeline

```
SHORT POLLING (10s interval):
Time:  0s    10s   20s   30s   40s   50s
       |-----|-----|-----|-----|-----|
       req   req   req   req   req   req
        ↓     ↓     ↓     ↓     ↓     ↓
       empty empty DATA! empty empty DATA!

Result: 6 requests, 2-10s latency per message


LONG POLLING:
Time:  0s              25s            48s
       |---------------|--------------|
       req             req            req
        ↓               ↓              ↓
       (holding...)    DATA!          DATA!

Result: 3 requests, <1s latency per message
```

### All Technologies Comparison

| Feature | Short Polling | Long Polling | SSE | WebSocket |
|---------|--------------|--------------|-----|-----------|
| **Direction** | Pull | Pull | Push | Bi-directional |
| **Connection** | Multiple | Request/message | Persistent | Persistent |
| **Browser Support** | 100% | 100% | 98% | 98% |
| **Efficiency** | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Latency** | High | Low | Very Low | Very Low |
| **Mobile friendly** | ❌ | ⚠️ | ✅ | ✅ |
| **Complexity** | Very Low | Medium | Low | High |
| **Firewall friendly** | ✅ | ✅ | ✅ | ⚠️ |

---

## 🏁 Getting Started

### Prerequisites

**For Node.js demos:**
```bash
node --version  # v18+ recommended
npm --version   # v9+ recommended
```

**For Go demos:**
```bash
go version      # 1.21+ recommended
```

### Quick Start (Any Demo)

1. **Clone the repository:**
```bash
git clone <repository-url>
cd SystemDesign-Backend
```

2. **Choose a demo and start the server:**
```bash
# Example: Long Polling Node.js
cd long-polling-nodejs/server
npm install
npm start
```

3. **Start the client (new terminal):**
```bash
cd long-polling-nodejs/client
npm install
npm run dev
```

4. **Open in browser:**
```
http://localhost:3000  # (or the port shown in terminal)
```

---

## 📖 Learning Path

### Recommended Order

1. **Start with POLLING_COMPARISON.md**
   - Understand short vs long polling
   - Learn when to use each approach
   - See visual comparisons

2. **Try Long Polling - Node.js**
   - Easier to understand (JavaScript)
   - Good for learning the concept
   - See `long-polling-nodejs/README.md`

3. **Try Long Polling - Golang**
   - See performance benefits
   - Learn Go concurrency (goroutines, channels)
   - Compare with Node.js version
   - See `long-polling-golang/README.md`

4. **Try SSE (Server-Sent Events)**
   - More efficient than long polling
   - Built-in browser support
   - See `notification-demo/README.md`

### Key Concepts to Understand

#### 1. Short Polling
```javascript
// Client makes regular requests
setInterval(() => {
  fetch('/api/data').then(handleData)
}, 5000)  // Every 5 seconds
```
- ✅ Simple
- ❌ Wasteful
- ❌ High latency

#### 2. Long Polling
```javascript
// Server holds request until data arrives
async function poll() {
  const data = await fetch('/poll')  // Waits 30s
  handleData(data)
  poll()  // Immediately reconnect
}
```
- ✅ Near real-time
- ✅ Works everywhere
- ⚠️ More server resources

#### 3. Server-Sent Events (SSE)
```javascript
// Browser-native push from server
const eventSource = new EventSource('/events')
eventSource.onmessage = (event) => {
  handleData(event.data)
}
```
- ✅ Very efficient
- ✅ Auto-reconnect
- ⚠️ Server → Client only

---

## 🎓 Detailed Documentation

Each demo folder contains:
- **README.md** - Setup and explanation
- **Architecture diagrams**
- **API documentation**
- **Code examples**
- **Performance comparisons**

📄 **Must-read documents:**
- [`POLLING_COMPARISON.md`](./POLLING_COMPARISON.md) - Complete comparison guide
- [`long-polling-nodejs/README.md`](./long-polling-nodejs/README.md)
- [`long-polling-golang/README.md`](./long-polling-golang/README.md)
- [`notification-demo/README.md`](./notification-demo/README.md)

---

## 🔧 Testing

### Test with curl

**Long Polling (Node.js):**
```bash
# Terminal 1: Start long poll
curl http://localhost:4000/poll

# Terminal 2: Send notification
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Test!", "type": "info"}'
```

**Long Polling (Go):**
```bash
# Terminal 1: Start long poll
curl http://localhost:4001/poll

# Terminal 2: Send notification
curl -X POST http://localhost:4001/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Test from Go!", "type": "success"}'
```

**SSE:**
```bash
# Terminal 1: Connect to SSE
curl -N http://localhost:8080/events

# Terminal 2: Send notification
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"message": "SSE test", "type": "info"}'
```

---

## 🤔 When to Use What?

### Use Short Polling:
- ✅ Very simple use case
- ✅ Updates can be delayed (5-30s OK)
- ✅ Low traffic
- ✅ Quick prototype

### Use Long Polling:
- ✅ Need near real-time
- ✅ Must work through firewalls
- ✅ Support old browsers
- ✅ Moderate concurrent users (<10K)

### Use SSE:
- ✅ Server → Client only
- ✅ Modern browsers
- ✅ Real-time notifications
- ✅ Higher concurrency (10K-50K)

### Use WebSocket:
- ✅ Bidirectional communication
- ✅ Chat applications
- ✅ Gaming
- ✅ Very high frequency updates

---

## 🌟 Key Takeaways

1. **Short Polling** = Simple but wasteful
2. **Long Polling** = Universal real-time solution
3. **SSE** = Efficient server → client push
4. **WebSocket** = Full duplex, high performance

**General Rule:**
```
Legacy → Short Polling
Universal Real-time → Long Polling  
Modern Notifications → SSE
Chat/Gaming → WebSocket
```

---

## 📝 License

MIT

---

## 🤝 Contributing

Feel free to open issues or submit PRs to improve these demos!

---

## 📚 Additional Resources

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Go by Example: Channels](https://gobyexample.com/channels)
- [Node.js Event Loop](https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/)

---

**Happy Learning! 🚀**
